// analysis.js: etapa 2 do fluxo — achar os sítios válidos na janela de tempo inicial e mostrá-los como barras.
//
// Ouve 'lunite:mission-change' (parâmetros da missão), monta os instantes da janela (data de início + duração) com as
// direções do Sol e da Terra do Horizons, e manda o cálculo para analysis-worker.js. Os pontos válidos chegam em lotes
// e viram barras no terreno: altura e tom pela métrica escolhida (Sol = amarelo, Terra = azul, Viability Score = verde).
//
//   initAnalysis(api)  api = { THREE, scene, camera, canvas, eph, setTime(ms), base, sites, frame() -> { lat, lon, exag, mode } }
//   window.lunite.analysis -> { counts, phase, window, points: [...] } do cálculo atual
//   window.lunite.window   -> janela fixada { start, end, offsetDays, valid, score } (ou null); evento 'lunite:window-fixed'
import { R, unit, enuBasis } from './tiles.js';

const $ = (id) => document.getElementById(id);
const STRIDE = 11;
const D2R = Math.PI / 180;
const STATION_MIN_EL = 10;   // elevação mínima da Lua vista da estação em solo (°), típica das antenas de espaço profundo
const STATIONS = {   // mesmas coordenadas do mission.js
  goldstone: [35.4267, -116.89], madrid: [40.4314, -4.2481], canberra: [-35.4014, 148.9817],
  newnorcia: [-31.0482, 116.1914], cebreros: [40.4527, -4.3676], malargue: [-35.776, -69.3982],
};
export const METRICS = {
  sun:   { label: 'Duração de contato com o Sol', short: 'Sol', colors: ['#fff3c0', '#d98e00'], get: (p) => p.sunPct },
  earth: { label: 'Duração de comunicação com a Terra', short: 'Terra', colors: ['#d4e8ff', '#1749b8'], get: (p) => p.commPct },
  score: { label: 'Viability Score', short: 'Score', colors: ['#d2f4d6', '#0e7a34'], get: (p) => (p.sunPct + p.commPct) / 2 },
};

const fmtInt = (n) => n.toLocaleString('pt-BR');
const fmtPct = (v) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
const fmtH = (h) => (h >= 48 ? `${(h / 24).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} d` : `${Math.round(h)} h`);
const fmtDate = (ms) => new Date(ms).toLocaleDateString('pt-BR', { timeZone: 'UTC' });

export function initAnalysis(api) {
  const { THREE, scene, camera, canvas, eph } = api;
  // vários workers em paralelo (um por núcleo livre, até 6): cada um calcula uma parte dos pontos
  const NW = +new URLSearchParams(location.search).get('workers') || Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));   // ?workers=N força (testes)
  const workers = Array.from({ length: NW }, () => new Worker(new URL('./analysis-worker.js?v=20261115e', import.meta.url), { type: 'module' }));
  const sendAll = (msg) => workers.forEach((w) => w.postMessage(msg));
  sendAll({ type: 'init', base: new URL(api.base, location.href).href, sites: api.sites.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon })) });

  let metric = 'sun', runId = 0, job = null, timer = 0, lastKey = '';
  const filt = { on: false, sun: 0, comm: 0 };   // etapa 4: filtragem (pente fino) sobre a janela fixada
  let marks = {};                                 // marcadores 3D: { sel, fixed, cmp } = índices de candidatos
  const group = new THREE.Group(); group.name = 'analysis'; scene.add(group);
  let bars = null, dots = null, ring = null;

  // ---------------------------------------------------------------- disparo
  addEventListener('lunite:mission-change', (e) => schedule(e.detail));
  function schedule(P) {
    const key = JSON.stringify([P.site.lat, P.site.lon, P.radiusKm, P.probe, P.earth, P.sun, P.time]);
    if (key === lastKey) return; lastKey = key;
    window.lunite = window.lunite || {}; window.lunite.analysis = null;   // o resultado anterior deixa de valer já
    clearTimeout(timer); timer = setTimeout(() => start(P), 350);
  }

  function start(P) {
    const id = ++runId; sendAll({ type: 'cancel' }); filt.on = false; marks = {}; $('anFilter').hidden = true;
    dispatchEvent(new CustomEvent('lunite:analysis-reset')); clear(); clearInterval(pumpTimer); pumpTimer = 0;
    document.body.classList.toggle('analyzing', P.site.mode !== 'none');   // com um alvo, o painel da direita mostra os sítios (CSS: body.analyzing.local)
    window.lunite = window.lunite || {}; window.lunite.analysis = null; window.lunite.window = null;   // nada do cálculo anterior fica valendo
    if (P.site.mode === 'none') { job = null; status('Escolha um local de pouso nos parâmetros da missão.'); return; }
    if (P.earth.mode === 'stations' && !P.earth.stations.length) { job = null; status('Escolha pelo menos um centro de comunicação.', 'err'); return; }
    hintParams([]);
    const t0 = Date.parse(P.time.startDate + 'T00:00:00Z'), days = P.time.days, r = eph.range();
    const tab = [r.a, r.b].find((x) => t0 >= x[0] && t0 + days * 86400e3 <= x[1]);
    if (!tab) { job = null; status('A janela fica fora das efemérides disponíveis (2020–2050 e 1969–1972).', 'err'); return; }
    // atraso máximo: a janela pode começar até "delay" dias depois do início (limitado ao fim das efemérides)
    const delay = Math.max(0, Math.min(P.time.maxDelayDays, Math.floor((tab[1] - t0) / 86400e3 - days)));
    const total = days + delay, stepH = [1, 2, 3, 4, 6, 8, 12, 24].find((h) => total * 24 / h <= 3000) || 24;
    const n = Math.round(total * 24 / stepH), nW = Math.max(1, Math.round(days * 24 / stepH)), dStep = 24 / stepH, t1 = t0 + days * 86400e3;
    // direções do Sol e da Terra vistas do centro da área, a cada passo
    const sun = new Float32Array(3 * n), earth = new Float32Array(3 * n), ok = new Uint8Array(n);
    const st = P.earth.mode === 'stations' ? P.earth.stations.map((k) => unit(...STATIONS[k])) : null;
    const cosMin = Math.cos((90 - STATION_MIN_EL) * D2R);
    let noStationData = false;
    for (let k = 0; k < n; k++) {
      const o = eph.topo(t0 + k * stepH * 3600e3, P.site.lat, P.site.lon, 0);
      sun.set(o.sun, 3 * k); earth.set(o.earth, 3 * k);
      if (!st) ok[k] = 1;
      else if (!o.g.subMoon) { ok[k] = 1; noStationData = true; }   // tabelas Apollo não têm o ponto sub-Lua na Terra
      else { const sm = unit(o.g.subMoon.lat, o.g.subMoon.lon); ok[k] = st.some((u) => u[0] * sm[0] + u[1] * sm[1] + u[2] * sm[2] >= cosMin) ? 1 : 0; }
    }
    job = { id, P, t0, t1, days, stepH, n, delay, delayClamped: delay < P.time.maxDelayDays, noStationData, pts: [], counts: null, done: false, spacing: P.probe.precisionM,
            phase: 'initial', cur: 0, windows: [], queue: [], best: null, hints: null, total: 0, prog: new Array(NW).fill(0), partsDone: 0, sweeps: 0 };
    drawChart();
    $('anWin').className = 'an-win initial'; $('anWinLbl').textContent = 'Janela inicial em avaliação';
    $('anWinDates').textContent = `${fmtDate(t0)} – ${fmtDate(t1)}`;
    status('Analisando…'); progress(0);
    const runMsg = { type: 'run', id, lat: P.site.lat, lon: P.site.lon, radiusM: P.radiusKm * 1000, spacingM: P.probe.precisionM,
      slopeMax: P.probe.slopeMaxDeg, panelM: P.probe.panelM, antennaM: P.probe.antennaM, stepH, sun, earth, ok, nW, dStep, nOff: delay + 1,
      thr: { minSunPct: P.sun.minSunPct, maxDarkH: P.sun.maxDarkH, minCommPct: P.earth.minCommPct, maxBlackoutH: P.earth.maxBlackoutH } };
    workers.forEach((w, part) => w.postMessage({ ...runMsg, part, parts: NW }));
  }

  workers.forEach((w) => w.onmessage = onWorker);
  function onWorker(ev) {
    const m = ev.data;
    if (m.type === 'error') { status('Erro na análise: ' + m.message.split('\n')[0], 'err'); console.error(m.message); return; }
    if (!job || m.id !== job.id) return;
    if (m.type === 'progress') {
      job.prog[m.part] = m.stage === 'pontos' ? 0.25 + 0.75 * m.f : 0.25 * m.f;
      const lbl = m.stage === 'pontos' ? 'calculando Sol e Terra' : 'carregando ' + m.stage;
      if (!job.pts.length) status(`Analisando… ${lbl}`);
      progress(job.prog.reduce((a, b) => a + b, 0) / NW); return;
    }
    if (m.type === 'detail') { const cb = detailReq.get(m.req); if (cb) { detailReq.delete(m.req); cb(m); } return; }
    if (m.type === 'ring') { job.ring = m.ring; drawRing(); api.invalidate?.(); return; }
    if (m.type === 'chunk') {
      const a = m.pts;
      for (let i = 0; i < a.length; i += STRIDE) job.pts[a[i + 10]] = { c: a[i + 10], lat: a[i], lon: a[i + 1], h: a[i + 2], slope: a[i + 3], sunPct: a[i + 4], commPct: a[i + 5], maxDarkH: a[i + 6], maxBlackoutH: a[i + 7], flags: a[i + 8], dist: a[i + 9] };
      job.total = m.counts.total; job.spacing = m.spacing; job.ms = m.ms;
      if (m.done) job.partsDone++;
      job.done = job.partsDone === NW;
      draw(); summary();
      if (job.done) { job.phase = 'sweep'; status(`Janela inicial: <b>${fmtInt(counts().valid)}</b> válidos · procurando a melhor janela…`); progress(0); }
      publish();
    }
    if (m.type === 'window') {   // junta a parte deste worker na janela o; quando todas chegam, a janela entra na fila
      let w = job.windows[m.o];
      if (!w) w = job.windows[m.o] = { o: m.o, met: new Float32Array(4 * job.total).fill(NaN), fl: new Uint8Array(job.total), valid: 0, sum: 0, sunOk: 0, earthOk: 0, parts: 0 };
      for (let j = 0, c = m.part; j < m.fl.length; j++, c += m.parts) { w.fl[c] = m.fl[j]; w.met.set(m.met.subarray(4 * j, 4 * j + 4), 4 * c); }
      w.valid += m.valid; w.sum += m.sum; w.sunOk += m.sunOk; w.earthOk += m.earthOk;
      if (++w.parts === NW) { w.score = w.valid ? w.sum / w.valid : 0; job.queue.push(m.o); pump(); }
    }
    if (m.type === 'sweep') {   // junta as dicas; com todas as partes, escolhe a melhor janela (mais válidos; empate: maior score médio)
      const H = m.hints;
      if (!job.hints) job.hints = { ...H };
      else { const J = job.hints; J.slopeOk += H.slopeOk; J.minSlope = Math.min(J.minSlope, H.minSlope); J.bestSun = Math.max(J.bestSun, H.bestSun); J.bestDark = Math.min(J.bestDark, H.bestDark); J.bestComm = Math.max(J.bestComm, H.bestComm); J.bestBlack = Math.min(J.bestBlack, H.bestBlack); }
      if (++job.sweeps === NW) {
        let best = -1, bv = 0, bs = -1;
        job.windows.forEach((w, o) => { if (w.valid > bv || (w.valid === bv && w.valid > 0 && w.score > bs)) { best = o; bv = w.valid; bs = w.score; } });
        job.best = best; pump();
      }
    }
  }
  function publish() {
    window.lunite = window.lunite || {};
    window.lunite.analysis = { counts: counts(), done: job.done, phase: job.phase, window: winInfo(job.cur), spacing: job.spacing, ms: job.ms, points: job.pts };
  }

  // ---------------------------------------------------------------- etapa 3: arrastar a janela e fixar a melhor
  // As janelas chegam do worker em poucos décimos de segundo; a página as mostra uma a uma (as barras acompanham)
  // para que dê para ver qual janela está em avaliação, e no fim fixa a melhor.
  let pumpTimer = 0;
  function pump() {
    if (pumpTimer || !job) return;
    const per = Math.max(30, Math.min(110, 3000 / (job.delay + 1)));
    pumpTimer = setInterval(() => {
      if (!job) { clearInterval(pumpTimer); pumpTimer = 0; return; }
      const o = job.queue.shift();
      if (o != null) { applyWindow(o); progress((o + 1) / (job.delay + 1)); return; }
      if (job.best !== null) { clearInterval(pumpTimer); pumpTimer = 0; finish(); }
    }, per);
  }
  function applyWindow(o) {
    const w = job.windows[o]; job.cur = o;
    job.pts.forEach((p, c) => { p.sunPct = w.met[4 * c]; p.commPct = w.met[4 * c + 1]; p.maxDarkH = w.met[4 * c + 2]; p.maxBlackoutH = w.met[4 * c + 3]; p.flags = w.fl[c]; });
    draw(); summary(); drawChart(); publish();
  }
  function winInfo(o) { const a = job.t0 + o * 86400e3; return { offsetDays: o, start: new Date(a).toISOString(), end: new Date(a + job.days * 86400e3).toISOString() }; }
  function finish() {
    progress(-1);
    const w0 = job.windows[0];
    if (job.best >= 0) {
      applyWindow(job.best); job.phase = 'fixed';
      const w = winInfo(job.best), v = job.windows[job.best].valid;
      job.verdict = job.best === 0 ? `A janela inicial já é a melhor: <b>${fmtInt(v)}</b> sítios válidos.`
        : w0.valid ? `Melhor janela: <b>${job.best} ${job.best === 1 ? 'dia' : 'dias'}</b> depois do início, com <b>${fmtInt(v)}</b> sítios válidos (a inicial tinha ${fmtInt(w0.valid)}).`
        : `A janela inicial não tinha sítios válidos. A janela foi movida <b>${job.best} ${job.best === 1 ? 'dia' : 'dias'}</b>, para uma com <b>${fmtInt(v)}</b> sítios válidos.`;
      window.lunite.window = { ...w, fixed: true, valid: v, score: job.windows[job.best].score };
      if (api.setTime) api.setTime(Date.parse(w.start));   // o céu do visualizador passa a mostrar o início da janela fixada
      dispatchEvent(new CustomEvent('lunite:window-fixed', { detail: window.lunite.window }));
      startFilter();
    } else {
      applyWindow(0); job.phase = 'none'; window.lunite.window = null;
      job.verdict = loosen();
    }
    summary(); drawChart(); publish();
  }
  // ---------------------------------------------------------------- etapa 4: filtragem
  // Dois requisitos mínimos, mais finos que os da missão, sobre a janela fixada: duração de contato com o Sol e de
  // comunicação com a Terra (em % da janela, com o equivalente em horas). Só os sítios que passam ficam visíveis.
  function startFilter() {
    const P = job.P; filt.on = true; filt.sun = P.sun.minSunPct; filt.comm = P.earth.minCommPct;
    for (const [id, v, min] of [['fSun', filt.sun, P.sun.minSunPct], ['fComm', filt.comm, P.earth.minCommPct]]) { const el = $(id); el.min = min; el.max = 100; el.value = v; }
    $('anFilter').hidden = false; filterUI(); draw(); filterChanged();
  }
  const hoursOf = (pct) => Math.round(pct / 100 * job.days * 24);
  function filterUI() {
    $('fSunV').textContent = `≥ ${filt.sun}% · ${fmtH(hoursOf(filt.sun))}`;
    $('fCommV').textContent = `≥ ${filt.comm}% · ${fmtH(hoursOf(filt.comm))}`;
    const all = job.pts.filter(isValid).length, n = valid().length;
    const st = $('fStatus');
    if (!n) { st.innerHTML = `<b class="bad">Nenhum sítio passa nos filtros.</b> Afrouxe a duração mínima de ${filt.sun > job.P.sun.minSunPct ? 'contato com o Sol' : ''}${filt.sun > job.P.sun.minSunPct && filt.comm > job.P.earth.minCommPct ? ' e/ou ' : ''}${filt.comm > job.P.earth.minCommPct ? 'comunicação com a Terra' : ''}.`; }
    else st.innerHTML = `<b>${fmtInt(n)}</b> de ${fmtInt(all)} sítios válidos passam nos filtros. Clique numa barra para selecionar um sítio.`;
    $('anFilter').classList.toggle('none', !n);
    // os sliders que estão eliminando tudo ficam em vermelho
    $('fSun').closest('.an-frow').classList.toggle('warn', !n && filt.sun > job.P.sun.minSunPct);
    $('fComm').closest('.an-frow').classList.toggle('warn', !n && filt.comm > job.P.earth.minCommPct);
  }
  function filterChanged() { dispatchEvent(new CustomEvent('lunite:filter-change', { detail: { sun: filt.sun, comm: filt.comm, n: valid().length } })); }
  for (const [id, k] of [['fSun', 'sun'], ['fComm', 'comm']]) $(id).addEventListener('input', (e) => { filt[k] = +e.target.value; filterUI(); draw(); summary(); filterChanged(); publish(); });

  // nenhuma janela tem sítios válidos: mostra o que a área consegue no máximo e destaca os parâmetros a afrouxar
  function loosen() {
    const H = job.hints, P = job.P, items = [], paths = [];
    const add = (path, txt) => { items.push(`<li>${txt}</li>`); paths.push(path); };
    if (!H.slopeOk) add('probe.slopeMaxDeg', `Inclinação máxima: você pediu ≤ ${P.probe.slopeMaxDeg}°, o terreno mais plano da área tem ${H.minSlope.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}°.`);
    else {
      if (H.bestSun < P.sun.minSunPct) add('sun.minSunPct', `Contato com o Sol: você pediu ≥ ${P.sun.minSunPct}%, o máximo possível aqui é ${fmtPct(H.bestSun)}.`);
      if (H.bestDark > P.sun.maxDarkH) add('sun.maxDarkH', `Maior escuridão: você pediu ≤ ${fmtH(P.sun.maxDarkH)}, o mínimo possível aqui é ${fmtH(H.bestDark)}.`);
      if (H.bestComm < P.earth.minCommPct) add('earth.minCommPct', `Comunicação com a Terra: você pediu ≥ ${P.earth.minCommPct}%, o máximo possível aqui é ${fmtPct(H.bestComm)}.`);
      if (H.bestBlack > P.earth.maxBlackoutH) add('earth.maxBlackoutH', `Maior apagão: você pediu ≤ ${fmtH(P.earth.maxBlackoutH)}, o mínimo possível aqui é ${fmtH(H.bestBlack)}.`);
      if (!items.length) {   // cada requisito é possível sozinho, mas nenhum ponto cumpre todos na mesma janela
        const sunMax = Math.max(...job.windows.map((w) => w.sunOk)), earthMax = Math.max(...job.windows.map((w) => w.earthOk));
        if (sunMax <= earthMax) { paths.push('sun.minSunPct', 'sun.maxDarkH'); items.push('<li>Cada requisito é possível sozinho, mas nenhum ponto cumpre todos na mesma janela. Os de <b>Sol e energia</b> são os que mais eliminam.</li>'); }
        else { paths.push('earth.minCommPct', 'earth.maxBlackoutH'); items.push('<li>Cada requisito é possível sozinho, mas nenhum ponto cumpre todos na mesma janela. Os de <b>Terra e comunicação</b> são os que mais eliminam.</li>'); }
      }
    }
    hintParams(paths);
    const end = fmtDate(job.t0 + (job.delay + job.days) * 86400e3);
    return `<b>Nenhuma janela</b> entre ${fmtDate(job.t0)} e ${end} tem sítios válidos. Os requisitos estão altos demais para esta área. Afrouxe:<ul class="an-loosen">${items.join('')}</ul><span class="dim">Também ajuda aumentar o raio de busca ou o intervalo máximo de atraso.</span>`;
  }
  function hintParams(paths) { dispatchEvent(new CustomEvent('lunite:hint-params', { detail: { paths } })); }

  // gráfico: sítios válidos em cada janela (posição = dias de atraso)
  function drawChart() {
    const cv = $('anChart'), wrap = $('anChartWrap');
    if (!job || job.delay < 1 || !job.windows.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const dpr = devicePixelRatio || 1, W = cv.clientWidth, Hh = cv.clientHeight; cv.width = W * dpr; cv.height = Hh * dpr;
    const x = cv.getContext('2d'); x.scale(dpr, dpr); x.clearRect(0, 0, W, Hh);
    const n = job.delay + 1, bw = W / n, mx = Math.max(1, ...job.windows.filter(Boolean).map((w) => w.valid));
    for (let o = 0; o < n; o++) {
      const w = job.windows[o]; if (!w) continue;
      const h = w.valid ? Math.max(2, (Hh - 4) * w.valid / mx) : 1;
      x.fillStyle = job.phase === 'fixed' && o === job.best ? '#16903e' : o === job.cur ? '#ffffff' : 'rgba(255,255,255,.32)';
      x.fillRect(o * bw + 0.5, Hh - h, Math.max(1, bw - 1), h);
    }
    if (job.phase !== 'fixed') { x.strokeStyle = '#7fd4ff'; x.lineWidth = 1; x.strokeRect(job.cur * bw + 0.5, 0.5, Math.max(1, bw - 1), Hh - 1); }
    $('anChartA').textContent = fmtDate(job.t0); $('anChartB').textContent = '+' + job.delay + ' d';
  }

  // ---------------------------------------------------------------- barras
  function toFrame(lat, lon, h) {   // mesma conta do terreno (worker.js positions): ponto na esfera, no ENU do centro do patch
    const f = api.frame(), B = enuBasis(f.lat, f.lon), u = unit(lat, lon), rr = R + h * f.exag;
    const d = [u[0] * rr - B.u[0] * R, u[1] * rr - B.u[1] * R, u[2] * rr - B.u[2] * R];
    return [d[0] * B.e[0] + d[1] * B.e[1] + d[2] * B.e[2], d[0] * B.n[0] + d[1] * B.n[1] + d[2] * B.n[2], d[0] * B.u[0] + d[1] * B.u[1] + d[2] * B.u[2]];
  }
  const isValid = (p) => p && p.flags === 7;
  const passes = (p) => isValid(p) && (!filt.on || (p.sunPct >= filt.sun && p.commPct >= filt.comm));
  const valid = () => (job ? job.pts.filter(passes) : []);
  function range(list) {
    const g = METRICS[metric].get; let lo = Infinity, hi = -Infinity;
    for (const p of list) { const v = g(p); if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi];
  }
  const cA = new THREE.Color(), cB = new THREE.Color(), cOut = new THREE.Color();
  function colorAt(t) {
    const [a, b] = METRICS[metric].colors; cA.set(a); cB.set(b);
    return cOut.copy(cA).lerp(cB, Math.max(0, Math.min(1, t)));
  }
  function clear() {
    for (const o of [bars, dots, ring]) if (o) { group.remove(o); o.geometry.dispose(); o.material.dispose(); }
    bars = dots = ring = null; $('anTip').hidden = true; api.invalidate?.();
  }
  // As malhas das barras e dos pontos são criadas uma vez por cálculo (com espaço para todos os candidatos) e só têm
  // posições, cores e quantidade atualizadas — trocar de janela não recria nada (antes recriava ~2.000 barras por janela).
  const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0, 0.5);
  const mtx = new THREE.Matrix4(), q0 = new THREE.Quaternion(), vPos = new THREE.Vector3(), vScl = new THREE.Vector3();
  function ensureMeshes(cap) {
    if (bars && bars.userData.cap >= cap) return;
    for (const o of [bars, dots]) if (o) { group.remove(o); if (o !== bars) o.geometry.dispose(); o.material.dispose(); }
    bars = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial(), cap); bars.userData.cap = cap; bars.count = 0;
    bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage); bars.setColorAt(0, new THREE.Color()); bars.frustumCulled = false; group.add(bars);
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    dots = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false })); dots.frustumCulled = false; group.add(dots);
  }
  function drawRing() {
    if (ring) { group.remove(ring); ring.geometry.dispose(); ring.material.dispose(); ring = null; }
    if (!job || !job.ring) return;
    const pts = []; for (let i = 0; i < job.ring.length; i += 3) pts.push(...toFrame(job.ring[i], job.ring[i + 1], job.ring[i + 2] + 2));
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    ring = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })); group.add(ring);
  }
  function draw() {
    if (!job) { clear(); return; }
    const list = valid(), sp = job.spacing, radius = job.P.radiusKm * 1000;
    legend(list);
    ensureMeshes(Math.max(1, job.total || list.length));
    const [lo, hi] = list.length ? range(list) : [0, 0], g = METRICS[metric].get;
    const w = Math.max(sp * 0.3, 3), Hmax = Math.max(radius * 0.06, sp * 3), dp = dots.geometry.getAttribute('position'), lift = Math.max(1.5, sp * 0.02);
    for (let i = 0; i < list.length; i++) {
      const p = list[i], t = hi > lo ? (g(p) - lo) / (hi - lo) : 1;
      if (!p.xyz) p.xyz = toFrame(p.lat, p.lon, p.h);   // posição no referencial do patch (recalculada quando o patch muda)
      const [x, y, z] = p.xyz;
      mtx.compose(vPos.set(x, y, z), q0, vScl.set(w, w, Hmax * (0.12 + 0.88 * t)));
      bars.setMatrixAt(i, mtx); bars.setColorAt(i, colorAt(t)); dp.setXYZ(i, x, y, z + lift);
    }
    bars.count = list.length; bars.instanceMatrix.needsUpdate = true; if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
    dp.needsUpdate = true; dots.geometry.setDrawRange(0, list.length);
    bars.userData.list = list;
    api.invalidate?.();
  }
  // marcadores: caixa em volta da barra selecionada (branca), fixada (ciano) e comparada (rosa)
  const markObjs = {};
  const edges = new THREE.EdgesGeometry(box);
  for (const [k, col] of [['sel', 0xffffff], ['fixed', 0x7fd4ff], ['cmp', 0xff8ad8]]) {
    markObjs[k] = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true }));
    markObjs[k].visible = false; markObjs[k].renderOrder = 5; group.add(markObjs[k]);
  }
  function drawMarks() {
    const sp = job ? job.spacing : 100, radius = job ? job.P.radiusKm * 1000 : 3000, w = Math.max(sp * 0.3, 3) * 2.4, H = Math.max(radius * 0.06, sp * 3) * 1.1;
    for (const k of ['sel', 'fixed', 'cmp']) {
      const o = markObjs[k], p = job && marks[k] != null ? job.pts[marks[k]] : null;
      o.visible = !!p && !(k === 'sel' && (marks.sel === marks.fixed || marks.sel === marks.cmp));
      if (!p) continue;
      if (!p.xyz) p.xyz = toFrame(p.lat, p.lon, p.h);
      o.position.set(...p.xyz); o.scale.set(w, w, H);
    }
    api.invalidate?.();
  }
  function reposition() { if (job) for (const p of job.pts) if (p) p.xyz = null; drawRing(); draw(); drawMarks(); }
  addEventListener('lunite:patch', reposition);   // o patch mudou de centro ou de exagero vertical: reposiciona

  // ---------------------------------------------------------------- painel
  const seg = $('anSeg');
  seg.querySelectorAll('button').forEach((b) => b.onclick = () => {
    metric = b.dataset.m;
    seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    draw();
  });
  function status(html, cls = '') { const el = $('anStatus'); el.innerHTML = html; el.className = 'an-status ' + cls; if (cls === 'err' || !job) { progress(-1); $('anFunnel').innerHTML = ''; legend([]); $('anWin').className = 'an-win idle'; $('anWinDates').textContent = '–'; $('anWinLbl').textContent = 'Janela'; $('anChartWrap').hidden = true; } }
  function progress(f) { const b = $('anProg'); if (f < 0) { b.hidden = true; return; } b.hidden = false; b.firstElementChild.style.width = (100 * f).toFixed(1) + '%'; }
  function legend(list) {
    const M = METRICS[metric]; $('anGrad').style.background = `linear-gradient(90deg, ${M.colors[0]}, ${M.colors[1]})`;
    if (!list.length) { $('anMin').textContent = $('anMax').textContent = '–'; return; }
    const [lo, hi] = range(list); $('anMin').textContent = fmtPct(lo); $('anMax').textContent = fmtPct(hi);
  }
  function counts() {
    const c = { total: job.total || 0, slope: 0, sun: 0, earth: 0, valid: 0 };
    for (const p of job.pts) { if (!p) continue; if (p.flags & 1) c.slope++; if (p.flags & 2) c.sun++; if (p.flags & 4) c.earth++; if (p.flags === 7) c.valid++; }
    return c;
  }
  function summary() {
    const c = counts(), P = job.P, v = c.valid, w = winInfo(job.cur);
    const lbl = { initial: 'Janela inicial em avaliação', sweep: 'Avaliando janela', fixed: 'Janela fixada', none: 'Sem janela válida' }[job.phase];
    $('anWin').className = 'an-win ' + job.phase; $('anWinLbl').textContent = lbl;
    $('anWinDates').textContent = `${fmtDate(Date.parse(w.start))} – ${fmtDate(Date.parse(w.end))}`;
    let head;
    if (job.phase === 'initial') head = job.done ? '' : `Analisando a janela inicial… <b>${fmtInt(v)}</b> válidos até agora`;
    else if (job.phase === 'sweep') head = `<b>${fmtInt(v)}</b> sítios válidos nesta janela · procurando a melhor…`;
    else head = job.verdict;
    const notes = [`passo ${job.stepH} h`];
    if (job.delay) notes.unshift(`atraso testado: até ${job.delay} ${job.delay === 1 ? 'dia' : 'dias'}${job.delayClamped ? ' (limitado ao fim das efemérides)' : ''}`);
    if (job.spacing > P.probe.precisionM + 0.5) notes.push(`pontos a cada ${Math.round(job.spacing)} m (área grande para a precisão escolhida)`);
    if (job.noStationData) notes.push('sem dados das estações nessa época: só a visibilidade da Terra conta');
    status(`${head}<div class="dim">${notes.join(' · ')}</div>`, job.phase === 'none' ? 'warn' : '');
    const row = (label, n, cls = '') => `<div class="an-fr ${cls}"><span>${label}</span><i><b style="width:${c.total ? (100 * n / c.total).toFixed(1) : 0}%"></b></i><span>${fmtInt(n)}</span></div>`;
    $('anFunnel').innerHTML = row('Candidatos', c.total) + row(`Inclinação ≤ ${P.probe.slopeMaxDeg}°`, c.slope)
      + row(`Sol ≥ ${P.sun.minSunPct}% · escuridão ≤ ${fmtH(P.sun.maxDarkH)}`, c.sun, 'sun')
      + row(`Terra ≥ ${P.earth.minCommPct}% · apagão ≤ ${fmtH(P.earth.maxBlackoutH)}`, c.earth, 'earth')
      + row('Válidos (todos os requisitos)', job.pts.filter(isValid).length, 'score')
      + (filt.on ? row('Passam nos filtros', v, 'filter') : '');
  }

  // ---------------------------------------------------------------- dica ao passar o mouse numa barra
  const ray = new THREE.Raycaster(), tip = $('anTip');
  let hoverPending = null;
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (!hoverPending) requestAnimationFrame(() => { hover(hoverPending); hoverPending = null; });
    hoverPending = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
  function hover(m) {
    if (!m || !bars || api.frame().mode !== 'local' || !$('selChip').hidden) { tip.hidden = true; return; }   // com o chip de seleção aberto, a dica sairia por cima dele
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((m.x - r.left) / r.width) * 2 - 1, -((m.y - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObject(bars)[0];
    if (!hit) { tip.hidden = true; return; }
    const p = bars.userData.list[hit.instanceId];
    tip.innerHTML = `<b>${Math.abs(p.lat).toFixed(3)}°${p.lat < 0 ? 'S' : 'N'} ${Math.abs(p.lon).toFixed(3)}°${p.lon < 0 ? 'O' : 'L'}</b>
      <span class="sun">Sol ${fmtPct(p.sunPct)} · maior escuridão ${fmtH(p.maxDarkH)}</span>
      <span class="earth">Terra ${fmtPct(p.commPct)} · maior apagão ${fmtH(p.maxBlackoutH)}</span>
      <span class="score">Viability Score ${fmtPct((p.sunPct + p.commPct) / 2)}</span>
      <span class="dim">inclinação ${p.slope.toFixed(1)}° · ${Math.round(p.dist)} m do centro</span>`;
    tip.style.transform = `translate(${m.x + 16}px, ${m.y + 46}px)`; tip.hidden = false;
  }

  // primeiro cálculo com os parâmetros atuais (o formulário já existe quando este módulo inicia)
  if (window.lunite && window.lunite.mission) schedule(window.lunite.mission);

  // ---------------------------------------------------------------- API para os cards e a tabela (js/inspect.js)
  const detailReq = new Map(); let reqN = 0;
  const ndc = new THREE.Vector2();
  return {
    // ponto (sítio) da barra sob o cursor, só entre os que passam nos filtros
    pickBar(x, y) {
      if (!bars || !bars.count || api.frame().mode !== 'local') return null;
      const r = canvas.getBoundingClientRect(); ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera); const hit = ray.intersectObject(bars)[0];
      return hit ? bars.userData.list[hit.instanceId] : null;
    },
    // posição na tela do topo da barra de um sítio
    screenPos(c) {
      const p = job && job.pts[c]; if (!p) return null;
      if (!p.xyz) p.xyz = toFrame(p.lat, p.lon, p.h);
      const v = new THREE.Vector3(p.xyz[0], p.xyz[1], p.xyz[2] + Math.max(job.P.radiusKm * 1000 * 0.06, job.spacing * 3)).project(camera), r = canvas.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, on: v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05 };
    },
    setMarks(m) { marks = { ...m }; drawMarks(); },
    point: (c) => (job ? job.pts[c] : null),
    // série detalhada (Sol/Terra × horizonte) de um sítio na janela fixada
    detail(c) {
      return new Promise((resolve, reject) => {
        if (!job || job.phase !== 'fixed') { reject(new Error('sem janela fixada')); return; }
        const req = ++reqN; detailReq.set(req, (m) => (m.error ? reject(new Error(m.error)) : resolve(m)));
        workers[c % NW].postMessage({ type: 'detail', id: job.id, req, c, o: job.best });
      });
    },
    info: () => (job && job.phase === 'fixed' ? { t0: job.t0 + job.best * 86400e3, days: job.days, stepH: job.stepH, P: job.P, filt: { ...filt } } : null),
  };
}
