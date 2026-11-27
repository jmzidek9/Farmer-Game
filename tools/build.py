# Packs the game into one "Harvest Haven.html" that runs by double-clicking it (file://).
# Browsers block local module/asset loads from file://, so every module becomes a data: URL
# in the import map and the models are inlined. Run after changing code or models:
#   python tools/build.py
import base64, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
read = lambda p, mode='r': open(os.path.join(ROOT, p), mode, **({} if 'b' in mode else {'encoding': 'utf-8'})).read()
b64 = lambda data: base64.b64encode(data).decode()

html = read('index.html')
imports = json.loads(re.search(r'<script type="importmap">(.*?)</script>', html, re.S).group(1))['imports']
for f in sorted(os.listdir(os.path.join(ROOT, 'src'))):
    if f.endswith('.js'):
        src = re.sub(r"""from\s+(['"])\./(\w+)\.js\1""", r"from 'hh/\2'", read('src/' + f))
        imports['hh/' + f[:-3]] = 'data:text/javascript;base64,' + b64(src.encode())

pack = {'glb': 'data:model/gltf-binary;base64,' + b64(read('assets/models.glb', 'rb')),
        'mountain': 'data:model/gltf-binary;base64,' + b64(read('assets/mountain.glb', 'rb')),
        'heights': 'data:application/json;base64,' + b64(read('assets/heights.json', 'rb')),
        'tex': {f[:-4]: ('data:image/png;base64,' if f.endswith('.png') else 'data:image/jpeg;base64,') + b64(read('assets/textures/' + f, 'rb'))
                for f in sorted(os.listdir(os.path.join(ROOT, 'assets/textures'))) if f.endswith(('.jpg', '.png'))}}

html = re.sub(r'<script type="importmap">.*?</script>', lambda _: '<script type="importmap">' + json.dumps({'imports': imports}) + '</script>', html, flags=re.S)
html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>' + read('styles.css') + '</style>')
html = html.replace('<script type="module" src="src/main.js"></script>',
                    '<script>window.HH_PACK=' + json.dumps(pack) + '</script>\n  <script type="module">import "hh/main";</script>')
out = os.path.join(ROOT, 'Harvest Haven.html')
open(out, 'w', encoding='utf-8').write(html)
print('wrote', out, round(os.path.getsize(out) / 1e6, 1), 'MB')
