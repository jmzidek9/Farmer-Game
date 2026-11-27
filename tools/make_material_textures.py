# Harvest Haven — bakes the detail textures every model is painted with, the same way as the ground textures:
# real geometry (grain ridges, leaves, straw, stones, threads...) on a 1 unit tile that wraps, rendered straight
# down in Cycles with the crevice shadows baked in.
# Run: blender -b --factory-startup --python tools/make_material_textures.py -- assets/textures
# Writes mat_<name>_albedo.jpg / _data.jpg / _height.jpg for each name in MATERIALS (same layout as the ground
# textures). The game divides each albedo by its average colour, so the model's own colour tints the detail.
import math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_ground_textures as G
from make_ground_textures import Geo, heightfield, lump, wrapped, periodic_noise, srgb

G.RES = 512
G.SAMPLES = 20
OUT = G.OUT
# texture layer order in the game (src/assets.js MAT_LAYERS must match)
MATERIALS = ['wood', 'bark', 'leaf', 'stone', 'thatch', 'fabric', 'metal', 'organic', 'plaster', 'cliff']


def aniso_noise(n, power, sx, sy, rng):
    """seamless noise stretched along one axis: features sx times finer across x than... (sy along y)"""
    fx = np.fft.fftfreq(n)[:, None] * sy
    fy = np.fft.rfftfreq(n)[None, :] * sx
    f = fx ** 2 + fy ** 2
    f[0, 0] = 1
    spec = (rng.normal(size=f.shape) + 1j * rng.normal(size=f.shape)) * f ** (-power / 2)
    spec[0, 0] = 0
    h = np.fft.irfft2(spec, s=(n, n))
    return (h - h.mean()) / (h.std() + 1e-9)


def voronoi(n, k, rng, aspect=(1.0, 1.0)):
    """seamless F1, F2 distances and cell id for k random points on the unit tile"""
    pts = rng.random((k, 2))
    ys, xs = np.mgrid[0:n, 0:n] / n
    f1 = np.full((n, n), 9.0); f2 = np.full((n, n), 9.0); cid = np.zeros((n, n), int)
    for i, (px, py) in enumerate(pts):
        dx = np.abs(xs - px); dx = np.minimum(dx, 1 - dx) * aspect[0]
        dy = np.abs(ys - py); dy = np.minimum(dy, 1 - dy) * aspect[1]
        d = np.hypot(dx, dy)
        closer = d < f1
        f2 = np.where(closer, f1, np.minimum(f2, d)); cid = np.where(closer, i, cid); f1 = np.where(closer, d, f1)
    return f1, f2, cid


def strip(g, x, y, z0, d, L, w, col, rough, seg=6, lift=0.0, curl=0.0):
    """a flat tapered strand lying along direction d (straw, a blade of a leaf midrib...)"""
    side = np.array([-d[1], d[0]])
    vs, cs = [], []
    for i in range(seg + 1):
        s = i / seg; ww = w * (1 - s * 0.6)
        p = d * L * s
        z = z0 + lift * math.sin(s * math.pi) + curl * s * s
        for sg in (-1, 1):
            vs.append([p[0] + side[0] * ww * sg, p[1] + side[1] * ww * sg, z]); cs.append(col * (0.8 + 0.35 * math.sin(s * math.pi)))
    faces = [[2 * i, 2 * i + 1, 2 * i + 3] for i in range(seg)] + [[2 * i, 2 * i + 3, 2 * i + 2] for i in range(seg)]
    vs = np.array(vs)
    for dx, dy in wrapped(x, y, L):
        g.add(vs + [x + dx, y + dy, 0], faces, np.array(cs), rough)


# --------------------------------------------------------------------------------------------- the materials
def wood(g, rng):   # sawn planks: four boards across the tile, grain along x, seams, knots, nail heads
    n = 512
    ys, xs = np.mgrid[0:n, 0:n] / n
    warp = aniso_noise(n, 2.2, 8, 1, rng) * 0.035
    board = np.floor(ys * 4).astype(int)
    rings = np.sin((ys * 4 % 1 + warp + board * 0.37) * 2 * math.pi * 11 + aniso_noise(n, 1.8, 10, 1, rng) * 2.2)
    fib = aniso_noise(n, 1.1, 30, 1, rng)
    h = rings * 0.0012 + fib * 0.0005
    seam = np.abs(ys * 4 - np.round(ys * 4)) * 0.25 / 4
    h -= 0.004 * (1 - np.clip(seam / 0.0035, 0, 1))
    tone = 0.84 + 0.07 * rings + 0.1 * fib + (board % 3 - 1) * 0.06
    kn = np.zeros((n, n))
    for _ in range(5):   # knots: dark rings stretched along the grain
        kx, ky = rng.random(2); r = rng.uniform(0.015, 0.03)
        dx = np.minimum(np.abs(xs - kx), 1 - np.abs(xs - kx)) / 2.2; dy = np.minimum(np.abs(ys - ky), 1 - np.abs(ys - ky))
        d = np.hypot(dx, dy) / r
        kn = np.maximum(kn, np.clip(1.2 - d, 0, 1) * (0.6 + 0.4 * np.sin(d * 14)))
    tone *= 1 - kn * 0.45
    tone *= np.where(seam < 0.002, 0.55, 1.0)
    cols = srgb('#a77a4c') * tone[..., None]
    heightfield(g, n, h, np.clip(cols, 0, 1), 0.7 + 0.15 * (rings > 0))
    for b in range(4):   # nail heads near each board's ends
        for x in (0.06, 0.56):
            for yy in (b / 4 + 0.07, b / 4 + 0.18):
                lump(g, rng, x + rng.uniform(-0.01, 0.01), yy, 0.0, 0.006, 0.006, 0.0025, srgb('#4a4744'), 0.35, jit=0.05)


def bark(g, rng):   # deep furrows running up the trunk between corky ridges, broken across now and then, with lichen
    n = 512
    ys, xs = np.mgrid[0:n, 0:n] / n
    u = xs * 12 + aniso_noise(n, 2.4, 1, 10, rng) * 0.9 + aniso_noise(n, 1.6, 1, 6, rng) * 0.12
    r = 1 - np.abs(2 * (u % 1) - 1)
    ridge = np.clip(r * 1.25, 0, 1) ** 0.6
    f1, f2, cid = voronoi(n, 60, rng, aspect=(1.0, 0.2))
    brk = np.clip((f2 - f1 + periodic_noise(n, 1.2, rng) * 0.002) / 0.004, 0, 1)
    fine = aniso_noise(n, 1.0, 1, 4, rng)
    h = ridge * 0.012 + fine * 0.001 - 0.003 * (1 - brk) * ridge
    tone = 0.45 + 0.55 * ridge + 0.06 * fine + (rng.random(60)[cid] - 0.5) * 0.12
    tone *= np.where(brk < 0.4, 0.75, 1.0)
    cols = srgb('#7a6450') * tone[..., None]
    lich = periodic_noise(n, 1.5, rng) + periodic_noise(n, 2.4, rng) * 0.6
    lm = np.clip((lich - 1.9) * 1.5, 0, 0.7)[..., None] * (ridge[..., None] > 0.6)
    cols = cols * (1 - lm) + srgb('#9aa070') * lm * (0.8 + 0.4 * rng.random((n, n, 1)))
    heightfield(g, n, h, np.clip(cols, 0, 1), 0.92)

def leaf(g, rng):   # a dense mat of overlapping leaves, each with a midrib and a lighter edge
    n = 128
    heightfield(g, n, periodic_noise(n, 2, rng) * 0.002 - 0.03, np.broadcast_to(srgb('#1d3315'), (n, n, 3)).copy(), 0.9)
    greens = [srgb(c) for c in ('#3f7a2e', '#4c8a34', '#2f6526', '#5a9a3c', '#6aa848', '#7bb24e', '#3a6e2a')]
    ring = 16
    for k in range(1100):
        x, y = rng.random(2); L = rng.uniform(0.07, 0.15); W = L * rng.uniform(0.32, 0.45)
        a = rng.uniform(0, math.tau); z0 = rng.uniform(0, 0.03)
        col = greens[rng.integers(len(greens))] * rng.uniform(0.85, 1.12)
        vs, cs = [[0.0, 0.0, 0.0]], [col * 0.9]
        for i in range(ring):
            t = i / ring * math.tau
            px = (math.cos(t) * 0.5 + 0.5) * L; py = math.sin(t) * 0.5 * W * math.sin(max(0.05, (math.cos(t) * 0.5 + 0.5)) * math.pi) ** 0.6
            vs.append([px, py, 0.18 * L * (px / L) * (1 - px / L) + 0.04 * L * abs(py) / W]); cs.append(col * 1.08)
        vs = np.array(vs) - [L * 0.5, 0, 0]
        ca, sa = math.cos(a), math.sin(a)
        vs = vs @ np.array([[ca, sa, 0], [-sa, ca, 0], [0, 0, 1]])
        faces = [[0, 1 + i, 1 + (i + 1) % ring] for i in range(ring)]
        for dx, dy in wrapped(x, y, L):
            g.add(vs + [x + dx, y + dy, z0], faces, np.array(cs), 0.55)
        d = np.array([ca, sa])   # midrib, a pale line down the middle
        strip(g, x - d[0] * L * 0.48, y - d[1] * L * 0.48, z0 + 0.004, d, L * 0.9, L * 0.012, col * 1.35, 0.5, seg=4, lift=0.04 * L)


def stone(g, rng):   # granite-ish: crystals, pits, hairline cracks, specks and the odd lichen patch
    n = 512
    f1, f2, cid = voronoi(n, 9, rng)
    crack = np.clip((f2 - f1) / 0.003, 0, 1) ** 0.6
    big = periodic_noise(n, 2.6, rng); mid = periodic_noise(n, 1.8, rng); fine = periodic_noise(n, 0.9, rng)
    h = big * 0.006 + mid * 0.0015 + fine * 0.0006 - 0.003 * (1 - crack)
    tone = 0.84 + 0.07 * big + 0.06 * mid + 0.05 * fine
    spk = rng.random((n, n))
    cols = srgb('#8c8a84') * tone[..., None]
    cols = np.where(spk[..., None] > 0.985, srgb('#2e2d2b'), cols)
    cols = np.where(spk[..., None] < 0.01, srgb('#d8d4ca'), cols)
    cols = cols * np.where(crack[..., None] < 0.4, 0.7, 1.0)
    lich = np.clip((periodic_noise(n, 1.5, rng) + periodic_noise(n, 2.4, rng) * 0.5 - 2.0) * 2, 0, 0.8)[..., None]
    cols = cols * (1 - lich * 0.7) + srgb('#a7a97a') * lich * 0.7
    heightfield(g, n, h, np.clip(cols, 0, 1), 0.85)
    for k in range(60):
        x, y = rng.random(2); r = rng.uniform(0.004, 0.012)
        lump(g, rng, x, y, -0.002, r, r * 0.8, r * 0.4, srgb('#7d7a73') * rng.uniform(0.8, 1.15), 0.8, jit=0.25)


def thatch(g, rng):   # layered straw bundles hanging down the roof (along -y), golden to weathered grey
    n = 64
    heightfield(g, n, np.zeros((n, n)) - 0.02, np.broadcast_to(srgb('#4a3d22'), (n, n, 3)).copy(), 0.95)
    straws = [srgb(c) for c in ('#c9a85a', '#d8b867', '#b8964c', '#a88a4a', '#e0c47a', '#9c8f72')]
    for row in range(5):
        y0 = row / 5
        for k in range(1500):
            x = rng.random(); y = (y0 + rng.uniform(0, 0.12)) % 1
            a = -math.pi / 2 + rng.normal(0, 0.12); d = np.array([math.cos(a), math.sin(a)])
            L = rng.uniform(0.18, 0.3); w = rng.uniform(0.002, 0.0035)
            col = straws[rng.integers(len(straws))] * rng.uniform(0.85, 1.1)
            strip(g, x, y, 0.004 * row + rng.uniform(0, 0.01), d, L, w, col, 0.85, seg=5, lift=0.006, curl=-0.006)


def fabric(g, rng):   # plain weave: over-under threads with a little fibre fuzz; white so the model colour shows
    n = 512
    ys, xs = np.mgrid[0:n, 0:n] / n
    N = 48
    u, v = xs * N, ys * N
    warp_h = np.abs(np.sin(v * math.pi)) * np.where((np.floor(u) + np.floor(v)) % 2 == 0, 1, 0.55)
    weft_h = np.abs(np.sin(u * math.pi)) * np.where((np.floor(u) + np.floor(v)) % 2 == 1, 1, 0.55)
    thread = np.maximum(warp_h, weft_h)
    fuzz = periodic_noise(n, 0.8, rng)
    h = thread * 0.0018 + fuzz * 0.0002 + periodic_noise(n, 2.6, rng) * 0.002
    tone = 0.78 + 0.22 * thread + 0.05 * fuzz + 0.04 * periodic_noise(n, 2.0, rng)
    heightfield(g, n, h, np.clip(srgb('#e8e2d4') * tone[..., None], 0, 1), 0.92)


def metal(g, rng):   # brushed steel with dents, scratches and spots of rust
    n = 512
    brush = aniso_noise(n, 0.9, 1, 40, rng)
    dent = periodic_noise(n, 3.0, rng)
    h = brush * 0.0002 + dent * 0.0015
    tone = 0.9 + 0.05 * brush + 0.05 * dent
    rough = np.clip(0.35 + 0.1 * brush, 0.2, 0.6)
    rust = np.clip((periodic_noise(n, 2.2, rng) - 1.4) * 2, 0, 1)[..., None]
    cols = srgb('#a3a7aa') * tone[..., None] * (1 - rust) + srgb('#8a4f2c') * rust * (0.7 + 0.5 * rng.random((n, n, 1)))
    rough = rough * (1 - rust[..., 0]) + 0.9 * rust[..., 0]
    heightfield(g, n, h, np.clip(cols, 0, 1), rough)
    for k in range(70):   # scratches
        x, y = rng.random(2); a = rng.uniform(0, math.tau)
        strip(g, x, y, 0.0006, np.array([math.cos(a), math.sin(a)]), rng.uniform(0.05, 0.2), 0.0012, srgb('#d5d9dc'), 0.25, seg=3)


def organic(g, rng):   # skin, hide, fruit peel: fine pores, soft mottling, short hairs
    n = 512
    pores = periodic_noise(n, 0.4, rng); mott = periodic_noise(n, 2.4, rng)
    h = mott * 0.0015 + pores * 0.0002 - (pores > 2.2) * 0.0008
    tone = 0.88 + 0.08 * mott - 0.1 * (pores > 2.0)
    heightfield(g, n, h, np.clip(srgb('#d9c4ae') * tone[..., None], 0, 1), 0.7)
    for k in range(2500):   # short hairs, mostly lying one way
        x, y = rng.random(2); a = 0.4 + rng.normal(0, 0.35)
        strip(g, x, y, 0.0005, np.array([math.cos(a), math.sin(a)]), rng.uniform(0.015, 0.03), 0.0011, srgb('#c9b29a') * rng.uniform(0.85, 1.1), 0.75, seg=2, lift=0.002)


def plaster(g, rng):   # lime render: trowel swirls, grit, pits and hairline cracks
    n = 512
    swirl = periodic_noise(n, 2.4, rng); grit = periodic_noise(n, 0.5, rng)
    f1, f2, _ = voronoi(n, 14, rng)
    crack = np.clip((f2 - f1) / 0.004, 0, 1) ** 0.4
    h = swirl * 0.002 + grit * 0.0003 - 0.0015 * (1 - crack) - (grit > 2.4) * 0.001
    tone = 0.9 + 0.06 * swirl + 0.03 * grit
    cols = srgb('#e6ddcc') * tone[..., None] * np.where(crack < 0.5, 0.75, 1.0)[..., None]
    heightfield(g, n, h, np.clip(cols, 0, 1), 0.93)


def cliff(g, rng):   # mountain cliff (4 m tile): sedimentary bands, blocky joints, ledges with moss and grit
    n = 512
    ys, xs = np.mgrid[0:n, 0:n] / n
    bandw = aniso_noise(n, 2.5, 6, 1, rng) * 0.03
    band = np.sin((ys + bandw) * 2 * math.pi * 7) * 0.5 + 0.5
    f1, f2, cid = voronoi(n, 30, rng, aspect=(0.3, 1.0))
    joint = np.clip((f2 - f1 + periodic_noise(n, 1.4, rng) * 0.004) / 0.006, 0, 1) ** 0.6
    blocks = rng.random(55)[cid]
    big = periodic_noise(n, 2.8, rng); fine = periodic_noise(n, 1.1, rng)
    h = band * 0.03 + blocks * 0.03 + big * 0.02 + fine * 0.002 - 0.04 * (1 - joint)
    tone = 0.75 + 0.15 * band + 0.12 * (blocks - 0.5) + 0.06 * big + 0.04 * fine
    cols = srgb('#8b867c') * tone[..., None]
    cols = cols * (1 - 0.25 * (band[..., None] > 0.8)) + srgb('#a08a6c') * 0.25 * (band[..., None] > 0.8)   # iron-stained bands
    cols = cols * np.where(joint[..., None] < 0.35, 0.6, 1.0)
    moss = np.clip((periodic_noise(n, 2.0, rng) * 0.6 + (1 - joint) * 1.5 - 1.2) * 2, 0, 1)[..., None]
    cols = cols * (1 - moss) + srgb('#55783a') * moss * (0.8 + 0.4 * rng.random((n, n, 1)))
    heightfield(g, n, h, np.clip(cols, 0, 1), 0.88)
    for k in range(400):   # grit and pebbles on the ledges
        x, y = rng.random(2); r = rng.uniform(0.002, 0.008)
        lump(g, rng, x, y, 0.035, r, r, r * 0.6, srgb('#7f7a70') * rng.uniform(0.8, 1.2), 0.85, jit=0.25)


G.HEIGHT.update({'mat_wood': (-0.006, 0.004), 'mat_bark': (-0.016, 0.012), 'mat_leaf': (-0.03, 0.06), 'mat_stone': (-0.016, 0.016),
                 'mat_thatch': (-0.02, 0.04), 'mat_fabric': (-0.004, 0.005), 'mat_metal': (-0.005, 0.005), 'mat_organic': (-0.006, 0.006),
                 'mat_plaster': (-0.008, 0.008), 'mat_cliff': (-0.09, 0.1)})
AO = {'wood': 0.01, 'bark': 0.02, 'leaf': 0.04, 'stone': 0.02, 'thatch': 0.03, 'fabric': 0.006, 'metal': 0.006, 'organic': 0.008, 'plaster': 0.01, 'cliff': 0.08}

def leafcard():
    """2 x 2 atlas of dense leafy twig clusters on a transparent background, the cards tree crowns and bushes are
    built from (like a broadleaf tree's foliage atlas): a forked twig, 40-60 ovate leaves with serrated edges,
    cupped and twisted at different angles, veined, varied from fresh yellow-green to deep green with the odd
    tired leaf. Writes mat_leafcard_albedo.png (colour + crevice shadow, alpha) and mat_leafcard_normal.png
    (each leaf's own facing, so the cards shade leaf by leaf in the game)."""
    import bpy
    sc = G.reset(); rng = np.random.default_rng(778); g = Geo()
    sc.render.resolution_x = sc.render.resolution_y = 1024
    sc.cycles.samples = 32
    greens = [srgb(c) for c in ('#4f6e2b', '#5e7c31', '#3e5a24', '#6c8a3a', '#7c9440', '#56722d', '#465f27', '#869a46')]
    old = [srgb(c) for c in ('#9a8a3e', '#a07a3a')]
    ring = 28

    def rot3(yaw, pitch, roll):
        cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
        Rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
        Ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
        Rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
        return Rz @ Ry @ Rx

    def leaf(p, yaw, L, W, col, z):
        # outline: ovate, widest a third of the way up, drawn-out tip, fine teeth along the edge
        vs, cs = [[0.0, 0.0, 0.0]], [col * 0.8]
        for i in range(ring):
            t = i / ring * math.tau
            u = math.cos(t) * 0.5 + 0.5                      # 0 at the stalk, 1 at the tip
            prof = math.sin(max(0.03, u) * math.pi) ** 0.7 * (1.15 - 0.45 * u)
            teeth = 1 + 0.06 * (1 if i % 2 else -1) * (0.3 < u < 0.95)
            px = u * L
            py = math.sin(t) * 0.5 * W * prof * teeth
            pz = 0.22 * W * (abs(py) / (0.5 * W + 1e-9)) ** 2 - 0.12 * L * u * u   # cupped, the tip bending down
            vs.append([px, py, pz]); cs.append(col * (0.88 + 0.22 * u) * (1.06 if abs(py) > 0.35 * W else 1.0))
        R3 = rot3(yaw, rng.uniform(-0.45, 0.35), rng.uniform(-0.7, 0.7))
        vs = (np.array(vs) @ R3.T) + [p[0], p[1], z]
        g.add(vs, [[0, 1 + i, 1 + (i + 1) % ring] for i in range(ring)], np.array(cs), 0.45)
        def vein(a, b, w, c):
            a, b = np.array(a, float) @ R3.T + [p[0], p[1], z + 0.0006], np.array(b, float) @ R3.T + [p[0], p[1], z + 0.0006]
            d = b - a; s = np.cross(d, [0, 0, 1]); s = s / (np.linalg.norm(s) + 1e-9) * w
            g.add(np.array([a - s, a + s, b]), [[0, 1, 2]], c, 0.45)
        vein([0, 0, 0], [L * 0.92, 0, -0.1 * L * 0.85], L * 0.012, col * 1.4)
        for k in range(5):                                     # side veins running to the edge
            u0 = 0.15 + k * 0.15
            for sgn in (-1, 1):
                vein([L * u0, 0, -0.12 * L * u0 * u0], [L * (u0 + 0.14), sgn * W * 0.38 * math.sin(min(1, u0 + 0.1) * math.pi), 0], L * 0.005, col * 1.2)

    def twig(a, b, w):
        d = np.array(b) - np.array(a); s = np.array([-d[1], d[0]]); s = s / (np.linalg.norm(s) + 1e-9) * w
        g.add(np.array([[*(np.array(a) - s), -0.004], [*(np.array(a) + s), -0.004], [*(np.array(b) + s * 0.5), -0.002], [*(np.array(b) - s * 0.5), -0.002]]),
              [[0, 1, 2], [0, 2, 3]], srgb('#5b4632'), 0.8)

    for cell in range(4):
        cx, cy = (cell % 2) * 0.5 + 0.25, (cell // 2) * 0.5 + 0.25
        base = np.array([cx + rng.uniform(-0.04, 0.04), cy - 0.235])
        tip = np.array([cx + rng.uniform(-0.05, 0.05), cy + 0.12])
        twig(base, tip, 0.004)
        stems = [(base, tip)]
        for k in range(6):                                     # side shoots fanning off the main twig
            t = 0.18 + k * 0.13
            s0 = base + (tip - base) * t
            side = 1 if (k + cell) % 2 else -1
            ang = math.atan2(*(tip - base)[::-1]) + side * rng.uniform(0.55, 1.15)
            ln = rng.uniform(0.12, 0.19) * (1.1 - 0.4 * t)
            s1 = s0 + ln * np.array([math.cos(ang), math.sin(ang)])
            s1 = np.clip(s1, [cx - 0.2, cy - 0.2], [cx + 0.2, cy + 0.2])
            twig(s0, s1, 0.0025)
            stems.append((s0, s1))
        n = 95 + cell * 8
        for k in range(n):                                     # leaves on short stalks along every stem, alternating sides
            a0, b0 = stems[k % len(stems)]
            t = rng.uniform(0.15, 1.0)
            p = a0 + (b0 - a0) * t
            up = math.atan2(*(b0 - a0)[::-1])
            yaw = up + (1 if k % 2 else -1) * rng.uniform(0.35, 1.2) + rng.normal(0, 0.15)
            L = rng.uniform(0.05, 0.085) * (1.1 - 0.3 * t); W = L * rng.uniform(0.5, 0.62)
            col = (old[rng.integers(2)] if rng.random() < 0.04 else greens[rng.integers(len(greens))]) * rng.uniform(0.85, 1.15)
            p = np.clip(p, [cx - 0.21 + L * 0.5, cy - 0.21], [cx + 0.21 - L * 0.5, cy + 0.2])
            leaf(p, yaw, L, W, col, rng.uniform(0.0, 0.03))
    g.mesh('leafcard')
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
    for kind in ('albedo', 'normal'):
        if kind == 'albedo':
            m = G.material('albedo', 0.02)
            sc.view_settings.view_transform = 'Standard'
        else:   # tangent-space normal map (x right, y up, z out of the card), the OpenGL convention three.js uses
            m = bpy.data.materials.new('nrm'); m.use_nodes = True
            N = m.node_tree.nodes; Lk = m.node_tree.links
            for nd in list(N): N.remove(nd)
            out = N.new('ShaderNodeOutputMaterial'); em = N.new('ShaderNodeEmission'); geo = N.new('ShaderNodeNewGeometry')
            mp = N.new('ShaderNodeVectorMath'); mp.operation = 'MULTIPLY_ADD'
            mp.inputs[1].default_value = (0.5, 0.5, 0.5); mp.inputs[2].default_value = (0.5, 0.5, 0.5)
            Lk.new(geo.outputs['Normal'], mp.inputs[0]); Lk.new(mp.outputs[0], em.inputs['Color']); Lk.new(em.outputs[0], out.inputs['Surface'])
            sc.view_settings.view_transform = 'Raw'
        for ob in sc.collection.objects:
            if ob.type == 'MESH':
                ob.data.materials.clear(); ob.data.materials.append(m)
        sc.render.filepath = os.path.abspath(os.path.join(OUT, f'mat_leafcard_{kind}.png'))
        bpy.ops.render.render(write_still=True)
        print('wrote', sc.render.filepath)


if __name__ == '__main__':
    if 'leafcard' in sys.argv:
        leafcard(); sys.exit(0)
    only = sys.argv[sys.argv.index('--') + 2:] if '--' in sys.argv and len(sys.argv) > sys.argv.index('--') + 2 else MATERIALS
    for i, name in enumerate(MATERIALS):
        if name not in only:
            continue
        sc = G.reset(); g = Geo()
        globals()[name](g, np.random.default_rng(100 + i))
        g.mesh(name)
        G.render(sc, 'mat_' + name, AO[name])
