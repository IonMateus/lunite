// inspect.js: etapa 4 do fluxo — depois da filtragem, selecionar sítios, fixar um e comparar.
//
//  - Clique numa barra seleciona o sítio (caixa branca) e abre um chip com "Fixar" e "Comparar".
//  - Fixar: card com os dados do sítio e os gráficos do Sol e da Terra contra o horizonte, em datas terrestres.
//  - Comparar com um sítio fixado: segundo card ao lado, com a diferença de cada número em relação ao fixado.
//  - Comparar sem sítio fixado: janelinha com uma tabela (ordenável) de todos os sítios enviados para comparação.
//    As duas comparações não coexistem: com a tabela aberta não dá para fixar; com um sítio fixado, comparar vai para o card.
//
//   initInspect(api)  api = { an (API do analysis.js), canvas, setTime(ms), time() -> ms, mode() -> 'globe' | 'local' }
const $ = (id) => document.getElementById(id);
const fmtPct = (v) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
const fmtNum = (v, d = 1) => v.toLocaleString('pt-BR', { maximumFractionDigits: d });
function fmtDur(h) {   // 3d14h · 12h · 45min
  if (!isFinite(h)) return '–';
  const a = Math.abs(h), s = h < 0 ? '−' : '';
  if (a < 1) return s + Math.round(a * 60) + 'min';
  if (a < 48) return s + Math.round(a) + 'h';
  const d = Math.floor(a / 24), r = Math.round(a - d * 24);
  return s + d + 'd' + (r ? String(r).padStart(2, '0') + 'h' : '');
}
const fmtLL = (p) => `${Math.abs(p.lat).toFixed(3)}°${p.lat < 0 ? 'S' : 'N'} ${Math.abs(p.lon).toFixed(3)}°${p.lon < 0 ? 'O' : 'L'}`;
const fmtWhen = (ms) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const score = (p) => (p.sunPct + p.commPct) / 2;

export function initInspect(api) {
  const { an, canvas } = api;
  let sel = null, fixed = null, cmp = null, table = [], sortKey = 'score', sortDir = -1, info = null;

  // ---------------------------------------------------------------- seleção no terreno
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || api.mode() !== 'local' || !an.info()) return;
    const p = an.pickBar(e.clientX, e.clientY);
    select(p ? p.c : null);
  });
  function select(c) { sel = c; marks(); chip(); }
  function marks() { an.setMarks({ sel, fixed: fixed && fixed.c, cmp: cmp && cmp.c }); }

  // chip com as ações, preso ao topo da barra selecionada
  const chipEl = $('selChip');
  function chip() {
    if (sel == null) { chipEl.hidden = true; return; }
    const p = an.point(sel); if (!p) { chipEl.hidden = true; return; }
    $('scInfo').innerHTML = `${fmtLL(p)}<br>Score <b>${fmtPct(score(p))}</b> · Sol ${fmtPct(p.sunPct)} · Terra ${fmtPct(p.commPct)}`;
    const tableOpen = !$('cmpWin').hidden;
    $('scFix').disabled = tableOpen || (fixed && fixed.c === sel);
    $('scCmp').disabled = (fixed && fixed.c === sel) || (cmp && cmp.c === sel) || (!fixed && table.includes(sel));
    $('scWhy').textContent = tableOpen ? 'Feche a tabela de comparação para fixar um sítio.' : fixed && fixed.c === sel ? 'Este é o sítio fixado.' : fixed ? 'Comparar abre o card ao lado do fixado.' : 'Sem sítio fixado, comparar adiciona o sítio à tabela.';
    chipEl.hidden = false; placeChip();
  }
  function placeChip() {
    if (chipEl.hidden || sel == null) return;
    const s = an.screenPos(sel);
    if (!s || !s.on) { chipEl.style.visibility = 'hidden'; return; }
    chipEl.style.visibility = ''; chipEl.style.transform = `translate(${Math.round(s.x + 12)}px, ${Math.round(s.y - 20)}px)`;
  }
  $('scX').onclick = () => select(null);
  $('scFix').onclick = () => { if (sel != null) doFix(sel); };
  $('scCmp').onclick = () => { if (sel != null) doCompare(sel); };

  // ---------------------------------------------------------------- fixar / comparar
  async function doFix(c) {
    if (!$('cmpWin').hidden) return;
    if (cmp && cmp.c === c) cmp = null;
    fixed = { c, p: an.point(c), d: null }; sel = null;   // a ação concluída fecha o chip; a caixa ciano marca o fixado
    marks(); chip(); render();
    fixed.d = await load(c); render();
  }
  async function doCompare(c) {
    if (fixed) {
      if (fixed.c === c) return;
      cmp = { c, p: an.point(c), d: null }; sel = null;
      marks(); chip(); render();
      cmp.d = await load(c); render();
    } else {
      if (!table.includes(c)) table.push(c);
      sel = null; marks(); openTable(); chip();
    }
  }
  async function load(c) {
    try { info = an.info(); return metricsOf(an.point(c), await an.detail(c)); }
    catch (e) { console.warn(e); return null; }
  }

  // números de um sítio a partir da série do worker (janela fixada, passo stepH)
  function metricsOf(p, m) {
    const N = m.sunEl.length, h = m.stepH, t0 = info.t0;
    const sv = new Uint8Array(N), cv = new Uint8Array(N);
    let sumEl = 0, nEl = 0, maxEl = -90, sumClear = 0;
    for (let i = 0; i < N; i++) {
      sv[i] = m.sunEl[i] > m.sunHz[i] ? 1 : 0; cv[i] = m.ok[i] && m.earthEl[i] > m.earthHz[i] ? 1 : 0;
      if (sv[i]) { sumEl += m.sunEl[i]; nEl++; sumClear += m.sunEl[i] - m.sunHz[i]; if (m.sunEl[i] > maxEl) maxEl = m.sunEl[i]; }
    }
    const runs = (v) => { const out = []; let a = -1; for (let i = 0; i <= N; i++) { const on = i < N && v[i]; if (on && a < 0) a = i; if (!on && a >= 0) { out.push([a, i]); a = -1; } } return out; };
    const next = (v) => { if (!v[0]) { const i = v.indexOf(1); return { up: false, h: i < 0 ? Infinity : i * h }; } const i = v.indexOf(0); return { up: true, h: i < 0 ? Infinity : i * h }; };
    const sRuns = runs(sv), cRuns = runs(cv);
    return {
      N, h, t0, series: m, sv, cv, sRuns, cRuns,
      sunH: sRuns.reduce((a, r) => a + (r[1] - r[0]), 0) * h, comH: cRuns.reduce((a, r) => a + (r[1] - r[0]), 0) * h,
      nextSun: next(sv), nextEarth: next(cv),
      meanEl: nEl ? sumEl / nEl : NaN, maxEl: nEl ? maxEl : NaN, meanClear: nEl ? sumClear / nEl : NaN,
    };
  }

  // linhas do card: [rótulo, valor(p, d), melhor ('hi' maior é melhor, 'lo' menor é melhor), formato da diferença]
  const durD = (v) => (v > 0 ? '+' : '') + fmtDur(v);
  const ROWS = {
    sun: [
      ['Contato com o Sol', (p) => p.sunPct, 'hi', (v) => fmtPct(v), (v) => (v > 0 ? '+' : '') + fmtNum(v) + ' p.p.'],
      ['Horas de Sol na janela', (p, d) => d && d.sunH, 'hi', fmtDur, durD],
      ['Maior escuridão contínua', (p) => p.maxDarkH, 'lo', fmtDur, durD],
      ['Períodos com Sol', (p, d) => d && d.sRuns.length, null, (v) => String(v), (v) => (v > 0 ? '+' : '') + v],
      ['Próximo pôr do Sol', (p, d) => d && (d.nextSun.up ? d.nextSun.h : null), 'hi', fmtDur, durD, (p, d) => !d ? null : !d.nextSun.up ? (isFinite(d.nextSun.h) ? `abaixo do horizonte · nasce em ${fmtDur(d.nextSun.h)}` : 'não nasce nesta janela') : !isFinite(d.nextSun.h) ? 'não se põe nesta janela' : null],
      ['Elevação média do Sol (quando visível)', (p, d) => d && d.meanEl, 'hi', (v) => fmtNum(v, 2) + '°', (v) => (v > 0 ? '+' : '') + fmtNum(v, 2) + '°'],
      ['Folga média sobre o relevo', (p, d) => d && d.meanClear, 'hi', (v) => fmtNum(v, 2) + '°', (v) => (v > 0 ? '+' : '') + fmtNum(v, 2) + '°'],
    ],
    earth: [
      ['Comunicação com a Terra', (p) => p.commPct, 'hi', (v) => fmtPct(v), (v) => (v > 0 ? '+' : '') + fmtNum(v) + ' p.p.'],
      ['Horas de comunicação na janela', (p, d) => d && d.comH, 'hi', fmtDur, durD],
      ['Maior apagão contínuo', (p) => p.maxBlackoutH, 'lo', fmtDur, durD],
      ['Janelas de comunicação', (p, d) => d && d.cRuns.length, null, (v) => String(v), (v) => (v > 0 ? '+' : '') + v],
      ['Próximo pôr da Terra', (p, d) => d && (d.nextEarth.up ? d.nextEarth.h : null), 'hi', fmtDur, durD, (p, d) => !d ? null : !d.nextEarth.up ? (isFinite(d.nextEarth.h) ? `sem contato · volta em ${fmtDur(d.nextEarth.h)}` : 'sem contato nesta janela') : !isFinite(d.nextEarth.h) ? 'não se põe nesta janela' : null],
    ],
    ter: [
      ['Inclinação do relevo', (p) => p.slope, 'lo', (v) => fmtNum(v) + '°', (v) => (v > 0 ? '+' : '') + fmtNum(v) + '°'],
      ['Altitude (LOLA)', (p) => p.h, null, (v) => fmtNum(v, 0) + ' m', (v) => (v > 0 ? '+' : '') + fmtNum(v, 0) + ' m'],
      ['Distância do centro da área', (p) => p.dist, null, (v) => fmtNum(v / 1000, 2) + ' km', (v) => (v > 0 ? '+' : '') + fmtNum(v / 1000, 2) + ' km'],
    ],
  };

  function cardHTML(kind, X, ref) {
    const p = X.p, d = X.d, isCmp = kind === 'cmp';
    const delta = (v, rv, better, fmt) => {
      if (!isCmp || v == null || rv == null || !isFinite(v) || !isFinite(rv)) return '';
      const dv = v - rv; if (Math.abs(dv) < 1e-9) return '<i class="d-eq">(=)</i>';
      // verde = melhor que o fixado, vermelho = pior (para escuridão, apagão e inclinação, menos é melhor)
      const good = better === 'lo' ? dv < 0 : better === 'hi' ? dv > 0 : null;
      return `<i class="${good === null ? 'd-eq' : good ? 'd-good' : 'd-bad'}">(${fmt(dv)})</i>`;
    };
    const rows = (key) => ROWS[key].map(([label, get, better, fmt, dfmt, alt]) => {
      const v = get(p, d), rv = ref ? get(ref.p, ref.d) : null, a = alt && alt(p, d);
      const val = a || (v == null || (typeof v === 'number' && !isFinite(v)) ? (d || get.length < 2 ? '–' : '…') : fmt(v));
      return `<div class="c-row"><span>${label}</span><span>${val}${a ? '' : delta(v, rv, better, dfmt)}</span></div>`;
    }).join('');
    const sc = score(p), rsc = ref ? score(ref.p) : null;
    return `<header><span class="lbl">${isCmp ? 'Sítio comparado' : 'Sítio fixado · referência'}</span><button type="button" class="sc-x" data-close="${kind}" aria-label="Fechar">×</button></header>
      <div class="c-coord">${fmtLL(p)}</div>
      <div class="c-score">Viability Score <b>${fmtPct(sc)}</b>${delta(sc, rsc, 'hi', (v) => (v > 0 ? '+' : '') + fmtNum(v) + ' p.p.')}</div>
      <div class="c-sec sun">Sol e energia</div>${rows('sun')}
      <canvas class="c-chart" data-chart="sun" aria-label="Elevação do Sol e do horizonte ao longo da janela"></canvas>
      <div class="c-legend"><span><i style="background:#ffc84a"></i>Sol visível</span><span><i style="background:rgba(255,200,74,.35)"></i>Sol atrás do relevo</span><span><i style="background:#5b6472"></i>horizonte do relevo</span></div>
      ${d ? `<div class="c-ivals">${ivals(d.sRuns, d)}</div>` : ''}
      <div class="c-sec earth">Terra e comunicação</div>${rows('earth')}
      <canvas class="c-chart" data-chart="earth" aria-label="Elevação da Terra e do horizonte ao longo da janela"></canvas>
      <div class="c-legend"><span><i style="background:#7fb6ff"></i>comunicação</span><span><i style="background:rgba(127,182,255,.35)"></i>sem contato</span><span><i style="background:#5b6472"></i>horizonte do relevo</span></div>
      ${d ? `<div class="c-ivals">${ivals(d.cRuns, d)}</div>` : ''}
      <div class="c-sec ter">Terreno</div>${rows('ter')}
      ${d ? '' : '<div class="c-loading">Calculando a série do Sol e da Terra…</div>'}
      <div class="dim" style="margin-top:6px;font-size:10.5px">Clique num gráfico para levar o relógio àquele instante.</div>`;
  }
  function ivals(runs, d) {   // primeiros períodos, em datas terrestres (UTC)
    if (!runs.length) return 'nenhum período na janela';
    const show = runs.slice(0, 3).map(([a, b]) => `${fmtWhen(d.t0 + a * d.h * 3600e3)} → ${fmtWhen(d.t0 + b * d.h * 3600e3)} (${fmtDur((b - a) * d.h)})`);
    return show.join('<br>') + (runs.length > 3 ? `<br>+ ${runs.length - 3} períodos` : '');
  }

  function render() {
    for (const [kind, X, ref] of [['fixed', fixed, null], ['cmp', cmp, fixed]]) {
      const el = $(kind === 'fixed' ? 'cardFixed' : 'cardCmp');
      if (!X) { el.hidden = true; el.innerHTML = ''; continue; }
      el.innerHTML = cardHTML(kind, X, ref); el.hidden = false;
      el.querySelector('[data-close]').onclick = () => close(kind);
      el.querySelectorAll('canvas[data-chart]').forEach((cv) => { cv.onclick = (e) => chartClick(cv, X, e); });
    }
    charts();
  }
  function close(kind) {
    if (kind === 'fixed') { fixed = null; cmp = null; } else cmp = null;   // sem o fixado, a comparação perde a referência
    render(); marks(); chip();
  }

  // ---------------------------------------------------------------- gráficos (elevação × tempo, com o horizonte do relevo)
  let lastT = -1;
  function charts() {
    for (const [X, id] of [[fixed, 'cardFixed'], [cmp, 'cardCmp']]) {
      if (!X || !X.d) continue;
      $(id).querySelectorAll('canvas[data-chart]').forEach((cv) => drawChart(cv, X.d, cv.dataset.chart));
    }
  }
  function drawChart(cv, d, body) {
    const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
    cv.width = W * dpr; cv.height = H * dpr; const x = cv.getContext('2d'); x.scale(dpr, dpr);
    const el = body === 'sun' ? d.series.sunEl : d.series.earthEl, hz = body === 'sun' ? d.series.sunHz : d.series.earthHz, vis = body === 'sun' ? d.sv : d.cv;
    const col = body === 'sun' ? '255,200,74' : '127,182,255', N = d.N, L = 30, R = 6, T = 6, B = 16;
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < N; i++) { lo = Math.min(lo, el[i], hz[i]); hi = Math.max(hi, el[i], hz[i]); }
    const pad = Math.max(0.3, (hi - lo) * 0.08); lo -= pad; hi += pad;
    const X = (i) => L + (W - L - R) * i / (N - 1), Y = (v) => T + (H - T - B) * (hi - v) / (hi - lo);
    // dias (00:00 UTC) no eixo x
    x.font = '9px ui-monospace, monospace'; x.fillStyle = '#8b95a3'; x.strokeStyle = 'rgba(255,255,255,.07)'; x.lineWidth = 1;
    const days = Math.round(N * d.h / 24), every = Math.max(1, Math.ceil(days / 6));
    for (let k = 0; k <= days; k++) {
      const i = (k * 24) / d.h; if (i > N - 1) break; const xx = X(i);
      x.beginPath(); x.moveTo(xx, T); x.lineTo(xx, H - B); x.stroke();
      if (k % every === 0) { const t = new Date(d.t0 + k * 86400e3); x.fillText(`${String(t.getUTCDate()).padStart(2, '0')}/${String(t.getUTCMonth() + 1).padStart(2, '0')}`, xx + 2, H - 4); }
    }
    // eixo y: graus
    for (const v of [hi - pad, lo + pad, 0]) { if (v < lo || v > hi) continue; x.fillText(fmtNum(v, 1) + '°', 2, Y(v) + 3); x.beginPath(); x.strokeStyle = v === 0 ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.07)'; x.moveTo(L, Y(v)); x.lineTo(W - R, Y(v)); x.stroke(); }
    // relevo (horizonte no azimute do astro): área cinza
    x.beginPath(); x.moveTo(X(0), H - B); for (let i = 0; i < N; i++) x.lineTo(X(i), Y(hz[i])); x.lineTo(X(N - 1), H - B); x.closePath();
    x.fillStyle = 'rgba(91,100,114,.55)'; x.fill();
    // astro: forte quando visível, apagado quando atrás do relevo
    x.lineWidth = 2;
    for (let i = 1; i < N; i++) { x.strokeStyle = vis[i] && vis[i - 1] ? `rgb(${col})` : `rgba(${col},.35)`; x.beginPath(); x.moveTo(X(i - 1), Y(el[i - 1])); x.lineTo(X(i), Y(el[i])); x.stroke(); }
    // instante do visualizador
    const t = api.time(), fi = (t - d.t0) / (d.h * 3600e3);
    if (fi >= 0 && fi <= N - 1) { x.strokeStyle = 'rgba(255,255,255,.8)'; x.lineWidth = 1; x.setLineDash([3, 3]); x.beginPath(); x.moveTo(X(fi), T); x.lineTo(X(fi), H - B); x.stroke(); x.setLineDash([]); }
    cv._map = { L, R, N, d };
  }
  function chartClick(cv, X, e) {
    const m = cv._map; if (!m) return;
    const r = cv.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left - m.L) / (r.width - m.L - m.R)));
    api.setTime(m.d.t0 + f * (m.N - 1) * m.d.h * 3600e3);
  }

  // ---------------------------------------------------------------- tabela (comparação sem sítio fixado)
  const COLS = [
    ['site', 'Sítio', (p) => fmtLL(p), null, null],
    ['score', 'Viability Score', (p) => score(p), 'hi', fmtPct],
    ['sun', 'Sol', (p) => p.sunPct, 'hi', fmtPct],
    ['dark', 'Maior escuridão', (p) => p.maxDarkH, 'lo', fmtDur],
    ['comm', 'Terra', (p) => p.commPct, 'hi', fmtPct],
    ['black', 'Maior apagão', (p) => p.maxBlackoutH, 'lo', fmtDur],
    ['slope', 'Inclinação', (p) => p.slope, 'lo', (v) => fmtNum(v) + '°'],
    ['alt', 'Altitude', (p) => p.h, null, (v) => fmtNum(v, 0) + ' m'],
    ['dist', 'Distância do centro', (p) => p.dist, null, (v) => fmtNum(v / 1000, 2) + ' km'],
  ];
  function openTable() { $('cmpWin').hidden = false; drawTable(); }
  function drawTable() {
    const rows = table.map((c) => an.point(c)).filter(Boolean);
    const col = COLS.find((c) => c[0] === sortKey) || COLS[1];
    if (col[0] !== 'site') rows.sort((a, b) => (col[2](a) - col[2](b)) * sortDir);
    const best = {};   // melhor valor de cada coluna (em verde)
    for (const [k, , get, better] of COLS) if (better && rows.length > 1) { const vs = rows.map(get); best[k] = better === 'hi' ? Math.max(...vs) : Math.min(...vs); }
    $('cmpTitle').textContent = `Comparação de sítios (${rows.length})`;
    $('cmpTable').innerHTML = `<thead><tr>${COLS.map(([k, label]) => `<th data-k="${k}"${k === sortKey ? ` aria-sort="${sortDir > 0 ? 'ascending' : 'descending'}"` : ''}>${label}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map((p) => `<tr data-c="${p.c}"${p.c === sel ? ' class="sel"' : ''}>${COLS.map(([k, , get, , fmt]) => { const v = get(p); return `<td${best[k] != null && v === best[k] ? ' class="best"' : ''}>${fmt ? fmt(v) : v}</td>`; }).join('')}<td><button type="button" class="sc-x" data-rm="${p.c}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody>`;
    $('cmpTable').querySelectorAll('th[data-k]').forEach((th) => th.onclick = () => { const k = th.dataset.k; if (k === 'site') return; if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = COLS.find((c) => c[0] === k)[3] === 'lo' ? 1 : -1; } drawTable(); });
    $('cmpTable').querySelectorAll('tbody tr').forEach((tr) => tr.onclick = (e) => { if (e.target.dataset.rm) return; select(+tr.dataset.c); drawTable(); });
    $('cmpTable').querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { table = table.filter((c) => c !== +b.dataset.rm); drawTable(); chip(); });
  }
  $('cmpClose').onclick = () => { $('cmpWin').hidden = true; chip(); };
  $('cmpWin').addEventListener('click', (e) => { if (e.target.id === 'cmpWin') { $('cmpWin').hidden = true; chip(); } });

  // ---------------------------------------------------------------- ciclo: chip preso à barra, cursor do tempo nos gráficos
  function tick() {
    placeChip();
    const t = api.time(); if (t !== lastT) { lastT = t; charts(); }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  addEventListener('lunite:analysis-reset', () => { sel = null; fixed = null; cmp = null; table = []; $('cmpWin').hidden = true; render(); chip(); });
  addEventListener('lunite:filter-change', () => { const p = sel != null && an.point(sel); if (p && !(p.flags === 7 && p.sunPct >= an.info().filt.sun && p.commPct >= an.info().filt.comm)) select(null); else chip(); });
  addEventListener('lunite:mode', () => { if (api.mode() !== 'local') chipEl.hidden = true; else chip(); });

  window.lunite = window.lunite || {};
  Object.defineProperty(window.lunite, 'inspect', { get: () => ({ sel, fixed: fixed && { c: fixed.c, ready: !!fixed.d }, cmp: cmp && { c: cmp.c, ready: !!cmp.d }, table: [...table] }), configurable: true });
}
