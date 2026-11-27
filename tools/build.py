# Packs the game into single HTML files that run by double-clicking them (file://).
# Browsers block local module/asset loads from file://, so every module becomes a data: URL
# in the import map and the models are inlined. Two versions are built:
#   Harvest Haven - Realistic.html  from the repo root (src/, assets/)
#   Harvest Haven - Low Poly.html   from lowpoly/ (the original low-poly look)
# Run after changing code or models:
#   python tools/build.py            (both)
#   python tools/build.py realistic  (or: lowpoly)
import base64, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
b64 = lambda data: base64.b64encode(data).decode()

def build(base, out_name):
    def read(p, mode='r'):
        with open(os.path.join(base, p), mode, **({} if 'b' in mode else {'encoding': 'utf-8'})) as f:
            return f.read()
    exists = lambda p: os.path.exists(os.path.join(base, p))

    html = read('index.html')
    imports = json.loads(re.search(r'<script type="importmap">(.*?)</script>', html, re.S).group(1))['imports']
    for f in sorted(os.listdir(os.path.join(base, 'src'))):
        if f.endswith('.js'):
            src = re.sub(r"""from\s+(['"])\./(\w+)\.js\1""", r"from 'hh/\2'", read('src/' + f))
            imports['hh/' + f[:-3]] = 'data:text/javascript;base64,' + b64(src.encode())

    pack = {'glb': 'data:model/gltf-binary;base64,' + b64(read('assets/models.glb', 'rb')),
            'heights': 'data:application/json;base64,' + b64(read('assets/heights.json', 'rb'))}
    if exists('assets/mountain.glb'):
        pack['mountain'] = 'data:model/gltf-binary;base64,' + b64(read('assets/mountain.glb', 'rb'))
    if exists('assets/textures'):
        pack['tex'] = {f[:-4]: ('data:image/png;base64,' if f.endswith('.png') else 'data:image/jpeg;base64,') + b64(read('assets/textures/' + f, 'rb'))
                       for f in sorted(os.listdir(os.path.join(base, 'assets/textures'))) if f.endswith(('.jpg', '.png'))}

    html = re.sub(r'<script type="importmap">.*?</script>', lambda _: '<script type="importmap">' + json.dumps({'imports': imports}) + '</script>', html, flags=re.S)
    html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>' + read('styles.css') + '</style>')
    html = html.replace('<script type="module" src="src/main.js"></script>',
                        '<script>window.HH_PACK=' + json.dumps(pack) + '</script>\n  <script type="module">import "hh/main";</script>')
    out = os.path.join(ROOT, out_name)
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print('wrote', out, round(os.path.getsize(out) / 1e6, 1), 'MB')

VERSIONS = {'realistic': (ROOT, 'Harvest Haven - Realistic.html'),
            'lowpoly': (os.path.join(ROOT, 'lowpoly'), 'Harvest Haven - Low Poly.html')}
for name in (sys.argv[1:] or VERSIONS):
    build(*VERSIONS[name])
