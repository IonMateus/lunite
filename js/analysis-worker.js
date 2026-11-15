// analysis-worker.js: busca de sítios válidos na janela de tempo inicial (etapa 2 do fluxo).
//
// Para cada ponto candidato dentro do raio de busca (malha com espaçamento = precisão de pouso):
//   1. inclinação do relevo (LOLA) no ponto;
//   2. perfil de horizonte em 360°, visto da altura do painel e da altura da antena;
//   3. varredura da janela (data de início + duração) com as direções reais do Sol e da Terra (Horizons, vindas da página):
//      % do tempo com Sol, % com comunicação direta, maior escuridão contínua, maior apagão contínuo.
// Um ponto é válido quando cumpre todos os mínimos dos parâmetros da missão.
//
// Tudo é medido no referencial leste-norte-cima do centro da área (o mesmo do patch do app.js): alturas z incluem a
// curvatura da Lua, então "o Sol está acima do horizonte" vira comparar inclinações nesse referencial.
import { Store, aeqdInv } from './tiles.js';
import { makeSampler, positions, zAt } from './terrain-grid.js?v=20261115d';

const NA = 360;               // azimutes do perfil de horizonte (1°)
const MAX_POINTS = 3000;      // acima disso o espaçamento dos candidatos aumenta
const CHUNK = 120;            // pontos por lote enviado à página
const STRIDE = 11;            // lat, lon, h, slope, sunPct, commPct, maxDarkH, maxBlackH, flags, dist, índice do candidato

let store = null, sampler = null, current = 0;

function hAt(G, e, n) {   // altura LOLA (m) bilinear, NaN fora da grade
  const N = G.N, s = (e + G.W / 2) / G.spacing, l = (G.W / 2 - n) / G.spacing;
  if (s < 0 || l < 0 || s >= N - 1 || l >= N - 1) return NaN;
  const j = Math.floor(s), i = Math.floor(l), fj = s - j, fi = l - i, k = i * N + j, h = G.h;
  return h[k] * (1 - fi) * (1 - fj) + h[k + 1] * (1 - fi) * fj + h[k + N] * fi * (1 - fj) + h[k + N + 1] * fi * fj;
}

async function run(m) {
  const id = m.id, t0 = performance.now();
  const cancelled = () => id !== current;
  // vários workers dividem os candidatos: este fica com os índices c ≡ part (mod parts), intercalados para manter a ordem do centro para fora
  const part = m.part || 0, parts = m.parts || 1;
  const prog = (stage, f) => postMessage({ type: 'progress', id, part, stage, f });

  // ---- candidatos: malha quadrada dentro do círculo, do centro para fora
  let sp = Math.max(m.spacingM, 1);
  if (Math.PI * (m.radiusM / sp) ** 2 > MAX_POINTS) sp = m.radiusM * Math.sqrt(Math.PI / MAX_POINTS);
  const cand = [], nn = Math.floor(m.radiusM / sp);
  for (let i = -nn; i <= nn; i++) for (let j = -nn; j <= nn; j++) { const e = j * sp, n = i * sp, d = Math.hypot(e, n); if (d <= m.radiusM) cand.push([e, n, d]); }
  cand.sort((a, b) => a[2] - b[2]);

  // ---- relevo: grade fina (área de busca), média (8x) e longínqua (horizonte distante)
  const Wf = 2 * m.radiusM + 2 * Math.max(1000, 4 * sp);
  const Nf = Math.min(513, Math.max(129, Math.ceil(Wf / Math.max(5, Math.min(sp / 4, 60))) + 1));
  prog('relevo', 0);
  const lab = (stage) => (d, t) => prog(stage, d / t);
  const F = await sampler.grid(m.lat, m.lon, Wf, Nf, lab('relevo da área'));
  if (cancelled()) return;
  const M = await sampler.grid(m.lat, m.lon, Wf * 8, 257, lab('relevo ao redor'));
  if (cancelled()) return;
  const C = await sampler.grid(m.lat, m.lon, Math.max(Wf * 48, 400000), 257, lab('relevo distante'));
  if (cancelled()) return;
  for (const G of [F, M, C]) G.z = positions(G, m.lat, m.lon, 1).z;
  let zMax = -1e9; for (const G of [F, M, C]) for (const v of G.z) if (v > zMax) zMax = v;
  const grids = [F, M, C];
  if (part === 0) { // círculo da área de busca, com as alturas do relevo, para a página desenhar
    const ring = new Float64Array(256 * 3);
    for (let i = 0; i < 256; i++) { const a = 2 * Math.PI * i / 256, e = m.radiusM * Math.sin(a), n = m.radiusM * Math.cos(a); const [la, lo] = aeqdInv(m.lat, m.lon, e, n); ring.set([la, lo, hAt(F, e, n)], 3 * i); }
    postMessage({ type: 'ring', id, ring }, [ring.buffer]);
  }
  const zAny = (x, y) => { for (const G of grids) { const z = zAt(G, x, y); if (!isNaN(z)) return [z, G.spacing]; } return null; };

  // ---- direções do Sol e da Terra por instante (no referencial do centro)
  const n = m.ok.length, S = m.sun, E = m.earth;
  const sAz = new Float32Array(n), sTan = new Float32Array(n), eAz = new Float32Array(n), eTan = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const sx = S[3 * k], sy = S[3 * k + 1], sz = S[3 * k + 2], ex = E[3 * k], ey = E[3 * k + 1], ez = E[3 * k + 2];
    sAz[k] = ((Math.atan2(sx, sy) / (2 * Math.PI) + 1) % 1) * NA; sTan[k] = sz / Math.max(Math.hypot(sx, sy), 1e-9);
    eAz[k] = ((Math.atan2(ex, ey) / (2 * Math.PI) + 1) % 1) * NA; eTan[k] = ez / Math.max(Math.hypot(ex, ey), 1e-9);
  }
  const at = (prof, a) => { const i = Math.floor(a), f = a - i; return prof[i % NA] * (1 - f) + prof[(i + 1) % NA] * f; };
  const dirX = new Float32Array(NA), dirY = new Float32Array(NA);
  for (let a = 0; a < NA; a++) { dirX[a] = Math.sin(2 * Math.PI * a / NA); dirY[a] = Math.cos(2 * Math.PI * a / NA); }

  const profP = new Float32Array(NA), profA = new Float32Array(NA);
  const T = m.thr, hp = m.panelM, ha = m.antennaM, dSlope = Math.max(F.spacing, 10);
  const counts = { total: cand.length, slope: 0, sun: 0, earth: 0, valid: 0 };
  let out = [];
  const flush = (last) => {
    const a = new Float64Array(out.length * STRIDE); out.forEach((r, i) => a.set(r, i * STRIDE));
    postMessage({ type: 'chunk', id, part, pts: a, counts: { ...counts, total: cand.length }, done: last, spacing: sp, steps: nW, ms: performance.now() - t0 }, [a.buffer]);
    out = [];
  };

  // visibilidade (0/1) por ponto e por instante, no período todo
  const mine = []; for (let c = part; c < cand.length; c += parts) mine.push(c);
  const visSun = new Uint8Array(mine.length * n), visCom = new Uint8Array(mine.length * n), slopes = new Float32Array(mine.length);
  const nW = m.nW;
  function windowMetrics(c, k0) {   // % de Sol, % de comunicação, maior escuridão (h), maior apagão (h) na janela [k0, k0 + nW)
    const sv = visSun.subarray(c * n + k0, c * n + k0 + nW), cv = visCom.subarray(c * n + k0, c * n + k0 + nW);
    let sunN = 0, comN = 0, dark = 0, black = 0, maxDark = 0, maxBlack = 0;
    for (let k = 0; k < nW; k++) {
      if (sv[k]) { sunN++; dark = 0; } else if (++dark > maxDark) maxDark = dark;
      if (cv[k]) { comN++; black = 0; } else if (++black > maxBlack) maxBlack = black;
    }
    return [100 * sunN / nW, 100 * comN / nW, maxDark * m.stepH, maxBlack * m.stepH];
  }
  const judge = (sunPct, commPct, darkH, blackH) => (sunPct >= T.minSunPct && darkH <= T.maxDarkH ? 2 : 0) | (commPct >= T.minCommPct && blackH <= T.maxBlackoutH ? 4 : 0);
  for (let j = 0; j < mine.length; j++) {
    const c = mine[j], [e0, n0, dist] = cand[c];
    const [lat, lon] = latLonAt(F, e0, n0);
    const h0 = hAt(F, e0, n0), z0 = zAt(F, e0, n0);
    // 1) inclinação (gradiente central sobre ±dSlope)
    const gx = (hAt(F, e0 + dSlope, n0) - hAt(F, e0 - dSlope, n0)) / (2 * dSlope), gy = (hAt(F, e0, n0 + dSlope) - hAt(F, e0, n0 - dSlope)) / (2 * dSlope);
    const slope = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI; slopes[j] = slope;
    let flags = 0, sunPct = NaN, commPct = NaN, darkH = NaN, blackH = NaN;
    if (slope <= m.slopeMax) {
      flags |= 1; counts.slope++;
      // 2) horizonte 360° (inclinação máxima do relevo), para os dois pontos de vista
      for (let a = 0; a < NA; a++) {
        const dx = dirX[a], dy = dirY[a]; let t = F.spacing, mP = -1e9, mA = -1e9;
        while (true) {
          const r = zAny(e0 + dx * t, n0 + dy * t); if (!r) break;
          const z = r[0], sP = (z - z0 - hp) / t, sA = (z - z0 - ha) / t;
          if (sP > mP) mP = sP; if (sA > mA) mA = sA;
          if (t > F.W * 0.25 && z0 + Math.min(hp, ha) + t * Math.min(mP, mA) > zMax) break;   // nada mais longe pode subir o horizonte
          t += Math.max(r[1] * 0.7, t / 48);
        }
        profP[a] = mP; profA[a] = mA;
      }
      // 3) visibilidade em todo o período (janela inicial + atraso máximo), guardada para arrastar a janela depois
      const sv = visSun.subarray(j * n, (j + 1) * n), cv = visCom.subarray(j * n, (j + 1) * n);
      for (let k = 0; k < n; k++) { sv[k] = sTan[k] > at(profP, sAz[k]) ? 1 : 0; cv[k] = m.ok[k] && eTan[k] > at(profA, eAz[k]) ? 1 : 0; }
      [sunPct, commPct, darkH, blackH] = windowMetrics(j, 0);
      const f = judge(sunPct, commPct, darkH, blackH); flags |= f;
      if (f & 2) counts.sun++; if (f & 4) counts.earth++; if (flags === 7) counts.valid++;
    }
    out.push([lat, lon, h0, slope, sunPct, commPct, darkH, blackH, flags, dist, c]);
    if (out.length >= CHUNK) {
      flush(false); prog('pontos', (j + 1) / mine.length);
      await new Promise((r) => setTimeout(r, 0));   // deixa chegar um pedido novo (cancelamento)
      if (cancelled()) return;
    }
  }
  flush(true);

  // ---- etapa 3: arrastar a janela de tempo, um dia por vez, dentro do atraso máximo (cada worker avalia os seus pontos;
  //      a página junta as partes de cada janela e escolhe a melhor)
  const N = mine.length, hints = { slopeOk: counts.slope, minSlope: Infinity, bestSun: -1, bestDark: Infinity, bestComm: -1, bestBlack: Infinity };
  for (const s of slopes) if (s < hints.minSlope) hints.minSlope = s;
  for (let o = 0; o < m.nOff; o++) {
    const met = new Float32Array(4 * N).fill(NaN), fl = new Uint8Array(N);
    let valid = 0, sum = 0, sunOk = 0, earthOk = 0;
    for (let j = 0; j < N; j++) {
      if (!(slopes[j] <= m.slopeMax)) continue;
      const r = windowMetrics(j, o * m.dStep); met.set(r, 4 * j);
      const f = 1 | judge(...r); fl[j] = f;
      if (f & 2) sunOk++; if (f & 4) earthOk++;
      if (f === 7) { valid++; sum += (r[0] + r[1]) / 2; }
      if (r[0] > hints.bestSun) hints.bestSun = r[0]; if (r[2] < hints.bestDark) hints.bestDark = r[2];
      if (r[1] > hints.bestComm) hints.bestComm = r[1]; if (r[3] < hints.bestBlack) hints.bestBlack = r[3];
    }
    postMessage({ type: 'window', id, part, parts, o, valid, sum, sunOk, earthOk, met, fl }, [met.buffer, fl.buffer]);
    if (o % 8 === 7) { await new Promise((r) => setTimeout(r, 0)); if (cancelled()) return; }
  }
  postMessage({ type: 'sweep', id, part, hints });
}

function latLonAt(F, e, n) {   // lat/lon do ponto (e, n) da grade fina (bilinear nas colunas lat/lon da grade)
  const N = F.N, s = (e + F.W / 2) / F.spacing, l = (F.W / 2 - n) / F.spacing;
  const j = Math.min(N - 2, Math.floor(s)), i = Math.min(N - 2, Math.floor(l)), fj = s - j, fi = l - i, k = i * N + j;
  const lat = F.lat[k] * (1 - fi) * (1 - fj) + F.lat[k + 1] * (1 - fi) * fj + F.lat[k + N] * fi * (1 - fj) + F.lat[k + N + 1] * fi * fj;
  // longitude: interpola o desvio em relação ao canto, para não quebrar em ±180°
  const w = (x) => ((x - F.lon[k] + 540) % 360) - 180;
  const lon = F.lon[k] + w(F.lon[k + 1]) * (1 - fi) * fj + w(F.lon[k + N]) * fi * (1 - fj) + w(F.lon[k + N + 1]) * fi * fj;
  return [lat, ((lon + 540) % 360) - 180];
}

onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      store = new Store(m.base); await store.init();
      sampler = makeSampler(store, Object.fromEntries(m.sites.map((s) => [s.id, s])));
      postMessage({ type: 'ready' });
    }
    if (m.type === 'run') { current = m.id; await run(m); }
    if (m.type === 'cancel') current = -1;
  } catch (err) { postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) }); }
};
