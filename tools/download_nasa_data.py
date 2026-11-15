#!/usr/bin/env python3
"""
download_nasa_data.py: baixa os dados brutos da NASA para raw/ SEM alterar nada e registra a prova.

  python3 tools/download_nasa_data.py                 baixa (retoma o que ficou pela metade) e verifica
  python3 tools/download_nasa_data.py --verify        só refaz os SHA-256 e compara com manifest.json
  python3 tools/download_nasa_data.py --compare-old DIR   compara os hashes com cópias baixadas antes

Garantias: cada arquivo é gravado como .part, conferido (tamanho do servidor, tamanho da grade do rótulo,
SHA-256) e só então renomeado e posto em somente leitura. Nada em raw/ é processado ou reescrito.
"""
import argparse, datetime, hashlib, json, os, re, subprocess, sys, threading, urllib.parse
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'raw'); MANIFEST = os.path.join(ROOT, 'manifest.json')
PDS = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx'
GDR, ILL = PDS + '/data/lola_gdr', PDS + '/extras/illumination'
lock = threading.Lock()
def log(*a):
    with lock: print(datetime.datetime.utcnow().strftime('%H:%M:%S'), *a, flush=True)

# ----------------------------------------------------------------------------- lista de arquivos
ITEMS = []
def add(path, url, desc, group, kind='file', geom_label=None, bps=2):
    ITEMS.append(dict(path=path, url=url, description=desc, group=group, kind=kind, geom_label=geom_label, bytes_per_sample=bps))

for f, d in (('aareadme.txt', 'Descrição do volume LOLA no PDS'), ('errata.txt', 'Erratas conhecidas do volume'), ('voldesc.cat', 'Descritor do volume')):
    add(f'lola/docs/{f}', f'{PDS}/{f}', d, 'docs', 'doc')
add('lola_illumination/readme_illumination_2016.txt', f'{ILL}/readme_illumination_2016.txt', 'Leia-me dos mapas de iluminação', 'docs', 'doc')

LDEM = [('global', 'cylindrical/img/ldem_64', 'LDEM 64 pix/grau, Lua inteira, projeção cilíndrica simples'),
        ('polar_south', 'polar/img/ldem_75s_120m', 'LDEM polar sul 75°-90°S, 120 m/pixel, estereográfica polar'),
        ('polar_south', 'polar/img/ldem_80s_40m', 'LDEM polar sul 80°-90°S, 40 m/pixel, estereográfica polar'),
        ('polar_south', 'polar/img/ldem_80s_20m', 'LDEM polar sul 80°-90°S, 20 m/pixel, estereográfica polar'),
        ('polar_south', 'polar/img/ldem_85s_10m', 'LDEM polar sul 85°-90°S, 10 m/pixel, estereográfica polar'),
        ('polar_south', 'polar/img/ldem_875s_5m', 'LDEM polar sul 87,5°-90°S, 5 m/pixel, estereográfica polar')]

TILES = ['ldem_1024_75s_60s_000_030', 'ldem_1024_75s_60s_030_060', 'ldem_1024_60s_45s_150_180', 'ldem_1024_60s_45s_180_210', 'ldem_1024_45s_30s_150_180', 'ldem_1024_45s_30s_180_210', 'ldem_1024_45s_30s_210_240', 'ldem_1024_30s_15s_000_030', 'ldem_1024_15s_00s_000_030', 'ldem_1024_15s_00s_330_360', 'ldem_1024_00n_15n_000_030', 'ldem_1024_00n_15n_330_360', 'ldem_1024_15n_30n_000_030', 'ldem_1024_15n_30n_030_060', 'ldem_1024_15n_30n_060_090', 'ldem_1024_15n_30n_330_360', 'ldem_1024_30n_45n_330_360', 'ldem_1024_45n_60n_330_360']
for n in TILES:
    LDEM.append(('tiles_30m', 'cylindrical/img/'+n, f'LDEM 1024 pix/grau (~30 m/pixel) {n[10:]}, tile cilíndrico 15°×30° (anéis de 30 m dos sites curados)'))
for sub, p, d in LDEM:
    n = p.split('/')[-1]
    add(f'lola/{sub}/{n}.lbl', f'{GDR}/{p}.lbl', f'Rótulo PDS3 de {n}.img', 'lola', 'label')
    add(f'lola/{sub}/{n}.xml', f'{GDR}/{p}.xml', f'Rótulo PDS4 de {n}.img', 'lola', 'label')
    add(f'lola/{sub}/{n}.img', f'{GDR}/{p}.img', d + '; altura = DN × 0,5 m sobre a esfera de 1737,4 km', 'lola', 'img', geom_label=f'lola/{sub}/{n}.lbl')

ILLUM = [('avgvisib_85s_060m_201608', 'Visibilidade média do Sol, 85°-90°S, 60 m'), ('avgvisib_85s_060m_201608_earth', 'Visibilidade média da Terra, 85°-90°S, 60 m'),
         ('lpsr_85s_060m_201608', 'Regiões permanentemente sombreadas, 85°-90°S, 60 m'),
         ('avgvisib_75s_120m_201608', 'Visibilidade média do Sol, 75°-90°S, 120 m'), ('avgvisib_75s_120m_201608_earth', 'Visibilidade média da Terra, 75°-90°S, 120 m')]
for n, d in ILLUM:
    add(f'lola_illumination/{n}.lbl', f'{ILL}/img/{n}.lbl', f'Rótulo PDS3 de {n}.img', 'illumination', 'label')
    add(f'lola_illumination/{n}.img', f'{ILL}/img/{n}.img', d + '; fração = DN × 0,00004', 'illumination', 'img', geom_label=f'lola_illumination/{n}.lbl')

for fn, url, d in (('nssdc_apolloland.html', 'https://nssdc.gsfc.nasa.gov/planetary/lunar/apolloland.html', 'NSSDCA: coordenadas dos pousos Apollo'),
                   ('lroc_posts_1360_im1_odysseus.html', 'https://www.lroc.asu.edu/posts/1360', 'LROC: IM-1 Odysseus'),
                   ('lroc_images_1408_im2_athena.html', 'https://www.lroc.asu.edu/images/1408', 'LROC: IM-2 Athena'),
                   ('lroc_images_1407_blue_ghost.html', 'https://www.lroc.asu.edu/images/1407', 'LROC: Blue Ghost'),
                   ('lroc_images_1374_change6.html', 'https://www.lroc.asu.edu/images/1374', "LROC: Chang'e 6"),
                   ('nasa_artemis3_regions.html', 'https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/', 'NASA: regiões candidatas do Artemis III (só nomes)')):
    add(f'sites/{fn}', url, d, 'sites', 'html')
for fn, url, d in (('lroc_color_poles_4k.tif', 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif', 'NASA SVS 4720: mosaico de cor da Lua (visual)'),
                   ('global_vir_2015287_mosaic_sm.tif', 'https://svs.gsfc.nasa.gov/vis/a030000/a030700/a030763/global_vir_2015287_mosaic_sm.tif', 'NASA SVS 30763: Terra VIIRS (visual)'),
                   ('BlackMarble_2016_global_7km.png', 'https://svs.gsfc.nasa.gov/vis/a030000/a030800/a030876/BlackMarble_2016_global_7km.png', 'NASA SVS 30876: Terra à noite (visual)')):
    add(f'textures/{fn}', url, d, 'textures', 'texture')

# Horizons: a resposta da API é gravada exatamente como vem
HZ = 'https://ssd.jpl.nasa.gov/api/horizons.api'
def hz_url(**kw):
    base = dict(format='json', OBJ_DATA="'YES'", MAKE_EPHEM="'YES'", EPHEM_TYPE="'OBSERVER'", CSV_FORMAT="'YES'", ANG_FORMAT="'DEG'")
    base.update(kw); return HZ + '?' + urllib.parse.urlencode(base)
HZ_ITEMS = []
def hz(path, desc, **kw): HZ_ITEMS.append(dict(path=path, url=hz_url(**kw), description=desc, group='horizons', kind='horizons', geom_label=None, bytes_per_sample=0))
for a, b, tag in (("1969-07-01", "1972-12-31", 'apollo_1969-07_1972-12'), ("2020-01-01", "2034-12-31", '2020_2034'), ("2035-01-01", "2049-12-31", '2035_2049')):
    hz(f'horizons/moon_from_earth_{tag}_3h.json', f'Lua vista do centro da Terra {a}..{b}, 3 h: ObsSub-LON/LAT (ponto sub-Terra), SunSub-LON/LAT (ponto sub-solar), distância',
       COMMAND="'301'", CENTER="'500@399'", START_TIME=f"'{a}'", STOP_TIME=f"'{b}'", STEP_SIZE="'3 h'", QUANTITIES="'14,15,20'")
hz('horizons/earth_from_moon_2020_2034_3h.json', 'Terra vista do centro da Lua 2020..2034, 3 h: ponto sub-Lua da Terra (face da Terra voltada à Lua)',
   COMMAND="'399'", CENTER="'500@301'", START_TIME="'2020-01-01'", STOP_TIME="'2034-12-31'", STEP_SIZE="'3 h'", QUANTITIES="'14,20'")
SITES = {'89.5S_0E': (-89.5, 0.0), '85.97S_2.8E': (-85.97, 2.8), '84.7906S_29.1957E_im2': (-84.7906, 29.1957), '0.674N_23.473E_apollo11': (0.674, 23.473), '43.31S_11.36W_tycho': (-43.31, -11.36)}
for nm, (la, lo) in SITES.items():
    for body, cmd in (('sun', '10'), ('earth', '399')):
        hz(f'horizons/validation/topocentric_{body}_{nm}_2026-11-14_2026-12-14_12h.json', f'{body} visto de {nm} (az/el aparentes), 12 h',
           COMMAND=f"'{cmd}'", CENTER="'coord@301'", COORD_TYPE="'GEODETIC'", SITE_COORD=f"'{lo},{la},0.0'", START_TIME="'2026-11-14 00:00'", STOP_TIME="'2026-12-14 00:00'", STEP_SIZE="'12 h'", QUANTITIES="'4'")
# complementos: fecham as lacunas de 21 h entre arquivos (o STOP_TIME termina às 00:00) e estendem até o fim de 2050
for a, b, tag in (("2034-12-31", "2035-01-01", 'gap_2034-12-31'), ("2049-12-31", "2051-01-01", '2049-12-31_2050')):
    hz(f'horizons/moon_from_earth_{tag}_3h.json', f'Lua vista do centro da Terra {a}..{b}, 3 h (complemento)',
       COMMAND="'301'", CENTER="'500@399'", START_TIME=f"'{a}'", STOP_TIME=f"'{b}'", STEP_SIZE="'3 h'", QUANTITIES="'14,15,20'")
hz('horizons/earth_from_moon_2034-12-31_2050_3h.json', 'Terra vista do centro da Lua 2034-12-31..2051-01-01, 3 h (complemento)',
   COMMAND="'399'", CENTER="'500@301'", START_TIME="'2034-12-31'", STOP_TIME="'2051-01-01'", STEP_SIZE="'3 h'", QUANTITIES="'14,20'")
ITEMS += HZ_ITEMS

# ----------------------------------------------------------------------------- utilidades
def run(cmd, **kw): return subprocess.run(cmd, capture_output=True, text=True, **kw)
def head(url):
    r = run(['curl', '-sSI', '-L', '-m', '90', url]); blocks = [b for b in r.stdout.replace('\r', '').split('\n\n') if b.strip().startswith('HTTP')]
    h = {}
    if blocks:
        for line in blocks[-1].split('\n')[1:]:
            if ':' in line: k, v = line.split(':', 1); h[k.strip().lower()] = v.strip()
    return h
def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for c in iter(lambda: f.read(1 << 22), b''): h.update(c)
    return h.hexdigest()
def geom_bytes(label_path, bps):
    t = open(label_path, errors='ignore').read()
    g = lambda k: int(re.search(r'\n\s*' + k + r'\s*=\s*(\d+)', t).group(1))
    return g('LINES') * g('LINE_SAMPLES') * bps
def load_manifest(): return json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {}
def save_manifest(m):
    with lock: json.dump(m, open(MANIFEST + '.tmp', 'w'), indent=1, ensure_ascii=False); os.replace(MANIFEST + '.tmp', MANIFEST)

def process(it, manifest, old_dir):
    dest = os.path.join(RAW, it['path']); os.makedirs(os.path.dirname(dest), exist_ok=True); rec = manifest.get(it['path'], {})
    if os.path.exists(dest) and rec.get('sha256') and os.path.getsize(dest) == rec.get('bytes'):
        log('já tem', it['path']); return
    if os.path.exists(dest): os.chmod(dest, 0o644)
    ok = False; err = ''
    for attempt in range(1, 4):
        hd = {} if it['kind'] == 'horizons' else head(it['url'])
        expected = int(hd['content-length']) if hd.get('content-length') else None
        part = dest + '.part'
        r = run(['curl', '-sS', '-L', '--fail', '--retry', '5', '--retry-delay', '5', '--retry-all-errors', '-C', '-', '-o', part, it['url']])
        if r.returncode != 0: err = r.stderr.strip()[:200]; log('falha', it['path'], err); continue
        size = os.path.getsize(part)
        if expected is not None and size != expected: err = f'tamanho {size} != servidor {expected}'; log('tamanho errado', it['path'], err); os.remove(part); continue
        if it['kind'] == 'horizons':
            txt = open(part, errors='ignore').read()
            if '$$SOE' not in txt or '$$EOE' not in txt: err = 'resposta sem tabela: ' + txt[:200].replace('\n', ' '); log('Horizons sem tabela', it['path'], err); os.remove(part); break
        geom_ok = None
        if it['kind'] == 'img':
            gb = geom_bytes(os.path.join(RAW, it['geom_label']), it['bytes_per_sample']); geom_ok = (gb == size)
            if not geom_ok: err = f'grade do rótulo prevê {gb} bytes, arquivo tem {size}'; log('grade não bate', it['path'], err); os.remove(part); continue
        os.replace(part, dest); digest = sha256(dest); os.chmod(dest, 0o444)
        rec = dict(url=it['url'], description=it['description'], group=it['group'], bytes=size, sha256=digest, retrieved_utc=datetime.datetime.utcnow().isoformat(timespec='seconds') + 'Z',
                   server_content_length=expected, server_last_modified=hd.get('last-modified'), server_etag=hd.get('etag'), server_content_type=hd.get('content-type'),
                   size_matches_server=(expected == size) if expected is not None else None, size_matches_label_grid=geom_ok)
        if old_dir:
            o = os.path.join(old_dir, os.path.basename(it['path']))
            if os.path.exists(o) and it['kind'] == 'img': rec['same_sha256_as_earlier_download'] = (sha256(o) == digest)
        manifest[it['path']] = rec; save_manifest(manifest); log('ok', it['path'], f'{size:,} B', digest[:12]); ok = True; break
    if not ok: manifest[it['path']] = dict(url=it['url'], description=it['description'], group=it['group'], failed=err or 'erro'); save_manifest(manifest); log('FALHOU', it['path'], err)

def verify():
    m = load_manifest(); bad = 0
    for p, r in m.items():
        f = os.path.join(RAW, p)
        if r.get('failed'): print('FALHA registrada:', p, r['failed']); bad += 1; continue
        if not os.path.exists(f): print('FALTA:', p); bad += 1; continue
        if os.path.getsize(f) != r['bytes'] or sha256(f) != r['sha256']: print('DIFERENTE:', p); bad += 1
    print(f'{len(m)} arquivos no manifesto, {bad} problemas'); return bad

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--verify', action='store_true'); ap.add_argument('--compare-old'); ap.add_argument('--workers', type=int, default=3); a = ap.parse_args()
    if a.verify: sys.exit(1 if verify() else 0)
    manifest = load_manifest()
    small = [i for i in ITEMS if i['kind'] != 'img' or i['group'] == 'illumination']; big = [i for i in ITEMS if i not in small]
    labels_first = [i for i in small if i['kind'] == 'label']; rest_small = [i for i in small if i['kind'] != 'label']
    for batch, w in ((labels_first + [i for i in rest_small if i['kind'] != 'img'], 4), ([i for i in rest_small if i['kind'] == 'img'], 3), (sorted(big, key=lambda i: i['path']), a.workers)):
        with ThreadPoolExecutor(w) as ex: list(ex.map(lambda it: process(it, manifest, a.compare_old), batch))
    log('conferindo tudo de novo...'); verify()
