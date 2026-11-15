// mission.js: painel "Parâmetros da missão" (lado esquerdo) e a mira de latitude/longitude sob o cursor.
// Só interface: guarda os parâmetros num objeto e avisa o resto do app por eventos. O cálculo vem depois.
//
//   initMission(api)  api = { sites, goSite(s), home(), mode() -> 'globe' | 'local', goTo(lat, lon), pick(clientX, clientY) -> {lat, lon} | null, setTime(ms), time() -> ms }
//   window.lunite.mission           -> cópia dos parâmetros atuais
//   evento 'lunite:mission-change'  (detail = parâmetros) a cada alteração
//
// Local: "Personalizado" é o padrão; com ele, um clique na Lua (no globo) marca o alvo. Escolher um sítio pré-definido
// leva a câmera até ele.
// Convenção de longitude: −180° a +180° (leste positivo), a mesma do sites.json.

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dec = (step) => (String(step).split('.')[1] || '').length;

// Centros de comunicação que podem ser escolhidos (antenas de espaço profundo)
const STATIONS = [
  { id: 'goldstone', name: 'Goldstone (EUA) · DSN', lat: 35.4267, lon: -116.8900 },
  { id: 'madrid', name: 'Madrid (Espanha) · DSN', lat: 40.4314, lon: -4.2481 },
  { id: 'canberra', name: 'Canberra (Austrália) · DSN', lat: -35.4014, lon: 148.9817 },
  { id: 'newnorcia', name: 'New Norcia (Austrália) · ESA', lat: -31.0482, lon: 116.1914 },
  { id: 'cebreros', name: 'Cebreros (Espanha) · ESA', lat: 40.4527, lon: -4.3676 },
  { id: 'malargue', name: 'Malargüe (Argentina) · ESA', lat: -35.7760, lon: -69.3982 },
];

function defaults(t) {
  return {
    probe: { precisionM: 100, slopeMaxDeg: 10, antennaM: 4, panelM: 2 },
    site: { mode: 'none', id: null, name: null, lat: null, lon: null }, radiusKm: 3,
    earth: { mode: 'center', stations: ['goldstone', 'madrid', 'canberra'], maxBlackoutH: 24, minCommPct: 50 },
    sun: { minSunPct: 70, maxDarkH: 72 },
    time: { startDate: new Date(t).toISOString().slice(0, 10), days: 14, maxDelayDays: 30 },
  };
}

// path: caminho no objeto de parâmetros
const SECTIONS = [
  { title: 'Sonda', rows: [
    { path: 'probe.precisionM', label: 'Precisão de pouso', unit: 'm', min: 10, max: 5000, step: 10, help: 'Raio da elipse de pouso: o erro esperado entre o ponto planejado e o real. No polo, 200 m podem separar sol de sombra.' },
    { path: 'probe.slopeMaxDeg', label: 'Inclinação máxima do relevo', unit: '°', min: 1, max: 30, step: 1, help: 'Declividade máxima aceita sob a sonda. Acima disso ela pode tombar, como aconteceu com a IM-1 e a IM-2.' },
    { path: 'probe.antennaM', label: 'Altura da antena', unit: 'm', min: 0.5, max: 50, step: 0.5, help: 'Altura da antena sobre o solo. Quanto mais alta, mais baixo fica o horizonte para enxergar a Terra.' },
    { path: 'probe.panelM', label: 'Altura do painel', unit: 'm', min: 0.5, max: 50, step: 0.5, help: 'Altura dos painéis solares. É o ponto de vista usado para decidir se o Sol está visível.' },
  ] },
  { title: 'Local de pouso', rows: [
    { path: 'site', type: 'site', label: 'Local', help: 'Escolha um sítio pré-definido para ir até ele, ou "Personalizado" e clique na Lua para marcar o local.' },
    { path: 'radiusKm', label: 'Raio da área de busca', unit: 'km', min: 0.5, max: 100, step: 0.5, help: 'Círculo em volta do local onde a ferramenta procura pontos de pouso.' },
  ] },
  { title: 'Terra e comunicação', cls: 'earth', rows: [
    { path: 'earth.mode', type: 'select', label: 'Comunicação com', options: [['center', 'Somente o centro da Terra (simplificado)'], ['stations', 'Escolher centros de comunicação']], help: 'Ver a Terra não basta: a estação em solo também precisa ver a Lua. "Centro da Terra" ignora isso. Com 3 estações a cobertura é quase contínua; com 1, cerca de 8–12 h por dia.' },
    { path: 'earth.stations', type: 'stations', show: (p) => p.earth.mode === 'stations' },
    { path: 'earth.maxBlackoutH', label: 'Maior apagão contínuo tolerado', unit: 'h', min: 0, max: 720, step: 1, help: 'Maior período seguido sem comunicação com a Terra que a missão aceita.' },
    { path: 'earth.minCommPct', label: 'Duração mínima de comunicação direta', unit: '%', min: 0, max: 100, step: 1, help: 'Fração mínima da missão com linha de visada direta para a Terra, vista da antena.' },
  ] },
  { title: 'Sol e energia', cls: 'sun', rows: [
    { path: 'sun.minSunPct', label: 'Duração mínima de contato com Sol', unit: '%', min: 0, max: 100, step: 1, help: 'Fração mínima da missão com o Sol visível dos painéis, acima do relevo real.' },
    { path: 'sun.maxDarkH', label: 'Maior escuridão contínua tolerada', unit: 'h', min: 0, max: 720, step: 1, help: 'Maior período seguido sem Sol que bateria e controle térmico aguentam.' },
  ] },
  { title: 'Tempo e duração', rows: [
    { path: 'time.startDate', type: 'date', label: 'Data de início', help: 'Dia do pouso (0h UTC). As efemérides cobrem 2020–2050 e 1969–1972 (Apollo).' },
    { path: 'time.days', label: 'Duração da missão', unit: 'dias', min: 1, max: 365, step: 1, help: 'Período, depois do pouso, em que Sol e Terra são avaliados. 1 dia lunar ≈ 29,5 dias terrestres.' },
    { path: 'time.maxDelayDays', label: 'Intervalo máximo de atraso', unit: 'dias', min: 0, max: 365, step: 1, help: 'Quanto o lançamento pode atrasar. A ferramenta arrasta a janela de tempo dentro desse intervalo.' },
  ] },
];

const get = (o, path) => path.split('.').reduce((a, k) => a[k], o);
function set(o, path, v) { const ks = path.split('.'), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }
const fmtLat = (a) => Math.abs(a).toFixed(3) + '°' + (a < 0 ? 'S' : 'N');
const fmtLon = (a) => Math.abs(a).toFixed(3) + '°' + (a < 0 ? 'O' : 'L');
const wrapLon = (l) => ((l + 540) % 360) - 180;

export function initMission(api) {
  let P = defaults(api.time());
  const body = $('mfBody'), rows = [];
  const picking = () => $('mf-site').value === 'custom' && api.mode() === 'globe';   // esperando o clique na Lua?
  const ret = $('reticle'); let pending = null;

  const emit = () => dispatchEvent(new CustomEvent('lunite:mission-change', { detail: structuredClone(P) }));
  window.lunite = window.lunite || {};
  Object.defineProperty(window.lunite, 'mission', { get: () => structuredClone(P), configurable: true });

  // ---------------------------------------------------------------- montagem
  function build() {
    body.innerHTML = '';
    for (const S of SECTIONS) {
      const h = document.createElement('h3'); h.className = 'mf-grp ' + (S.cls || ''); h.textContent = S.title; body.appendChild(h);
      for (const r of S.rows) { const el = r.type === 'stations' ? stationsRow(r) : fieldRow(r); body.appendChild(el); rows.push({ r, el }); }
    }
    const card = $('siteCard'); body.querySelector('[data-path="site"]').after(card);   // ficha do sítio logo abaixo do campo Local
    refresh();
  }

  function fieldRow(r) {
    const id = 'mf-' + r.path.replace(/\./g, '-'), v = get(P, r.path);
    const row = document.createElement('div'); row.className = 'mf-row'; row.dataset.path = r.path;
    let ctl;
    if (r.type === 'site') ctl = `<select id="${id}"><option value="custom" selected>Personalizado (clicar na Lua)</option><optgroup label="Sítios pré-definidos">${api.sites.map((s) => `<option value="${s.id}">${s.rank}. ${s.name}</option>`).join('')}</optgroup></select>`;
    else if (r.type === 'select') ctl = `<select id="${id}">${r.options.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    else if (r.type === 'date') ctl = `<input type="date" id="${id}" value="${v}" min="1969-07-01" max="2050-12-31">`;
    else ctl = `<div class="mf-num"><button type="button" tabindex="-1" data-d="-1" aria-label="Diminuir ${r.label}">−</button><input type="number" id="${id}" value="${v}" min="${r.min}" max="${r.max}" step="${r.step}" inputmode="decimal"><span class="mf-unit">${r.unit}</span><button type="button" tabindex="-1" data-d="1" aria-label="Aumentar ${r.label}">+</button></div>`;
    if (r.type === 'site' || r.type === 'select') row.classList.add('wide');
    row.innerHTML = `<div class="mf-name"><label for="${id}">${r.label}</label><button type="button" class="mf-q" aria-expanded="false" aria-label="O que é ${r.label}">?</button></div>${ctl}<div class="mf-help" hidden>${r.help}</div>`;
    const q = row.querySelector('.mf-q'), help = row.querySelector('.mf-help');
    q.onclick = () => { help.hidden = !help.hidden; q.setAttribute('aria-expanded', String(!help.hidden)); };
    const inp = row.querySelector('#' + CSS.escape(id));

    if (r.type === 'site') {
      row.insertAdjacentHTML('beforeend', '<div class="mf-sub" id="mfSiteSub"></div>');
      inp.onchange = () => {
        if (inp.value === 'custom') { clearSite(); api.home(); return; }   // volta ao globo para clicar no alvo
        const s = api.sites.find((x) => x.id === inp.value); if (s) api.goSite(s);   // goSite dispara 'lunite:site', que preenche P.site
      };
      return row;
    }
    const commit = (val) => {
      if (r.type === 'select') val = inp.value;
      else if (r.type === 'date') { if (!val) { inp.value = get(P, r.path); return; } api.setTime(Date.parse(val + 'T00:00:00Z')); }
      else { val = parseFloat(val); if (isNaN(val)) val = get(P, r.path); val = +clamp(val, r.min, r.max).toFixed(dec(r.step)); inp.value = val; }
      set(P, r.path, val); refresh(); emit();
    };
    inp.onchange = () => commit(inp.value);
    if (!r.type) inp.oninput = () => { const x = parseFloat(inp.value); if (!isNaN(x) && x >= r.min && x <= r.max) { set(P, r.path, x); emit(); } };
    row.querySelectorAll('.mf-num button').forEach((b) => b.onclick = () => commit(get(P, r.path) + r.step * +b.dataset.d));
    return row;
  }

  function stationsRow(r) {
    const row = document.createElement('div'); row.className = 'mf-stations'; row.dataset.path = r.path;
    row.innerHTML = STATIONS.map((s) => `<label class="mf-check"><input type="checkbox" value="${s.id}"${P.earth.stations.includes(s.id) ? ' checked' : ''}><span>${s.name}</span></label>`).join('') + '<div class="mf-err" id="mfStErr"></div>';
    row.querySelectorAll('input').forEach((c) => c.onchange = () => {
      P.earth.stations = [...row.querySelectorAll('input:checked')].map((x) => x.value);
      $('mfStErr').textContent = P.earth.stations.length ? '' : 'Escolha pelo menos um centro de comunicação.';
      emit();
    });
    return row;
  }

  function refresh() {
    for (const { r, el } of rows) el.hidden = r.show ? !r.show(P) : false;
    const sub = $('mfSiteSub'), s = P.site; if (!sub) return;
    const pk = picking();
    sub.textContent = pk ? 'Clique na Lua para marcar o local de pouso.' : s.mode === 'none' ? '' : `${fmtLat(s.lat)}  ${fmtLon(s.lon)}`;
    sub.classList.toggle('pick', pk);
    document.body.classList.toggle('picking', pk);
    $('btnHome').hidden = s.mode === 'none' && api.mode() === 'globe';
  }

  // ---------------------------------------------------------------- local pré-definido / personalizado
  addEventListener('lunite:site', (e) => {   // lista, rótulo no globo ou select
    const s = e.detail; ret.hidden = true;
    P.site = { mode: 'preset', id: s.id, name: s.name, lat: s.lat, lon: s.lon };
    $('mf-site').value = s.id; refresh(); emit();
  });
  function clearSite() {
    P.site = { mode: 'none', id: null, name: null, lat: null, lon: null };
    $('mf-site').value = 'custom'; $('siteCard').hidden = true; refresh(); emit();
  }
  addEventListener('lunite:mode', () => refresh());   // globo <-> terreno muda se o clique marca o alvo
  const canvas = $('view');
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!picking() || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;   // arrastar gira a câmera, não marca
    const p = api.pick(e.clientX, e.clientY); if (!p) return;
    const lon = wrapLon(p.lon);
    P.site = { mode: 'custom', id: null, name: null, lat: p.lat, lon };
    $('mf-site').value = 'custom'; $('siteCard').hidden = true; refresh(); emit(); ret.hidden = true;
    api.goTo(p.lat, lon);
  });

  // ---------------------------------------------------------------- mira: lat/lon sob o cursor
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (!pending) requestAnimationFrame(() => { hover(pending); pending = null; });
    pending = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerleave', () => { ret.hidden = true; });
  canvas.addEventListener('wheel', () => { ret.hidden = true; }, { passive: true });   // o zoom muda o ponto sob o cursor
  function hover(m) {
    if (!m) return;
    const p = api.pick(m.x, m.y);
    if (!p) { ret.hidden = true; return; }
    ret.innerHTML = `${fmtLat(p.lat)}  ${fmtLon(wrapLon(p.lon))}<small>Raio ${String(P.radiusKm).replace('.', ',')} km</small>`;
    ret.style.transform = `translate(${m.x + 16}px, ${m.y + 10}px)`;
    ret.hidden = false;
  }

  // ---------------------------------------------------------------- destaque dos parâmetros a afrouxar (vem da análise)
  addEventListener('lunite:hint-params', (e) => {
    body.querySelectorAll('.mf-warn').forEach((r) => r.classList.remove('mf-warn'));
    for (const p of e.detail.paths) body.querySelector(`[data-path="${p}"]`)?.classList.add('mf-warn');
    const first = body.querySelector('.mf-warn'); if (first) { $('left').classList.remove('min'); first.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  });

  // ---------------------------------------------------------------- voltar ao início: globo + formulário, local limpo
  $('btnHome').onclick = () => {
    $('left').classList.remove('min'); clearSite(); api.home();
  };

  // ---------------------------------------------------------------- encolher painel
  $('mfMin').onclick = () => { const min = $('left').classList.toggle('min'); $('mfMin').setAttribute('aria-expanded', String(!min)); };

  build();
  emit();
}
