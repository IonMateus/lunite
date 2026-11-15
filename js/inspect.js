// inspect.js: etapa 4 do fluxo — depois da filtragem, selecionar sítios, fixar um e comparar.
//
//  - Clique numa barra seleciona o sítio (caixa branca) e abre um chip com "Fixar" e "Comparar".
//  - Fixar: card com os dados do sítio e os gráficos do Sol e da Terra contra o horizonte, em datas terrestres.
//  - Comparar com um sítio fixado: segundo card ao lado, com a diferença de cada número em relação ao fixado.
//  - Comparar sem sítio fixado: janelinha com uma tabela (ordenável) de todos os sítios enviados para comparação.
//    As duas comparações não coexistem: com a tabela aberta não dá para fixar; com um sítio fixado, comparar vai para o card.
//
//  - Cards e tabela são janelas móveis (arraste pelo título). "Destacar" abre o card numa janela própria do navegador,
//    que pode ir para outro monitor.
//  - Relatório (etapa final): Alt+clique numa barra, "+ Relatório" no chip/card, ou arrastar um card ou uma linha da tabela
//    até a bandeja "Relatório"; "Gerar relatório em PDF" monta Inputs, Métricas (com legendas) e uma seção por sítio.
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
  let sel = null, fixed = null, cmp = null, table = [], sortKey = 'score', sortDir = -1, info = null, report = [];

  // ---------------------------------------------------------------- seleção no terreno
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || api.mode() !== 'local' || !an.info()) return;
    const p = an.pickBar(e.clientX, e.clientY);
    if (e.altKey) { if (p) toggleReport(p.c); return; }   // Alt+clique: entra/sai do relatório sem mexer na seleção
    select(p ? p.c : null);
  });
  function select(c) { sel = c; marks(); chip(); }
  function marks() { an.setMarks({ sel, fixed: fixed && fixed.c, cmp: cmp && cmp.c, report }); }

  // chip com as ações, preso ao topo da barra selecionada
  const chipEl = $('selChip');
  function chip() {
    if (sel == null) { chipEl.hidden = true; return; }
    const p = an.point(sel); if (!p) { chipEl.hidden = true; return; }
    $('scInfo').innerHTML = `${fmtLL(p)}<br>Score <b>${fmtPct(score(p))}</b> · Sol ${fmtPct(p.sunPct)} · Terra ${fmtPct(p.commPct)}`;
    const tableOpen = !$('cmpWin').hidden;
    $('scFix').disabled = tableOpen || (fixed && fixed.c === sel);
    $('scCmp').disabled = (fixed && fixed.c === sel) || (cmp && cmp.c === sel) || (!fixed && table.includes(sel));
    $('scRep').textContent = report.includes(sel) ? '− Relatório' : '+ Relatório';
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
  $('scRep').onclick = () => { if (sel != null) toggleReport(sel); };

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
    const inRep = report.includes(X.c), pop = X.win && !X.win.closed;
    return `<header class="drag"><span class="lbl">${isCmp ? 'Sítio comparado' : 'Sítio fixado · referência'}</span>
        <span class="c-tools">${pop ? '' : `<button type="button" class="b" data-pop="${kind}" title="Abrir numa janela separada (pode ir para outro monitor)">Destacar</button>`}
        <button type="button" class="b" data-rep="${X.c}">${inRep ? '− Relatório' : '+ Relatório'}</button></span>
        <button type="button" class="sc-x" data-close="${kind}" aria-label="Fechar">×</button></header>
      ${pop ? '' : `<span class="c-grip" draggable="true" data-drag="${X.c}" title="Arraste até a bandeja Relatório">⠿ arrastar para o relatório</span>`}
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
      const popped = X.win && !X.win.closed;
      const host = popped ? X.win.document.getElementById('card') : el;
      host.innerHTML = cardHTML(kind, X, ref);
      el.hidden = popped; if (popped) el.innerHTML = '';
      host.querySelector('[data-close]').onclick = () => close(kind);
      host.querySelector('[data-rep]').onclick = () => toggleReport(X.c);
      const pb = host.querySelector('[data-pop]'); if (pb) pb.onclick = () => popOut(kind);
      const g = host.querySelector('[data-drag]'); if (g) g.ondragstart = (e) => dragSite(e, X.c);
      host.querySelectorAll('canvas[data-chart]').forEach((cv) => { cv.onclick = (e) => chartClick(cv, X, e); });
    }
    charts();
  }
  // "Destacar": o card vai para uma janela própria do navegador (pode ser levada a outro monitor) e volta ao fechá-la
  function popOut(kind) {
    const X = kind === 'fixed' ? fixed : cmp; if (!X) return;
    const w = window.open('', 'lunite-' + kind, 'popup=yes,width=400,height=860');
    if (!w) { alert('O navegador bloqueou a janela. Permita pop-ups para este site e tente de novo.'); return; }
    const css = [...document.querySelectorAll('style')].map((st) => st.textContent).join('\n');
    w.document.open();
    w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Lunite · ${kind === 'fixed' ? 'Sítio fixado' : 'Sítio comparado'}</title>
      <style>${css}
      html,body{overflow:auto;height:auto;background:#05070a} body{padding:10px}
      .site-card{position:static !important;width:auto !important;max-height:none !important;transform:none !important}
      header.drag{cursor:default}</style></head><body><aside id="card" class="panel site-card ${kind}"></aside></body></html>`);
    w.document.close();
    X.win = w; w.addEventListener('beforeunload', () => setTimeout(() => { X.win = null; render(); }, 0));
    render();
  }
  function close(kind) {
    for (const X of kind === 'fixed' ? [fixed, cmp] : [cmp]) if (X && X.win && !X.win.closed) { const w = X.win; X.win = null; w.close(); }
    if (kind === 'fixed') { fixed = null; cmp = null; } else cmp = null;   // sem o fixado, a comparação perde a referência
    render(); marks(); chip();
  }

  // ---------------------------------------------------------------- gráficos (elevação × tempo, com o horizonte do relevo)
  let lastT = -1;
  function charts() {
    for (const [X, id] of [[fixed, 'cardFixed'], [cmp, 'cardCmp']]) {
      if (!X || !X.d) continue;
      const host = X.win && !X.win.closed ? X.win.document : $(id);
      host.querySelectorAll('canvas[data-chart]').forEach((cv) => drawChart(cv, X.d, cv.dataset.chart));
    }
  }
  const DARK = { bg: null, grid: 'rgba(255,255,255,.07)', zero: 'rgba(255,255,255,.2)', text: '#8b95a3', terrain: 'rgba(91,100,114,.55)', sun: '255,200,74', earth: '127,182,255', cursor: 'rgba(255,255,255,.8)', faint: 0.35 };
  const LIGHT = { bg: '#ffffff', grid: 'rgba(0,0,0,.08)', zero: 'rgba(0,0,0,.3)', text: '#555c66', terrain: 'rgba(120,128,140,.45)', sun: '214,140,0', earth: '31,95,208', cursor: null, faint: 0.3 };
  function drawChart(cv, d, body, o = {}) {
    const th = o.theme || DARK, dpr = o.dpr || devicePixelRatio || 1, W = o.W || cv.clientWidth, H = o.H || cv.clientHeight; if (!W) return;
    cv.width = W * dpr; cv.height = H * dpr; const x = cv.getContext('2d'); x.scale(dpr, dpr);
    if (th.bg) { x.fillStyle = th.bg; x.fillRect(0, 0, W, H); }
    const el = body === 'sun' ? d.series.sunEl : d.series.earthEl, hz = body === 'sun' ? d.series.sunHz : d.series.earthHz, vis = body === 'sun' ? d.sv : d.cv;
    const col = body === 'sun' ? th.sun : th.earth, N = d.N, L = 30, R = 6, T = 6, B = 16;
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < N; i++) { lo = Math.min(lo, el[i], hz[i]); hi = Math.max(hi, el[i], hz[i]); }
    const pad = Math.max(0.3, (hi - lo) * 0.08); lo -= pad; hi += pad;
    const X = (i) => L + (W - L - R) * i / (N - 1), Y = (v) => T + (H - T - B) * (hi - v) / (hi - lo);
    // dias (00:00 UTC) no eixo x
    x.font = '9px ui-monospace, monospace'; x.fillStyle = th.text; x.strokeStyle = th.grid; x.lineWidth = 1;
    const days = Math.round(N * d.h / 24), every = Math.max(1, Math.ceil(days / 6));
    for (let k = 0; k <= days; k++) {
      const i = (k * 24) / d.h; if (i > N - 1) break; const xx = X(i);
      x.beginPath(); x.moveTo(xx, T); x.lineTo(xx, H - B); x.stroke();
      if (k % every === 0) { const t = new Date(d.t0 + k * 86400e3); x.fillText(`${String(t.getUTCDate()).padStart(2, '0')}/${String(t.getUTCMonth() + 1).padStart(2, '0')}`, xx + 2, H - 4); }
    }
    // eixo y: graus
    for (const v of [hi - pad, lo + pad, 0]) { if (v < lo || v > hi) continue; x.fillText(fmtNum(v, 1) + '°', 2, Y(v) + 3); x.beginPath(); x.strokeStyle = v === 0 ? th.zero : th.grid; x.moveTo(L, Y(v)); x.lineTo(W - R, Y(v)); x.stroke(); }
    // relevo (horizonte no azimute do astro): área cinza
    x.beginPath(); x.moveTo(X(0), H - B); for (let i = 0; i < N; i++) x.lineTo(X(i), Y(hz[i])); x.lineTo(X(N - 1), H - B); x.closePath();
    x.fillStyle = th.terrain; x.fill();
    // astro: forte quando visível, apagado quando atrás do relevo
    x.lineWidth = 2;
    for (let i = 1; i < N; i++) { x.strokeStyle = vis[i] && vis[i - 1] ? `rgb(${col})` : `rgba(${col},${th.faint})`; x.beginPath(); x.moveTo(X(i - 1), Y(el[i - 1])); x.lineTo(X(i), Y(el[i])); x.stroke(); }
    // instante do visualizador
    const t = api.time(), fi = (t - d.t0) / (d.h * 3600e3);
    if (th.cursor && fi >= 0 && fi <= N - 1) { x.strokeStyle = th.cursor; x.lineWidth = 1; x.setLineDash([3, 3]); x.beginPath(); x.moveTo(X(fi), T); x.lineTo(X(fi), H - B); x.stroke(); x.setLineDash([]); }
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
      <tbody>${rows.map((p) => `<tr data-c="${p.c}" draggable="true"${p.c === sel ? ' class="sel"' : ''}>${COLS.map(([k, , get, , fmt]) => { const v = get(p); return `<td${best[k] != null && v === best[k] ? ' class="best"' : ''}>${fmt ? fmt(v) : v}</td>`; }).join('')}<td><button type="button" class="sc-x" data-rm="${p.c}" aria-label="Remover">×</button></td></tr>`).join('')}</tbody>`;
    $('cmpTable').querySelectorAll('th[data-k]').forEach((th) => th.onclick = () => { const k = th.dataset.k; if (k === 'site') return; if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = COLS.find((c) => c[0] === k)[3] === 'lo' ? 1 : -1; } drawTable(); });
    $('cmpTable').querySelectorAll('tbody tr').forEach((tr) => tr.onclick = (e) => { if (e.target.dataset.rm) return; select(+tr.dataset.c); drawTable(); });
    $('cmpTable').querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { table = table.filter((c) => c !== +b.dataset.rm); drawTable(); chip(); });
    $('cmpTable').querySelectorAll('tbody tr').forEach((tr) => tr.ondragstart = (e) => dragSite(e, +tr.dataset.c));
  }
  $('cmpClose').onclick = () => { $('cmpWin').hidden = true; chip(); };

  // ---------------------------------------------------------------- janelas móveis (arrastar pelo título)
  function draggable(el) {
    el.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('header.drag'); if (!h || e.target.closest('button, [draggable="true"], input, select')) return;
      const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      el.style.left = r.left + 'px'; el.style.top = r.top + 'px'; el.style.right = 'auto'; el.classList.add('dragging');
      h.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const x = Math.max(-r.width + 80, Math.min(innerWidth - 80, ev.clientX - dx)), y = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy));
        el.style.left = x + 'px'; el.style.top = y + 'px';
      };
      const up = () => { el.classList.remove('dragging'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
      e.preventDefault();
    });
  }
  ['cardFixed', 'cardCmp', 'cmpWin'].forEach((id) => draggable($(id)));

  // ---------------------------------------------------------------- relatório: escolher sítios
  function toggleReport(c) {
    if (report.includes(c)) report = report.filter((x) => x !== c); else report.push(c);
    renderTray(); marks(); chip(); render();
  }
  function dragSite(e, c) { e.dataTransfer.setData('text/x-lunite-site', String(c)); e.dataTransfer.setData('text/plain', 'Sítio ' + c); e.dataTransfer.effectAllowed = 'copy'; }
  const tray = $('repTray');
  tray.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('text/x-lunite-site')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; tray.classList.add('over'); } });
  tray.addEventListener('dragleave', (e) => { if (!tray.contains(e.relatedTarget)) tray.classList.remove('over'); });
  tray.addEventListener('drop', (e) => { e.preventDefault(); tray.classList.remove('over'); const c = +e.dataTransfer.getData('text/x-lunite-site'); if (Number.isFinite(c) && !report.includes(c) && an.point(c)) toggleReport(c); });
  function renderTray() {
    tray.hidden = !an.info();
    $('repN').textContent = report.length ? `(${report.length} ${report.length === 1 ? 'sítio' : 'sítios'})` : '';
    $('repList').innerHTML = report.map((c, i) => { const p = an.point(c); return p ? `<div class="rep-item"><b>${i + 1}</b><span>${fmtLL(p)}</span><span>${fmtPct(score(p))}</span><button type="button" class="sc-x" data-unrep="${c}" aria-label="Tirar do relatório">×</button></div>` : ''; }).join('');
    $('repList').querySelectorAll('[data-unrep]').forEach((b) => b.onclick = () => toggleReport(+b.dataset.unrep));
    $('repGo').disabled = !report.length;
  }
  $('repGo').onclick = () => makeReport().catch((e) => { console.error(e); $('repStatus').innerHTML = `<b class="bad">Não foi possível gerar o PDF:</b> ${e.message}`; });

  // ---------------------------------------------------------------- relatório em PDF
  // jsPDF (MIT, vendor/) só é carregado na hora de gerar. Fontes padrão do PDF (Helvetica): acentos do português ok;
  // símbolos fora do Latin-1 (≥, →, −) são trocados por equivalentes.
  function loadJsPDF() {
    if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
    return new Promise((res, rej) => {
      const sc = document.createElement('script'); sc.src = new URL('../vendor/jspdf.umd.min.js', import.meta.url).href;
      sc.onload = () => res(window.jspdf.jsPDF); sc.onerror = () => rej(new Error('não foi possível carregar vendor/jspdf.umd.min.js')); document.head.appendChild(sc);
    });
  }
  const METRIC_DOCS = [
    ['Viability Score', 'Média aritmética entre a duração de contato com o Sol e a de comunicação com a Terra (%). Resume o sítio num número só.'],
    ['Contato com o Sol', 'Fração da janela fixada em que o centro do Sol está acima do horizonte real do relevo (LOLA), visto da altura do painel solar.'],
    ['Horas de Sol na janela', 'O mesmo contato com o Sol, em horas terrestres.'],
    ['Maior escuridão contínua', 'Maior período seguido sem Sol na janela. É o que a bateria e o controle térmico precisam aguentar.'],
    ['Períodos com Sol', 'Quantos intervalos contínuos de Sol existem na janela.'],
    ['Próximo pôr do Sol', 'Tempo, a partir do início da janela, até o Sol se esconder atrás do relevo (ou até nascer, se começa escondido).'],
    ['Elevação média do Sol', 'Elevação média do centro do Sol acima do plano horizontal, nos instantes em que está visível.'],
    ['Folga média sobre o relevo', 'Quanto o Sol fica, em média, acima do horizonte do relevo quando visível: a margem contra sombras de cristas e crateras.'],
    ['Comunicação com a Terra', 'Fração da janela com linha de visada direta para o centro da Terra, vista da altura da antena. Com estações em solo escolhidas, também exige a Lua a 10° ou mais sobre alguma delas.'],
    ['Horas de comunicação na janela', 'A mesma comunicação, em horas terrestres.'],
    ['Maior apagão contínuo', 'Maior período seguido sem comunicação direta com a Terra.'],
    ['Janelas de comunicação', 'Quantos intervalos contínuos de comunicação existem na janela.'],
    ['Próximo pôr da Terra', 'Tempo, a partir do início da janela, até a Terra sumir atrás do relevo (ou até voltar, se começa sem contato).'],
    ['Inclinação do relevo', 'Declividade do terreno no ponto, medida no relevo LOLA.'],
    ['Altitude', 'Altura do terreno em relação à esfera de referência da Lua (raio de 1.737,4 km), segundo o LOLA.'],
    ['Gráficos', 'Eixo horizontal: datas terrestres (UTC) ao longo da janela. Eixo vertical: elevação em graus. Área cinza: horizonte do relevo no azimute do astro. Linha forte: astro visível; linha clara: astro atrás do relevo.'],
  ];
  async function makeReport() {
    const st = $('repStatus'); st.textContent = 'Preparando o relatório…'; $('repGo').disabled = true;
    try {
      const JsPDF = await loadJsPDF();
      info = an.info(); if (!info) throw new Error('não há janela fixada');
      const P = info.P, Fl = info.filt, Wd = window.lunite.window || {};
      const sites = [];
      for (const [i, c] of report.entries()) { st.textContent = `Calculando a série do sítio ${i + 1} de ${report.length}…`; const p = an.point(c); sites.push({ c, p, d: metricsOf(p, await an.detail(c)) }); }
      st.textContent = 'Montando o PDF…';
      const T = (v) => String(v).replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/→/g, '->').replace(/−/g, '-').replace(/…/g, '...').replace(/×/g, 'x').replace(/[⠿▲▼]/g, '');
      const doc = new JsPDF({ unit: 'mm', format: 'a4' }), PW = 210, PH = 297, M = 16, CW = PW - 2 * M;
      let y = M;
      const need = (h) => { if (y + h > PH - M - 6) { doc.addPage(); y = M; } };
      const font = (size, style = 'normal', rgb = [20, 24, 30]) => { doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...rgb); };
      const h1 = (t) => { need(14); font(18, 'bold'); doc.text(T(t), M, y + 6); y += 11; };
      const h2 = (t, rgb = [20, 24, 30]) => { need(12); font(12.5, 'bold', rgb); doc.text(T(t), M, y + 5); doc.setDrawColor(200); doc.line(M, y + 7, PW - M, y + 7); y += 11; };
      const h3 = (t, rgb = [60, 66, 76]) => { need(8); font(9.5, 'bold', rgb); doc.text(T(t).toUpperCase(), M, y + 4); y += 6.5; };
      const para = (t, size = 9.5, rgb = [50, 56, 66], style = 'normal') => { font(size, style, rgb); const lines = doc.splitTextToSize(T(t), CW); for (const l of lines) { need(size * 0.45); doc.text(l, M, y + size * 0.35); y += size * 0.45; } y += 1.5; };
      const kv = (rows) => {   // tabela de duas colunas: rótulo | valor
        for (const [k, v] of rows) {
          font(9.5, 'normal', [70, 76, 86]); const lk = doc.splitTextToSize(T(k), CW * 0.55); font(9.5, 'bold', [20, 24, 30]); const lv = doc.splitTextToSize(T(v), CW * 0.43);
          const h = Math.max(lk.length, lv.length) * 4.4 + 1.6; need(h);
          font(9.5, 'normal', [70, 76, 86]); doc.text(lk, M, y + 3.6); font(9.5, 'bold', [20, 24, 30]); doc.text(lv, PW - M, y + 3.6, { align: 'right' });
          doc.setDrawColor(232); doc.line(M, y + h - 0.6, PW - M, y + h - 0.6); y += h;
        }
        y += 2;
      };
      const table = (head, rows, widths) => {
        const rowH = 6.2, draw = (cells, bold, fill) => {
          need(rowH); if (fill) { doc.setFillColor(...fill); doc.rect(M, y, CW, rowH, 'F'); }
          font(8.3, bold ? 'bold' : 'normal', bold ? [40, 46, 56] : [20, 24, 30]); let x = M;
          cells.forEach((cv, i) => { doc.text(T(cv), x + 1.4, y + 4.3, { maxWidth: widths[i] - 2 }); x += widths[i]; });
          y += rowH;
        };
        draw(head, true, [236, 239, 243]); rows.forEach((r, i) => draw(r, false, i % 2 ? [248, 249, 251] : null)); y += 3;
      };
      const chart = (d, body) => {
        const cv = document.createElement('canvas'), w = 560, h = 150;
        drawChart(cv, d, body, { W: w, H: h, dpr: 3, theme: LIGHT });
        const hh = CW * h / w; need(hh + 2); doc.addImage(cv.toDataURL('image/png'), 'PNG', M, y, CW, hh); y += hh + 2;
      };
      const ivalsTxt = (runs, d) => runs.length ? runs.slice(0, 24).map(([a, b]) => `${fmtWhen(d.t0 + a * d.h * 3600e3)} -> ${fmtWhen(d.t0 + b * d.h * 3600e3)} (${fmtDur((b - a) * d.h)})`).join('   ') + (runs.length > 24 ? `   + ${runs.length - 24} períodos` : '') : 'nenhum período na janela';
      const now = new Date(), d2 = (n) => String(n).padStart(2, '0');
      const fmtDateUTC = (iso) => { const t = new Date(iso); return `${d2(t.getUTCDate())}/${d2(t.getUTCMonth() + 1)}/${t.getUTCFullYear()}`; };
      const localName = P.site.mode === 'preset' ? P.site.name : 'Ponto personalizado';
      const station = (k) => (document.querySelector(`.mf-stations input[value="${k}"]`)?.nextElementSibling?.textContent || k);

      // ---- capa
      h1('Lunite · Relatório de sítios de pouso');
      para(`Gerado em ${d2(now.getDate())}/${d2(now.getMonth() + 1)}/${now.getFullYear()} às ${d2(now.getHours())}:${d2(now.getMinutes())} (horário local).`, 9.5, [90, 96, 106]);
      kv([
        ['Área analisada', `${localName} · ${fmtLL(P.site)}`], ['Raio da área de busca', `${fmtNum(P.radiusKm)} km`],
        ['Janela de tempo fixada (UTC)', `${fmtDateUTC(Wd.start)} - ${fmtDateUTC(Wd.end)}${Wd.offsetDays ? ` (${Wd.offsetDays} dias após o início pedido)` : ''}`],
        ['Sítios neste relatório', String(sites.length)],
        ['Dados', 'Relevo: NASA LOLA (PDS). Sol e Terra: JPL Horizons (DE441). Passo da simulação: ' + info.stepH + ' h.'],
      ]);

      // ---- inputs
      h2('INPUTS · parâmetros da missão');
      h3('Sonda'); kv([['Precisão de pouso', `${P.probe.precisionM} m`], ['Inclinação máxima do relevo', `${P.probe.slopeMaxDeg}°`], ['Altura da antena', `${fmtNum(P.probe.antennaM)} m`], ['Altura do painel', `${fmtNum(P.probe.panelM)} m`]]);
      h3('Local de pouso'); kv([['Local', `${localName} (${fmtLL(P.site)})`], ['Raio da área de busca', `${fmtNum(P.radiusKm)} km`]]);
      h3('Terra e comunicação'); kv([
        ['Comunicação com', P.earth.mode === 'stations' ? 'Centros de comunicação escolhidos' : 'Somente o centro da Terra (simplificado)'],
        ...(P.earth.mode === 'stations' ? [['Centros de comunicação', P.earth.stations.map(station).join('; ')]] : []),
        ['Maior apagão contínuo tolerado', `${P.earth.maxBlackoutH} h`], ['Duração mínima de comunicação direta', `${P.earth.minCommPct}%`]]);
      h3('Sol e energia'); kv([['Duração mínima de contato com o Sol', `${P.sun.minSunPct}%`], ['Maior escuridão contínua tolerada', `${P.sun.maxDarkH} h`]]);
      h3('Tempo e duração'); kv([['Data de início', fmtDateUTC(P.time.startDate + 'T00:00:00Z')], ['Duração da missão', `${P.time.days} dias`], ['Intervalo máximo de atraso', `${P.time.maxDelayDays} dias`]]);
      h3('Filtragem'); kv([['Duração mínima de contato com o Sol', `${Fl.sun}%`], ['Duração mínima de comunicação com a Terra', `${Fl.comm}%`]]);

      // ---- métricas
      h2('MÉTRICAS · o que cada número significa');
      for (const [k, v] of METRIC_DOCS) { need(10); font(9.5, 'bold'); doc.text(T(k), M, y + 3.5); y += 4.6; para(v, 9, [70, 76, 86]); }

      // ---- resumo
      h2('RESUMO DOS SÍTIOS');
      table(['#', 'Coordenadas', 'Score', 'Sol', 'Escuridão', 'Terra', 'Apagão', 'Incl.'],
        sites.map(({ p }, i) => [String(i + 1), fmtLL(p), fmtPct(score(p)), fmtPct(p.sunPct), fmtDur(p.maxDarkH), fmtPct(p.commPct), fmtDur(p.maxBlackoutH), fmtNum(p.slope) + '°']),
        [8, 52, 20, 20, 22, 20, 22, 14]);

      // ---- um sítio por página
      const rowsOf = (key, p, d) => ROWS[key].map(([label, get, , fmt, , alt]) => { const a = alt && alt(p, d), v = get(p, d); return [label, a || (v == null || (typeof v === 'number' && !isFinite(v)) ? '-' : fmt(v))]; });
      sites.forEach(({ p, d }, i) => {
        doc.addPage(); y = M;
        h2(`SÍTIO ${i + 1}`, [14, 122, 52]);
        para(`Coordenadas: ${fmtLL(p)}  ·  ${fmtNum(p.dist / 1000, 2)} km do centro da área`, 10.5, [20, 24, 30], 'bold');
        kv([['Viability Score', fmtPct(score(p))]]);
        h3('Sol e energia', [168, 110, 0]); kv(rowsOf('sun', p, d)); chart(d, 'sun'); para('Períodos com Sol (UTC): ' + ivalsTxt(d.sRuns, d), 8, [90, 96, 106]);
        h3('Terra e comunicação', [24, 80, 180]); kv(rowsOf('earth', p, d)); chart(d, 'earth'); para('Janelas de comunicação (UTC): ' + ivalsTxt(d.cRuns, d), 8, [90, 96, 106]);
        h3('Terreno'); kv(rowsOf('ter', p, d));
      });

      // ---- rodapé em todas as páginas
      const n = doc.getNumberOfPages();
      for (let k = 1; k <= n; k++) { doc.setPage(k); font(7.5, 'normal', [140, 146, 156]); doc.text(T(`Lunite · NASA Space Apps · ${localName} · página ${k} de ${n}`), PW / 2, PH - 8, { align: 'center' }); }
      const name = `lunite-relatorio-${now.getFullYear()}${d2(now.getMonth() + 1)}${d2(now.getDate())}-${d2(now.getHours())}${d2(now.getMinutes())}.pdf`;
      doc.save(name);
      st.innerHTML = `PDF gerado: <b>${name}</b> (${n} páginas).`;
    } finally { $('repGo').disabled = !report.length; }
  }

  // ---------------------------------------------------------------- ciclo: chip preso à barra, cursor do tempo nos gráficos
  function tick() {
    placeChip();
    for (const X of [fixed, cmp]) if (X && X.win && X.win.closed) { X.win = null; render(); }
    const t = api.time(); if (t !== lastT) { lastT = t; charts(); }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  addEventListener('lunite:analysis-reset', () => {
    for (const X of [fixed, cmp]) if (X && X.win && !X.win.closed) X.win.close();
    sel = null; fixed = null; cmp = null; table = []; report = []; $('cmpWin').hidden = true; render(); chip(); renderTray();
  });
  addEventListener('lunite:window-fixed', () => setTimeout(renderTray, 0));
  addEventListener('lunite:filter-change', () => { const p = sel != null && an.point(sel); if (p && !(p.flags === 7 && p.sunPct >= an.info().filt.sun && p.commPct >= an.info().filt.comm)) select(null); else chip(); });
  addEventListener('lunite:mode', () => { if (api.mode() !== 'local') chipEl.hidden = true; else chip(); });

  window.lunite = window.lunite || {};
  Object.defineProperty(window.lunite, 'inspect', { get: () => ({ sel, fixed: fixed && { c: fixed.c, ready: !!fixed.d, popped: !!(fixed.win && !fixed.win.closed) }, cmp: cmp && { c: cmp.c, ready: !!cmp.d }, table: [...table], report: [...report] }), configurable: true });
}
