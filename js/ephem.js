// ephem.js: Sun and Earth directions from the JPL Horizons tables (DE441, MOON_ME frame), 3 h steps,
// interpolated with Catmull-Rom on unit vectors. Topocentric directions add the site position (parallax).
import { unit, enuBasis, R } from './tiles.js';
const D2R = Math.PI / 180;

export class Ephem {
  async load(base) {
    this.meta = await (await fetch(base + 'ephem.json')).json();
    this.tabs = {};
    for (const k of ['moon_2020_2050', 'moon_apollo_1969_1972', 'earth_2020_2050']) {
      const m = this.meta[k]; const buf = await (await fetch(base + m.file)).arrayBuffer();
      this.tabs[k] = { ...m, t0: Date.parse(m.start_utc), d: new Float32Array(buf), nc: m.columns.length };
    }
    this.au = this.meta.au_km;
    return this;
  }
  range() { const a = this.tabs.moon_2020_2050, b = this.tabs.moon_apollo_1969_1972; return { a: [a.t0, a.t0 + (a.count - 1) * a.step_s * 1000], b: [b.t0, b.t0 + (b.count - 1) * b.step_s * 1000] }; }
  tabFor(t) {
    const a = this.tabs.moon_2020_2050, b = this.tabs.moon_apollo_1969_1972;
    if (t >= b.t0 && t <= b.t0 + (b.count - 1) * b.step_s * 1000) return b;
    return a;
  }
  // Catmull-Rom of the vector built from (lon, lat) columns ci, cj of table T at time t
  vec(T, t, ci, cj, distCol) {
    let x = (t - T.t0) / (T.step_s * 1000); x = Math.max(0, Math.min(T.count - 1.000001, x));
    const i = Math.floor(x), f = x - i, nc = T.nc;
    const row = (k) => { k = Math.max(0, Math.min(T.count - 1, k)); const lon = T.d[k * nc + ci], lat = T.d[k * nc + cj]; const u = unit(lat, lon); const dd = distCol != null ? T.d[k * nc + distCol] : 1; return [u[0], u[1], u[2], dd]; };
    const p0 = row(i - 1), p1 = row(i), p2 = row(i + 1), p3 = row(i + 2);
    const f2 = f * f, f3 = f2 * f, out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) out[c] = 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * f + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * f2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * f3);
    const l = Math.hypot(out[0], out[1], out[2]);
    return [out[0] / l, out[1] / l, out[2] / l, out[3]];
  }
  at(t) {
    const T = this.tabFor(t);
    const e = this.vec(T, t, 0, 1, 4), s = this.vec(T, t, 2, 3, null);
    const dkm = e[3] * this.au;
    const E = this.tabs.earth_2020_2050;
    let subMoon = null;
    if (T === this.tabs.moon_2020_2050) { const v = this.vec(E, t, 0, 1, null); subMoon = { lat: Math.asin(v[2]) / D2R, lon: Math.atan2(v[1], v[0]) / D2R }; }
    return { sun: [s[0], s[1], s[2]], earthDir: [e[0], e[1], e[2]], earthKm: dkm, subMoon, table: T === this.tabs.moon_2020_2050 ? '2020-2050' : 'Apollo 1969-1972' };
  }
  // topocentric unit vectors in the site's east-north-up frame, plus az/el (deg)
  topo(t, lat, lon, hM = 0) {
    const g = this.at(t), B = enuBasis(lat, lon), u = unit(lat, lon), rs = (R + hM) / 1000;
    const E = [g.earthDir[0] * g.earthKm - u[0] * rs, g.earthDir[1] * g.earthKm - u[1] * rs, g.earthDir[2] * g.earthKm - u[2] * rs];
    const dE = Math.hypot(...E); const eh = E.map(v => v / dE);
    const toENU = (v) => [v[0] * B.e[0] + v[1] * B.e[1] + v[2] * B.e[2], v[0] * B.n[0] + v[1] * B.n[1] + v[2] * B.n[2], v[0] * B.u[0] + v[1] * B.u[1] + v[2] * B.u[2]];
    const s = toENU(g.sun), e = toENU(eh);
    const azel = (v) => ({ az: ((Math.atan2(v[0], v[1]) / D2R) + 360) % 360, el: Math.asin(Math.max(-1, Math.min(1, v[2]))) / D2R });
    return { sun: s, earth: e, sunAE: azel(s), earthAE: azel(e), earthKm: dE, earthHalfDeg: Math.asin(6371.0 / dE) / D2R, g };
  }
}

export function validate(eph, series) {
  // compares our table-based topocentric directions with Horizons' own topocentric answers
  const res = [];
  for (const s of series) {
    let maxEl = 0, maxAz = 0, n = 0;
    for (const [iso, az, el] of s.rows) {
      const t = Date.parse(iso); const o = eph.topo(t, s.lat, s.lon, (s.alt_km || 0) * 1000);
      const ae = s.body === 'sun' ? o.sunAE : o.earthAE;
      const dEl = Math.abs(ae.el - el); let dAz = Math.abs(((ae.az - az + 540) % 360) - 180) * Math.cos(el * D2R);
      if (Math.abs(s.lat) > 89.9) dAz = 0;
      maxEl = Math.max(maxEl, dEl); maxAz = Math.max(maxAz, dAz); n++;
    }
    res.push({ body: s.body, lat: s.lat, lon: s.lon, n, maxEl, maxAz, file: s.file });
  }
  return res;
}
