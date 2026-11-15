// worker.js: builds a terrain patch from the real LOLA tiles, off the main thread.
// patch  : heights on an N x N grid (azimuthal-equidistant around the centre) + a coarse context grid 8x wider
// shade  : for every vertex, the Sun's margin over the terrain horizon in disc diameters (0..1 = fraction of the disc visible)
import { Store } from './tiles.js';
import { makeSampler, positions, zAt } from './terrain-grid.js?v=20261115d';

let store = null, P = null;   // P = last patch kept for re-shading when the time changes

let SITES = {}, sampler = null;
const grid = (lat0, lon0, W, N, label) => sampler.grid(lat0, lon0, W, N, (d, t) => postMessage({ type: 'progress', label, done: d, total: t }));

function normals(pos, N) {
  const nrm = new Float32Array(N * N * 3);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const a = i * N + Math.max(j - 1, 0), b = i * N + Math.min(j + 1, N - 1), c = Math.max(i - 1, 0) * N + j, d = Math.min(i + 1, N - 1) * N + j;
    const ex = pos[3 * b] - pos[3 * a], ey = pos[3 * b + 1] - pos[3 * a + 1], ez = pos[3 * b + 2] - pos[3 * a + 2];
    const nx = pos[3 * c] - pos[3 * d], ny = pos[3 * c + 1] - pos[3 * d + 1], nz = pos[3 * c + 2] - pos[3 * d + 2];
    let x = ey * nz - ez * ny, y = ez * nx - ex * nz, z = ex * ny - ey * nx; const l = Math.hypot(x, y, z) || 1;
    const k = 3 * (i * N + j); nrm[k] = x / l; nrm[k + 1] = y / l; nrm[k + 2] = z / l;
  }
  return nrm;
}

// horizon elevation angle (deg) seen from (e,n,z0) toward direction (dx,dy), using fine grid then context grid
function horizonDeg(e, n, z0, dx, dy, tanStop) {
  const F = P.fine, C = P.ctx;
  let t = F.spacing, maxS = -1e9; const tMax = C.W * 0.5 * 1.41, zTop = P.zMax;
  while (t < tMax) {
    const x = e + dx * t, y = n + dy * t;
    let z = zAt(F, x, y); if (isNaN(z)) z = zAt(C, x, y); if (isNaN(z)) break;
    const s = (z - z0) / t; if (s > maxS) { maxS = s; if (maxS > tanStop) break; }
    if (z0 + t * Math.max(maxS, tanStop - 0.02) > zTop && t > F.W) break;
    t += Math.max(F.spacing, t / 24);
  }
  return Math.atan(maxS) * 180 / Math.PI;
}

function shade(sun) {
  const F = P.fine, N = F.N, vis = new Float32Array(N * N);
  const hl = Math.hypot(sun[0], sun[1]) || 1e-9, dx = sun[0] / hl, dy = sun[1] / hl;
  const sunEl = Math.atan2(sun[2], hl) * 180 / Math.PI, half = 0.2665;
  const tanStop = Math.tan((sunEl + half + 1.5) * Math.PI / 180);   // segue até o horizonte passar 1,5° do Sol: margem correta perto da borda
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const k = i * N + j;
    if (sunEl < -3) { vis[k] = -20; continue; }
    const e = -F.W / 2 + j * F.spacing, n = F.W / 2 - i * F.spacing;
    // local tilt of "up" across the patch is folded in: elevation is measured in the centre frame for both Sun and terrain
    const hz = horizonDeg(e, n, F.z[k] + 0.5, dx, dy, tanStop);
    // margem do Sol sobre o horizonte, em diâmetros do disco (0..1 = penumbra). Não é cortada em [0,1]: o sombreador
    // interpola entre vértices e corta por pixel, o que deixa a borda da sombra nítida em vez de borrada.
    vis[k] = Math.max(-20, Math.min(20, (sunEl - hz) / (2 * half) + 0.5));
  }
  return vis;
}

function centreVisibility(dir, halfDeg) {
  const hl = Math.hypot(dir[0], dir[1]) || 1e-9, el = Math.atan2(dir[2], hl) * 180 / Math.PI;
  const F = P.fine, k = ((F.N - 1) / 2) * F.N + (F.N - 1) / 2;
  const hz = horizonDeg(0, 0, F.z[k] + 2, dir[0] / hl, dir[1] / hl, Math.tan((el + halfDeg + 0.01) * Math.PI / 180));
  return { el, horizon: hz, frac: Math.max(0, Math.min(1, (el - hz) / (2 * halfDeg) + 0.5)) };
}

onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      store = new Store(m.base); const j = await store.init();
      SITES = Object.fromEntries(m.sites.map(s => [s.id, s])); sampler = makeSampler(store, SITES);
      postMessage({ type: 'ready', layers: store.layers.map(L => ({ name: L.name, group: L.group, pix: L.pix, bytes: L.bytes, ntiles: L.ntiles, derived: L.derived, note: L.note, polar: L.polar })) });
    }
    if (m.type === 'patch') {
      const t0 = performance.now();
      const fine = await grid(m.lat, m.lon, m.W, m.N, 'terrain');
      const ctx = await grid(m.lat, m.lon, m.W * 8, 161, 'horizon context');
      const fp = positions(fine, m.lat, m.lon, m.exag), cp = positions(ctx, m.lat, m.lon, m.exag);
      fine.z = fp.z; ctx.z = cp.z;
      let zMax = -1e9; for (const v of cp.z) if (v > zMax) zMax = v; for (const v of fp.z) if (v > zMax) zMax = v;
      P = { fine, ctx, zMax, id: m.id };
      const nrm = normals(fp.pos, fine.N);
      const vis = shade(m.sun);
      // NASA average-visibility maps (only inside 85 S) for the comparison overlay
      let nasaSun = null, nasaEarth = null;
      const sunL = store.byName['sun60'], earL = store.byName['earth60'];
      if (sunL && m.lat < -84) {
        const locs = [], locE = [];
        for (let k = 0; k < fine.N * fine.N; k++) { locs.push(store.locate(sunL, fine.lat[k], fine.lon[k])); locE.push(store.locate(earL, fine.lat[k], fine.lon[k])); }
        await store.fetchTiles([...locs, ...locE].filter(Boolean).map(l => l.key));
        nasaSun = new Float32Array(fine.N * fine.N).fill(-1); nasaEarth = new Float32Array(fine.N * fine.N).fill(-1);
        for (let k = 0; k < locs.length; k++) { if (locs[k]) nasaSun[k] = store.value(locs[k]) * 0.00004; if (locE[k]) nasaEarth[k] = store.value(locE[k]) * 0.00004; }
      }
      const ll = new Float32Array(fine.N * fine.N * 2);
      for (let k = 0; k < fine.N * fine.N; k++) { ll[2 * k] = fine.lat[k]; ll[2 * k + 1] = fine.lon[k]; }
      const usage = [...fine.usage].map(([name, count]) => ({ name, count, ctx: false }));
      for (const [name, count] of ctx.usage) usage.push({ name, count, ctx: true });
      const sv = centreVisibility(m.sun, 0.2665), ev2 = m.earth ? centreVisibility(m.earth, m.earthHalf || 0.95) : null;
      const pixOut = fine.pix.slice();
      const out = { type: 'patch', id: m.id, pix: pixOut, N: fine.N, W: m.W, spacing: fine.spacing, pos: fp.pos, nrm, vis, ll, nasaSun, nasaEarth, z: fine.z,
                    usage, sunCentre: sv, earthCentre: ev2, ms: performance.now() - t0, bytes: store.bytes, tiles: store.tilesFetched,
                    hCentre: fine.h[((fine.N - 1) / 2) * fine.N + (fine.N - 1) / 2] };
      postMessage(out, [out.pos.buffer, out.nrm.buffer, out.vis.buffer, out.ll.buffer, out.pix.buffer].concat(nasaSun ? [nasaSun.buffer, nasaEarth.buffer] : []));
    }
    if (m.type === 'shade' && P && P.id === m.id) {
      const vis = shade(m.sun);
      const sv = centreVisibility(m.sun, 0.2665), ev2 = m.earth ? centreVisibility(m.earth, m.earthHalf || 0.95) : null;
      postMessage({ type: 'shade', id: m.id, vis, sunCentre: sv, earthCentre: ev2 }, [vis.buffer]);
    }
  } catch (err) { postMessage({ type: 'error', message: String(err && err.stack || err) }); }
};
