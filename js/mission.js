// mission.js: the "Mission parameters" panel (left side) and the latitude/longitude reticle under the cursor.
// Interface only: keeps the parameters in an object and tells the rest of the app through events.
//
//   initMission(api)  api = { sites, goSite(s), home(), mode() -> 'globe' | 'local', goTo(lat, lon), pick(clientX, clientY) -> {lat, lon} | null, setTime(ms), time() -> ms }
//   window.lunite.mission           -> copy of the current parameters
//   event 'lunite:mission-change'   (detail = parameters) on every change
//
// Site: "Custom" is the default; with it, a click on the Moon (on the globe) marks the target. Picking a predefined site
// flies the camera there.
// Longitude convention: −180° to +180° (east positive), the same as sites.json.

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dec = (step) => (String(step).split('.')[1] || '').length;

// Ground stations that can be chosen (deep-space antennas)
const STATIONS = [
  { id: 'goldstone', name: 'Goldstone (USA) · DSN', lat: 35.4267, lon: -116.8900 },
  { id: 'madrid', name: 'Madrid (Spain) · DSN', lat: 40.4314, lon: -4.2481 },
  { id: 'canberra', name: 'Canberra (Australia) · DSN', lat: -35.4014, lon: 148.9817 },
  { id: 'newnorcia', name: 'New Norcia (Australia) · ESA', lat: -31.0482, lon: 116.1914 },
  { id: 'cebreros', name: 'Cebreros (Spain) · ESA', lat: 40.4527, lon: -4.3676 },
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

// path: location in the parameters object
const SECTIONS = [
  { title: 'Lander', rows: [
    { path: 'probe.precisionM', label: 'Landing accuracy', unit: 'm', min: 10, max: 5000, step: 10, help: 'Radius of the landing ellipse: the expected error between the planned and the actual touchdown point. At the pole, 200 m can separate sunlight from shadow.' },
    { path: 'probe.slopeMaxDeg', label: 'Maximum terrain slope', unit: '°', min: 1, max: 30, step: 1, help: 'Steepest ground accepted under the lander. Beyond it the lander may tip over, as IM-1 and IM-2 did.' },
    { path: 'probe.antennaM', label: 'Antenna height', unit: 'm', min: 0.5, max: 50, step: 0.5, help: 'Antenna height above the ground. The higher it is, the lower the horizon it has to clear to see Earth.' },
    { path: 'probe.panelM', label: 'Solar panel height', unit: 'm', min: 0.5, max: 50, step: 0.5, help: 'Height of the solar panels. It is the viewpoint used to decide whether the Sun is visible.' },
  ] },
  { title: 'Landing site', rows: [
    { path: 'site', type: 'site', label: 'Site', help: 'Pick a predefined site to fly there, or keep "Custom" and click the Moon to mark the target.' },
    { path: 'radiusKm', label: 'Search radius', unit: 'km', min: 0.5, max: 100, step: 0.5, help: 'Circle around the site where the tool looks for landing points.' },
  ] },
  { title: 'Earth & communication', cls: 'earth', rows: [
    { path: 'earth.mode', type: 'select', label: 'Communicate with', options: [['center', 'Earth centre only (simplified)'], ['stations', 'Choose ground stations']], help: 'Seeing Earth is not enough: the ground station must also see the Moon. "Earth centre" ignores that. With 3 stations coverage is almost continuous; with 1, about 8–12 h a day.' },
    { path: 'earth.stations', type: 'stations', show: (p) => p.earth.mode === 'stations' },
    { path: 'earth.maxBlackoutH', label: 'Longest tolerated blackout', unit: 'h', min: 0, max: 720, step: 1, help: 'Longest uninterrupted period without contact with Earth that the mission accepts.' },
    { path: 'earth.minCommPct', label: 'Minimum direct-to-Earth time', unit: '%', min: 0, max: 100, step: 1, help: 'Minimum share of the mission with a direct line of sight to Earth from the antenna.' },
  ] },
  { title: 'Sun & power', cls: 'sun', rows: [
    { path: 'sun.minSunPct', label: 'Minimum sunlight time', unit: '%', min: 0, max: 100, step: 1, help: 'Minimum share of the mission with the Sun visible from the panels, above the real terrain.' },
    { path: 'sun.maxDarkH', label: 'Longest tolerated darkness', unit: 'h', min: 0, max: 720, step: 1, help: 'Longest uninterrupted period without sunlight that the batteries and thermal control can survive.' },
  ] },
  { title: 'Time & duration', rows: [
    { path: 'time.startDate', type: 'date', label: 'Start date', help: 'Landing day (00:00 UTC). The ephemerides cover 2020–2050 and 1969–1972 (Apollo).' },
    { path: 'time.days', label: 'Mission duration', unit: 'days', min: 1, max: 365, step: 1, help: 'Period after landing over which the Sun and Earth are evaluated. 1 lunar day ≈ 29.5 Earth days.' },
    { path: 'time.maxDelayDays', label: 'Maximum launch delay', unit: 'days', min: 0, max: 365, step: 1, help: 'How late the launch may slip. The tool slides the time window within this range.' },
  ] },
];

const get = (o, path) => path.split('.').reduce((a, k) => a[k], o);
function set(o, path, v) { const ks = path.split('.'), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }
const fmtLat = (a) => Math.abs(a).toFixed(3) + '°' + (a < 0 ? 'S' : 'N');
const fmtLon = (a) => Math.abs(a).toFixed(3) + '°' + (a < 0 ? 'W' : 'E');
const wrapLon = (l) => ((l + 540) % 360) - 180;

export function initMission(api) {
  let P = defaults(api.time());
  const body = $('mfBody'), rows = [];
  const picking = () => $('mf-site').value === 'custom' && api.mode() === 'globe';   // waiting for the click on the Moon?
  const ret = $('reticle'); let pending = null;

  const emit = () => dispatchEvent(new CustomEvent('lunite:mission-change', { detail: structuredClone(P) }));
  window.lunite = window.lunite || {};
  Object.defineProperty(window.lunite, 'mission', { get: () => structuredClone(P), configurable: true });

  // ---------------------------------------------------------------- build
  function build() {
    body.innerHTML = '';
    for (const S of SECTIONS) {
      const h = document.createElement('h3'); h.className = 'mf-grp ' + (S.cls || ''); h.textContent = S.title; body.appendChild(h);
      for (const r of S.rows) { const el = r.type === 'stations' ? stationsRow(r) : fieldRow(r); body.appendChild(el); rows.push({ r, el }); }
    }
    const card = $('siteCard'); body.querySelector('[data-path="site"]').after(card);   // site card right below the Site field
    refresh();
  }

  function fieldRow(r) {
    const id = 'mf-' + r.path.replace(/\./g, '-'), v = get(P, r.path);
    const row = document.createElement('div'); row.className = 'mf-row'; row.dataset.path = r.path;
    let ctl;
    if (r.type === 'site') ctl = `<select id="${id}"><option value="custom" selected>Custom (click the Moon)</option><optgroup label="Predefined sites">${api.sites.map((s) => `<option value="${s.id}">${s.rank}. ${s.name}</option>`).join('')}</optgroup></select>`;
    else if (r.type === 'select') ctl = `<select id="${id}">${r.options.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    else if (r.type === 'date') ctl = `<input type="date" id="${id}" value="${v}" min="1969-07-01" max="2050-12-31">`;
    else ctl = `<div class="mf-num"><button type="button" tabindex="-1" data-d="-1" aria-label="Decrease ${r.label}">−</button><input type="number" id="${id}" value="${v}" min="${r.min}" max="${r.max}" step="${r.step}" inputmode="decimal"><span class="mf-unit">${r.unit}</span><button type="button" tabindex="-1" data-d="1" aria-label="Increase ${r.label}">+</button></div>`;
    if (r.type === 'site' || r.type === 'select') row.classList.add('wide');
    row.innerHTML = `<div class="mf-name"><label for="${id}">${r.label}</label><button type="button" class="mf-q" aria-expanded="false" aria-label="What is ${r.label}">?</button></div>${ctl}<div class="mf-help" hidden>${r.help}</div>`;
    const q = row.querySelector('.mf-q'), help = row.querySelector('.mf-help');
    q.onclick = () => { help.hidden = !help.hidden; q.setAttribute('aria-expanded', String(!help.hidden)); };
    const inp = row.querySelector('#' + CSS.escape(id));

    if (r.type === 'site') {
      row.insertAdjacentHTML('beforeend', '<div class="mf-sub" id="mfSiteSub"></div>');
      inp.onchange = () => {
        if (inp.value === 'custom') { clearSite(); api.home(); return; }   // back to the globe to click the target
        const s = api.sites.find((x) => x.id === inp.value); if (s) api.goSite(s);   // goSite fires 'lunite:site', which fills P.site
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
      $('mfStErr').textContent = P.earth.stations.length ? '' : 'Choose at least one ground station.';
      emit();
    });
    return row;
  }

  function refresh() {
    for (const { r, el } of rows) el.hidden = r.show ? !r.show(P) : false;
    const sub = $('mfSiteSub'), s = P.site; if (!sub) return;
    const pk = picking();
    sub.textContent = pk ? 'Click the Moon to mark the landing target.' : s.mode === 'none' ? '' : `${fmtLat(s.lat)}  ${fmtLon(s.lon)}`;
    sub.classList.toggle('pick', pk);
    document.body.classList.toggle('picking', pk);
    $('btnHome').hidden = s.mode === 'none' && api.mode() === 'globe';
  }

  // ---------------------------------------------------------------- predefined / custom site
  addEventListener('lunite:site', (e) => {   // list, globe label or select
    const s = e.detail; ret.hidden = true;
    P.site = { mode: 'preset', id: s.id, name: s.name, lat: s.lat, lon: s.lon };
    $('mf-site').value = s.id; refresh(); emit();
  });
  function clearSite() {
    P.site = { mode: 'none', id: null, name: null, lat: null, lon: null };
    $('mf-site').value = 'custom'; $('siteCard').hidden = true; refresh(); emit();
  }
  addEventListener('lunite:mode', () => refresh());   // globe <-> terrain changes whether a click marks the target
  const canvas = $('view');
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!picking() || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;   // dragging rotates the camera, it does not mark
    const p = api.pick(e.clientX, e.clientY); if (!p) return;
    const lon = wrapLon(p.lon);
    P.site = { mode: 'custom', id: null, name: null, lat: p.lat, lon };
    $('mf-site').value = 'custom'; $('siteCard').hidden = true; refresh(); emit(); ret.hidden = true;
    api.goTo(p.lat, lon);
  });

  // ---------------------------------------------------------------- reticle: lat/lon under the cursor
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (!pending) requestAnimationFrame(() => { hover(pending); pending = null; });
    pending = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerleave', () => { ret.hidden = true; });
  canvas.addEventListener('wheel', () => { ret.hidden = true; }, { passive: true });   // zooming changes the point under the cursor
  function hover(m) {
    if (!m) return;
    const p = api.pick(m.x, m.y);
    if (!p) { ret.hidden = true; return; }
    ret.innerHTML = `${fmtLat(p.lat)}  ${fmtLon(wrapLon(p.lon))}<small>Radius ${P.radiusKm} km</small>`;
    ret.style.transform = `translate(${m.x + 16}px, ${m.y + 10}px)`;
    ret.hidden = false;
  }

  // ---------------------------------------------------------------- highlight the parameters to relax (from the analysis)
  addEventListener('lunite:hint-params', (e) => {
    body.querySelectorAll('.mf-warn').forEach((r) => r.classList.remove('mf-warn'));
    for (const p of e.detail.paths) body.querySelector(`[data-path="${p}"]`)?.classList.add('mf-warn');
    const first = body.querySelector('.mf-warn'); if (first) { $('left').classList.remove('min'); first.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  });

  // ---------------------------------------------------------------- back to start: globe + form, site cleared
  $('btnHome').onclick = () => {
    $('left').classList.remove('min'); clearSite(); api.home();
  };

  // ---------------------------------------------------------------- collapse panel
  $('mfMin').onclick = () => { const min = $('left').classList.toggle('min'); $('mfMin').setAttribute('aria-expanded', String(!min)); };

  build();
  emit();
}
