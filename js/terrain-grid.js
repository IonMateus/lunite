// terrain-grid.js: samples LOLA heights on a local grid (azimuthal-equidistant around a centre).
// Shared by the patch worker (worker.js) and the analysis worker (analysis-worker.js), so both read exactly the same terrain.
import { R, unit, enuBasis, aeqdInv } from './tiles.js';

export function makeSampler(store, SITES) {
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

  async function grid(lat0, lon0, W, N, onProgress) {
    const cands = pickLayers(lat0, lon0, W), spacing = W / (N - 1);
    const pick = new Array(N * N), lat = new Float64Array(N * N), lon = new Float64Array(N * N), keys = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const k = i * N + j, e = -W / 2 + j * spacing, n = W / 2 - i * spacing;
      const [la, lo] = aeqdInv(lat0, lon0, e, n); lat[k] = la; lon[k] = lo;
      const c = choose(cands, la, lo, spacing); pick[k] = c; if (c) keys.push(c[1].key);
    }
    await store.fetchTiles(keys, onProgress);
    const h = new Float32Array(N * N), pix = new Float32Array(N * N), usage = new Map();
    for (let k = 0; k < N * N; k++) {
      const c = pick[k]; if (!c) { h[k] = 0; pix[k] = 0; continue; }
      h[k] = store.value(c[1]) * 0.5; pix[k] = c[0].pix;
      const u = usage.get(c[0].name) || 0; usage.set(c[0].name, u + 1);
    }
    return { N, W, spacing, lat, lon, h, pix, usage };
  }
  return { grid };
}

export function positions(g, lat0, lon0, exag) {
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

// bilinear height-in-frame (G.z) from a grid, or NaN outside
export function zAt(G, e, n) {
  const N = G.N, s = (e + G.W / 2) / G.spacing, l = (G.W / 2 - n) / G.spacing;
  if (s < 0 || l < 0 || s >= N - 1 || l >= N - 1) return NaN;
  const j = Math.floor(s), i = Math.floor(l), fj = s - j, fi = l - i, k = i * N + j, z = G.z;
  return z[k] * (1 - fi) * (1 - fj) + z[k + 1] * (1 - fi) * fj + z[k + N] * fi * (1 - fj) + z[k + N + 1] * fi * fj;
}
