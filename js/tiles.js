// tiles.js: reads the static data pack (data/layers.json + tile files) and samples heights.
// Every number shown by the viewer comes from here; nothing is procedural.
export const R = 1737400;            // LOLA reference sphere (m)
const D2R = Math.PI / 180;
const N1 = 257;                      // samples per tile side (256 + shared border)

function b64bits(s) {
  const bin = atob(s); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

export async function decodeTile(buf) {
  const ds = new DecompressionStream('deflate');
  const raw = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer());
  const N = N1 * N1, r = new Int16Array(N), x = new Int16Array(N);
  for (let i = 0; i < N; i++) r[i] = raw[i] | (raw[N + i] << 8);
  x[0] = r[0];
  for (let j = 1; j < N1; j++) x[j] = x[j - 1] + r[j];
  for (let i = 1; i < N1; i++) {
    const k0 = i * N1;
    x[k0] = x[k0 - N1] + r[k0];
    for (let j = 1; j < N1; j++) { const k = k0 + j; x[k] = x[k - 1] + x[k - N1] - x[k - N1 - 1] + r[k]; }
  }
  return x;
}

export class Store {
  constructor(base) { this.base = base; this.cache = new Map(); this.pending = new Map(); this.bytes = 0; this.tilesFetched = 0; }
  async init() {
    const j = await (await fetch(this.base + 'layers.json')).json();
    this.meta = j;
    this.layers = j.layers.map(L => {
      L.bits = b64bits(L.tiles_b64);
      L.pix = L.proj.type === 'cyl' ? (Math.PI * R / 180) / L.proj.res : L.proj.scale;   // native pixel (m)
      L.polar = L.proj.type === 'polar';
      L.site = /_(core|r30|r120)$/.test(L.name) ? L.name.replace(/_(core|r30|r120)$/, '') : null;
      return L;
    });
    this.byName = Object.fromEntries(this.layers.map(L => [L.name, L]));
    return j;
  }
  // continuous pixel coordinates (s = column, l = row) of lat/lon in layer L, or null
  pix(L, lat, lon) {
    const p = L.proj;
    if (p.type === 'cyl') {
      const l = p.loff - lat * p.res;
      let s = p.soff + (((lon % 360) + 360) % 360) * p.res;
      if (L.wrap) s = ((s % L.width) + L.width) % L.width;
      else if (s > L.width - 1) s -= 360 * p.res;
      else if (s < 0) s += 360 * p.res;
      return [s, l];
    }
    if (lat > -60) return null;
    const r = 2 * R * Math.tan(Math.PI / 4 + lat * D2R / 2);
    return [p.soff + r * Math.sin(lon * D2R) / p.scale, p.loff - r * Math.cos(lon * D2R) / p.scale];
  }
  // tile + fractional position, or null if the layer has no stored data there
  locate(L, lat, lon) {
    const q = this.pix(L, lat, lon); if (!q) return null;
    let [s, l] = q;
    if (!(l >= 0 && l <= L.height - 1)) return null;
    if (!L.wrap && !(s >= 0 && s <= L.width - 1)) return null;
    let i = Math.floor(l), j = Math.floor(s), fi = l - i, fj = s - j;
    if (i >= L.height - 1 && L.height > 1) { i = L.height - 2; fi = 1; }
    if (!L.wrap && j >= L.width - 1 && L.width > 1) { j = L.width - 2; fj = 1; }
    const ty = Math.floor(i / 256), tx = Math.floor(j / 256), k = ty * L.nx + tx;
    if (ty >= L.ny || tx >= L.nx || !(L.bits[k >> 3] & (1 << (k & 7)))) return null;
    return { key: L.group + '/' + L.name + '/' + ty + '_' + tx, li: i - ty * 256, lj: j - tx * 256, fi, fj };
  }
  async fetchTiles(keys, onProgress) {
    const todo = [...new Set(keys)].filter(k => !this.cache.has(k));
    let done = 0; const lim = 8; let idx = 0;
    const worker = async () => {
      while (idx < todo.length) {
        const k = todo[idx++];
        if (!this.pending.has(k)) this.pending.set(k, (async () => {
          const res = await fetch(this.base + k + '.bin');
          if (!res.ok) throw new Error('tile ' + k + ' HTTP ' + res.status);
          const buf = await res.arrayBuffer(); this.bytes += buf.byteLength; this.tilesFetched++;
          this.cache.set(k, await decodeTile(buf)); this.pending.delete(k);
        })());
        await this.pending.get(k);
        done++; if (onProgress) onProgress(done, todo.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(lim, todo.length) }, worker));
    if (this.cache.size > 1500) {             // simple LRU-ish trim
      const keep = new Set(keys); for (const k of this.cache.keys()) { if (this.cache.size <= 1000) break; if (!keep.has(k)) this.cache.delete(k); }
    }
  }
  value(loc) {   // bilinear interpolation of the DN values (exact at the samples)
    const t = this.cache.get(loc.key); const k = loc.li * N1 + loc.lj, a = loc.fi, b = loc.fj;
    return t[k] * (1 - a) * (1 - b) + t[k + 1] * (1 - a) * b + t[k + N1] * a * (1 - b) + t[k + N1 + 1] * a * b;
  }
}

// ---- geometry helpers (Moon Mean-Earth frame: x -> lon 0, y -> lon 90E, z -> north)
export function unit(lat, lon) { const a = lat * D2R, b = lon * D2R; return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)]; }
export function enuBasis(lat, lon) {
  const a = lat * D2R, b = lon * D2R;
  return { e: [-Math.sin(b), Math.cos(b), 0], n: [-Math.sin(a) * Math.cos(b), -Math.sin(a) * Math.sin(b), Math.cos(a)], u: unit(lat, lon) };
}
// azimuthal-equidistant inverse: local (east, north) metres around (lat0, lon0) -> lat, lon
export function aeqdInv(lat0, lon0, e, n) {
  const c = Math.hypot(e, n) / R; if (c === 0) return [lat0, lon0];
  const az = Math.atan2(e, n), p0 = lat0 * D2R;
  const lat = Math.asin(Math.sin(p0) * Math.cos(c) + Math.cos(p0) * Math.sin(c) * Math.cos(az));
  const lon = lon0 * D2R + Math.atan2(Math.sin(az) * Math.sin(c) * Math.cos(p0), Math.cos(c) - Math.sin(p0) * Math.sin(lat));
  return [lat / D2R, ((lon / D2R + 540) % 360) - 180];
}
export function aeqdFwd(lat0, lon0, lat, lon) {
  const p0 = lat0 * D2R, p = lat * D2R, dl = (lon - lon0) * D2R;
  const cc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl);
  const c = Math.acos(Math.max(-1, Math.min(1, cc))); if (c < 1e-12) return [0, 0];
  const k = c / Math.sin(c);
  return [R * k * Math.cos(p) * Math.sin(dl), R * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl))];
}
