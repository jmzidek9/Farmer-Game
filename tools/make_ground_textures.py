# Harvest Haven — bakes the realistic ground textures (grass/clover, tilled soil, sand) in Blender.
# Run: blender -b --factory-startup --python tools/make_ground_textures.py -- assets/textures
# Each surface is real geometry (blades, clover leaves, clods, grains) laid out on a 1 m tile that wraps,
# rendered straight down with an orthographic camera. Two seamless JPEGs per surface:
#   <name>_albedo.jpg  colour with the crevice shadows (ambient occlusion) baked in
#   <name>_data.jpg    R,G = surface normal x,y (0.5 = flat), B = roughness
#   <name>_height.jpg  height (white = top), for parallax occlusion; HEIGHT below gives the range in metres
import bpy, math, os, sys
import numpy as np

OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'assets/textures'
os.makedirs(OUT, exist_ok=True)
RES = 1024
SAMPLES = 24


def srgb(hexs):
    c = np.array([int(hexs[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def periodic_noise(n, power, rng):
    """Seamless noise on an n x n grid: random spectrum with a power-law falloff (FFT wraps by construction)."""
    f = np.fft.fftfreq(n)[:, None] ** 2 + np.fft.rfftfreq(n)[None, :] ** 2
    f[0, 0] = 1
    spec = (rng.normal(size=f.shape) + 1j * rng.normal(size=f.shape)) * f ** (-power / 2)
    spec[0, 0] = 0
    h = np.fft.irfft2(spec, s=(n, n))
    return (h - h.mean()) / (h.std() + 1e-9)


class Geo:
    """Collects triangles with per-vertex colour (linear) and roughness, then becomes one mesh."""
    def __init__(self):
        self.v, self.f, self.c, self.r, self.n = [], [], [], [], 0

    def add(self, verts, faces, cols, rough):
        verts = np.asarray(verts, float)
        self.v.append(verts)
        self.f.append(np.asarray(faces, int) + self.n)
        cols = np.asarray(cols, float)
        self.c.append(np.broadcast_to(cols, (len(verts), 3)) if cols.ndim == 1 else cols)
        self.r.append(np.broadcast_to(np.float64(rough), (len(verts),)) if np.ndim(rough) == 0 else np.asarray(rough, float))
        self.n += len(verts)

    def mesh(self, name):
        v, f = np.concatenate(self.v), np.concatenate(self.f)
        c, r = np.concatenate(self.c), np.concatenate(self.r)
        me = bpy.data.meshes.new(name)
        me.from_pydata(v.tolist(), [], f.tolist())
        me.update()
        col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        col.data.foreach_set('color', np.hstack([c, np.ones((len(c), 1))]).ravel())
        ra = me.attributes.new('Rough', 'FLOAT', 'POINT')
        ra.data.foreach_set('value', r)
        me.shade_smooth()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def wrapped(x, y, r):
    """The offsets at which an element centred at (x, y) with radius r must be drawn so the 1 m tile wraps."""
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if -r < x + dx < 1 + r and -r < y + dy < 1 + r:
                yield dx, dy


def heightfield(geo, n, h, cols, rough):
    """A 1 m grid (n x n cells, seamless) with heights h[n, n] and colours cols[n, n, 3]. It runs a few percent
    past the tile on every side (wrapped), so the render's edge pixels and the AO rays never see empty space."""
    m = max(4, n // 16)
    xs = np.arange(-m, n + m + 1) / n
    X, Y = np.meshgrid(xs, xs, indexing='xy')
    H = np.pad(h, ((m, m + 1), (m, m + 1)), mode='wrap')
    C = np.pad(cols, ((m, m + 1), (m, m + 1), (0, 0)), mode='wrap').reshape(-1, 3)
    R = np.pad(rough, ((m, m + 1), (m, m + 1)), mode='wrap').ravel() if np.ndim(rough) else rough
    v = np.stack([X.ravel(), Y.ravel(), H.ravel()], 1)
    w = n + 2 * m
    i = np.arange(w)[:, None] * (w + 1) + np.arange(w)[None, :]
    a, b, c, d = i, i + 1, i + w + 1, i + w + 2
    faces = np.concatenate([np.stack([a, b, d], -1).reshape(-1, 3), np.stack([a, d, c], -1).reshape(-1, 3)])
    geo.add(v, faces, C, R)


def ico():
    t = (1 + 5 ** 0.5) / 2
    v = np.array([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
                  [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]], float)
    f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
         [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
    # one subdivision: 42 verts, rounder lumps
    v = list(v / np.linalg.norm(v, axis=1)[:, None]); mid = {}
    def m(a, b):
        k = (min(a, b), max(a, b))
        if k not in mid:
            p = (v[a] + v[b]) / 2; v.append(p / np.linalg.norm(p)); mid[k] = len(v) - 1
        return mid[k]
    nf = []
    for a, b, c in f:
        ab, bc, ca = m(a, b), m(b, c), m(c, a)
        nf += [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]
    return np.array(v), np.array(nf)


ICO_V, ICO_F = ico()


def lump(geo, rng, x, y, z, sx, sy, sz, col, rough, jit=0.18, rot=None):
    v = ICO_V * (1 + rng.uniform(-jit, jit, (len(ICO_V), 1)))
    v = v * [sx, sy, sz]
    a = rng.uniform(0, math.tau) if rot is None else rot
    ca, sa = math.cos(a), math.sin(a)
    v = v @ np.array([[ca, sa, 0], [-sa, ca, 0], [0, 0, 1]])
    shade = 1 + rng.uniform(-0.12, 0.12, (len(v), 1))
    for dx, dy in wrapped(x, y, max(sx, sy)):
        geo.add(v + [x + dx, y + dy, z], ICO_F, np.clip(col * shade, 0, 1), rough)


# ------------------------------------------------------------------------------------------- scene + render
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = False
    sc.render.resolution_x = sc.render.resolution_y = RES
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.dither_intensity = 0
    sc.cycles.filter_width = 0.01   # box filter: samples stay inside each pixel, nothing from beyond the tile edge leaks in
    sc.render.image_settings.file_format = 'JPEG'
    sc.render.image_settings.quality = 92
    world = bpy.data.worlds.new('w'); world.color = (0, 0, 0); sc.world = world
    cam = bpy.data.cameras.new('cam'); cam.type = 'ORTHO'; cam.ortho_scale = 1.0; cam.clip_end = 100
    co = bpy.data.objects.new('cam', cam); co.location = (0.5, 0.5, 10); sc.collection.objects.link(co); sc.camera = co
    return sc


HEIGHT = {'grass': (-0.004, 0.05), 'soil': (-0.004, 0.02), 'sand': (-0.006, 0.006)}   # metres at black / white in <name>_height.jpg


def material(kind, ao_dist, hr=(0, 1)):
    m = bpy.data.materials.new(kind)
    m.use_nodes = True
    nt = m.node_tree; N = nt.nodes; L = nt.links
    for n in list(N): N.remove(n)
    out = N.new('ShaderNodeOutputMaterial'); em = N.new('ShaderNodeEmission')
    L.new(em.outputs[0], out.inputs['Surface'])
    col = N.new('ShaderNodeAttribute'); col.attribute_name = 'Col'
    rough = N.new('ShaderNodeAttribute'); rough.attribute_name = 'Rough'
    if kind == 'albedo':
        ao = N.new('ShaderNodeAmbientOcclusion'); ao.samples = 16; ao.inputs['Distance'].default_value = ao_dist
        mr = N.new('ShaderNodeMapRange'); mr.inputs['To Min'].default_value = 0.42
        L.new(ao.outputs['AO'], mr.inputs['Value'])
        mul = N.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY'
        L.new(col.outputs['Color'], mul.inputs[0]); L.new(mr.outputs['Result'], mul.inputs[1])
        L.new(mul.outputs[0], em.inputs['Color'])
    elif kind == 'height':
        geo = N.new('ShaderNodeNewGeometry'); sep = N.new('ShaderNodeSeparateXYZ')
        L.new(geo.outputs['Position'], sep.inputs[0])
        mr = N.new('ShaderNodeMapRange'); mr.inputs['From Min'].default_value = hr[0]; mr.inputs['From Max'].default_value = hr[1]
        L.new(sep.outputs['Z'], mr.inputs['Value'])
        L.new(mr.outputs['Result'], em.inputs['Color'])
    else:   # data: normal x,y remapped to 0..1, roughness in blue
        geo = N.new('ShaderNodeNewGeometry')
        flip = N.new('ShaderNodeMath'); flip.operation = 'MULTIPLY_ADD'
        flip.inputs[1].default_value = -2; flip.inputs[2].default_value = 1
        L.new(geo.outputs['Backfacing'], flip.inputs[0])
        nn = N.new('ShaderNodeVectorMath'); nn.operation = 'SCALE'
        L.new(geo.outputs['Normal'], nn.inputs[0]); L.new(flip.outputs[0], nn.inputs['Scale'])
        sep = N.new('ShaderNodeSeparateXYZ'); L.new(nn.outputs[0], sep.inputs[0])
        rx = N.new('ShaderNodeMath'); rx.operation = 'MULTIPLY_ADD'; rx.inputs[1].default_value = .5; rx.inputs[2].default_value = .5
        ry = N.new('ShaderNodeMath'); ry.operation = 'MULTIPLY_ADD'; ry.inputs[1].default_value = .5; ry.inputs[2].default_value = .5
        L.new(sep.outputs['X'], rx.inputs[0]); L.new(sep.outputs['Y'], ry.inputs[0])
        comb = N.new('ShaderNodeCombineXYZ')
        L.new(rx.outputs[0], comb.inputs['X']); L.new(ry.outputs[0], comb.inputs['Y']); L.new(rough.outputs['Fac'], comb.inputs['Z'])
        L.new(comb.outputs[0], em.inputs['Color'])
    return m


def render(sc, name, ao_dist):
    for kind in ('albedo', 'data', 'height'):
        m = material(kind, ao_dist, HEIGHT[name])
        for ob in sc.collection.objects:
            if ob.type == 'MESH':
                ob.data.materials.clear(); ob.data.materials.append(m)
        sc.view_settings.view_transform = 'Standard' if kind == 'albedo' else 'Raw'
        sc.view_settings.look = 'None'
        sc.render.filepath = os.path.abspath(os.path.join(OUT, f'{name}_{kind}.jpg'))
        bpy.ops.render.render(write_still=True)
        print('wrote', sc.render.filepath)


# ------------------------------------------------------------------------------------------- grass + clover
def grass():
    sc = reset(); rng = np.random.default_rng(11); g = Geo()
    n = 256
    # under-layer: dark earth and thatch, mostly hidden
    h = periodic_noise(n, 2.4, rng) * 0.002
    t = periodic_noise(n, 1.6, rng)
    base = np.where(t[..., None] > 0.3, srgb('#4a4326'), srgb('#24301a')) * (0.8 + 0.4 * rng.random((n, n, 1)))
    heightfield(g, n, h, base, 0.95)
    # where clover grows (big soft patches) and where the grass is sun-dried
    clov = periodic_noise(64, 2.3, rng); dry = periodic_noise(64, 2.3, rng)
    at = lambda F, x, y: F[int(y % 1 * 64) % 64, int(x % 1 * 64) % 64]
    greens = [srgb(c) for c in ('#3f6b25', '#4d7d2b', '#5b8a31', '#6b9a38', '#365f22', '#7aa43f')]
    straw = [srgb(c) for c in ('#9a9455', '#a8a060', '#8b8a4c')]
    seg = 5
    for k in range(16000):   # blades: tapered, leaning over, curling down at the tip
        x, y = rng.random(2)
        if at(clov, x, y) > 0.9 and rng.random() < 0.6: continue
        a = rng.uniform(0, math.tau); L = rng.uniform(0.035, 0.085); w = rng.uniform(0.0025, 0.0045)
        lean = rng.uniform(0.15, 0.75)
        d = np.array([math.cos(a), math.sin(a)]); side = np.array([-d[1], d[0]])
        drift = at(dry, x, y)
        col = straw[rng.integers(3)] if rng.random() < 0.035 + max(0, drift - 1.2) * 0.12 else greens[rng.integers(len(greens))]
        col = col * rng.uniform(0.85, 1.15)
        vs, cs = [], []
        for i in range(seg + 1):
            s = i / seg; ww = w * (1 - s * 0.9)
            p = d * L * s * math.cos(lean * (1 - s * 0.5))
            z = 0.002 + L * s * math.sin(lean) * (1 - s) * 1.2
            for sgn in (-1, 1):
                vs.append([p[0] + side[0] * ww * sgn, p[1] + side[1] * ww * sgn, z])
                cs.append(col * (0.55 + 0.6 * s))   # darker at the root, sunlit tip
        faces = [[2 * i, 2 * i + 1, 2 * i + 3] for i in range(seg)] + [[2 * i, 2 * i + 3, 2 * i + 2] for i in range(seg)]
        vs = np.array(vs)
        for dx, dy in wrapped(x, y, L):
            g.add(vs + [x + dx, y + dy, 0], faces, np.array(cs), 0.75)
    # clover: three heart-shaped leaflets with a pale chevron, in patches
    leafc = [srgb(c) for c in ('#3e7a2e', '#4a8a34', '#356b28', '#55963a')]
    ring = 14
    for k in range(5200):
        x, y = rng.random(2)
        if at(clov, x, y) < 0.7 + rng.random() * 0.5: continue
        s = rng.uniform(0.006, 0.012); z0 = rng.uniform(0.004, 0.02); rot = rng.uniform(0, math.tau)
        col = leafc[rng.integers(len(leafc))] * rng.uniform(0.85, 1.12)
        for j in range(3):
            a = rot + j * math.tau / 3
            vs, cs = [[0, 0, 0]], [col * 1.25]
            for i in range(ring):
                t2 = i / ring * math.tau
                r = (1 - 0.55 * math.exp(-((t2 - math.pi) ** 2) / 0.06)) * (0.75 + 0.25 * math.sin(t2 / 2))   # notch at the tip
                px, py = (math.cos(t2) * 0.55 + 0.55) * r, math.sin(t2) * 0.48 * r
                vs.append([px, py, 0.08 * (px ** 2 + py ** 2)])
                cs.append(col * (1.12 if 0.2 < math.hypot(px - 0.45, py) < 0.3 else 1.0))
            vs = np.array(vs) * s
            ca, sa = math.cos(a), math.sin(a)
            vs = vs @ np.array([[ca, sa, 0], [-sa, ca, 0], [0, 0, 1]])
            faces = [[0, 1 + i, 1 + (i + 1) % ring] for i in range(ring)]
            for dx, dy in wrapped(x, y, s * 1.2):
                g.add(vs + [x + dx, y + dy, z0], faces, np.array(cs), 0.55)
    # a few small flowers only
    for k in range(7):
        x, y = rng.random(2); white = rng.random() < 0.6
        col = srgb('#f2efe2') if white else srgb('#e8c23a')
        lump(g, rng, x, y, 0.022, 0.006, 0.006, 0.003, col, 0.6, jit=0.3)
        lump(g, rng, x, y, 0.025, 0.002, 0.002, 0.0015, srgb('#d9a520'), 0.6, jit=0.1)
    g.mesh('grass'); render(sc, 'grass', 0.025)


# ------------------------------------------------------------------------------------------- tilled soil
def soil():
    sc = reset(); rng = np.random.default_rng(23); g = Geo()
    n = 320
    h = periodic_noise(n, 2.6, rng) * 0.0012 + periodic_noise(n, 1.4, rng) * 0.0005
    tone = periodic_noise(n, 2.0, rng)
    browns = np.where(tone[..., None] > 0, srgb('#5a3a24'), srgb('#47301e'))
    heightfield(g, n, h, browns * (0.85 + 0.3 * rng.random((n, n, 1))), 0.92)
    cl = [srgb(c) for c in ('#5e4029', '#6b4a30', '#553823', '#76533a', '#4a311f')]
    for k in range(26000):  # crumbly clods, half buried: lots of fine crumbs, the odd big clod
        x, y = rng.random(2); r = 0.0018 * rng.pareto(2.6) + 0.0016
        r = min(r, 0.014)
        c = cl[rng.integers(len(cl))] * rng.uniform(0.85, 1.12) * (0.85 + 0.25 * min(r / 0.008, 1))   # big clods dry paler
        lump(g, rng, x, y, 0.0, r, r * rng.uniform(0.7, 1.1), r * rng.uniform(0.55, 0.85), c, 0.9, jit=0.3)
    for k in range(45):     # pebbles
        x, y = rng.random(2); r = rng.uniform(0.003, 0.008)
        lump(g, rng, x, y, 0.001, r * 1.2, r, r * 0.6, srgb('#857767') * rng.uniform(0.85, 1.15), 0.5, jit=0.08)
    for k in range(10):     # bits of straw and root
        x, y = rng.random(2); a = rng.uniform(0, math.tau); L = rng.uniform(0.02, 0.05); w = 0.0012
        d = np.array([math.cos(a), math.sin(a)]); s = np.array([-d[1], d[0]])
        vs = np.array([[*(-d * L / 2 + s * w), 0.004], [*(-d * L / 2 - s * w), 0.004], [*(d * L / 2 + s * w), 0.006], [*(d * L / 2 - s * w), 0.006]])
        for dx, dy in wrapped(x, y, L):
            g.add(vs + [x + dx, y + dy, 0], [[0, 1, 3], [0, 3, 2]], srgb('#8f7a4e') * rng.uniform(0.8, 1.1), 0.8)
    g.mesh('soil'); render(sc, 'soil', 0.02)


# ------------------------------------------------------------------------------------------- sand
def sand():
    sc = reset(); rng = np.random.default_rng(37); g = Geo()
    n = 512
    h = periodic_noise(n, 2.2, rng) * 0.0015 + periodic_noise(n, 0.6, rng) * 0.00025
    grains = rng.random((n, n))
    pal = np.array([srgb(c) for c in ('#e3cf9f', '#d9c391', '#eedcb0', '#cdb382', '#f4e7c6', '#b89c6d')])
    pick = np.digitize(grains, [0.32, 0.6, 0.8, 0.9, 0.97])
    cols = pal[pick] * (0.92 + 0.12 * periodic_noise(n, 2.0, rng)[..., None] * 0.5)
    heightfield(g, n, h, np.clip(cols, 0, 1), 0.9)
    for k in range(900):    # coarse grains and tiny shell bits that catch the light
        x, y = rng.random(2); r = rng.uniform(0.0008, 0.0022)
        c = srgb('#fbf3e4') if rng.random() < 0.5 else srgb('#9c8463')
        lump(g, rng, x, y, 0.0, r, r, r * 0.6, c * rng.uniform(0.9, 1.1), 0.45, jit=0.2)
    for k in range(10):     # shell fragments
        x, y = rng.random(2); r = rng.uniform(0.004, 0.009)
        lump(g, rng, x, y, 0.0, r * 1.3, r, r * 0.35, srgb('#f1e4d0') * rng.uniform(0.9, 1.05), 0.35, jit=0.12)
    g.mesh('sand'); render(sc, 'sand', 0.012)


for job in (grass, soil, sand):
    job()
