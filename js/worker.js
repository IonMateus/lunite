// worker.js: builds a terrain patch from the real LOLA tiles, off the main thread.
// patch  : heights on an N x N grid (azimuthal-equidistant around the centre) + a coarse context grid 8x wider
// shade  : for every vertex, the fraction of the Sun's disc above the terrain horizon (ray march toward the Sun)
import { Store, R, unit, enuBasis, aeqdInv } from './tiles.js';

let store = null, P = null;   // P = last patch kept for re-shading when the time changes

function pickLayers(lat0, lon0, W) {
  // layers that can contribute: global chain, polar chain (if near the pole) and site rings near the patch
  const out = [];
  for (const L of store.layers) {
    if (L.group !== 'terrain') continue;
    if (L.polar && lat0 > -70) continue;
    if (L.site) {
      const st = SITES[L.site]; if (!st) continue;
      const half = L.name.endsWith('_core') ? 5000 : L.name.endsWith('_r30') ? 25000 : 100000;
      const d = angDist(lat0, lon0, st.lat, st.lon) * R;
      if (d > half * 1.5 + W * 0.75) continue;
    }
    out.push(L);
  }
  return out.sort((a, b) => a.pix - b.pix);   // finest first
}
let SITES = {};
function angDist(a1, o1, a2, o2) {
  const u = unit(a1, o1), v = unit(a2, o2);
  return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])));
}

// choose, for one point, the coarsest stored layer whose native pixel is <= the grid spacing, else the finest one there
function choose(cands, lat, lon, spacing) {
  let finest = null, best = null, polarHere = false;
  for (const L of cands) {
    const loc = store.locate(L, lat, lon); if (!loc) continue;
    if (L.polar) polarHere = true;
    if (!finest) finest = [L, loc];
    if (L.pix <= spacing * 1.001) best = [L, loc];
  }
  let r = best || finest;
  if (r && polarHere && !r[0].polar && !r[0].site) {   // inside the polar cap prefer the polar products over the cylindrical global map
    let f2 = null, b2 = null;
    for (const L of cands) { if (!L.polar) continue; const loc = store.locate(L, lat, lon); if (!loc) continue; if (!f2) f2 = [L, loc]; if (L.pix <= spacing * 1.001) b2 = [L, loc]; }
    r = b2 || f2;
  }
  return r;
}

async function grid(lat0, lon0, W, N, label) {
  const cands = pickLayers(lat0, lon0, W), spacing = W / (N - 1);
  const pick = new Array(N * N), lat = new Float64Array(N * N), lon = new Float64Array(N * N), keys = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const k = i * N + j, e = -W / 2 + j * spacing, n = W / 2 - i * spacing;
    const [la, lo] = aeqdInv(lat0, lon0, e, n); lat[k] = la; lon[k] = lo;
    const c = choose(cands, la, lo, spacing); pick[k] = c; if (c) keys.push(c[1].key);
  }
  await store.fetchTiles(keys, (d, t) => postMessage({ type: 'progress', label, done: d, total: t }));
  const h = new Float32Array(N * N), pix = new Float32Array(N * N), usage = new Map();
  for (let k = 0; k < N * N; k++) {
    const c = pick[k]; if (!c) { h[k] = 0; pix[k] = 0; continue; }
    h[k] = store.value(c[1]) * 0.5; pix[k] = c[0].pix;
    const u = usage.get(c[0].name) || 0; usage.set(c[0].name, u + 1);
  }
  return { N, W, spacing, lat, lon, h, pix, usage };
}

function positions(g, lat0, lon0, exag) {
  // exact 3-D positions on the sphere (R + h) expressed in the centre's east-north-up frame (includes curvature)
  const B = enuBasis(lat0, lon0), c = B.u, N = g.N, pos = new Float32Array(N * N * 3), z = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) {
    const u = unit(g.lat[k], g.lon[k]), rr = R + g.h[k] * exag;
    const d = [u[0] * rr - c[0] * R, u[1] * rr - c[1] * R, u[2] * rr - c[2] * R];
    pos[3 * k] = d[0] * B.e[0] + d[1] * B.e[1] + d[2] * B.e[2];
    pos[3 * k + 1] = d[0] * B.n[0] + d[1] * B.n[1] + d[2] * B.n[2];
    z[k] = pos[3 * k + 2] = d[0] * B.u[0] + d[1] * B.u[1] + d[2] * B.u[2];
  }
  return { pos, z };
}

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

function zAt(G, e, n) {   // bilinear height-in-frame from a grid, or NaN outside
  const N = G.N, s = (e + G.W / 2) / G.spacing, l = (G.W / 2 - n) / G.spacing;
  if (s < 0 || l < 0 || s >= N - 1 || l >= N - 1) return NaN;
  const j = Math.floor(s), i = Math.floor(l), fj = s - j, fi = l - i, k = i * N + j, z = G.z;
  return z[k] * (1 - fi) * (1 - fj) + z[k + 1] * (1 - fi) * fj + z[k + N] * fi * (1 - fj) + z[k + N + 1] * fi * fj;
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
  const tanStop = Math.tan((sunEl + half + 0.01) * Math.PI / 180);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const k = i * N + j;
    if (sunEl < -3) { vis[k] = 0; continue; }
    const e = -F.W / 2 + j * F.spacing, n = F.W / 2 - i * F.spacing;
    // local tilt of "up" across the patch is folded in: elevation is measured in the centre frame for both Sun and terrain
    const hz = horizonDeg(e, n, F.z[k] + 0.5, dx, dy, tanStop);
    vis[k] = Math.max(0, Math.min(1, (sunEl - hz) / (2 * half) + 0.5));
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
      SITES = Object.fromEntries(m.sites.map(s => [s.id, s]));
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
