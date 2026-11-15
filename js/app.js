// app.js: Last Light data viewer. Globe -> terrain patches that refine with zoom, real Sun/Earth from Horizons.
import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { Store, R, unit, enuBasis, aeqdInv, aeqdFwd } from './tiles.js';
import { Ephem, validate } from './ephem.js';
import { earthFrame, earthshine, GLSL_COMMON, EARTH_VERT, EARTH_FRAG, sunDiscCanvas } from './sky.js?v=20261115f';
import { initMission } from './mission.js?v=20261115f';
import { initAnalysis } from './analysis.js?v=20261115f';
import { initInspect } from './inspect.js?v=20261115f';
// versão dos arquivos JS: o index.html confere, e o ?v= nos imports evita que o navegador use arquivos antigos do cache
window.LUNITE_BUILD = '20261115f';

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
// render sob demanda: a cena só é redesenhada quando algo muda (câmera, tempo, terreno, barras), não 60 vezes por segundo parada
let dirty = 2;
function invalidate(frames = 2) { dirty = Math.max(dirty, frames); }
function resize() { const w = canvas.clientWidth, h = canvas.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); invalidate(); }
addEventListener('resize', resize);

// ------------------------------------------------------------------ data
const store = new Store(BASE);
const eph = new Ephem();
let SITES = [], moonTex = null, earthDay = null, earthNight = null;
const worker = new Worker(new URL('./worker.js?v=20261115f', import.meta.url), { type: 'module' });

function msg(text, cls = '') { const el = $('status'); el.textContent = text; el.className = cls; }

// ------------------------------------------------------------------ globe
const globeUniforms = { sun: { value: new THREE.Vector3(1, 0, 0) }, earthL: { value: new THREE.Vector3(1, 0, 0) }, earthI: { value: 0 }, colorTex: { value: null }, slopeTex: { value: null }, exag: { value: 1 }, exposure: { value: 1 } };
function makeGlobe() {
  const nLon = 512, nLat = 256, pos = [], idx = [];
  for (let i = 0; i <= nLat; i++) for (let j = 0; j <= nLon; j++) { const u = unit(90 - 180 * i / nLat, -180 + 360 * j / nLon); pos.push(...u); }
  for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) { const a = i * (nLon + 1) + j, b = a + nLon + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms: globeUniforms,
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: GLSL_COMMON + `
      uniform vec3 sun; uniform vec3 earthL; uniform float earthI; uniform sampler2D colorTex; uniform sampler2D slopeTex; uniform float exag; uniform float exposure; varying vec3 vP;
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
        vec3 V = normalize(cameraPosition - vP);
        float lit = lunarLambert(dot(n, sun), dot(n, V), phaseDeg(sun, V)) * smoothstep(-0.01, 0.01, dot(up, sun));
        float es = earthI * lunarLambert(dot(n, earthL), dot(n, V), phaseDeg(earthL, V));   // luz da Terra no lado noturno
        vec3 c = alb * (lit + es) * PHOTO * exposure;
        gl_FragColor = vec4(toScreen(c), 1.0);
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
// (direções reais; distâncias e tamanhos fora de escala para caberem na tela). A Terra gira com a orientação real.
const earthGlobeUniforms = { day: { value: null }, night: { value: null }, sunL: { value: new THREE.Vector3(1, 0, 0) }, exposure: { value: 1 } };
const earthGlobe = new THREE.Mesh(new THREE.SphereGeometry(0.18, 64, 32), new THREE.ShaderMaterial({ uniforms: earthGlobeUniforms, vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG }));
globeScene.add(earthGlobe);
const sunGlobe = new THREE.Sprite(new THREE.SpriteMaterial({ map: null, transparent: true, depthWrite: false })); sunGlobe.scale.set(0.9, 0.9, 1); globeScene.add(sunGlobe);
const sunGlobeGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: null, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); sunGlobeGlow.scale.set(4, 4, 1); globeScene.add(sunGlobeGlow);

// ------------------------------------------------------------------ local terrain
const localUniforms = { sun: { value: new THREE.Vector3(0, 0, 1) }, earthL: { value: new THREE.Vector3(0, 1, 0) }, earthI: { value: 0 }, colorTex: { value: null }, exposure: { value: 1 }, shadows: { value: 1 }, overlay: { value: 0 } };
const localMat = new THREE.ShaderMaterial({
  uniforms: localUniforms,
  vertexShader: `
    attribute float vis; attribute vec2 ll; attribute float nasa; attribute float pix;
    varying vec3 vN; varying float vVis; varying vec2 vLL; varying vec3 vP; varying float vNasa; varying float vPix;
    void main(){ vN = normal; vVis = vis; vLL = ll; vP = position; vNasa = nasa; vPix = pix; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: GLSL_COMMON + `
    uniform vec3 sun; uniform vec3 earthL; uniform float earthI; uniform sampler2D colorTex; uniform float exposure; uniform float shadows; uniform int overlay;
    varying vec3 vN; varying float vVis; varying vec2 vLL; varying vec3 vP; varying float vNasa; varying float vPix;
    vec3 ramp(float x){ x = clamp(x,0.0,1.0); return vec3(smoothstep(0.35,0.9,x), smoothstep(0.05,0.6,x)*(1.0-0.3*x), smoothstep(-0.2,0.35,x)*(1.0-smoothstep(0.55,1.0,x))) * 0.9 + 0.05; }
    void main(){
      vec3 n = normalize(vN), V = normalize(cameraPosition - vP);
      // albedo: mapa de cor da Lua (NASA SVS, ~2,6 km/px) — dá a diferença real entre mares e terras altas; o detalhe fino é o relevo LOLA
      vec2 uv = vec2((vLL.y + 180.0) / 360.0, (90.0 - vLL.x) / 180.0);
      vec3 alb = pow(texture2D(colorTex, uv).rgb, vec3(2.2));
      // sombra: vVis é a margem do Sol sobre o horizonte (em diâmetros do disco), interpolada entre vértices -> borda nítida
      float shadow = clamp(vVis, 0.0, 1.0);
      float lit = lunarLambert(dot(n, sun), dot(n, V), phaseDeg(sun, V)) * mix(1.0, shadow, shadows);
      float es = earthI * lunarLambert(dot(n, earthL), dot(n, V), phaseDeg(earthL, V));
      vec3 c = alb * (lit + es) * PHOTO * exposure;
      c = aces(c);
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
const sunTex = new THREE.CanvasTexture(sunDiscCanvas()); sunTex.colorSpace = THREE.SRGBColorSpace;
const sunSky = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, depthWrite: false, transparent: true }));
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture(true), depthWrite: false, transparent: true, blending: THREE.AdditiveBlending }));   // brilho da lente (não há atmosfera)
sunGlobe.material.map = sunTex; sunGlobeGlow.material.map = sunGlow.material.map;
localScene.add(sunSky, sunGlow);
const earthUniforms = { day: { value: null }, night: { value: null }, sunL: { value: new THREE.Vector3(1, 0, 0) }, exposure: { value: 1 } };
const earthSky = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.ShaderMaterial({ uniforms: earthUniforms, vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG }));
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
  sunGlobe.position.set(...g.sun).multiplyScalar(40); sunGlobeGlow.position.copy(sunGlobe.position);
  const es = earthshine(g); globeUniforms.earthL.value.copy(ed); globeUniforms.earthI.value = es; earthGlobeUniforms.sunL.value.set(...g.sun);
  const F = earthFrame(state.t, g);   // eixos reais da Terra no referencial da Lua (= referencial do globo)
  if (F) earthGlobe.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...F.x), new THREE.Vector3(...F.y), new THREE.Vector3(...F.z)));
  if (state.mode === 'local' && state.patch) {
    const o = topoCentre(), W = state.patch.W, D = W * 30;
    localUniforms.sun.value.set(...o.sun); localUniforms.earthL.value.set(...o.earth); localUniforms.earthI.value = es;
    sunSky.position.set(...o.sun).multiplyScalar(D); const sr = D * Math.tan(0.2665 * D2R) * 2; sunSky.scale.set(sr, sr, 1);
    sunGlow.position.copy(sunSky.position); sunGlow.scale.set(sr * 9, sr * 9, 1);
    earthSky.position.set(...o.earth).multiplyScalar(D); const er = D * Math.tan(o.earthHalfDeg * D2R); earthSky.scale.set(er, er, er);
    orientEarth(g, o, F);
    readSky(o);
  } else {
    const o = eph.topo(state.t, state.lat, state.lon, 0); readSky(o);
  }
  $('tlabel').textContent = new Date(state.t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  $('tsrc').textContent = 'Horizons table ' + g.table;
  invalidate();
}
function orientEarth(g, o, F) {
  const B = enuBasis(state.lat, state.lon), toENU = (v) => new THREE.Vector3(v[0] * B.e[0] + v[1] * B.e[1] + v[2] * B.e[2], v[0] * B.n[0] + v[1] * B.n[1] + v[2] * B.n[2], v[0] * B.u[0] + v[1] * B.u[1] + v[2] * B.u[2]);
  earthUniforms.sunL.value.copy(localUniforms.sun.value);
  if (F) { earthSky.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(toENU(F.x), toENU(F.y), toENU(F.z))); return; }
  // sem o ponto sub-Lua (tabelas Apollo): o sub-Lua aproximado olha para a Lua e o polo da Terra vira o da Lua (só visual)
  if (!g.subMoon) { earthSky.quaternion.identity(); return; }
  const zE = toENU([0, 0, 1]).normalize(), m = new THREE.Vector3(...o.earth).negate();
  const mp = m.clone().sub(zE.clone().multiplyScalar(m.dot(zE))).normalize();
  const xE = mp.clone().applyAxisAngle(zE, -g.subMoon.lon * D2R), yE = zE.clone().cross(xE);
  earthSky.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xE, yE, zE));
}
function readSky(o) {
  const P = state.patch && state.mode === 'local' ? state.patch : null;
  const sv = P && P.sunCentre, ev = P && P.earthCentre;
  $('rSun').innerHTML = `az ${o.sunAE.az.toFixed(2)}°, el ${o.sunAE.el.toFixed(3)}°` + (sv ? `<br>terrain horizon ${sv.horizon.toFixed(2)}° → disc visible <b>${(100 * sv.frac).toFixed(0)}%</b>` : '');
  $('rEarth').innerHTML = `az ${o.earthAE.az.toFixed(2)}°, el ${o.earthAE.el.toFixed(3)}°, ${Math.round(o.earthKm).toLocaleString('en')} km` + (ev ? `<br>terrain horizon ${ev.horizon.toFixed(2)}° → disc visible <b>${(100 * ev.frac).toFixed(0)}%</b>` : '');
}
// sombras: um pedido por vez ao worker. Durante o play os pedidos não se acumulam (o worker sempre recebe o instante mais recente).
const shade = { busy: false, pending: false, timer: 0 };
function requestShade() {
  if (state.mode !== 'local' || !state.patch || state.building) return;
  if (shade.busy) { shade.pending = true; return; }
  shade.busy = true; shade.pending = false;
  const o = topoCentre(); worker.postMessage({ type: 'shade', id: state.patch.id, sun: o.sun, earth: o.earth, earthHalf: o.earthHalfDeg });
}
function setTime(t) {
  const r = eph.range(); const inA = t >= r.a[0] && t <= r.a[1], inB = t >= r.b[0] && t <= r.b[1];
  if (!inA && !inB) t = Math.max(r.a[0], Math.min(r.a[1], t));
  state.t = t; updateSky();
  $('tinput').value = new Date(t).toISOString().slice(0, 16);
  if (state.playing) requestShade(); else { clearTimeout(shade.timer); shade.timer = setTimeout(requestShade, 40); }
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
    buildMesh(m); state.patch = m; updateSky(); readLayers(m); invalidate(); dispatchEvent(new CustomEvent('lunite:patch'));
    if (shade.pending) requestShade();
    msg(`Patch ${fmtKm(m.W)} · ${m.N}×${m.N} samples · spacing ${m.spacing.toFixed(1)} m · ${m.ms.toFixed(0)} ms · ${m.tiles} tiles / ${(m.bytes / 1e6).toFixed(1)} MB downloaded so far`);
    if (state.queued) requestPatch();
  }
  if (m.type === 'shade') {
    shade.busy = false;
    if (state.patch && m.id === state.patch.id && terrain) {
      terrain.geometry.getAttribute('vis').array.set(m.vis); terrain.geometry.getAttribute('vis').needsUpdate = true;
      state.patch.sunCentre = m.sunCentre; state.patch.earthCentre = m.earthCentre; readSky(topoCentre()); invalidate();
    }
    if (shade.pending) requestShade();
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
  $('mode').textContent = 'Terrain'; document.body.classList.add('local'); invalidate(); dispatchEvent(new CustomEvent('lunite:mode'));
  requestPatch(); updateSky();
}
function enterGlobe() {
  state.mode = 'globe'; document.body.classList.remove('local'); $('mode').textContent = 'Globe'; invalidate(); dispatchEvent(new CustomEvent('lunite:mode'));
  camera.near = 0.005; camera.far = 100; camera.updateProjectionMatrix();
  const u = new THREE.Vector3(...unit(state.lat, state.lon));
  camera.position.copy(u.multiplyScalar(3.4)); controls.target.set(0, 0, 0); controls.minDistance = 1.02; controls.maxDistance = 12;
  updateSky();
}
function goSite(s) { enterLocal(s.lat, s.lon, 5); showSite(s); dispatchEvent(new CustomEvent('lunite:site', { detail: s })); }
function showSite(s) {
  $('siteCard').innerHTML = `<h3>${s.rank}. ${s.name}</h3><p>${s.why}</p>
    <p class="dim">${s.agency} · ${s.country} · ${s.status === 'future' ? 'future candidate' : 'past landing'} · core ${s.core_m} m</p>
    <p class="dim">Coordinates: ${s.lat}, ${s.lon} — ${s.coord_source}</p>${s.notes ? `<p class="dim">${s.notes}</p>` : ''}
    <p>${s.links.map(l => `<a href="${l}" target="_blank" rel="noopener">${new URL(l).hostname}</a>`).join(' · ')}</p>`;
  $('siteCard').hidden = false;
}
controls.addEventListener('change', () => {
  invalidate();
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
// lat/lon (graus) do ponto da Lua sob o cursor, ou null se o cursor não está sobre a Lua
function pickLatLon(cx, cy) {
  const r = canvas.getBoundingClientRect(), p = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  const rc = new THREE.Raycaster(); rc.setFromCamera(p, camera);
  if (state.mode === 'globe') { const hit = rc.intersectObject(globe)[0]; if (!hit) return null; const q = hit.point.clone().normalize(); return { lat: Math.asin(q.z) / D2R, lon: Math.atan2(q.y, q.x) / D2R }; }
  if (!terrain) return null;
  const hit = rc.intersectObject(terrain)[0]; if (!hit) return null;
  const [lat, lon] = aeqdInv(state.lat, state.lon, hit.point.x, hit.point.y); return { lat, lon };
}
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
    invalidate();
  };
  $('shadows').onchange = (e) => { localUniforms.shadows.value = e.target.checked ? 1 : 0; invalidate(); };
  $('expo').oninput = (e) => {   // exposição em EV (passos de 2x), como numa câmera: EV +12 a +14 mostra a luz da Terra no lado noturno
    const v = +e.target.value, k = 2 ** v; $('expoV').textContent = (v > 0 ? '+' : '') + v;
    globeUniforms.exposure.value = localUniforms.exposure.value = earthUniforms.exposure.value = earthGlobeUniforms.exposure.value = k; invalidate();
  };
  $('tinput').onchange = (e) => { const t = Date.parse(e.target.value + ':00Z'); if (!isNaN(t)) setTime(t); };
  const step = (d) => () => setTime(state.t + d * 1000);
  $('tm1d').onclick = step(-86400); $('tm1h').onclick = step(-3600); $('tp1h').onclick = step(3600); $('tp1d').onclick = step(86400);
  $('tplay').onclick = () => { state.playing = !state.playing; $('tplay').textContent = state.playing ? '❚❚' : '▶'; };
  $('tspeed').onchange = (e) => { state.speed = +e.target.value; };
  $('panelToggle').onclick = () => document.body.classList.toggle('panels');
  const list = $('siteList');
  for (const s of SITES) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'srow'; b.dataset.id = s.id;
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

// ------------------------------------------------------------------ setas do Sol e da Terra + foco da câmera
// Cada astro tem uma etiqueta: sobre ele quando está na tela, ou uma seta na borda apontando para onde ele está.
// Clicar anima a câmera até enquadrar o astro (no terreno: o horizonte com o astro acima; no globo: a Lua e o astro).
const bodies = { sun: { el: $('arrSun') }, earth: { el: $('arrEarth') } };
let camAnim = null;
function bodyWorld(k) { return state.mode === 'local' ? (k === 'sun' ? sunSky : earthSky).position : (k === 'sun' ? sunGlobe : earthGlobe).position; }
// área da tela não coberta pelos painéis (as setas de borda ficam dentro dela)
function freeRect() {
  const w = canvas.clientWidth, h = canvas.clientHeight, R = { l: 8, r: w - 8, t: 44, b: h - 8 };
  const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';   // (offsetParent é null em painéis fixos)
  const L = $('left'), Rt = $('right'), Bt = $('bottom');
  if (vis(L) && L.getBoundingClientRect().width < w * 0.5) R.l = L.getBoundingClientRect().right + 8;
  if (vis(Rt) && Rt.getBoundingClientRect().width < w * 0.5) R.r = Rt.getBoundingClientRect().left - 8;
  if (vis(Bt)) R.b = Bt.getBoundingClientRect().top - 8;
  if (R.r - R.l < 260) { R.l = 8; R.r = w - 8; }   // tela estreita: usa a largura toda
  return R;
}
function placeBodies() {
  const w = canvas.clientWidth, h = canvas.clientHeight, o = state.mode === 'local' && state.patch ? topoCentre() : null;
  for (const k of ['sun', 'earth']) {
    const B = bodies[k], el = B.el, p = bodyWorld(k).clone().applyMatrix4(camera.matrixWorldInverse);
    const ndc = bodyWorld(k).clone().project(camera), front = p.z < 0, on = front && Math.abs(ndc.x) < 0.96 && Math.abs(ndc.y) < 0.92;
    let x, y;
    if (on) { x = (ndc.x + 1) / 2 * w + 14; y = (1 - ndc.y) / 2 * h - 12; el.style.setProperty('--a', '0deg'); }
    else {   // seta na borda, na direção do astro (se estiver atrás da câmera, aponta para o lado em que é preciso girar)
      const R = freeRect(), a = Math.atan2(p.y, p.x), cx = (R.l + R.r) / 2, cy = (R.t + R.b) / 2, mx = (R.r - R.l) / 2 - 75, my = (R.b - R.t) / 2 - 22;
      const t = Math.min(Math.abs(mx / (Math.cos(a) || 1e-9)), Math.abs(my / (Math.sin(a) || 1e-9)));
      x = cx + Math.cos(a) * t - 45; y = cy - Math.sin(a) * t - 16;
      el.querySelector('svg').style.transform = `rotate(${-a}rad)`;
    }
    el.classList.toggle('onscreen', on);
    const ae = o ? (k === 'sun' ? o.sunAE : o.earthAE) : null;
    el.classList.toggle('below', !!ae && ae.el < 0);
    el.querySelector('small').textContent = ae ? (ae.el < 0 ? 'abaixo do horizonte' : `elevação ${ae.el.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}°`) : '';
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.hidden = false;
  }
}
function focusBody(k) {
  const fromP = camera.position.clone(), fromT = controls.target.clone();
  let toP, toT;
  if (state.mode === 'local' && state.patch) {
    const o = topoCentre(), dir = new THREE.Vector3(...(k === 'sun' ? o.sun : o.earth)).normalize();
    const el = Math.asin(dir.z), hz = new THREE.Vector3(dir.x, dir.y, 0).normalize(), d = camera.position.distanceTo(controls.target);
    const elV = Math.max(-35 * D2R, Math.min(60 * D2R, el - 10 * D2R));   // o astro fica ~10° acima do centro da tela
    const v = hz.clone().multiplyScalar(Math.cos(elV)).add(new THREE.Vector3(0, 0, Math.sin(elV)));
    const zc = state.patch.zc || 0, lift = Math.max(0, d * (Math.sin(elV) + 0.06));   // astro alto: sobe o alvo para a câmera não entrar no chão
    toT = new THREE.Vector3(0, 0, zc + lift); toP = toT.clone().sub(v.multiplyScalar(d));
  } else {
    const dir = bodyWorld(k).clone().normalize(), right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    right.sub(dir.clone().multiplyScalar(right.dot(dir))).normalize();
    toT = new THREE.Vector3(); toP = dir.clone().multiplyScalar(-6).add(right.multiplyScalar(3));   // a Lua na frente, o astro ao lado do limbo
  }
  camAnim = { t0: performance.now(), dur: 900, fromP, fromT, toP, toT };
}
bodies.sun.el.onclick = () => focusBody('sun');
bodies.earth.el.onclick = () => focusBody('earth');
function stepCamAnim(now) {
  const A = camAnim, k = Math.min(1, (now - A.t0) / A.dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  controls.target.lerpVectors(A.fromT, A.toT, e);
  // interpola a direção em arco (não em linha reta) e a distância, em volta do alvo
  const a = A.fromP.clone().sub(A.fromT), b = A.toP.clone().sub(A.toT), la = a.length(), lb = b.length();
  const q = new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());
  const dirv = a.normalize().applyQuaternion(new THREE.Quaternion().slerp(q, e));
  camera.position.copy(controls.target).add(dirv.multiplyScalar(la + (lb - la) * e));
  if (k >= 1) camAnim = null;
}

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000; last = now;
  if (state.playing) setTime(state.t + dt * state.speed * 1000);
  if (camAnim) { stepCamAnim(now); invalidate(); }
  if (controls.update()) invalidate();
  if (dirty > 0 || state.playing) {   // só redesenha quando algo mudou
    renderer.render(state.mode === 'globe' ? globeScene : localScene, camera);
    placeLabels(); placeBodies();
    dirty--;
  }
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
  earthUniforms.day.value = earthGlobeUniforms.day.value = await tl.loadAsync(BASE + 'textures/earth_day_2k.jpg');
  earthUniforms.night.value = earthGlobeUniforms.night.value = await tl.loadAsync(BASE + 'textures/earth_night_2k.jpg');
  await loadGlobeSlopes();
  for (const s of SITES) s._label = siteLabel(s);
  wireUI(); dataSummary();
  initMission({ sites: SITES, goSite, home: () => { camAnim = null; state.lat = -60; state.lon = 20; enterGlobe(); }, mode: () => state.mode, goTo: (lat, lon) => enterLocal(lat, lon, 5), pick: pickLatLon, setTime, time: () => state.t });
  const an = initAnalysis({ THREE, scene: localScene, camera, canvas, eph, setTime, invalidate, base: BASE, sites: SITES, frame: () => ({ lat: state.lat, lon: state.lon, exag: state.exag, mode: state.mode }) });
  initInspect({ an, canvas, setTime, time: () => state.t, mode: () => state.mode });
  state.lat = -60; state.lon = 20; enterGlobe(); setTime(state.t);
  runValidation();
  msg('Ready. Drag to rotate, scroll to zoom, double-click to open the terrain there, or pick a curated site.');
  requestAnimationFrame(loop);
}
main().catch(e => { msg('Error: ' + e.message, 'err'); console.error(e); });
