#!/usr/bin/env python3
"""
build_pack.py: turns the untouched NASA files in lunar-data/raw/ into the static data pack served by GitHub Pages.

    python3 tools/build_pack.py OUT_DIR            (OUT_DIR = repository root, e.g. ../lastlight-repo)

Output (OUT_DIR/data):
  terrain/<layer>/<ty>_<tx>.bin   height tiles, 257x257 int16 (DN; height = DN * 0.5 m above the 1737.4 km sphere)
  illum/<layer>/<ty>_<tx>.bin     NASA average Sun / Earth visibility (DN * 0.00004 = fraction of time)
  ephem/*.bin                     Horizons tables (float32), 3 h steps
  validation.json                 Horizons topocentric az/el for 5 test sites (to check the browser math)
  sites.json                      the 20 curated sites
  layers.json                     every layer: projection, tile grid, which tiles exist, source file + SHA-256, derived or native
  textures/*.jpg                  visual textures (NASA SVS)

Tile encoding (decoded in js/tiles.js): 257x257 samples (256 + 1 shared border row/col), predictor
residual r = x - (left + up - upleft) in int16 wrap-around arithmetic, low-byte plane then high-byte plane, zlib.
Lossless: decoding gives back the exact NASA integers.

Native layers are exact crops of NASA files. "Derived" layers (overviews, 120 m site rings outside the polar
cap, the 30 m polar site rings) are block means or bilinear resamples, and are marked derived in layers.json.
"""
import json, math, os, sys, zlib, hashlib, datetime, re
import numpy as np
from multiprocessing import Pool

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'raw')
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(os.path.dirname(ROOT), 'lastlight-repo')
DATA = os.path.join(OUT, 'data')
R = 1737400.0
T = 256
MAN = json.load(open(os.path.join(ROOT, 'manifest.json')))
MANF = MAN.get('files', MAN)

def sha(rel):
    rec = MANF.get(rel) if isinstance(MANF, dict) else next((x for x in MANF if x.get('path') == rel), None)
    return dict(file=rel, url=rec['url'], sha256=rec['sha256']) if rec else dict(file=rel)

def log(*a): print(datetime.datetime.now().strftime('%H:%M:%S'), *a, flush=True)

# ------------------------------------------------------------------ encoding
def encode(a):
    x = a.astype(np.int32)
    r = np.empty_like(x)
    r[0, 0] = x[0, 0]
    r[0, 1:] = x[0, 1:] - x[0, :-1]
    r[1:, 0] = x[1:, 0] - x[:-1, 0]
    r[1:, 1:] = x[1:, 1:] - (x[1:, :-1] + x[:-1, 1:] - x[:-1, :-1])
    r = (r & 0xFFFF).astype(np.uint16)
    return zlib.compress((r & 255).astype(np.uint8).tobytes() + (r >> 8).astype(np.uint8).tobytes(), 9)

def decode(b, n=T + 1):  # used for self-test only
    raw = np.frombuffer(zlib.decompress(b), np.uint8)
    r = (raw[:n * n].astype(np.uint16) | (raw[n * n:].astype(np.uint16) << 8)).view(np.int16).reshape(n, n).astype(np.int32)
    x = np.zeros((n, n), np.int32)
    for i in range(n):
        for j in range(n):
            if i == 0 and j == 0: v = r[0, 0]
            elif i == 0: v = x[0, j - 1] + r[0, j]
            elif j == 0: v = x[i - 1, 0] + r[i, 0]
            else: v = x[i, j - 1] + x[i - 1, j] - x[i - 1, j - 1] + r[i, j]
            x[i, j] = ((v + 32768) & 0xFFFF) - 32768
    return x

LAYERS = []
def write_layer(name, kind, arr, proj, keep=None, source=None, derived=False, note='', group='terrain', wrap=False):
    """arr: 2-D int16 array-like (memmap ok). keep(ty, tx) -> bool decides which tiles are stored."""
    H, W = arr.shape
    ny, nx = math.ceil((H - 1) / T) if H > 1 else 1, math.ceil((W - 1) / T) if W > 1 else 1
    ny, nx = max(ny, 1), max(nx, 1)
    d = os.path.join(DATA, group, name); os.makedirs(d, exist_ok=True)
    present = []; total = 0
    for ty in range(ny):
        rows = np.asarray(arr[ty * T: min(ty * T + T + 1, H)])
        for tx in range(nx):
            if keep and not keep(ty, tx): continue
            if wrap:
                cols = [(tx * T + k) % W for k in range(T + 1)]
                blk = rows[:, cols]
            else:
                blk = rows[:, tx * T: min(tx * T + T + 1, W)]
            if blk.shape != (T + 1, T + 1):
                pad = np.zeros((T + 1, T + 1), np.int16)
                pad[:blk.shape[0], :blk.shape[1]] = blk
                if blk.shape[1] < T + 1: pad[:blk.shape[0], blk.shape[1]:] = blk[:, -1:]
                if blk.shape[0] < T + 1: pad[blk.shape[0]:, :] = pad[blk.shape[0] - 1:blk.shape[0], :]
                blk = pad
            b = encode(blk)
            with open(os.path.join(d, f'{ty}_{tx}.bin'), 'wb') as f: f.write(b)
            present.append(ty * nx + tx); total += len(b)
    bits = bytearray((ny * nx + 7) // 8)
    for k in present: bits[k >> 3] |= 1 << (k & 7)
    L = dict(name=name, group=group, kind=kind, width=W, height=H, tile=T, ny=ny, nx=nx, wrap=wrap,
             tiles_b64=__import__('base64').b64encode(bytes(bits)).decode(), ntiles=len(present), bytes=total,
             proj=proj, derived=derived, note=note, source=source)
    LAYERS.append(L)
    log(f'{group}/{name}: {len(present)} tiles, {total / 1e6:.1f} MB')
    return L

# ------------------------------------------------------------------ projections
def polar_xy(lat, lon):
    r = 2 * R * math.tan(math.pi / 4 + math.radians(lat) / 2)
    return r * math.sin(math.radians(lon)), r * math.cos(math.radians(lon))
def polar_r(lat): return 2 * R * math.tan(math.pi / 4 + math.radians(lat) / 2)

def mm(rel, shape): return np.memmap(os.path.join(RAW, rel), dtype='<i2', mode='r', shape=shape)

def mean_down(a, f):
    H, W = (a.shape[0] // f) * f, (a.shape[1] // f) * f
    return np.round(np.asarray(a[:H, :W], np.float64).reshape(H // f, f, W // f, f).mean(axis=(1, 3))).astype(np.int16)

def polar_keep(proj, rmax, rmin=0.0, margin=3000.0):
    """keep tiles of a polar-stereographic grid that intersect the annulus rmin..rmax (metres)."""
    s0, l0, sc = proj['soff'], proj['loff'], proj['scale']
    def k(ty, tx):
        xs = [(tx * T - s0) * sc, ((tx + 1) * T - s0) * sc]
        ys = [(l0 - ty * T) * sc, (l0 - (ty + 1) * T) * sc]
        xc = min(max(0, min(xs)), max(xs)); yc = min(max(0, min(ys)), max(ys))
        near = math.hypot(xc, yc)
        far = max(math.hypot(x, y) for x in xs for y in ys)
        return near <= rmax + margin and far >= rmin - margin
    return k

# ------------------------------------------------------------------ 1. global (cylindrical) pyramid
def build_global():
    g = mm('lola/global/ldem_64.img', (11520, 23040))
    src = sha('lola/global/ldem_64.img')
    proj = dict(type='cyl', res=64.0, loff=5759.5, soff=-0.5)   # line = loff - lat*res ; sample = soff + lon*res (lon 0..360)
    write_layer('g64', 'height', g, proj, source=src, note='LOLA LDEM 64 px/deg (474 m), whole Moon', wrap=True)
    a = g; res, lo, so = 64.0, 5759.5, -0.5
    for lvl in (32, 16, 8, 4):
        a = mean_down(a, 2); res /= 2; lo = (lo - 0.5) / 2; so = (so - 0.5) / 2
        write_layer(f'g{lvl}', 'height', a, dict(type='cyl', res=res, loff=lo, soff=so), source=src, derived=True,
                    note='2x2 block mean overview of g64 (for zoomed-out views)', wrap=True)

# ------------------------------------------------------------------ 2. south-polar bands
POLAR = {
    'p120': ('lola/polar_south/ldem_75s_120m.img', 7624, 120.0, 3811.5),
    'p40':  ('lola/polar_south/ldem_80s_40m.img', 15200, 40.0, 7599.5),
    'p20':  ('lola/polar_south/ldem_80s_20m.img', 30400, 20.0, 15199.5),
    'p10':  ('lola/polar_south/ldem_85s_10m.img', 30336, 10.0, 15167.5),
    'p5':   ('lola/polar_south/ldem_875s_5m.img', 30336, 5.0, 15167.5),
}
def pproj(sc, off): return dict(type='polar', scale=sc, loff=off, soff=off)   # x=r sin lon, y=r cos lon ; s=soff+x/sc ; l=loff-y/sc

def build_polar():
    r75, r80, r85, r875 = polar_r(-75), polar_r(-80), polar_r(-85), polar_r(-87.5)
    f, n, sc, off = POLAR['p120']; a = mm(f, (n, n)); pr = pproj(sc, off)
    write_layer('p120', 'height', a, pr, keep=polar_keep(pr, r75), source=sha(f), note='LOLA 75S-90S 120 m (whole cap; band 75-80S)')
    lo = off; s = sc; b = a
    for lvl in (240, 480):
        b = mean_down(b, 2); s *= 2; lo = (lo - 0.5) / 2
        p2 = pproj(s, lo)
        write_layer(f'p{lvl}', 'height', b, p2, keep=polar_keep(p2, r75), source=sha(f), derived=True, note='2x2 block mean overview of p120')
    f, n, sc, off = POLAR['p40']; pr = pproj(sc, off)
    write_layer('p40', 'height', mm(f, (n, n)), pr, keep=polar_keep(pr, r80), source=sha(f), note='LOLA 80S-90S 40 m (band 80-85S)')
    f, n, sc, off = POLAR['p20']; pr = pproj(sc, off)
    write_layer('p20', 'height', mm(f, (n, n)), pr, keep=polar_keep(pr, r85, r875), source=sha(f), note='LOLA 80S-90S 20 m, stored only for the 85-87.5S band')
    f, n, sc, off = POLAR['p10']; pr = pproj(sc, off)
    write_layer('p10', 'height', mm(f, (n, n)), pr, keep=polar_keep(pr, r875), source=sha(f), note='LOLA 85S-90S 10 m, stored only for 87.5-90S')

# ------------------------------------------------------------------ 3. illumination (NASA, for validation overlay)
def build_illum():
    for nm, key in (('avgvisib_85s_060m_201608', 'sun60'), ('avgvisib_85s_060m_201608_earth', 'earth60')):
        f = f'lola_illumination/{nm}.img'; pr = pproj(60.0, 2528.5)
        write_layer(key, 'visibility', mm(f, (5058, 5058)), pr, keep=polar_keep(pr, polar_r(-85)), source=sha(f), group='illum',
                    note='NASA LOLA average visibility (DN*0.00004 = fraction of time steps with any part of the disc above the horizon); unsupported EXTRAS product')

# ------------------------------------------------------------------ 4. curated sites
SITES = json.load(open(os.path.join(ROOT, 'tools', 'sites.json')))
TILES_DIR = os.path.join(RAW, 'lola', 'tiles_30m')
TPPD = 1024
_tmm = {}
def cyl_tile(lat_lo, lon_lo):
    """memmap of the ldem_1024 tile whose band starts at lat_lo (south edge) and lon_lo."""
    hi = lat_lo + 15
    band = f'{lat_lo:02d}n_{hi:02d}n' if lat_lo >= 0 else f'{abs(lat_lo):02d}s_{abs(hi):02d}s'
    nm = f'ldem_1024_{band}_{lon_lo:03d}_{lon_lo + 30:03d}'
    if nm not in _tmm:
        p = os.path.join(TILES_DIR, nm + '.img')
        _tmm[nm] = np.memmap(p, dtype='<i2', mode='r', shape=(15360, 30720)) if os.path.exists(p) else None
    return _tmm[nm], nm

def read_cyl(r0, r1, c0, c1):
    """global 1024 px/deg grid: row r -> lat 90-(r+0.5)/1024, col c -> lon (c+0.5)/1024 (c may wrap). returns int16 [r0,r1) x [c0,c1)."""
    out = np.zeros((r1 - r0, c1 - c0), np.int16); used = set()
    r = r0
    while r < r1:
        band_lo = 90 - 15 * ((r // (15 * TPPD)) + 1)          # south edge of band containing row r
        rb_end = min(r1, (r // (15 * TPPD) + 1) * 15 * TPPD)
        c = c0
        while c < c1:
            cw = c % (360 * TPPD)
            lon_lo = 30 * (cw // (30 * TPPD))
            ce = min(c1, c + (30 * TPPD - cw % (30 * TPPD)))
            t, nm = cyl_tile(band_lo, lon_lo)
            if t is None: raise RuntimeError(f'missing 30 m tile {nm} for rows {r}-{rb_end} cols {c}-{ce}')
            used.add(nm)
            tr0 = r - (90 - (band_lo + 15)) * TPPD
            tc0 = cw % (30 * TPPD)
            out[r - r0: rb_end - r0, c - c0: ce - c0] = t[tr0: tr0 + (rb_end - r), tc0: tc0 + (ce - c)]
            c = ce
        r = rb_end
    return out, sorted(used)

def bilinear_polar(src, n, sc, off, X, Y):
    """sample a polar grid (memmap n x n) at metre coords X,Y (arrays). returns float, nan outside."""
    s = off + X / sc; l = off - Y / sc
    ok = (s >= 0) & (l >= 0) & (s <= n - 1.001) & (l <= n - 1.001)
    out = np.full(X.shape, np.nan)
    if not ok.any(): return out
    rs, ls = s[ok], l[ok]
    i0, j0 = np.floor(ls).astype(int), np.floor(rs).astype(int)
    rmin, rmax, cmin, cmax = i0.min(), i0.max() + 2, j0.min(), j0.max() + 2
    blk = np.asarray(src[rmin:rmax, cmin:cmax], np.float64)
    fi, fj = ls - i0, rs - j0; i0 -= rmin; j0 -= cmin
    v = (blk[i0, j0] * (1 - fi) * (1 - fj) + blk[i0, j0 + 1] * (1 - fi) * fj + blk[i0 + 1, j0] * fi * (1 - fj) + blk[i0 + 1, j0 + 1] * fi * fj)
    out[ok] = v
    return out

def build_sites():
    deg_m = R * math.pi / 180
    meta = []
    for st in SITES:
        sid, lat, lon, core = st['id'], st['lat'], st['lon'], st['core_m']
        lon360 = lon % 360
        rings = []
        if lat <= -75:
            x0, y0 = polar_xy(lat, lon360)
            # core: native crop of the polar file with the site's best resolution
            key = {5: 'p5', 10: 'p10', 20: 'p20'}[core]
            f, n, sc, off = POLAR[key]
            src = mm(f, (n, n))
            half = 5000.0
            s_c, l_c = off + x0 / sc, off - y0 / sc
            c0, c1 = int(math.floor(s_c - half / sc)), int(math.ceil(s_c + half / sc)) + 1
            r0, r1 = int(math.floor(l_c - half / sc)), int(math.ceil(l_c + half / sc)) + 1
            note = f'native crop of {os.path.basename(f)}'
            if c0 >= 0 and r0 >= 0 and c1 <= n and r1 <= n:
                arr = np.asarray(src[r0:r1, c0:c1]); derived = False
            else:   # part of the square lies outside the polar file (IM-1 at 80.13S): fill that part from 120 m
                ii, jj = np.mgrid[r0:r1, c0:c1]
                X, Y = (jj - off) * sc, (off - ii) * sc
                v = bilinear_polar(src, n, sc, off, X, Y)
                f1, n1, sc1, o1 = POLAR['p120']
                miss = np.isnan(v)
                v[miss] = bilinear_polar(mm(f1, (n1, n1)), n1, sc1, o1, X[miss], Y[miss])
                arr = np.round(v).astype(np.int16); derived = True
                note += f'; {100 * miss.mean():.0f}% of samples outside that file, filled by bilinear upsampling of ldem_75s_120m'
            rings.append(write_layer(f'{sid}_core', 'height', arr, pproj(sc, off - c0) | dict(loff=off - r0), source=sha(f), derived=derived,
                                     note=f'{st["name"]}: 0-5 km at {core} m; ' + note))
            # 5-25 km at 30 m: bilinear from the 20 m file (outside it: from 120 m)
            sc2, half = 30.0, 25000.0
            nn = int(2 * half / sc2) + 1
            jj, ii = np.meshgrid(np.arange(nn), np.arange(nn))
            X = x0 - half + jj * sc2; Y = y0 + half - ii * sc2
            f, n, sc, off = POLAR['p20']
            v = bilinear_polar(mm(f, (n, n)), n, sc, off, X, Y)
            miss = np.isnan(v)
            if miss.any():
                f1, n1, sc1, o1 = POLAR['p120']
                v[miss] = bilinear_polar(mm(f1, (n1, n1)), n1, sc1, o1, X[miss], Y[miss])
            soff2 = -(x0 - half) / sc2; loff2 = (y0 + half) / sc2
            rings.append(write_layer(f'{sid}_r30', 'height', np.round(v).astype(np.int16), pproj(sc2, 0) | dict(soff=soff2, loff=loff2),
                                     source=sha(f), derived=True, note=f'{st["name"]}: 5-25 km at 30 m, bilinear resample of ldem_80s_20m'
                                     + (f' ({100 * miss.mean():.0f}% from ldem_75s_120m)' if miss.any() else '')))
            # 25-100 km at 120 m: native crop of ldem_75s_120m
            f, n, sc, off = POLAR['p120']; half = 100000.0
            s_c, l_c = off + x0 / sc, off - y0 / sc
            c0, c1 = max(0, int(s_c - half / sc)), min(n, int(s_c + half / sc) + 2)
            r0, r1 = max(0, int(l_c - half / sc)), min(n, int(l_c + half / sc) + 2)
            rings.append(write_layer(f'{sid}_r120', 'height', np.asarray(mm(f, (n, n))[r0:r1, c0:c1]), pproj(sc, 0) | dict(soff=off - c0, loff=off - r0),
                                     source=sha(f), note=f'{st["name"]}: 25-100 km at 120 m, native crop of ldem_75s_120m'))
        else:
            # cylindrical 1024 px/deg tiles: 0-25 km native crop (covers the 0-5 km core at 30 m too)
            def crop(half_m, mult):
                dlat = half_m / deg_m; dlon = dlat / math.cos(math.radians(lat))
                r0 = int(math.floor((90 - (lat + dlat)) * TPPD)) // mult * mult
                r1 = (int(math.ceil((90 - (lat - dlat)) * TPPD)) // mult + 2) * mult
                c0 = int(math.floor((lon360 - dlon) * TPPD)) // mult * mult
                c1 = (int(math.ceil((lon360 + dlon) * TPPD)) // mult + 2) * mult
                return r0, r1, c0, c1
            r0, r1, c0, c1 = crop(25000.0, 1)
            arr, used = read_cyl(r0, r1, c0, c1)
            prj = dict(type='cyl', res=float(TPPD), loff=90 * TPPD - 0.5 - r0, soff=-0.5 - c0)
            srcs = [sha(f'lola/tiles_30m/{u}.img') for u in used]
            L = write_layer(f'{sid}_r30', 'height', arr, prj, source=srcs, note=f'{st["name"]}: 0-25 km at 30 m (1024 px/deg), native crop of {", ".join(used)}')
            rings.append(L); rings.append(L)   # core (0-5 km) uses the same native 30 m layer
            r0, r1, c0, c1 = crop(100000.0, 4)
            arr, used = read_cyl(r0, r1, c0, c1)
            a4 = mean_down(arr, 4)
            prj = dict(type='cyl', res=TPPD / 4, loff=((90 * TPPD - 0.5 - r0) - 1.5) / 4, soff=((-0.5 - c0) - 1.5) / 4)
            rings.append(write_layer(f'{sid}_r120', 'height', a4, prj, source=[sha(f'lola/tiles_30m/{u}.img') for u in used], derived=True,
                                     note=f'{st["name"]}: 25-100 km at ~118 m (256 px/deg), 4x4 block mean of the 30 m tiles'))
        meta.append(dict(st, layers=dict(core=rings[0]['name'], r30=rings[1]['name'], r120=rings[2]['name'])))
    return meta

# ------------------------------------------------------------------ 5. ephemerides
def hz_rows(rel):
    r = json.load(open(os.path.join(RAW, rel)))['result']
    body = r[r.index('$$SOE') + 5: r.index('$$EOE')]
    rows = []
    for ln in body.strip().splitlines():
        p = [x.strip() for x in ln.split(',')]
        t = datetime.datetime.strptime(p[0], '%Y-%b-%d %H:%M').replace(tzinfo=datetime.timezone.utc)
        rows.append((t, [float(x) for x in p[3:] if x != '']))
    return rows

def build_ephem():
    d = os.path.join(DATA, 'ephem'); os.makedirs(d, exist_ok=True)
    out = {}
    def table(name, files, cols, desc):
        allr = {}
        for f in files:
            for t, v in hz_rows(f): allr[t] = v
        ts = sorted(allr); t0 = ts[0]; step = 3 * 3600
        n = int((ts[-1] - t0).total_seconds() // step) + 1
        missing = [k for k in range(n) if (t0 + datetime.timedelta(seconds=k * step)) not in allr]
        if missing: raise RuntimeError(f'{name}: {len(missing)} missing epochs, first at index {missing[0]}')
        a = np.array([[allr[t0 + datetime.timedelta(seconds=k * step)][c] for c in cols] for k in range(n)], np.float64)
        np.asarray(a, '<f4').tofile(os.path.join(d, name + '.bin'))
        out[name] = dict(file=f'ephem/{name}.bin', start_utc=t0.isoformat().replace('+00:00', 'Z'), step_s=step, count=n,
                         columns=desc, dtype='float32 little-endian, row-major', sources=[sha(f) for f in files])
        log(f'ephem {name}: {n} rows {t0} .. {t0 + datetime.timedelta(seconds=(n - 1) * step)}')
    AU = 149597870.700
    moon_files = ['horizons/moon_from_earth_2020_2034_3h.json', 'horizons/moon_from_earth_gap_2034-12-31_3h.json',
                  'horizons/moon_from_earth_2035_2049_3h.json', 'horizons/moon_from_earth_2049-12-31_2050_3h.json']
    # columns: ObsSub-LON, ObsSub-LAT, SunSub-LON, SunSub-LAT, delta(au), deldot
    table('moon_2020_2050', moon_files, [0, 1, 2, 3, 4],
          ['subEarth_lon_deg', 'subEarth_lat_deg', 'subSun_lon_deg', 'subSun_lat_deg', 'earth_moon_dist_au'])
    table('moon_apollo_1969_1972', ['horizons/moon_from_earth_apollo_1969-07_1972-12_3h.json'], [0, 1, 2, 3, 4],
          ['subEarth_lon_deg', 'subEarth_lat_deg', 'subSun_lon_deg', 'subSun_lat_deg', 'earth_moon_dist_au'])
    table('earth_2020_2050', ['horizons/earth_from_moon_2020_2034_3h.json', 'horizons/earth_from_moon_2034-12-31_2050_3h.json'], [0, 1],
          ['subMoon_lon_deg_on_Earth', 'subMoon_lat_deg_on_Earth'])
    out['frame'] = 'Horizons body-fixed frame MOON_ME (DE441); LOLA grids use Mean Earth/Polar Axis of DE421'
    out['au_km'] = AU
    json.dump(out, open(os.path.join(DATA, 'ephem.json'), 'w'), indent=1)

def build_validation():
    v = []
    vd = os.path.join(RAW, 'horizons', 'validation')
    for fn in sorted(os.listdir(vd)):
        m = re.match(r'topocentric_(sun|earth)_([\d.]+)([NS])_([\d.]+)([EW])', fn)
        body, la, ns, lo, ew = m.groups()
        lat = float(la) * (1 if ns == 'N' else -1); lon = float(lo) * (1 if ew == 'E' else -1)
        r = json.load(open(os.path.join(vd, fn)))['result']
        hdr = r[:r.index('$$SOE')].splitlines()
        cols = [c.strip() for c in [h for h in hdr if 'Date__' in h][-1].split(',')]
        ia, ie = cols.index('Azi_(a-app)'), cols.index('Elev_(a-app)')
        rows = []
        for ln in r[r.index('$$SOE') + 5: r.index('$$EOE')].strip().splitlines():
            p = [x.strip() for x in ln.split(',')]
            t = datetime.datetime.strptime(p[0], '%Y-%b-%d %H:%M').replace(tzinfo=datetime.timezone.utc)
            rows.append([t.isoformat().replace('+00:00', 'Z'), float(p[ia]), float(p[ie])])
        site_h = re.search(r'Center geodetic\s*:\s*([-\d.Ee+]+),\s*([-\d.Ee+]+),\s*([-\d.Ee+]+)', r)
        v.append(dict(body=body, lat=lat, lon=lon, alt_km=float(site_h.group(3)) if site_h else 0.0, file=fn, rows=rows,
                      source=sha(f'horizons/validation/{fn}')))
    json.dump(v, open(os.path.join(DATA, 'validation.json'), 'w'))
    log(f'validation: {len(v)} series')

# ------------------------------------------------------------------ 6. textures
def build_textures():
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    d = os.path.join(DATA, 'textures'); os.makedirs(d, exist_ok=True)
    out = {}
    for src, dst, size, desc in (('textures/lroc_color_poles_4k.tif', 'moon_color_4k.jpg', (4096, 2048), 'NASA SVS 4720 LROC colour mosaic'),
                                 ('textures/global_vir_2015287_mosaic_sm.tif', 'earth_day_2k.jpg', (2048, 1024), 'NASA SVS 30763 VIIRS Earth'),
                                 ('textures/BlackMarble_2016_global_7km.png', 'earth_night_2k.jpg', (2048, 1024), 'NASA SVS 30876 Black Marble')):
        im = Image.open(os.path.join(RAW, src)).convert('RGB').resize(size, Image.LANCZOS)
        im.save(os.path.join(d, dst), quality=88)
        out[dst] = dict(description=desc + ' (resized, JPEG; visual only)', source=sha(src))
    json.dump(out, open(os.path.join(DATA, 'textures.json'), 'w'), indent=1)

# ------------------------------------------------------------------ main
if __name__ == '__main__':
    os.makedirs(DATA, exist_ok=True)
    # self-test of the codec
    t = (np.random.default_rng(1).normal(0, 3000, (T + 1, T + 1))).astype(np.int16)
    t[5, 5] = -32768; t[6, 6] = 32767
    assert (decode(encode(t)) == t).all(), 'codec self-test failed'
    steps = sys.argv[2].split(',') if len(sys.argv) > 2 else ['ephem', 'validation', 'textures', 'sites', 'polar', 'illum', 'global']
    if os.path.exists(os.path.join(DATA, 'layers.json')):
        LAYERS[:] = [l for l in json.load(open(os.path.join(DATA, 'layers.json')))['layers']]
    def drop(pred): LAYERS[:] = [l for l in LAYERS if not pred(l)]
    for s in steps:
        if s == 'ephem': build_ephem()
        if s == 'validation': build_validation()
        if s == 'textures': build_textures()
        if s == 'sites':
            ids = {x['id'] for x in SITES}; drop(lambda l: l['name'].rsplit('_', 1)[0] in ids)
            meta = build_sites(); json.dump(meta, open(os.path.join(DATA, 'sites.json'), 'w'), indent=1, ensure_ascii=False)
        if s == 'polar':
            drop(lambda l: l['name'] in ('p120', 'p240', 'p480', 'p40', 'p20', 'p10')); build_polar()
        if s == 'illum': drop(lambda l: l['group'] == 'illum'); build_illum()
        if s == 'global': drop(lambda l: re.fullmatch(r'g\d+', l['name'])); build_global()
        json.dump(dict(generated_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'), radius_m=R,
                       height_scale_m=0.5, tile=T, layers=LAYERS), open(os.path.join(DATA, 'layers.json'), 'w'), indent=0)
    tot = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(DATA) for f in fs)
    log(f'data pack total: {tot / 1e6:.1f} MB')
