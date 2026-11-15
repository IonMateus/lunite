// app.js: Last Light data viewer. Globe -> terrain patches that refine with zoom, real Sun/Earth from Horizons.
import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { Store, R, unit, enuBasis, aeqdInv, aeqdFwd } from './tiles.js';
import { Ephem, validate } from './ephem.js';

const BASE = 'data/';
const D2R = Math.PI / 180;
const $ = (id) => document.getElementById(id);
const mobile = matchMedia('(max-width: 760px)').matches;
const LEVELS = [409600, 204800, 102400, 51200, 25600, 12800, 6400, 3200, 1600];
const NGRID = mobile ? 201 : 321;

const state = { mode: 'globe', t: Date.UTC(2026, 10, 15, 12), playing: false, speed: 3600, exag: 1, overlay: 'none', shadows: true, exposure: 1.0,
                lat: 0, lon: 0, level: 1, patchId: 0, building: false, queued: null, patch: null };

// ------------------------------------------------------------------ renderer + scenes
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const camera = new THREE.PerspectiveCamera(40, 1, 0.005, 100);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08;
const globeScene = new THREE.Scene(), localScene = new THREE.Scene();
globeScene.background = new THREE.Color(0x000000); localScene.background = new THREE.Color(0x000000);
function resize() { const w = canvas.clientWidth, h = canvas.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize);

// ------------------------------------------------------------------ data
const store = new Store(BASE);
const eph = new Ephem();
let SITES = [], moonTex = null, earthDay = null, earthNight = null;
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

function msg(text, cls = '') { const el = $('status'); el.textContent = text; el.className = cls; }

// ------------------------------------------------------------------ globe
const globeUniforms = { sun: { value: new THREE.Vector3(1, 0, 0) }, colorTex: { value: null }, slopeTex: { value: null }, exag: { value: 1 }, exposure: { value: 1 } };
function makeGlobe() {
  const nLon = 512, nLat = 256, pos = [], idx = [];
  for (let i = 0; i <= nLat; i++) for (let j = 0; j <= nLon; j++) { const u = unit(90 - 180 * i / nLat, -180 + 360 * j / nLon); pos.push(...u); }
  for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) { const a = i * (nLon + 1) + j, b = a + nLon + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms: globeUniforms,
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 sun; uniform sampler2D colorTex; uniform sampler2D slopeTex; uniform float exag; uniform float exposure; varying vec3 vP;
      const float PI = 3.141592653589793;
      void main(){
        vec3 up = normalize(vP);
        float lat = asin(clamp(up.z,-1.0,1.0)), lon = atan(up.y, up.x);
        vec2 uvC = vec2((lon + PI) / (2.0*PI), (PI*0.5 - lat) / PI);
        vec2 uvS = vec2(fract(lon / (2.0*PI) + 1.0), (PI*0.5 - lat) / PI);
        vec2 sl = texture2D(slopeTex, uvS).rg;
        vec2 slope = tan((sl - 0.5) * PI) / 4.0;
        vec3 E = normalize(vec3(-sin(lon), cos(lon), 0.0)), N = cross(up, E);
        vec3 n = normalize(up - exag * (slope.x * E + slope.y * N));
        vec3 alb = pow(texture2D(colorTex, uvC).rgb, vec3(2.2));
        float mu0 = dot(n, sun), mu = max(dot(n, normalize(cameraPosition - vP)), 0.0);
        float lit = mu0 > 0.0 ? (0.5 * 2.0 * mu0 / (mu0 + mu + 1e-4) + 0.5 * mu0) : 0.0;
        lit *= smoothstep(-0.02, 0.02, dot(up, sun));
        vec3 c = alb * lit * 2.2 * exposure + alb * 0.012;
        gl_FragColor = vec4(pow(c / (1.0 + c), vec3(1.0/2.2)), 1.0);
      }`
  });
  return new THREE.Mesh(g, m);
}
const globe = makeGlobe(); globeScene.add(globe);

async function loadGlobeSlopes() {
  // whole-Moon heights from layer g8 (8 px/deg, block-mean overview of LOLA 64 px/deg); slopes for shading
  const L = store.byName['g8']; const W = L.width, H = L.height;
  const keys = []; for (let ty = 0; ty < L.ny; ty++) for (let tx = 0; tx < L.nx; tx++) keys.push(`terrain/g8/${ty}_${tx}`);
  await store.fetchTiles(keys, (d, t) => msg(`Loading whole-Moon heights ${d}/${t}`));
  const h = new Float32Array(W * H);
  for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) {
    const ty = Math.min(Math.floor(i / 256), L.ny - 1), tx = Math.min(Math.floor(j / 256), L.nx - 1);
    h[i * W + j] = store.cache.get(`terrain/g8/${ty}_${tx}`)[(i - ty * 256) * 257 + (j - tx * 256)] * 0.5;
  }
  const px = new Uint8Array(W * H * 4), dy = Math.PI * R / H;
  for (let i = 0; i < H; i++) {
    const lat = 90 - (i + 0.5) * 180 / H, dx = Math.max(Math.cos(lat * D2R), 0.02) * 2 * Math.PI * R / W;
    for (let j = 0; j < W; j++) {
      const sx = (h[i * W + (j + 1) % W] - h[i * W + (j - 1 + W) % W]) / (2 * dx);
      const sy = (h[Math.max(i - 1, 0) * W + j] - h[Math.min(i + 1, H - 1) * W + j]) / (2 * dy);
      const k = 4 * (i * W + j);
      px[k] = Math.round(255 * (0.5 + Math.atan(sx * 4) / Math.PI)); px[k + 1] = Math.round(255 * (0.5 + Math.atan(sy * 4) / Math.PI)); px[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(px, W, H, THREE.RGBAFormat); tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.wrapS = THREE.RepeatWrapping; tex.needsUpdate = true;
  globeUniforms.slopeTex.value = tex;
}

// Earth and Sun markers in the globe view (true directions; distance not to scale)
const earthGlobe = new THREE.Mesh(new THREE.SphereGeometry(0.18, 48, 24), new THREE.MeshBasicMaterial({ color: 0x3a6ea5 }));
globeScene.add(earthGlobe);
const sunGlobe = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture(false), transparent: true })); sunGlobe.scale.set(0.25, 0.25, 1); globeScene.add(sunGlobe);

// ------------------------------------------------------------------ local terrain
const localUniforms = { sun: { value: new THREE.Vector3(0, 0, 1) }, colorTex: { value: null }, exposure: { value: 1 }, shadows: { value: 1 }, overlay: { value: 0 } };
const localMat = new THREE.ShaderMaterial({
  uniforms: localUniforms,
  vertexShader: `
    attribute float vis; attribute vec2 ll; attribute float nasa; attribute float pix;
    varying vec3 vN; varying float vVis; varying vec2 vLL; varying vec3 vP; varying float vNasa; varying float vPix;
    void main(){ vN = normal; vVis = vis; vLL = ll; vP = position; vNasa = nasa; vPix = pix; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform vec3 sun; uniform sampler2D colorTex; uniform float exposure; uniform float shadows; uniform int overlay;
    varying vec3 vN; varying float vVis; varying vec2 vLL; varying vec3 vP; varying float vNasa; varying float vPix;
    vec3 ramp(float x){ x = clamp(x,0.0,1.0); return vec3(smoothstep(0.35,0.9,x), smoothstep(0.05,0.6,x)*(1.0-0.3*x), smoothstep(-0.2,0.35,x)*(1.0-smoothstep(0.55,1.0,x))) * 0.9 + 0.05; }
    void main(){
      vec3 n = normalize(vN);
      vec3 alb = vec3(0.16);   // uniform albedo: at these scales only LOLA geometry is shown (colour maps are ~2.6 km/px)
      float mu0 = dot(n, sun), mu = max(dot(n, normalize(cameraPosition - vP)), 0.0);
      float lit = mu0 > 0.0 ? (0.5 * 2.0 * mu0 / (mu0 + mu + 1e-4) + 0.5 * mu0) : 0.0;
      lit *= mix(1.0, vVis, shadows);
      vec3 c = alb * lit * 2.2 * exposure + alb * 0.012;
      c = c / (1.0 + c);
      if (overlay == 1 || overlay == 2) { if (vNasa >= 0.0) c = mix(c, ramp(vNasa), 0.75); }
      if (overlay == 3) { float r = log2(max(vPix,1.0)) / log2(500.0); c = mix(c, ramp(1.0 - r), 0.6); }
      gl_FragColor = vec4(pow(c, vec3(1.0/2.2)), 1.0);
    }`
});
let terrain = null, ringLines = null;
function discTexture(soft) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  if (soft) { gr.addColorStop(0, 'rgba(255,250,235,0.35)'); gr.addColorStop(0.15, 'rgba(255,245,225,0.12)'); gr.addColorStop(1, 'rgba(255,240,220,0)'); }
  else { gr.addColorStop(0, '#fff'); gr.addColorStop(0.96, '#fffdf6'); gr.addColorStop(1, 'rgba(255,253,246,0)'); }
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// true-size solar disc (0.533 deg) plus a faint glow so it can be found on screen
const sunSky = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture(false), depthWrite: false, transparent: true }));
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture(true), depthWrite: false, transparent: true, blending: THREE.AdditiveBlending }));
localScene.add(sunSky, sunGlow);
const earthUniforms = { day: { value: null }, night: { value: null }, sunL: { value: new THREE.Vector3(1, 0, 0) } };
const earthSky = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.ShaderMaterial({
  uniforms: earthUniforms,
  vertexShader: `varying vec3 vO; varying vec3 vW; void main(){ vO = position; vW = normalize((modelMatrix * vec4(position,0.0)).xyz); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D day; uniform sampler2D night; uniform vec3 sunL; varying vec3 vO; varying vec3 vW;
    void main(){ vec3 o = normalize(vO); float lon = atan(o.y,o.x), lat = asin(o.z);
      vec2 uv = vec2((lon + 3.14159265)/6.2831853, (1.5707963 - lat)/3.14159265);
      float d = dot(normalize(vW), sunL);
      vec3 c = texture2D(day, uv).rgb * smoothstep(-0.05, 0.25, d) + texture2D(night, uv).rgb * (1.0 - smoothstep(-0.1, 0.05, d)) * 0.8;
      gl_FragColor = vec4(c, 1.0); }`
}));
localScene.add(earthSky);

// ------------------------------------------------------------------ labels
const labels = $('labels');
function siteLabel(s) {
  const d = document.createElement('button'); d.className = 'pin ' + s.status; d.innerHTML = `<i></i><span>${s.rank}. ${s.name}</span>`;
  d.onclick = (e) => { e.stopPropagation(); goSite(s); }; labels.appendChild(d); return d;
}
function placeLabels() {
  const w = canvas.clientWidth, h = canvas.clientHeight, v = new THREE.Vector3();
  for (const s of SITES) {
    const el = s._label; let show = false;
    if (state.mode === 'globe') {
      v.set(...unit(s.lat, s.lon)).multiplyScalar(1.003);
      const toCam = camera.position.clone().sub(v).normalize(); show = toCam.dot(v.clone().normalize()) > 0.05;
    } else if (state.patch) {
      const [e, n] = aeqdFwd(state.lat, state.lon, s.lat, s.lon), W = state.patch.W;
      if (Math.abs(e) < W / 2 && Math.abs(n) < W / 2) { v.set(e, n, zAtPatch(e, n) + W * 0.004); show = true; }
    }
    if (show) { v.project(camera); show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1; }
    el.style.display = show ? '' : 'none';
    if (show) el.style.transform = `translate(${(v.x + 1) / 2 * w}px, ${(1 - v.y) / 2 * h}px)`;
  }
}
function zAtPatch(e, n) {
  const P = state.patch; if (!P) return 0; const N = P.N, s = (e + P.W / 2) / P.spacing, l = (P.W / 2 - n) / P.spacing;
  const j = Math.max(0, Math.min(N - 2, Math.floor(s))), i = Math.max(0, Math.min(N - 2, Math.floor(l))), fj = Math.min(1, Math.max(0, s - j)), fi = Math.min(1, Math.max(0, l - i)), k = i * N + j, z = P.z;
  return z[k] * (1 - fi) * (1 - fj) + z[k + 1] * (1 - fi) * fj + z[k + N] * fi * (1 - fj) + z[k + N + 1] * fi * fj;
}

// ------------------------------------------------------------------ time + sky
function topoCentre() { return eph.topo(state.t, state.lat, state.lon, state.patch ? state.patch.hCentre : 0); }
function updateSky() {
  const g = eph.at(state.t);
  globeUniforms.sun.value.set(...g.sun);
  const ed = new THREE.Vector3(...g.earthDir); earthGlobe.position.copy(ed.clone().multiplyScalar(6));
  sunGlobe.position.set(...g.sun).multiplyScalar(40);
  if (state.mode === 'local' && state.patch) {
    const o = topoCentre(), W = state.patch.W, D = W * 30;
    localUniforms.sun.value.set(...o.sun);
    sunSky.position.set(...o.sun).multiplyScalar(D); const sr = D * Math.tan(0.2665 * D2R) * 2; sunSky.scale.set(sr, sr, 1);
    sunGlow.position.copy(sunSky.position); sunGlow.scale.set(sr * 14, sr * 14, 1);
    earthSky.position.set(...o.earth).multiplyScalar(D); const er = D * Math.tan(o.earthHalfDeg * D2R); earthSky.scale.set(er, er, er);
    orientEarth(g, o);
    readSky(o);
  } else {
    const o = eph.topo(state.t, state.lat, state.lon, 0); readSky(o);
  }
  $('tlabel').textContent = new Date(state.t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  $('tsrc').textContent = 'Horizons table ' + g.table;
}
function orientEarth(g, o) {
  // Earth's sub-Moon point (Horizons) must face the Moon. Earth's pole is approximated by the Moon's pole (visual only).
  if (!g.subMoon) { earthSky.quaternion.identity(); return; }
  const B = enuBasis(state.lat, state.lon), toENU = (v) => new THREE.Vector3(v[0] * B.e[0] + v[1] * B.e[1] + v[2] * B.e[2], v[0] * B.n[0] + v[1] * B.n[1] + v[2] * B.n[2], v[0] * B.u[0] + v[1] * B.u[1] + v[2] * B.u[2]);
  const zE = toENU([0, 0, 1]).normalize();
  const m = new THREE.Vector3(...o.earth).negate();          // Earth -> site
  const mp = m.clone().sub(zE.clone().multiplyScalar(m.dot(zE))).normalize();
  const xE = mp.clone().applyAxisAngle(zE, -g.subMoon.lon * D2R), yE = zE.clone().cross(xE);
  earthSky.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xE, yE, zE));
  earthUniforms.sunL.value.copy(localUniforms.sun.value);
}
function readSky(o) {
  const P = state.patch && state.mode === 'local' ? state.patch : null;
  const sv = P && P.sunCentre, ev = P && P.earthCentre;
  $('rSun').innerHTML = `az ${o.sunAE.az.toFixed(2)}°, el ${o.sunAE.el.toFixed(3)}°` + (sv ? `<br>terrain horizon ${sv.horizon.toFixed(2)}° → disc visible <b>${(100 * sv.frac).toFixed(0)}%</b>` : '');
  $('rEarth').innerHTML = `az ${o.earthAE.az.toFixed(2)}°, el ${o.earthAE.el.toFixed(3)}°, ${Math.round(o.earthKm).toLocaleString('en')} km` + (ev ? `<br>terrain horizon ${ev.horizon.toFixed(2)}° → disc visible <b>${(100 * ev.frac).toFixed(0)}%</b>` : '');
}
let shadeTimer = null;
function setTime(t) {
  const r = eph.range(); const inA = t >= r.a[0] && t <= r.a[1], inB = t >= r.b[0] && t <= r.b[1];
  if (!inA && !inB) t = Math.max(r.a[0], Math.min(r.a[1], t));
  state.t = t; updateSky();
  $('tinput').value = new Date(t).toISOString().slice(0, 16);
  if (state.mode === 'local' && state.patch && !state.building) {
    clearTimeout(shadeTimer);
    shadeTimer = setTimeout(() => { const o = topoCentre(); worker.postMessage({ type: 'shade', id: state.patch.id, sun: o.sun, earth: o.earth, earthHalf: o.earthHalfDeg }); }, state.playing ? 0 : 60);
  }
}

// ------------------------------------------------------------------ patches
function requestPatch() {
  if (state.building) { state.queued = true; return; }
  state.building = true; state.queued = false;
  const W = LEVELS[state.level], id = ++state.patchId;
  const o = eph.topo(state.t, state.lat, state.lon, 0);
  msg(`Building ${fmtKm(W)} patch at ${fmtLat(state.lat)}, ${fmtLon(state.lon)} …`, 'busy');
  worker.postMessage({ type: 'patch', id, lat: state.lat, lon: state.lon, W, N: NGRID, exag: state.exag, sun: o.sun, earth: o.earth, earthHalf: o.earthHalfDeg });
}
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'progress') { msg(`Loading ${m.label} tiles ${m.done}/${m.total}`, 'busy'); return; }
  if (m.type === 'error') { msg('Error: ' + m.message, 'err'); state.building = false; console.error(m.message); return; }
  if (m.type === 'ready') { onWorkerReady(m); return; }
  if (m.type === 'patch') {
    state.building = false;
    if (m.id !== state.patchId) { if (state.queued) requestPatch(); return; }
    buildMesh(m); state.patch = m; updateSky(); readLayers(m);
    msg(`Patch ${fmtKm(m.W)} · ${m.N}×${m.N} samples · spacing ${m.spacing.toFixed(1)} m · ${m.ms.toFixed(0)} ms · ${m.tiles} tiles / ${(m.bytes / 1e6).toFixed(1)} MB downloaded so far`);
    if (state.queued) requestPatch();
  }
  if (m.type === 'shade' && state.patch && m.id === state.patch.id) {
    terrain.geometry.getAttribute('vis').array.set(m.vis); terrain.geometry.getAttribute('vis').needsUpdate = true;
    state.patch.sunCentre = m.sunCentre; state.patch.earthCentre = m.earthCentre; readSky(topoCentre());
  }
};
function buildMesh(m) {
  if (terrain) { localScene.remove(terrain); terrain.geometry.dispose(); }
  const N = m.N, g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
  g.setAttribute('vis', new THREE.BufferAttribute(m.vis, 1));
  g.setAttribute('ll', new THREE.BufferAttribute(m.ll, 2));
  g.setAttribute('pix', new THREE.BufferAttribute(m.pix, 1));
  const nasa = state.overlay === 'earth' ? m.nasaEarth : m.nasaSun;
  g.setAttribute('nasa', new THREE.BufferAttribute(nasa || new Float32Array(N * N).fill(-1), 1));
  const idx = new Uint32Array((N - 1) * (N - 1) * 6); let q = 0;
  for (let i = 0; i < N - 1; i++) for (let j = 0; j < N - 1; j++) { const a = i * N + j, b = a + N; idx[q++] = a; idx[q++] = b; idx[q++] = a + 1; idx[q++] = a + 1; idx[q++] = b; idx[q++] = b + 1; }
  g.setIndex(new THREE.BufferAttribute(idx, 1)); g.computeBoundingSphere();
  terrain = new THREE.Mesh(g, localMat); localScene.add(terrain);
  m.zc = m.z[((N - 1) / 2) * N + (N - 1) / 2];
  const zOld = state.patch && state.patch.zc != null ? state.patch.zc : 0;   // keep the view relative to the ground
  camera.position.z += m.zc - zOld;
  controls.target.set(0, 0, m.zc);
  camera.near = m.W / 4000; camera.far = m.W * 60; camera.updateProjectionMatrix();
  drawRings(m);
}
function drawRings(m) {
  if (ringLines) { localScene.remove(ringLines); ringLines.geometry.dispose(); }
  const pts = [], half = m.W / 2, lift = m.W * 0.0015;
  const P = state.patch; state.patch = m;   // zAtPatch reads state.patch
  for (const s of SITES) {
    const [ce, cn] = aeqdFwd(state.lat, state.lon, s.lat, s.lon);
    for (const rad of [5000, 25000, 100000]) {
      if (rad < m.spacing * 4) continue;
      const n = 160; let prev = null;
      for (let k = 0; k <= n; k++) {
        const a = 2 * Math.PI * k / n, e = ce + rad * Math.cos(a), nn = cn + rad * Math.sin(a);
        const inside = Math.abs(e) < half && Math.abs(nn) < half; const cur = inside ? [e, nn, zAtPatch(e, nn) + lift] : null;
        if (prev && cur) pts.push(...prev, ...cur); prev = cur;
      }
    }
  }
  state.patch = P;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  ringLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.55 }));
  localScene.add(ringLines);
}
function readLayers(m) {
  const total = m.N * m.N, rows = m.usage.filter(u => !u.ctx).sort((a, b) => b.count - a.count).map(u => {
    const L = layerInfo[u.name] || {}; return `<tr><td>${u.name}</td><td>${fmtRes(L.pix)}</td><td>${(100 * u.count / total).toFixed(0)}%</td><td>${L.derived ? 'derived' : 'NASA native'}</td></tr>`;
  });
  const ctx = m.usage.filter(u => u.ctx).map(u => u.name).join(', ');
  $('rLayers').innerHTML = `<table><tr><th>layer</th><th>native</th><th>share</th><th></th></tr>${rows.join('')}</table><div class="dim">horizon context (8× wider): ${ctx}</div>`;
  $('rWhere').innerHTML = `${fmtLat(state.lat)}, ${fmtLon(state.lon)}<br>patch ${fmtKm(m.W)} wide · grid spacing ${m.spacing.toFixed(1)} m · centre height ${m.hCentre.toFixed(1)} m`;
}

// ------------------------------------------------------------------ modes + navigation
function enterLocal(lat, lon, level, view) {
  state.mode = 'local'; state.lat = lat; state.lon = lon; state.level = level; state.patch = null;
  if (terrain) { localScene.remove(terrain); terrain = null; }
  const W = LEVELS[level];
  camera.near = W / 4000; camera.far = W * 60; camera.updateProjectionMatrix();
  const v = view || [0, -0.75 * W, 0.45 * W];
  camera.position.set(...v); controls.target.set(0, 0, 0); controls.minDistance = 30; controls.maxDistance = W * 2.5;
  $('mode').textContent = 'Terrain'; document.body.classList.add('local');
  requestPatch(); updateSky();
}
function enterGlobe() {
  state.mode = 'globe'; document.body.classList.remove('local'); $('mode').textContent = 'Globe';
  camera.near = 0.005; camera.far = 100; camera.updateProjectionMatrix();
  const u = new THREE.Vector3(...unit(state.lat, state.lon));
  camera.position.copy(u.multiplyScalar(3.4)); controls.target.set(0, 0, 0); controls.minDistance = 1.02; controls.maxDistance = 12;
  updateSky();
}
function goSite(s) { enterLocal(s.lat, s.lon, 5); showSite(s); }
function showSite(s) {
  $('siteCard').innerHTML = `<h3>${s.rank}. ${s.name}</h3><p>${s.why}</p>
    <p class="dim">${s.agency} · ${s.country} · ${s.status === 'future' ? 'future candidate' : 'past landing'} · core ${s.core_m} m</p>
    <p class="dim">Coordinates: ${s.lat}, ${s.lon} — ${s.coord_source}</p>${s.notes ? `<p class="dim">${s.notes}</p>` : ''}
    <p>${s.links.map(l => `<a href="${l}" target="_blank" rel="noopener">${new URL(l).hostname}</a>`).join(' · ')}</p>`;
  $('siteCard').hidden = false;
}
controls.addEventListener('change', () => {
  if (state.mode === 'globe') {
    const d = camera.position.length();
    if (d < 1.09) {   // close to the surface: switch to real terrain under the screen centre
      const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hit = rc.intersectObject(globe)[0]; const p = (hit ? hit.point : camera.position.clone()).normalize();
      const lat = Math.asin(p.z) / D2R, lon = Math.atan2(p.y, p.x) / D2R;
      enterLocal(lat, lon, 1);
    }
    return;
  }
  if (!state.patch || state.building) return;
  const d = camera.position.distanceTo(controls.target), W = LEVELS[state.level];
  if (d < 0.32 * W && state.level < LEVELS.length - 1) { state.level++; controls.maxDistance = LEVELS[state.level] * 2.5; requestPatch(); }
  else if (d > 1.25 * W) { if (state.level === 0) enterGlobe(); else { state.level--; controls.maxDistance = LEVELS[state.level] * 2.5; requestPatch(); } }
});
canvas.addEventListener('dblclick', (ev) => {
  const r = canvas.getBoundingClientRect(), p = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  const rc = new THREE.Raycaster(); rc.setFromCamera(p, camera);
  if (state.mode === 'globe') {
    const hit = rc.intersectObject(globe)[0]; if (!hit) return;
    const q = hit.point.clone().normalize(); enterLocal(Math.asin(q.z) / D2R, Math.atan2(q.y, q.x) / D2R, 1);
  } else if (terrain) {
    const hit = rc.intersectObject(terrain)[0]; if (!hit) return;
    const [lat, lon] = aeqdInv(state.lat, state.lon, hit.point.x, hit.point.y);
    const off = camera.position.clone().sub(controls.target);
    state.lat = lat; state.lon = lon; camera.position.copy(off).add(new THREE.Vector3(0, 0, controls.target.z)); controls.target.set(0, 0, controls.target.z);
    requestPatch();
  }
});

// ------------------------------------------------------------------ UI
function fmtKm(m) { return m >= 1000 ? (m / 1000).toFixed(m % 1000 ? 1 : 0) + ' km' : m + ' m'; }
function fmtRes(p) { return p == null ? '' : p >= 1000 ? (p / 1000).toFixed(2) + ' km' : p.toFixed(p < 20 ? 1 : 0) + ' m'; }
function fmtLat(a) { return Math.abs(a).toFixed(4) + '°' + (a < 0 ? 'S' : 'N'); }
function fmtLon(a) { return Math.abs(a).toFixed(4) + '°' + (a < 0 ? 'W' : 'E'); }
let layerInfo = {};
function onWorkerReady(m) { for (const L of m.layers) layerInfo[L.name] = L; }

function wireUI() {
  $('btnGlobe').onclick = () => enterGlobe();
  $('btnIn').onclick = () => { if (state.mode === 'local' && state.level < LEVELS.length - 1) { state.level++; camera.position.lerp(controls.target, 0.5); requestPatch(); } };
  $('btnOut').onclick = () => { if (state.mode === 'local') { if (state.level === 0) return enterGlobe(); state.level--; camera.position.sub(controls.target).multiplyScalar(2).add(controls.target); requestPatch(); } };
  $('exag').onchange = (e) => { state.exag = +e.target.value; globeUniforms.exag.value = state.exag; if (state.mode === 'local') requestPatch(); };
  $('overlay').onchange = (e) => {
    state.overlay = e.target.value; localUniforms.overlay.value = { none: 0, sun: 1, earth: 2, layers: 3 }[state.overlay];
    if (state.patch && terrain) { const a = state.overlay === 'earth' ? state.patch.nasaEarth : state.patch.nasaSun; if (a) { terrain.geometry.getAttribute('nasa').array.set(a); terrain.geometry.getAttribute('nasa').needsUpdate = true; } }
  };
  $('shadows').onchange = (e) => { localUniforms.shadows.value = e.target.checked ? 1 : 0; };
  $('expo').oninput = (e) => { globeUniforms.exposure.value = localUniforms.exposure.value = +e.target.value; };
  $('tinput').onchange = (e) => { const t = Date.parse(e.target.value + ':00Z'); if (!isNaN(t)) setTime(t); };
  const step = (d) => () => setTime(state.t + d * 1000);
  $('tm1d').onclick = step(-86400); $('tm1h').onclick = step(-3600); $('tp1h').onclick = step(3600); $('tp1d').onclick = step(86400);
  $('tplay').onclick = () => { state.playing = !state.playing; $('tplay').textContent = state.playing ? '❚❚' : '▶'; };
  $('tspeed').onchange = (e) => { state.speed = +e.target.value; };
  $('panelToggle').onclick = () => document.body.classList.toggle('panels');
  const list = $('siteList');
  for (const s of SITES) {
    const b = document.createElement('button'); b.className = 'srow';
    b.innerHTML = `<span class="rk">${s.rank}</span><span class="nm">${s.name}</span><span class="tag ${s.status}">${s.status}</span><span class="res">${s.core_m} m</span>`;
    b.onclick = () => goSite(s); list.appendChild(b);
  }
}

function dataSummary() {
  const by = {}; let tot = 0;
  for (const L of store.layers) { const g = L.site ? 'curated site windows' : L.group === 'illum' ? 'NASA illumination maps' : /^g/.test(L.name) ? 'whole Moon' : 'south polar bands'; by[g] = (by[g] || 0) + L.bytes; tot += L.bytes; }
  $('rData').innerHTML = Object.entries(by).map(([k, v]) => `${k}: ${(v / 1e6).toFixed(0)} MB`).join('<br>') + `<br><b>terrain + maps: ${(tot / 1e6).toFixed(0)} MB</b> (plus ephemerides and textures)`;
}

async function runValidation() {
  const series = await (await fetch(BASE + 'validation.json')).json();
  const r = validate(eph, series);
  $('rValid').innerHTML = `<table><tr><th>body</th><th>site</th><th>max Δel</th><th>max Δaz·cos el</th></tr>` +
    r.map(x => `<tr><td>${x.body}</td><td>${x.lat.toFixed(2)}, ${x.lon.toFixed(2)}</td><td>${x.maxEl.toFixed(4)}°</td><td>${x.maxAz.toFixed(4)}°</td></tr>`).join('') +
    `</table><div class="dim">Our 3 h table + interpolation + parallax vs. Horizons' own topocentric answers (${r[0].n} epochs each, Nov–Dec 2026).</div>`;
}

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000; last = now;
  if (state.playing) setTime(state.t + dt * state.speed * 1000);
  controls.update();
  renderer.render(state.mode === 'globe' ? globeScene : localScene, camera);
  placeLabels();
  requestAnimationFrame(loop);
}

async function main() {
  resize();
  msg('Loading data index …', 'busy');
  await store.init();
  SITES = await (await fetch(BASE + 'sites.json')).json();
  await eph.load(BASE);
  worker.postMessage({ type: 'init', base: new URL(BASE, location.href).href, sites: SITES.map(s => ({ id: s.id, lat: s.lat, lon: s.lon })) });
  const tl = new THREE.TextureLoader();
  moonTex = await tl.loadAsync(BASE + 'textures/moon_color_4k.jpg'); moonTex.wrapS = THREE.RepeatWrapping;
  globeUniforms.colorTex.value = localUniforms.colorTex.value = moonTex;
  earthUniforms.day.value = await tl.loadAsync(BASE + 'textures/earth_day_2k.jpg');
  earthUniforms.night.value = await tl.loadAsync(BASE + 'textures/earth_night_2k.jpg');
  earthGlobe.material = new THREE.MeshBasicMaterial({ map: earthUniforms.day.value });
  await loadGlobeSlopes();
  for (const s of SITES) s._label = siteLabel(s);
  wireUI(); dataSummary();
  state.lat = -60; state.lon = 20; enterGlobe(); setTime(state.t);
  runValidation();
  msg('Ready. Drag to rotate, scroll to zoom, double-click to open the terrain there, or pick a curated site.');
  requestAnimationFrame(loop);
}
main().catch(e => { msg('Error: ' + e.message, 'err'); console.error(e); });
