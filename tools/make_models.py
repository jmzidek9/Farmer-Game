# Harvest Haven — every 3D model in the game, built in Blender.
# Run: blender -b --factory-startup --python tools/make_models.py -- assets
# Writes assets/models.glb (one object per model, all at the origin). The island is tools/make_island.py.
import bpy, bmesh, math, random, json, os, sys
from mathutils import Matrix, Vector, Euler

OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'assets'
os.makedirs(OUT, exist_ok=True)
random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)

D2R = math.pi / 180
MATS = {}
SPECIAL = {  # name: (hex, emission, alpha)
    'glass': ('#bfe8ff', 0, 0.28), 'net': ('#7fbf6a', 0, 0.45), 'metal': ('#9aa3ab', 0, 1),
    'emit_warm': ('#ffc35a', 3, 1), 'emit_eye': ('#7df9ff', 4, 1), 'emit_fire': ('#ff7a1a', 5, 1),
    'emit_gold': ('#ffd447', 1.5, 1), 'shirt': ('#3a86c8', 0, 1), 'tint': ('#ffffff', 0, 1),
    'sail': ('#f3e9d2', 0, 1), 'cloud': ('#ffffff', 0, 1), 'leafcard': ('#ffffff', 0, 1),
}


def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def mat(col):
    if col in MATS:
        return MATS[col]
    if col in SPECIAL:
        hexcol, emit, alpha = SPECIAL[col]
        name = col
    else:
        hexcol, emit, alpha = col, 0, 1
        name = 'c_' + col[1:]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    rgb = [lin(int(hexcol[i:i + 2], 16) / 255) for i in (1, 3, 5)]
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = 0.85
    if emit:
        b.inputs['Emission Color'].default_value = (*rgb, 1)
        b.inputs['Emission Strength'].default_value = emit
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            m.blend_method = 'BLEND'
    MATS[col] = m
    return m


def T(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    return (Matrix.Translation(Vector(loc)) @ Euler([r * D2R for r in rot], 'XYZ').to_matrix().to_4x4()
            @ Matrix.Diagonal(Vector((*scale, 1))))


class Model:
    def __init__(s, name):
        s.name, s.bm, s.mats, s.sm = name, bmesh.new(), [], False   # sm: smooth-shade parts added while True

    def _fin(s, verts, col, jit):
        m = mat(col)
        if m not in s.mats:
            s.mats.append(m)
        idx = s.mats.index(m)
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = idx
            f.smooth = s.sm
        if jit:
            for v in verts:
                v.co += Vector([random.uniform(-jit, jit) for _ in range(3)])
        return s

    def box(s, col, loc, size, rot=(0, 0, 0), jit=0):
        g = bmesh.ops.create_cube(s.bm, size=1.0, matrix=T(loc, rot, size))
        return s._fin(g['verts'], col, jit)

    def cyl(s, col, loc, r, h, seg=8, r2=None, rot=(0, 0, 0), jit=0, sx=1, sy=1):
        r2 = r if r2 is None else r2
        mtx = T(loc, rot) @ Matrix.Translation((0, 0, h / 2)) @ Matrix.Diagonal(Vector((sx, sy, 1, 1)))
        g = bmesh.ops.create_cone(s.bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r,
                                  radius2=max(r2, 0.0001), depth=h, matrix=mtx)
        return s._fin(g['verts'], col, jit)

    def cone(s, col, loc, r, h, seg=6, rot=(0, 0, 0), jit=0, sx=1, sy=1):
        return s.cyl(col, loc, r, h, seg, 0.0, rot, jit, sx, sy)

    def ball(s, col, loc, r, sub=1, scale=(1, 1, 1), rot=(0, 0, 0), jit=0):
        g = bmesh.ops.create_icosphere(s.bm, subdivisions=sub, radius=r, matrix=T(loc, rot, scale))
        return s._fin(g['verts'], col, jit)

    def rbox(s, col, loc, size, rad, rot=(0, 0, 0), seg=2):
        """Box with rounded edges (rad in metres, before scaling)."""
        g = bmesh.ops.create_cube(s.bm, size=1.0, matrix=T(loc, rot, size))
        vs = g['verts']
        es = list({e for v in vs for e in v.link_edges})
        s._fin(vs, col, 0)   # bevel replaces these verts, so tag the new faces by hand
        idx = s.mats.index(mat(col))
        r = bmesh.ops.bevel(s.bm, geom=vs + es, offset=rad, segments=seg, affect='EDGES', profile=0.5, clamp_overlap=True)
        for f in r['faces']:
            f.smooth, f.material_index = s.sm, idx
        return s

    def plate(s, col, loc, pts, thick, rot=(0, 0, 0)):
        """Flat outline pts [(x, z), ...] in the local xz plane, thickness along y."""
        mtx = T(loc, rot)
        f = [s.bm.verts.new(mtx @ Vector((x, -thick / 2, z))) for x, z in pts]
        b = [s.bm.verts.new(mtx @ Vector((x, thick / 2, z))) for x, z in pts]
        s.bm.faces.new(f)
        s.bm.faces.new(b[::-1])
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            s.bm.faces.new((f[i], b[i], b[j], f[j]))
        return s._fin(f + b, col, 0)

    def blade(s, col, base, yaw, h, w, lean, bend=0.0):
        """Single-sided grass blade: 2 quads + tip, leaning outward and curling over."""
        d, sd = Vector((math.cos(yaw), math.sin(yaw), 0)), Vector((-math.sin(yaw), math.cos(yaw), 0))
        b = Vector(base)
        pts = []
        for k, t in enumerate((0, 0.45, 0.8)):
            c = b + d * (lean * t + bend * t * t) + Vector((0, 0, h * t - bend * 0.5 * t * t))
            ww = w * (1 - t * 0.75)
            pts.append((s.bm.verts.new(c - sd * ww), s.bm.verts.new(c + sd * ww)))
        tip = s.bm.verts.new(b + d * (lean + bend) + Vector((0, 0, h - bend * 0.5)))
        for k in range(2):
            s.bm.faces.new((pts[k][0], pts[k][1], pts[k + 1][1], pts[k + 1][0]))
        s.bm.faces.new((pts[2][0], pts[2][1], tip))
        return s._fin([v for p in pts for v in p] + [tip], col, 0)

    def frond(s, col, base, yaw, L, rise, droop, w, n=5):
        """Palm frond: a drooping, V-folded strip that tapers to a point."""
        d, sd = Vector((math.cos(yaw), math.sin(yaw), 0)), Vector((-math.sin(yaw), math.cos(yaw), 0))
        b, rows = Vector(base), []
        for k in range(n + 1):
            t = k / n
            c = b + d * (L * t) + Vector((0, 0, rise * t - droop * t * t))
            ww = w * math.sin(math.pi * min(1, 0.15 + t * 0.95)) ** 0.8
            fold = Vector((0, 0, -ww * 0.35))
            rows.append((s.bm.verts.new(c - sd * ww + fold), s.bm.verts.new(c), s.bm.verts.new(c + sd * ww + fold)))
        for k in range(n):
            a, c = rows[k], rows[k + 1]
            s.bm.faces.new((a[0], a[1], c[1], c[0]))
            s.bm.faces.new((a[1], a[2], c[2], c[1]))
        return s._fin([v for r in rows for v in r], col, 0)

    def prism(s, col, loc, length, width, height, rot=(0, 0, 0)):
        """Gable roof: ridge along local x, base centred at loc."""
        mtx = T(loc, rot)
        L, W = length / 2, width / 2
        pts = [(-L, -W, 0), (L, -W, 0), (L, W, 0), (-L, W, 0), (-L, 0, height), (L, 0, height)]
        v = [s.bm.verts.new(mtx @ Vector(p)) for p in pts]
        for f in [(0, 1, 5, 4), (2, 3, 4, 5), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]:
            s.bm.faces.new([v[i] for i in f])
        return s._fin(v, col, 0)

    def tube(s, col, pts, radii, seg=8, bump=0.0, seed=0.0):
        """A smooth, tapering branch along a polyline (rings carried along without twisting), lumpy bark if bump."""
        from mathutils import noise
        pts = [Vector(p) for p in pts]
        rings, prev_side = [], None
        for i, p in enumerate(pts):
            d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            side = d.orthogonal().normalized() if prev_side is None else (prev_side - d * prev_side.dot(d)).normalized()
            prev_side = side
            up = d.cross(side)
            ring = []
            for k in range(seg):
                a = k / seg * math.tau
                o = side * math.cos(a) + up * math.sin(a)
                r = radii[i] * (1 + bump * noise.noise(p * 2.2 + o * 0.6 + Vector((seed, 0, 0))))
                ring.append(s.bm.verts.new(p + o * r))
            rings.append(ring)
        verts = [v for r in rings for v in r]
        for a, b in zip(rings, rings[1:]):
            for k in range(seg):
                s.bm.faces.new((a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]))
        sm = s.sm; s.sm = True
        s._fin(verts, col, 0)
        s.sm = sm
        return s

    def leafcards(s, spots, center, crown_r, size, pairs=2):
        """Leaf clusters (crossed cards with the twig atlas, cut out by alpha) at spots [(pos, dir), ...]. Each card's
        vertex colour carries its shading: darker deep inside the crown and underneath, sunlit yellow-green on top,
        bluer in the shade, plus a little random variation, like a real crown."""
        uvl = s.bm.loops.layers.uv.verify()
        col = s.bm.verts.layers.float_color.get('Col') or s.bm.verts.layers.float_color.new('Col')
        c = Vector(center)
        verts = []
        for p, d in spots:
            p = Vector(p); rel = p - c
            radial = min(1.0, (Vector((rel.x, rel.y, rel.z * 1.3))).length / max(crown_r, 1e-3))
            top = max(0.0, min(1.0, rel.z / max(crown_r, 1e-3) * 0.8 + 0.5))
            ao = 0.42 + 0.58 * min(1.0, max(0.0, (radial - 0.25) / 0.7)) ** 0.8
            ao *= 0.78 + 0.22 * top
            warm = top * 0.6 + random.uniform(-0.15, 0.25)
            tint = Vector((0.86, 0.94, 1.0)).lerp(Vector((1.1, 1.06, 0.78)), max(0.0, min(1.0, warm)))
            tint *= random.uniform(0.88, 1.08)
            out = (Vector(d) * 0.6 + rel.normalized() * 0.7 + Vector((0, 0, 0.25))).normalized()
            for k in range(pairs):
                w = size * random.uniform(0.8, 1.25)
                nrm = Vector((random.gauss(0, 1), random.gauss(0, 1), random.gauss(0, 1))).normalized()
                up = (out - nrm * out.dot(nrm))
                if up.length < 0.1:
                    up = nrm.orthogonal()
                up.normalize()
                side = up.cross(nrm).normalized()
                q = random.randrange(4); u0, v0 = (q % 2) * 0.5, (q // 2) * 0.5
                for t_ax in (side, nrm):
                    base = p - up * w * 0.18
                    cs = [base - t_ax * w / 2, base + t_ax * w / 2, base + t_ax * w / 2 + up * w, base - t_ax * w / 2 + up * w]
                    vs = [s.bm.verts.new(v) for v in cs]
                    for v in vs:
                        v[col] = (tint.x * ao, tint.y * ao, tint.z * ao, 1.0)
                    f = s.bm.faces.new(vs)
                    for lp, uv in zip(f.loops, ((u0, v0), (u0 + 0.5, v0), (u0 + 0.5, v0 + 0.5), (u0, v0 + 0.5))):
                        lp[uvl].uv = uv
                    verts += vs
        return s._fin(verts, 'leafcard', 0)

    def rock(s, col, loc, r, scale=(1, 1, 1), rot=(0, 0, 0), sub=3, rough=0.32, moss=None):
        """A sculpted boulder: a dense icosphere pushed in and out by fractal noise (cracks, ledges, chipped
        faces), flattened where it sits, smooth shaded; moss on the up-facing parts if moss is a colour."""
        from mathutils import noise
        g = bmesh.ops.create_icosphere(s.bm, subdivisions=sub, radius=r, matrix=T(loc, rot, scale))
        vs = g['verts']
        c = Vector(loc); off = Vector((random.uniform(0, 50), random.uniform(0, 50), random.uniform(0, 50)))
        for v in vs:
            d = (v.co - c)
            dn = d.normalized()
            q = dn * 1.6 + off
            h = noise.fractal(q, 0.75, 2.1, 5) * 0.75 + (noise.ridged_multi_fractal(q * 0.7, 0.9, 2.0, 3, 1.0, 2.0) - 1.0) * 0.25
            v.co = c + d * (1 + h * rough)
            v.co.z = max(v.co.z, c.z - r * scale[2] * 0.35)   # sits flat on the ground
        sm = s.sm; s.sm = True
        s._fin(vs, col, 0)
        s.sm = sm
        if moss:
            mm = mat(moss)
            if mm not in s.mats:
                s.mats.append(mm)
            bm_faces = {f for v in vs for f in v.link_faces}
            for f in bm_faces:
                f.normal_update()
                if f.normal.z > 0.55 and noise.noise(f.calc_center_median() * 0.9 + off) > 0.05:
                    f.material_index = s.mats.index(mm)
        return s

    def done(s):
        bmesh.ops.recalc_face_normals(s.bm, faces=s.bm.faces[:])
        me = bpy.data.meshes.new(s.name)
        s.bm.to_mesh(me)
        s.bm.free()
        for m in s.mats:
            me.materials.append(m)
        if len(me.color_attributes):
            me.color_attributes.active_color = me.color_attributes[0]
            me.color_attributes.render_color_index = 0
        ob = bpy.data.objects.new(s.name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def grow_tree(m, seed, height, crown_r, trunk_r, limbs=5, leaf=1.1, bark='#6a4a30', clear=0.5, pairs=2, sub=4):
    """A broadleaf tree grown branch by branch: a leaning, bumpy trunk with a root flare; limbs splitting off its
    upper half, reaching up and out; branches off the limbs; leaf clusters all along the branches and at their
    tips. clear: fraction of the height that is bare trunk. Returns the leaf spots (for fruit)."""
    random.seed(seed)
    spots = []
    top = Vector((0, 0, height * 0.62))

    def branch(p0, d0, L, r0, lvl):
        n = 9 if lvl == 0 else 6 if lvl == 1 else 4
        pts, radii, d, p = [p0.copy()], [r0], d0.copy(), p0.copy()
        for i in range(1, n + 1):
            t = i / n
            pull = Vector((0, 0, 0.08 if lvl == 0 else 0.05 if lvl == 1 else -0.03))   # trunk and limbs reach up, twigs droop
            d = (d + Vector((random.gauss(0, 1), random.gauss(0, 1), random.gauss(0, 1))) * (0.07 if lvl == 0 else 0.16) + pull).normalized()
            p = p + d * (L / n)
            pts.append(p.copy()); radii.append(max(0.012, r0 * (1 - 0.72 * t)))
        m.tube(bark, pts, radii, seg=(12, 8, 5)[lvl], bump=(0.18, 0.08, 0.0)[lvl], seed=seed + lvl)
        if lvl < 2:
            nk = limbs if lvl == 0 else sub + random.randint(0, 1)
            for k in range(nk):
                t = (clear + (1 - clear) * (k + random.uniform(0.2, 0.8)) / nk) if lvl == 0 else random.uniform(0.3, 0.95)
                i = min(n - 1, int(t * n))
                pk, dk = pts[i], (pts[i + 1] - pts[i]).normalized()
                side = dk.orthogonal().normalized()
                rot = Matrix.Rotation(k * 2.39996 + random.uniform(-0.4, 0.4) + seed, 3, dk)
                side = rot @ side
                ang = math.radians(random.uniform(38, 62) if lvl == 0 else random.uniform(30, 55))
                cd = (dk * math.cos(ang) + side * math.sin(ang)).normalized()
                if lvl == 0:
                    cd = (cd + Vector((0, 0, 0.25))).normalized()
                    Lk = crown_r * random.uniform(0.8, 1.05) * (1.15 - 0.4 * t)
                else:
                    Lk = L * random.uniform(0.5, 0.75)
                branch(pk, cd, Lk, radii[i] * (0.55 if lvl == 0 else 0.6), lvl + 1)
            if lvl == 0:   # the leader carries on into the top of the crown
                branch(pts[-1], d, crown_r * 0.7, radii[-1], 1)
        else:
            for t in (0.3, 0.55, 0.8, 1.0):
                i = min(n, int(round(t * n)))
                spots.append((pts[i], (pts[i] - pts[max(0, i - 1)]).normalized()))

    branch(Vector((0, 0, -0.15)), Vector((random.uniform(-0.08, 0.08), random.uniform(-0.08, 0.08), 1)).normalized(), height * 0.55, trunk_r, 0)
    for k in range(5):                                         # root flare
        a = k * 72 + random.uniform(-15, 15)
        dd = Vector((math.cos(math.radians(a)), math.sin(math.radians(a)), 0))
        m.tube(bark, [dd * trunk_r * 0.2 + Vector((0, 0, trunk_r * 1.6)), dd * trunk_r * 1.1 + Vector((0, 0, trunk_r * 0.4)), dd * trunk_r * 1.9 + Vector((0, 0, -0.1))],
               [trunk_r * 0.45, trunk_r * 0.32, trunk_r * 0.12], seg=6)
    cz = sum(p.z for p, _ in spots) / max(1, len(spots))
    cxy = sum((p for p, _ in spots), Vector()) / max(1, len(spots))
    m.leafcards(spots, (cxy.x, cxy.y, cz), crown_r, leaf, pairs)
    return spots


def grow_shrub(m, seed, h, w, leaf=0.6, stems=6, bark='#5e4632'):
    """A shrub: several stems from the ground, arching out, each forking once, leaves all along them."""
    random.seed(seed)
    spots = []
    for k in range(stems):
        a = k / stems * math.tau + random.uniform(-0.3, 0.3)
        out = Vector((math.cos(a), math.sin(a), 0))
        p, d = Vector((out.x * 0.05, out.y * 0.05, 0)), (out * random.uniform(0.35, 0.7) * w / max(0.5, h) + Vector((0, 0, 1))).normalized()
        pts = [p.copy()]
        for i in range(4):
            d = (d + Vector((random.gauss(0, 0.12), random.gauss(0, 0.12), -0.05))).normalized()
            p = p + d * h / 4
            pts.append(p.copy())
        m.tube(bark, pts, [0.03, 0.025, 0.018, 0.012, 0.008], seg=5)
        for i in (1, 2, 3, 4):
            spots.append((pts[i], d))
        fk = pts[2]; fd = (d + out * 0.8).normalized()
        q = fk + fd * h * 0.4
        m.tube(bark, [fk, q], [0.015, 0.008], seg=4)
        spots.append((q, fd)); spots.append(((fk + q) / 2, fd))
    m.leafcards(spots, (0, 0, h * 0.55), max(w, h) * 0.6, leaf, 2)
    return spots


R = random.uniform
LEAF, LEAF2, STEM, WOOD, WOOD2, DARKWOOD = '#5fa83a', '#4a8f2c', '#7bb34a', '#a8744a', '#8a5a36', '#5e3d24'
THATCH, STONE, STONE2, ROPE, RED, WHITE = '#d9b26f', '#9c9a92', '#7d7b74', '#c9a36b', '#b8403a', '#f2ede2'
SOIL = '#7a5134'

# ----------------------------------------------------------------- crops
CROPS = {
    'wheat': ('grain', '#e9c46a'), 'rice': ('grain', '#d8d29a'), 'carrot': ('root', '#f08a24'),
    'radish': ('root', '#d6336c'), 'onion': ('root', '#d9a066'), 'potato': ('root', '#b08850'),
    'lettuce': ('leafy', '#8fd16a'), 'corn': ('stalk', '#f6d743'), 'sugarcane': ('cane', '#8a9a3c'),
    'tomato': ('bush', '#e63946'), 'beans': ('bush', '#5aa832'), 'peppers': ('bush', '#d62828'),
    'strawberry': ('berry', '#e5383b'), 'coffee': ('bush', '#b5172f'), 'cotton': ('bush', '#f8f4ec'),
    'cucumber': ('vine', '#4d8b31'), 'pumpkin': ('vine', '#f28c28'), 'watermelon': ('vine', '#2d6a2e'),
    'pineapple': ('pine', '#e0a526'), 'goldpineapple': ('pine', 'emit_gold'), 'cacao': ('cacao', '#c46b2b'),
    'vanilla': ('vanilla', '#6b8a2b'), 'dragonfruit': ('cactus', '#e83e8c'), 'starfruit': ('star', '#f2d22e'),
}
TREES = {'banana': ('banana', '#f6e05e'), 'coconut': ('palm', '#6b4423'), 'orange': ('round', '#f9a03f'),
         'mango': ('round', '#f4a340'), 'apple': ('round', '#d62828'), 'papaya': ('papaya', '#f9a826')}
SC = [0.3, 0.55, 0.85, 1.0]


def sprout(m, k=1.0):
    m.cyl(STEM, (0, 0, 0), 0.025 * k, 0.18 * k, 5)
    m.ball(LEAF, (0.07 * k, 0, 0.18 * k), 0.07 * k, 1, (1.4, 0.7, 0.3), (0, -20, 0))
    m.ball(LEAF, (-0.07 * k, 0, 0.17 * k), 0.07 * k, 1, (1.4, 0.7, 0.3), (0, 20, 0))


def crop(cid, kind, pc, st):
    m = Model(f'crop_{cid}_{st}')
    s = SC[st]
    ripe, green = st == 3, st >= 2
    fc = pc if ripe else '#7fb045'
    random.seed(hash(cid) % 1000 + st)
    if st == 0 and kind not in ('pine',):
        sprout(m)
        return m.done()
    if kind == 'grain':
        for i in range(11):
            a, r = i * 2.4, 0.12 + 0.22 * (i % 4) / 3
            x, y, h = math.cos(a) * r, math.sin(a) * r, (0.7 + R(0, 0.25)) * s
            c = (pc if ripe else '#9cc95a') if green else STEM
            m.cyl(c if ripe else STEM, (x, y, 0), 0.02, h, 4, 0.012, (R(-8, 8), R(-8, 8), 0))
            if green:
                m.ball(fc if ripe else '#a7cf63', (x, y, h + 0.06), 0.045, 1, (0.8, 0.8, 2.2))
    elif kind == 'root':
        for i in range(6):
            a = i * 1.05
            m.cone(LEAF, (math.cos(a) * 0.05, math.sin(a) * 0.05, 0), 0.05, 0.45 * s, 4,
                   (math.sin(a) * 25, -math.cos(a) * 25, 0), sx=0.5)
        if green:
            k = 1 if ripe else 0.6
            if cid == 'carrot':
                m.cyl(pc if ripe else '#d39a52', (0, 0, -0.05), 0.1 * k, 0.12, 7, 0.08 * k)
            elif cid == 'potato':
                for a in (0, 2.1, 4.2):
                    m.ball('#b08850', (math.cos(a) * 0.18, math.sin(a) * 0.18, 0.02), 0.09 * k, 1, (1.2, 1, 0.8), jit=0.01)
            else:
                m.ball(pc if ripe else '#c9b47a', (0, 0, 0.05), 0.13 * k, 1, (1, 1, 0.9))
    elif kind == 'leafy':
        n = 3 if st == 1 else 7
        for i in range(n):
            a = i * 0.9
            m.ball(pc if i % 2 else '#79c25a', (math.cos(a) * 0.14 * s, math.sin(a) * 0.14 * s, 0.1 * s),
                   0.16 * s, 1, (1.2, 0.9, 0.7), (0, 0, a * 57))
        m.ball('#a6e07f', (0, 0, 0.16 * s), 0.13 * s, 1)
    elif kind in ('stalk', 'cane'):
        n = 3 if kind == 'stalk' else 5
        for i in range(n):
            a = i * 2.1
            x, y = math.cos(a) * 0.18, math.sin(a) * 0.18
            h = (1.7 if kind == 'stalk' else 2.0) * s
            if kind == 'cane':
                for seg in range(4):
                    m.cyl('#8a9a3c' if seg % 2 else '#6f7d2e', (x, y, seg * h / 4), 0.045, h / 4, 6)
            else:
                m.cyl(STEM, (x, y, 0), 0.04, h, 6, 0.025)
            for j in range(3):
                m.box(LEAF, (x + 0.15 * math.cos(a + j * 2), y + 0.15 * math.sin(a + j * 2), h * (0.35 + j * 0.2)),
                      (0.45 * s, 0.07, 0.01), (0, -35, (a + j * 2) * 57))
            if kind == 'stalk' and green:
                m.cyl(fc, (x + 0.06, y, h * 0.5), 0.06, 0.28 * s, 7, 0.04, (0, 15, 0))
            if ripe:
                m.cone('#e8d9a0' if kind == 'stalk' else '#efe6c8', (x, y, h), 0.06, 0.25, 4)
    elif kind in ('bush', 'berry'):
        low = kind == 'berry'
        r = (0.28 if low else 0.38) * s
        hgt = 0.18 if low else (0.55 if cid == 'coffee' else 0.38)
        m.ball(LEAF2, (0, 0, hgt * s), r, 1, (1, 1, 0.75 if low else 1), jit=0.02)
        if cid == 'coffee':
            m.ball(LEAF2, (0, 0, hgt * s + r), r * 0.8, 1, jit=0.02)
        if green:
            for i in range(7):
                a, el = i * 0.9, 0.5 + (i % 3) * 0.3
                p = (math.cos(a) * r * math.cos(el), math.sin(a) * r * math.cos(el), hgt * s + r * math.sin(el) * 0.6)
                if cid == 'beans':
                    m.cyl(fc, p, 0.025, 0.2, 5, 0.02, (180, 0, 0))
                elif cid == 'cotton':
                    m.ball(pc if ripe else '#cfe3b0', p, 0.07, 1, jit=0.01)
                elif cid == 'peppers':
                    m.cone(('#d62828' if i % 2 else '#f4a259') if ripe else '#5c9e2e', p, 0.05, 0.16, 6, (180, 0, 0))
                else:
                    m.ball(fc, p, 0.055 if low or cid == 'coffee' else 0.07, 1)
    elif kind == 'vine':
        for i in range(5):
            a = i * 1.25
            m.ball(LEAF if i % 2 else LEAF2, (math.cos(a) * 0.3 * s, math.sin(a) * 0.3 * s, 0.06), 0.2 * s, 1, (1.2, 1, 0.35))
        if green:
            k = 1 if ripe else 0.55
            if cid == 'pumpkin':
                m.ball(fc, (0.05, 0, 0.22 * k), 0.32 * k, 1, (1.15, 1.15, 0.8), jit=0.015)
                m.cyl('#4d6b2a', (0.05, 0, 0.45 * k), 0.035, 0.1, 5)
            elif cid == 'watermelon':
                m.ball(fc, (0.05, 0, 0.2 * k), 0.3 * k, 1, (1.35, 1, 0.8))
            else:
                for a in (0.3, 2.4, 4.4):
                    m.cyl(fc, (math.cos(a) * 0.22, math.sin(a) * 0.22, 0.06), 0.055, 0.26 * k, 6, rot=(90, 0, a * 57))
    elif kind == 'pine':
        n = 4 + st * 2
        for i in range(n):
            a = i * 2.4
            m.cone(LEAF2 if i % 2 else '#6aa84f', (0, 0, 0.02), 0.06, (0.25 + 0.3 * s), 3,
                   (math.sin(a) * 55, -math.cos(a) * 55, 0), sx=0.5)
        if green:
            k = 1 if ripe else 0.6
            m.ball(fc if ripe else '#8db650', (0, 0, 0.32 * k), 0.16 * k, 1, (1, 1, 1.4), jit=0.008)
            for i in range(5):
                a = i * 1.26
                m.cone(LEAF2, (0, 0, 0.5 * k), 0.04, 0.22 * k, 3, (math.sin(a) * 25, -math.cos(a) * 25, 0))
    elif kind in ('cacao', 'star'):
        m.cyl(WOOD2, (0, 0, 0), 0.06 * s, 0.7 * s, 6, 0.04 * s)
        m.ball(LEAF2, (0, 0, 0.85 * s), 0.42 * s, 1, (1, 1, 0.8), jit=0.03)
        if green:
            for i in range(5):
                a = i * 1.26
                if kind == 'cacao':
                    m.ball(fc, (math.cos(a) * 0.08, math.sin(a) * 0.08, 0.35 + i * 0.05), 0.07, 1, (1, 1, 1.7))
                else:
                    p = (math.cos(a) * 0.35, math.sin(a) * 0.35, 0.7 * s)
                    m.cyl(fc, p, 0.07, 0.15, 5, 0.03, (0, 0, a * 57))
    elif kind == 'vanilla':
        m.cyl(WOOD, (0, 0, 0), 0.04, 1.4 * s, 6)
        for i in range(int(8 * s) + 2):
            a = i * 1.1
            m.ball(LEAF, (math.cos(a) * 0.09, math.sin(a) * 0.09, i * 0.15 * s + 0.1), 0.08, 1, (1.4, 0.8, 0.4), (0, 0, a * 57))
        if green:
            for i in range(4):
                a = i * 1.6
                m.cyl('#6b4a2b' if ripe else '#7e9a3a', (math.cos(a) * 0.14, math.sin(a) * 0.14, 0.9 * s), 0.018, 0.28, 5, rot=(180, 0, 0))
    elif kind == 'cactus':
        m.box('#4f9a4a', (0, 0, 0.4 * s), (0.18, 0.18, 0.8 * s), (0, 0, 45))
        for a in (0, 120, 240):
            ca = math.radians(a)
            m.box('#5aa852', (math.cos(ca) * 0.2, math.sin(ca) * 0.2, 0.55 * s), (0.3, 0.12, 0.12), (0, -30, a))
            if green:
                m.ball(fc if ripe else '#9ccf6a', (math.cos(ca) * 0.38, math.sin(ca) * 0.38, 0.68 * s), 0.11, 1, (1, 1, 1.2), jit=0.01)
    return m.done()


def tree(tid, kind, pc, st):
    m = Model(f'tree_{tid}_{st}')
    s = SC[st]
    random.seed(hash(tid) % 997 + st)
    if kind in ('palm', 'banana'):
        h = (4.5 if kind == 'palm' else 2.6) * s
        segs = 6
        lean = 0
        for i in range(segs):
            m.cyl('#9b7653' if i % 2 else '#8a6845', (lean, 0, i * h / segs), 0.16 * s * (1 - i * 0.06), h / segs + 0.02, 7)
            lean += 0.05 * s
        top = (lean, 0, h)
        nl = 7 if kind == 'palm' else 6
        for i in range(nl):
            a = i * (360 / nl)
            if kind == 'palm':
                m.box('#3f8f3a' if i % 2 else '#4fa344', (top[0] + math.cos(a * D2R) * 0.9 * s, math.sin(a * D2R) * 0.9 * s, h - 0.25 * s),
                      (1.9 * s, 0.32 * s, 0.03), (0, 22, a))
            else:
                m.box('#5cb84a' if i % 2 else '#4aa33c', (top[0] + math.cos(a * D2R) * 0.65 * s, math.sin(a * D2R) * 0.65 * s, h + 0.2 * s),
                      (1.4 * s, 0.5 * s, 0.03), (0, -35, a))
        if st == 3:
            if kind == 'palm':
                for a in range(0, 360, 72):
                    m.ball(pc, (top[0] + math.cos(a * D2R) * 0.2, math.sin(a * D2R) * 0.2, h - 0.25), 0.16, 1)
            else:
                for i in range(7):
                    m.cyl(pc, (top[0] + 0.25, (i - 3) * 0.06, h - 0.3 - (i % 3) * 0.12), 0.05, 0.26, 5, rot=(0, 160, 0))
    elif kind == 'papaya':
        h = 3.2 * s
        m.cyl('#a5906a', (0, 0, 0), 0.12 * s, h, 7, 0.08 * s)
        for i in range(7):
            a = i * 51
            m.box('#4fa344', (math.cos(a * D2R) * 0.7 * s, math.sin(a * D2R) * 0.7 * s, h + 0.1), (1.3 * s, 0.6 * s, 0.03), (0, -28, a))
        if st == 3:
            for i in range(6):
                a = i * 1.05
                m.ball(pc, (math.cos(a) * 0.16, math.sin(a) * 0.16, h - 0.35 - (i % 2) * 0.2), 0.12, 1, (1, 1, 1.4))
    else:
        spots = grow_tree(m, sum(map(ord, tid)) * 7 + st, 3.6 * s, 1.35 * s, 0.16 * s, limbs=4, leaf=0.8 * s, bark='#5a4030', clear=0.38, sub=3)
        if st == 3:   # fruit hanging on the outside of the crown
            cz = sum(p.z for p, _ in spots) / len(spots)
            outer = sorted(spots, key=lambda sd: -math.hypot(sd[0].x, sd[0].y) - abs(sd[0].z - cz) * 0.3)[:14]
            for p, d in outer:
                m.ball(pc, tuple(p - d * 0.12 - Vector((0, 0, 0.12))), 0.11, 2)
    if st == 0:
        m.ball(LEAF, (0, 0, 0.05), 0.12, 1, (1.5, 1.5, 0.4))
    return m.done()


for cid, (kind, pc) in CROPS.items():
    for st in range(4):
        crop(cid, kind, pc, st)
for tid, (kind, pc) in TREES.items():
    for st in range(4):
        tree(tid, kind, pc, st)

# ----------------------------------------------------------------- scenery
def palm_wild(name, h, bend, seed):
    random.seed(seed)
    m = Model(name)
    lean, segs = 0, 10
    for i in range(segs):                      # ringed trunk that curves and tapers
        r = 0.22 * (1 - i * 0.045)
        m.cyl('#a07a55' if i % 2 else '#8a6646', (lean, 0, i * h / segs), r, h / segs + 0.02, 8, r * 0.93)
        m.cyl('#6e5038', (lean, 0, (i + 1) * h / segs - 0.03), r * 1.04, 0.05, 8)
        lean += bend * i * 0.016
    top = (lean, 0, h)
    m.ball('#7a5a3a', top, 0.24, 1, (1, 1, 0.8))
    greens = ['#3f8f3a', '#4f9f40', '#5fae48', '#468f36']
    for i in range(10):                         # two layers of drooping fronds
        a = i * 36 + R(-12, 12)
        up = i % 2
        m.frond(greens[i % 4], top, a * D2R, R(2.2, 2.8), 0.7 if up else 0.35, R(1.7, 2.3), R(0.32, 0.42))
    for i in range(4):
        a = i * 90 + 45
        m.frond('#7fbf52', top, a * D2R, 1.1, 1.1, 0.5, 0.2, 3)  # young shoots pointing up
    for a in range(0, 360, 72):
        m.ball('#6b4423', (lean + math.cos(a * D2R) * 0.24, math.sin(a * D2R) * 0.24, h - 0.32), 0.16, 1, jit=0.015)
    return m.done()


palm_wild('palm_a', 6.5, 1.0, 1)
palm_wild('palm_b', 8.0, -0.7, 2)
palm_wild('palm_c', 5.2, 1.6, 3)


def jungle(name, seed, big):
    m = Model(name)
    if big:   # a big spreading broadleaf, like the island's old forest trees
        grow_tree(m, seed, 10.5, 4.4, 0.42, limbs=6, leaf=1.35, bark='#6b5a48', clear=0.42, sub=4)
    else:     # a younger, narrower tree
        grow_tree(m, seed, 7.0, 2.8, 0.26, limbs=5, leaf=1.1, bark='#6a5040', clear=0.38, sub=3)
    return m.done()

jungle('jungle_a', 4, True)
jungle('jungle_b', 5, False)
for i, (nm, r) in enumerate([('rock_s', 0.45), ('rock_m', 0.8), ('rock_l', 1.4)]):
    random.seed(30 + i)
    m = Model(nm)
    m.rock('#9a968b', (0, 0, r * 0.32), r, (1.25, 1, 0.72), (0, 0, R(0, 90)), sub=(4, 5, 5)[i], moss='#5f8f3a' if i else None)
    m.rock('#86837a', (r * 0.62, r * 0.25, r * 0.12), r * 0.5, (1.1, 1, 0.7), sub=(3, 4, 4)[i])
    for k in range(2 + i):   # loose stones round its foot
        a = R(0, 6.28)
        m.rock('#8f8b80', (math.cos(a) * r * 1.35, math.sin(a) * r * 1.2, 0.02), r * R(0.12, 0.2), (1.2, 1, 0.6), sub=3, rough=0.25)
    m.done()
random.seed(77)
m = Model('bush_a'); grow_shrub(m, 77, 0.95, 0.9, leaf=0.62, stems=7); m.done()
m = Model('fern')
for i in range(7):
    a = i * 51
    m.box('#4a9a3f' if i % 2 else '#3a8a33', (math.cos(a * D2R) * 0.4, math.sin(a * D2R) * 0.4, 0.2), (0.9, 0.18, 0.02), (0, -30, a))
m.done()
random.seed(41)
m = Model('grass_tuft')
for i in range(11):
    a = i * 137.5 * D2R
    rr = R(0.0, 0.09)
    m.blade(['#5aa83c', '#6fb84a', '#4e9a36', '#82c457'][i % 4], (math.cos(a) * rr, math.sin(a) * rr, 0), a + R(-0.4, 0.4),
            R(0.28, 0.5), R(0.022, 0.034), R(0.05, 0.14), R(0.0, 0.12))
m.done()
for nm, c in (('flower_a', '#ffd23f'), ('flower_b', '#ff6fa3'), ('flower_c', '#ffffff')):
    m = Model(nm)
    for i in range(3):
        a = i * 2.1
        x, y = math.cos(a) * 0.12, math.sin(a) * 0.12
        m.cyl(STEM, (x, y, 0), 0.015, 0.3 + i * 0.05, 4)
        m.ball(c, (x, y, 0.32 + i * 0.05), 0.07, 1, (1, 1, 0.5)).ball('#f4a259', (x, y, 0.35 + i * 0.05), 0.025, 0)
    m.done()
Model('stump_tree').cyl(DARKWOOD, (0, 0, 0), 0.34, 0.4, 8, 0.3).cyl('#c9a27a', (0, 0, 0.4), 0.3, 0.01, 8).done()
Model('stump_palm').cyl('#866243', (0, 0, 0), 0.24, 0.35, 7, 0.21).cyl('#c9a27a', (0, 0, 0.35), 0.21, 0.01, 7).done()
Model('log').cyl(WOOD2, (0, 0, 0.22), 0.22, 1.8, 7, rot=(0, 90, 0)).done()
# cumulus clouds: a flat-bottomed base of wide puffs, rounder domes piled toward the middle, smooth shaded
for i, nm in enumerate(('cloud_a', 'cloud_b', 'cloud_c')):
    random.seed(60 + i)
    m = Model(nm)
    m.sm = True
    L = (11, 8, 14)[i]
    for j in range(7 + i):
        t = j / (6 + i)
        x = (t - 0.5) * L
        m.ball('cloud', (x, R(-1.4, 1.4), 0.4), R(1.7, 2.4) * (1 - abs(t - 0.5) * 0.5), 2, (1.25, 1.05, 0.55))
    for j in range(4 + i):
        x = R(-0.3, 0.3) * L
        m.ball('cloud', (x, R(-0.9, 0.9), 1.3 + R(0, 0.6)), R(1.6, 2.3) * (1 - abs(x) / L), 2, (1, 1, 0.85))
    m.ball('cloud', (R(-1, 1), 0, 2.4), R(1.5, 1.9), 2, (1, 1, 0.9))
    m.done()

# ----------------------------------------------------------------- buildings
def walls(m, w, d, h, col, z=0):
    m.box(col, (0, 0, z + h / 2), (w, d, h))
    for x in (-w / 2, w / 2):
        for y in (-d / 2, d / 2):
            m.box(DARKWOOD, (x, y, z + h / 2), (0.18, 0.18, h + 0.05))


def door_win(m, w, d, z=0, doors=1):
    m.box(DARKWOOD, (0, -d / 2 - 0.03, z + 0.95), (0.9, 0.08, 1.9))
    for x in (-w / 3, w / 3):
        m.box('#ffe7a8', (x, -d / 2 - 0.03, z + 1.4), (0.6, 0.06, 0.5))
        m.box(DARKWOOD, (x, -d / 2 - 0.06, z + 1.4), (0.75, 0.04, 0.08))


def farmhouse(level):
    m = Model(f'farmhouse_{level}')
    w = 3.6 + level * 0.25
    stone = level >= 4
    m.box(STONE2 if stone else DARKWOOD, (0, 0, 0.2), (w + 0.6, w + 0.4, 0.4))
    walls(m, w, w - 0.4, 2.4, '#c08a5a' if level < 3 else '#d6b48c', 0.4)
    door_win(m, w, w - 0.4, 0.4)
    top = 2.8
    if level >= 3:
        walls(m, w - 0.4, w - 0.8, 2.0, '#e8d4b0', 2.8)
        for x in (-w / 4, w / 4):
            m.box('#ffe7a8', (x, -(w - 0.8) / 2 - 0.03, 3.9), (0.6, 0.06, 0.5))
        top = 4.8
    roofc = THATCH if level < 2 else ('#b85c38' if level < 5 else '#7a3b2e')
    m.prism(roofc, (0, 0, top), w + 0.7, w + 0.5 - (0.4 if level >= 3 else 0), 1.6 + level * 0.15)
    if level >= 2:
        m.box(WOOD, (0, -w / 2 - 0.6, 0.45), (w, 1.2, 0.12))
        for x in (-w / 2 + 0.2, w / 2 - 0.2):
            m.cyl(WOOD2, (x, -w / 2 - 1.1, 0.4), 0.07, 2.0, 6)
        m.box(roofc, (0, -w / 2 - 0.65, 2.45), (w + 0.2, 1.4, 0.1), (-12, 0, 0))
        m.box(STONE, (w / 3, 0.3, top + 0.8), (0.5, 0.5, 2.0))
    if level >= 4:
        m.box('#d6b48c', (w / 2 + 0.9, 0.3, 1.5), (1.6, 2.4, 2.2))
        m.prism(roofc, (w / 2 + 0.9, 0.3, 2.6), 1.8, 2.6, 1.1, (0, 0, 90))
    if level >= 5:
        m.cyl('#e8d4b0', (-w / 2 - 0.3, -w / 2 + 0.6, 0), 0.8, 6.2, 8)
        m.cone('#7a3b2e', (-w / 2 - 0.3, -w / 2 + 0.6, 6.2), 1.05, 1.8, 8)
        m.box('emit_warm', (-w / 2 - 0.3, -w / 2 - 0.2, 4.8), (0.4, 0.06, 0.6))
    m.box('emit_warm', (0.9, -w / 2 - 0.25, 2.4), (0.18, 0.18, 0.25))
    return m.done()


for lv in range(1, 6):
    farmhouse(lv)

m = Model('barn')
walls(m, 5.0, 4.6, 2.8, '#b23a3a')
m.box(WHITE, (0, -2.33, 1.3), (2.0, 0.06, 2.6))
m.box('#b23a3a', (0, -2.36, 1.3), (1.7, 0.06, 2.3))
m.box(WHITE, (0, -2.39, 1.3), (2.3, 0.04, 0.12), (0, 45, 0)).box(WHITE, (0, -2.39, 1.3), (2.3, 0.04, 0.12), (0, -45, 0))
m.prism('#5a5a5a', (0, 0, 2.8), 5.4, 5.0, 2.0)
m.box(WHITE, (0, -2.36, 3.6), (0.8, 0.06, 0.8))
m.done()

m = Model('silo')
m.cyl('#c9c3b5', (0, 0, 0), 1.5, 5.5, 12)
for z in (1.2, 2.6, 4.0):
    m.cyl('#a9a395', (0, 0, z), 1.53, 0.12, 12)
m.ball('#b85c38', (0, 0, 5.5), 1.55, 2, (1, 1, 0.6))
m.box(DARKWOOD, (0, -1.5, 0.9), (0.8, 0.12, 1.8))
m.done()

m = Model('well')
m.cyl(STONE, (0, 0, 0), 0.75, 0.75, 10).cyl('#2b5d78', (0, 0, 0.6), 0.6, 0.16, 10)
for x in (-0.6, 0.6):
    m.cyl(WOOD2, (x, 0, 0.7), 0.06, 1.3, 6)
m.prism(THATCH, (0, 0, 1.95), 1.7, 1.4, 0.6)
m.cyl(WOOD, (0, 0, 1.6), 0.05, 1.2, 6, rot=(0, 90, 0))
m.cyl('#8a8f94', (0, 0, 1.0), 0.16, 0.25, 7)
m.done()


# --- the two starting stalls: 2x1 tiles (4 m x 2 m), front faces -Y (south, toward the beach)
def stall_base(m, seed):
    random.seed(seed)
    for k in range(7):                                                  # plank deck
        m.box(WOOD if k % 2 else '#b98552', (-1.71 + k * 0.57, 0, 0.07), (0.55, 1.92, 0.12), jit=0.006)
    m.box(DARKWOOD, (0, -0.97, 0.07), (4.0, 0.06, 0.14)).box(DARKWOOD, (0, 0.97, 0.07), (4.0, 0.06, 0.14))
    m.sm = True
    for x in (-1.78, 1.78):                                             # posts with rope wraps
        for y in (-0.84, 0.84):
            m.cyl(DARKWOOD, (x, y, 0.12), 0.085, 2.62, 8, 0.075)
            m.cyl(ROPE, (x, y, 1.0), 0.095, 0.1, 8).cyl(ROPE, (x, y, 1.16), 0.095, 0.05, 8)
            m.ball(DARKWOOD, (x, y, 2.78), 0.1, 1)
    m.sm = False
    for y in (-0.84, 0.84):
        m.box(DARKWOOD, (0, y, 2.7), (3.8, 0.12, 0.14))
    for x in (-1.78, 1.78):
        m.box(DARKWOOD, (x, 0, 2.7), (0.12, 1.8, 0.14))


def counter(m, front, top, trim):
    m.rbox(front, (0, -0.62, 0.56), (3.3, 0.5, 0.86), 0.03)
    for k in range(11):                                                 # vertical board front
        m.box(trim if k % 2 else front, (-1.5 + k * 0.3, -0.875, 0.56), (0.28, 0.02, 0.78))
    m.rbox(top, (0, -0.62, 1.02), (3.52, 0.66, 0.08), 0.025)
    m.box(trim, (0, -0.95, 0.94), (3.5, 0.03, 0.08))


def hanging_sign(m, z=2.05):
    for x in (-0.3, 0.3):
        m.cyl('#5a5a5a', (x, -0.88, z + 0.2), 0.008, 0.45, 4)
    m.rbox('#f3e3c3', (0, -0.9, z), (0.95, 0.06, 0.42), 0.04)
    m.box(DARKWOOD, (0, -0.9, z), (1.0, 0.04, 0.47))


# sell stall: striped awning, fruit crates, scale, bunting, coin sign
s = Model('market_stall')
stall_base(s, 71)
counter(s, '#c99a62', '#e0bb85', '#a8744a')
STRIPE = ['#e8536b', '#fff4e0']
for k in range(8):                                                      # sloped striped awning + scalloped edge
    x = -1.75 + k * 0.5
    s.box(STRIPE[k % 2], (x, -0.12, 2.98), (0.5, 2.3, 0.05), (14, 0, 0))
    s.cyl(STRIPE[k % 2], (x, -1.2, 2.67), 0.25, 0.04, 10, rot=(90, 0, 0))
crates = [('#f39c2b', -1.2), ('#e63946', -0.4), ('#f6d743', 0.4), ('#8cc152', 1.2)]
for col, x in crates:                                                   # tilted crates heaped with fruit
    s.box('#c9a36b', (x, -0.66, 1.16), (0.72, 0.52, 0.16), (-15, 0, 0))
    s.box(WOOD2, (x, -0.92, 1.12), (0.74, 0.03, 0.2), (-15, 0, 0))
    s.sm = True
    for r in range(2):
        for c in range(3):
            y = -0.8 + r * 0.22
            s.ball(col, (x - 0.22 + c * 0.22 + R(-0.02, 0.02), y, 1.27 + (y + 0.8) * 0.27 + R(0, 0.02)), 0.1, 1)
    s.ball(col, (x, -0.7, 1.4), 0.1, 1)
    s.sm = False
s.sm = True
for x, y in ((-1.55, -1.25), (-1.15, -1.3)):                             # watermelons out front
    s.ball('#2d6a2e', (x, y, 0.22), 0.22, 2, (1.25, 1, 0.95))
s.cyl('#8a6845', (1.7, -1.25, 0), 0.26, 0.62, 10, 0.3)                    # corn barrel
for k in range(5):
    a = k * 1.25
    s.cone('#f6d743', (1.7 + math.cos(a) * 0.1, -1.25 + math.sin(a) * 0.1, 0.55), 0.06, 0.32, 6, (math.sin(a) * 12, -math.cos(a) * 12, 0))
s.sm = False
s.cyl('metal', (1.45, -0.45, 1.06), 0.02, 0.4, 6).box('metal', (1.45, -0.45, 1.46), (0.42, 0.02, 0.02))   # balance scale
for x in (1.25, 1.65):
    s.cyl('metal', (x, -0.45, 1.25), 0.1, 0.02, 10, 0.12).cyl('#5a5a5a', (x, -0.45, 1.27), 0.004, 0.19, 3)
for k in range(3):                                                      # back shelf with baskets
    x = -1.1 + k * 1.1
    s.box(WOOD2, (x, 0.6, 0.45), (0.9, 0.5, 0.06))
    s.cyl('#c9a36b', (x, 0.6, 0.48), 0.28, 0.2, 10, 0.32)
    s.sm = True
    for q in range(4):
        s.ball(['#f08a24', '#d62828', '#f4a340', '#7fbf6a'][(k + q) % 4], (x - 0.12 + (q % 2) * 0.24, 0.55 + (q // 2) * 0.12, 0.72), 0.09, 1)
    s.sm = False
hanging_sign(s)
s.sm = True
s.cyl('#f2b33d', (0, -0.94, 2.05), 0.15, 0.03, 16, rot=(90, 0, 0)).cyl('#d99a20', (0, -0.96, 2.05), 0.1, 0.02, 16, rot=(90, 0, 0))
s.sm = False
for k in range(9):                                                      # bunting along the front beam
    s.cone(['#ffd23f', '#2fb7b0', '#e8536b'][k % 3], (-1.6 + k * 0.4, -0.86, 2.62), 0.1, 0.22, 3, (180, 0, 0), sx=1, sy=0.2)
s.box(DARKWOOD, (1.9, -0.84, 2.3), (0.2, 0.04, 0.04)).box('emit_warm', (2.0, -0.84, 2.12), (0.13, 0.13, 0.2))
s.done()

# shop stall: thatched roof, wall of seed packets, tools, sacks, cash box, sprout sign
s = Model('shop_stall')
stall_base(s, 72)
counter(s, '#2fb7b0', '#e0bb85', '#228f8a')
s.prism(THATCH, (0, 0, 2.78), 4.3, 2.6, 0.85)
s.prism('#c99d58', (0, 0, 2.76), 4.36, 2.66, 0.12)
for side in (-1, 1):                                                    # frayed thatch fringe
    for k in range(18):
        s.cone(THATCH if k % 2 else '#c99d58', (-2.1 + k * 0.247, side * 1.27, 2.8), 0.09, 0.2 + (k % 3) * 0.05, 4, (180, 0, 0))
for k in range(7):                                                      # back wall
    s.box('#a8744a' if k % 2 else '#9b6a42', (-1.71 + k * 0.57, 0.9, 1.4), (0.56, 0.08, 2.6))
PACKS = ['#e63946', '#f08a24', '#f6d743', '#8cc152', '#2d6a2e', '#e83e8c', '#7a5134', '#d8d29a']
for row, z in enumerate((0.9, 1.45, 2.0)):                              # shelves of seed packets and jars
    s.box(WOOD2, (0, 0.72, z), (3.4, 0.3, 0.05))
    for k in range(11):
        x = -1.55 + k * 0.31
        if (k + row) % 4 == 3:
            s.cyl('glass', (x, 0.72, z + 0.03), 0.07, 0.2, 8).cyl(PACKS[(k * 3 + row) % 8], (x, 0.72, z + 0.03), 0.055, 0.12, 8).cyl(ROPE, (x, 0.72, z + 0.22), 0.06, 0.03, 8)
        else:
            c = PACKS[(k + row * 3) % 8]
            s.box(c, (x, 0.7, z + 0.15), (0.2, 0.05, 0.26), (8, 0, 0)).box('#fff4e0', (x, 0.672, z + 0.12), (0.14, 0.01, 0.08), (8, 0, 0))
for x, kind in ((-1.95, 'hoe'), (-1.7, 'rake')):                         # tools leaning on the corner post
    s.cyl('#b98552', (x, 0.55, 0.12), 0.025, 1.7, 6, rot=(-8, 0, 0))
    if kind == 'hoe':
        s.box('metal', (x, 0.33, 1.78), (0.2, 0.03, 0.16))
    else:
        s.box('metal', (x, 0.33, 1.8), (0.32, 0.03, 0.04))
        for q in range(5):
            s.box('metal', (x - 0.14 + q * 0.07, 0.31, 1.73), (0.015, 0.02, 0.12))
s.rbox(DARKWOOD, (1.2, -0.6, 1.13), (0.46, 0.3, 0.16), 0.03).box('#f2b33d', (1.2, -0.76, 1.15), (0.12, 0.02, 0.06))   # cash box
s.plate('#fff4e0', (0.4, -0.62, 1.07), [(-0.24, -0.16), (0.0, -0.18), (0.0, 0.18), (-0.24, 0.16)], 0.01, (90, 0, 0))   # open ledger
s.plate('#f6eedb', (0.4, -0.62, 1.07), [(0.0, -0.18), (0.24, -0.16), (0.24, 0.16), (0.0, 0.18)], 0.01, (90, 0, 0))
s.box('#5a3a22', (0.4, -0.62, 1.07), (0.02, 0.36, 0.015))
s.box(WOOD2, (-0.8, -0.55, 1.25), (0.8, 0.06, 0.4), (-35, 0, 0))         # angled packet display
for k in range(4):
    s.box(PACKS[k * 2], (-1.08 + k * 0.19, -0.6, 1.3), (0.15, 0.03, 0.2), (-35, 0, 0))
s.sm = True
s.cyl('#c46b2b', (-1.45, -0.6, 1.06), 0.1, 0.16, 10, 0.13)              # potted sapling
s.ball(LEAF, (-1.45, -0.6, 1.38), 0.13, 1, jit=0.02).cyl(STEM, (-1.45, -0.6, 1.2), 0.012, 0.12, 4)
for x, y, c in ((1.3, -1.2, '#c9a36b'), (1.72, -1.15, '#d9bc84'), (1.5, -1.45, '#c2a070')):   # seed sacks
    s.ball(c, (x, y, 0.24), 0.2, 2, (1, 0.9, 1.25), jit=0.01)
    s.cone(c, (x, y, 0.5), 0.08, 0.12, 6).cyl(ROPE, (x, y, 0.47), 0.06, 0.03, 6)
s.sm = False
hanging_sign(s)
s.cyl(STEM, (0, -0.94, 1.95), 0.015, 0.2, 5)                             # sprout icon
s.sm = True
for sx in (-1, 1):
    s.ball('#5fae48', (sx * 0.09, -0.94, 2.08), 0.08, 1, (1.4, 0.5, 0.8), (0, sx * 25, 0))
s.sm = False
s.box('#c9a36b', (-1.75, -1.2, 0.25), (0.5, 0.5, 0.5)).box('#b28a55', (-1.6, -1.15, 0.62), (0.4, 0.4, 0.26), (0, 0, 20))   # crates
s.box('emit_warm', (1.78, -0.98, 2.15), (0.13, 0.13, 0.2)).box(DARKWOOD, (1.78, -0.92, 2.3), (0.04, 0.16, 0.04))
s.done()

m = Model('trader_pier')
m.box('#9b7653', (0, 0, 1.1), (24, 3.0, 0.2))
for i in range(9):
    for y in (-1.4, 1.4):
        m.cyl(DARKWOOD, (-11.5 + i * 2.9, y, -3), 0.14, 4.3, 6)
for i in range(24):
    m.box('#8a6845' if i % 2 else '#9b7653', (-11.5 + i, 0, 1.22), (0.9, 3.0, 0.04))
m.done()


def boat(name, big, wrecked=False):
    m = Model(name)
    L = 9 if big else 6
    m.box('#7a4b2a', (0, 0, 0.6), (L, 2.4 if big else 1.8, 1.2), (0, 0, 0))
    m.cone('#7a4b2a', (L / 2, 0, 0.6), 1.2 if big else 0.9, 1.6, 4, (0, 90, 0), sx=1.0, sy=1.0)
    m.box('#e8d4b0', (0, 0, 1.25), (L - 0.3, 2.2 if big else 1.6, 0.08))
    m.box(WHITE, (0, 0, 0.35), (L + 0.02, (2.4 if big else 1.8) + 0.02, 0.12))
    mast = 7 if big else 5
    if wrecked:
        m.cyl(DARKWOOD, (-0.5, 0, 1.2), 0.14, mast * 0.45, 6, rot=(25, 0, 0))
        m.box('sail', (-0.5, 1.4, 2.6), (2.0, 0.04, 1.4), (10, 25, 0))
        for i in range(6):
            m.box(WOOD, (R(-4, 4), R(-3, 3), 0.1), (R(1, 2), 0.25, 0.08), (0, 0, R(0, 180)))
    else:
        m.cyl(DARKWOOD, (-0.3, 0, 1.2), 0.12, mast, 6)
        m.box('sail', (-0.3, 0, 1.6 + mast * 0.5), (0.04, 3.4 if big else 2.4, mast * 0.75), (0, 0, 90))
        m.cyl(DARKWOOD, (-0.3, 0, 1.8), 0.05, 3.6 if big else 2.6, 5, rot=(90, 0, 0))
        m.box('#c9a36b', (-2.5, 0.3, 1.5), (0.8, 0.8, 0.6)).box('#c9a36b', (-2.0, -0.5, 1.45), (0.6, 0.6, 0.5))
        m.box('#e8536b', (-0.3, 0, mast + 1.3), (0.04, 0.6, 0.35))
    return m.done()


boat('trader_boat', False)


# --- the intro ship: a two-masted brigantine, 12 m long, bow +X, waterline at z=0.
# Split in three so the intro can animate it: intro_ship (hull, deck, main mast), intro_mainsails
# (origin on the main mast axis, billows) and intro_foremast (origin at its foot, snaps off at the reef).
def mi(m, col):
    mm = mat(col)
    if mm not in m.mats:
        m.mats.append(mm)
    return m.mats.index(mm)


def line(m, col, a, b, r, n=5):
    """Cylinder from a to b: spars, rigging."""
    a, b = Vector(a), Vector(b)
    d = b - a
    mtx = Matrix.Translation(a) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4() @ Matrix.Translation((0, 0, d.length / 2))
    g = bmesh.ops.create_cone(m.bm, cap_ends=True, cap_tris=False, segments=n, radius1=r, radius2=r, depth=d.length, matrix=mtx)
    return m._fin(g['verts'], col, 0)


SHIP_X0, SHIP_X1, SHIP_B, SHIP_D, SHIP_Z = -5.6, 6.4, 1.9, 1.95, 1.4


def ship_w(x, B=SHIP_B):
    u = (x - SHIP_X0) / (SHIP_X1 - SHIP_X0)
    if u < 0.6:
        return B * (0.78 + 0.22 * math.sin(u / 0.6 * math.pi / 2))
    v = (u - 0.6) / 0.4
    return B * max(0.035, 1 - v ** 1.9) ** 0.8


def ship_deck(x):
    u = (x - SHIP_X0) / (SHIP_X1 - SHIP_X0)
    return SHIP_Z + 0.55 * abs(u * 2 - 1) ** 2.2 + (0.3 * ((u - 0.78) / 0.22) ** 2 if u > 0.78 else 0)


def hull(m, s=1.0, o=(0, 0, 0), paint=('#3b2a1e', '#e0b04a', '#8a5a36', '#7a4b2a', '#9c3b2a'), deck='#c49a62', n=20, k=10):
    """Lofted closed hull: stations along x, U-shaped ribs, flat transom, pinched bow. Coloured in bands:
    dark rail, ochre stripe, alternating planks, red below the waterline."""
    ox, oy, oz = o
    rings = []
    for i in range(n):
        u = i / (n - 1)
        x = SHIP_X0 + (SHIP_X1 - SHIP_X0) * u
        w, zd = ship_w(x), ship_deck(x)
        kz = SHIP_Z - SHIP_D + (SHIP_D * 0.9 * ((u - 0.68) / 0.32) ** 2 if u > 0.68 else 0) + (0.35 * (0.15 - u) / 0.15 if u < 0.15 else 0)
        ring = []
        for j in range(k + 1):
            th = math.pi * j / k
            c = math.cos(th)
            y = w * math.copysign(abs(c) ** 0.5, c)
            z = zd - (zd - kz) * math.sin(th) ** 1.5
            ring.append(m.bm.verts.new((ox + x * s, oy + y * s, oz + z * s)))
        rings.append(ring)
    for i in range(n - 1):
        for j in range(k):
            q = (rings[i][j], rings[i + 1][j], rings[i + 1][j + 1], rings[i][j + 1])
            f = m.bm.faces.new(q)
            band = min(j, k - 1 - j)
            zc = sum(v.co.z for v in q) / 4
            col = paint[4] if zc < oz + 0.18 * s else paint[0] if band == 0 else paint[1] if band == 1 else paint[2 + band % 2]
            f.material_index = mi(m, col)
        f = m.bm.faces.new((rings[i][0], rings[i][k], rings[i + 1][k], rings[i + 1][0]))
        f.material_index = mi(m, deck)
    for r in (rings[0], rings[-1]):
        f = m.bm.faces.new(r)
        f.material_index = mi(m, paint[0])
    return m


def wall(m, col, a, b, h, inward):
    """Bulwark panel between rim points a and b, h tall, thickness toward inward."""
    a, b, up, iv = Vector(a), Vector(b), Vector((0, 0, h)), Vector(inward)
    v = [m.bm.verts.new(p) for p in (a, b, b + up, a + up, a + iv, b + iv, b + iv + up, a + iv + up)]
    for f in ((0, 1, 2, 3), (5, 4, 7, 6), (3, 2, 6, 7), (1, 5, 6, 2), (4, 0, 3, 7), (0, 4, 5, 1)):
        m.bm.faces.new([v[i] for i in f])
    return m._fin(v, col, 0)


def sail(m, col, x, zb, zt, wb, wt, bulge, nx=6, nz=4, t=0.04):
    """Square sail in the y-z plane at x, billowing toward +x; a thin closed solid so normals stay right."""
    def P(a, b, off):
        v, uu = a / nz, b / nx
        w = wb + (wt - wb) * v
        bx = bulge * math.sin(math.pi * uu) ** 0.8 * math.sin(math.pi * (0.12 + 0.76 * v)) + bulge * 0.25 * math.sin(math.pi * uu) * (1 - v)
        return Vector((x + bx + off, -w / 2 + w * uu, zb + (zt - zb) * v - 0.12 * math.sin(math.pi * uu) * (1 - v)))
    F = [[m.bm.verts.new(P(a, b, 0)) for b in range(nx + 1)] for a in range(nz + 1)]
    Bk = [[m.bm.verts.new(P(a, b, -t)) for b in range(nx + 1)] for a in range(nz + 1)]
    for a in range(nz):
        for b in range(nx):
            m.bm.faces.new((F[a][b], F[a][b + 1], F[a + 1][b + 1], F[a + 1][b]))
            m.bm.faces.new((Bk[a][b], Bk[a + 1][b], Bk[a + 1][b + 1], Bk[a][b + 1]))
    edge = [(0, b) for b in range(nx)] + [(a, nx) for a in range(nz)] + [(nz, b) for b in range(nx, 0, -1)] + [(a, 0) for a in range(nz, 0, -1)]
    for i, (a, b) in enumerate(edge):
        a2, b2 = edge[(i + 1) % len(edge)]
        m.bm.faces.new((F[a][b], Bk[a][b], Bk[a2][b2], F[a2][b2]))
    return m._fin([v for r in F + Bk for v in r], col, 0)


def barrel(m, loc, h=0.62, r=0.24):
    x, y, z = loc
    m.cyl('#8a5a36', (x, y, z), r * 0.88, h, 10, r2=r * 0.88).cyl('#9a6a40', (x, y, z + h * 0.2), r, h * 0.6, 10)
    for zz in (0.12, 0.88):
        m.cyl('#3a3a3a', (x, y, z + h * zz - 0.02), r * 0.95, 0.05, 10)


def crate(m, loc, sz=0.6, rot=0):
    m.rbox('#b08350', loc, (sz, sz, sz), 0.02, (0, 0, rot))
    for k in (-1, 1):
        m.box('#7a5134', (loc[0], loc[1], loc[2] + k * sz * 0.38), (sz * 1.02, sz * 1.02, 0.07), (0, 0, rot))


def lantern(m, loc):
    x, y, z = loc
    m.box(DARKWOOD, (x, y, z + 0.22), (0.2, 0.2, 0.04)).box('emit_warm', (x, y, z), (0.14, 0.14, 0.3)).box(DARKWOOD, (x, y, z - 0.16), (0.2, 0.2, 0.04))


def ship(name, wreck=False):
    m = Model(name)
    hull(m)
    dz = ship_deck
    # bulwarks + cap rail, posts
    xs = [SHIP_X0 + 0.05 + (SHIP_X1 - 0.35 - SHIP_X0) * i / 18 for i in range(19)]
    for side in (1, -1):
        for i in range(18):
            a, b = xs[i], xs[i + 1]
            if wreck and side == 1 and 6 <= i <= 8:
                continue                                                    # smashed rail
            pa, pb = (a, side * ship_w(a), dz(a)), (b, side * ship_w(b), dz(b))
            wall(m, '#6b4226', pa, pb, 0.42, (0, -side * 0.09, 0))
            line(m, '#e8d4b0', (a, side * (ship_w(a) - 0.04), dz(a) + 0.45), (b, side * (ship_w(b) - 0.04), dz(b) + 0.45), 0.06, 4)
        for i in range(0, 19, 2):
            x = xs[i]
            m.box('#5e3d24', (x, side * (ship_w(x) - 0.02), dz(x) + 0.05), (0.12, 0.1, 0.62))
        for x in (-2.2, -1.1, 0.0, 1.1, 2.2):                              # portholes
            w = ship_w(x) * 0.985
            m.cyl('#3b2a1e', (x, side * w, SHIP_Z - 0.35), 0.16, 0.06, 10, rot=(90, 0, 0))
            m.cyl('emit_warm', (x, side * (w + 0.03), SHIP_Z - 0.35), 0.1, 0.04, 10, rot=(90, 0, 0))
        for x in (-1.6, 1.6):                                               # chain plates for the shrouds
            m.box('#3b2a1e', (x, side * (ship_w(x) + 0.05), SHIP_Z + 0.05), (0.9, 0.1, 0.14))
    # deck planking lines + hatch
    for y in (-1.2, -0.6, 0, 0.6, 1.2):
        line(m, '#a77e4c', (-2.6, y, dz(-2.6) + 0.005), (4.6, y, dz(4.6) + 0.005), 0.025, 4)
    m.rbox('#5e3d24', (1.4, 0, dz(1.4) + 0.12), (1.5, 1.3, 0.25), 0.03)
    for k in range(5):
        m.box('#8a5a36', (0.85 + k * 0.28, 0, dz(1.4) + 0.26), (0.06, 1.2, 0.04))
    # stern castle: cabin with a raised quarterdeck
    q0, q1, qz = SHIP_X0 + 0.05, -2.7, 3.0
    cz = dz(-3.5) - 0.1
    m.rbox('#7a4b2a', ((q0 + q1) / 2, 0, (cz + qz) / 2), (q1 - q0, 3.0, qz - cz), 0.05)
    m.box('#c49a62', ((q0 + q1) / 2, 0, qz + 0.06), (q1 - q0 + 0.2, 3.2, 0.12))
    m.box('#e0b04a', ((q0 + q1) / 2, 0, qz - 0.05), (q1 - q0 + 0.24, 3.24, 0.08))
    m.box('#4a2e1c', (q1 + 0.02, 0, dz(q1) + 0.6), (0.06, 0.7, 1.15))       # door
    for y in (-0.95, 0.95):
        m.box('#3b2a1e', (q1 + 0.03, y, 2.35), (0.05, 0.5, 0.45)).box('emit_warm', (q1 + 0.05, y, 2.35), (0.04, 0.38, 0.33))
    for y in (-0.9, -0.3, 0.3, 0.9):                                        # stern gallery windows
        m.box('#e0b04a', (q0 - 0.03, y, 2.4), (0.06, 0.48, 0.62)).box('emit_warm', (q0 - 0.06, y, 2.4), (0.04, 0.36, 0.48))
    m.box('#e0b04a', (q0 - 0.05, 0, 2.95), (0.08, 3.0, 0.1)).box('#e0b04a', (q0 - 0.05, 0, 1.85), (0.08, 2.8, 0.1))
    for y in (-1.5, 1.5):                                                   # quarterdeck rail
        line(m, '#e8d4b0', (q0, y, qz + 0.6), (q1, y, qz + 0.6), 0.05, 4)
        for k in range(5):
            m.cyl('#5e3d24', (q0 + (q1 - q0) * k / 4, y, qz + 0.1), 0.05, 0.5, 6)
    line(m, '#e8d4b0', (q0, -1.5, qz + 0.6), (q0, 1.5, qz + 0.6), 0.05, 4)
    for y in (-1.45, 1.45):
        lantern(m, (q0 + 0.1, y, qz + 1.0))
        m.cyl(DARKWOOD, (q0 + 0.1, y, qz + 0.1), 0.04, 0.7, 5)
    for k in range(4):                                                      # steps up to the quarterdeck
        m.box('#8a5a36', (q1 + 0.25 + k * 0.28, 1.15, dz(q1) + 0.2 + k * 0.38), (0.3, 0.6, 0.08))
    # ship's wheel
    wx, wz = -3.6, qz + 1.0
    m.cyl('#5e3d24', (wx, 0, qz), 0.1, 0.85, 6)
    for k in range(8):
        a = k * math.pi / 4
        line(m, '#8a5a36', (wx + 0.08, 0, wz), (wx + 0.08, math.cos(a) * 0.6, wz + math.sin(a) * 0.6), 0.03, 4)
        b = a + math.pi / 4
        line(m, '#6b4226', (wx + 0.08, math.cos(a) * 0.45, wz + math.sin(a) * 0.45), (wx + 0.08, math.cos(b) * 0.45, wz + math.sin(b) * 0.45), 0.045, 4)
    # bowsprit, stem, anchors
    bs = (SHIP_X1 - 0.6, 0, dz(SHIP_X1 - 0.6) + 0.25)
    line(m, '#6b4226', bs, (SHIP_X1 + 3.2, 0, dz(SHIP_X1) + 1.6), 0.14, 7)
    m.box('#e0b04a', (SHIP_X1 - 0.05, 0, dz(SHIP_X1) - 0.6), (0.5, 0.12, 0.9), (0, -25, 0))
    for side in (1, -1):
        x = SHIP_X1 - 1.4
        y = side * (ship_w(x) + 0.08)
        line(m, '#4a4a4a', (x, y, dz(x) - 0.1), (x, y, dz(x) - 1.2), 0.05, 5)
        line(m, '#4a4a4a', (x - 0.35, y, dz(x) - 1.0), (x + 0.35, y, dz(x) - 1.0), 0.05, 5)
        m.cyl('#4a4a4a', (x, y, dz(x) - 0.12), 0.14, 0.05, 8, rot=(90, 0, 0))
    lantern(m, (SHIP_X1 - 0.7, 0, dz(SHIP_X1 - 0.7) + 0.9))
    # cargo
    for loc in ((-1.9, 0.9, dz(-1.9)), (-1.9, 0.38, dz(-1.9)), (3.6, -0.8, dz(3.6))):
        barrel(m, loc)
    crate(m, (-1.9, -0.8, dz(-1.9) + 0.3), 0.62, 10)
    crate(m, (-1.85, -0.75, dz(-1.9) + 0.88), 0.48, -15)
    crate(m, (4.3, 0.6, dz(4.3) + 0.25), 0.5, 30)
    m.cyl(ROPE, (2.7, 0.9, dz(2.7)), 0.34, 0.12, 12).cyl('#b08a55', (2.7, 0.9, dz(2.7) + 0.12), 0.22, 0.04, 12)
    m.ball('#d9c08c', (-1.2, -1.1, dz(-1.2) + 0.25), 0.3, 1, (1, 0.8, 0.8)).ball('#cdb27a', (-0.85, -1.2, dz(-1.2) + 0.2), 0.24, 1, (1, 0.9, 0.8))
    # little rowboat stowed on chocks
    hull(m, 0.2, (0.6, 0, dz(0.6) + 0.12), ('#2c5f6b', '#f2ede2', '#3e7f8c', '#367480', '#2c5f6b'), '#a77e4c', 10, 6)
    # main mast (stays put) + shrouds
    mx, mz = -0.4, dz(-0.4)
    mh = 12.0 if not wreck else 4.2
    m.cyl('#5e3d24', (mx, 0, mz), 0.2, mh, 10, r2=0.13)
    if not wreck:
        m.cyl('#6b4226', (mx, 0, 6.9), 0.75, 0.12, 10).cyl('#5e3d24', (mx, 0, 7.0), 0.75, 0.5, 10, r2=0.78)   # crow's nest
        m.cyl('#e0b04a', (mx, 0, mz + mh), 0.2, 0.18, 10)
        m.plate('#e8536b', (mx, 0, mz + mh - 0.5), [(0, 0), (1.8, 0.22), (0, 0.45)], 0.03)            # pennant
        for side in (1, -1):
            for x in (-1.9, -1.3, -0.7, -0.1):
                line(m, '#4a3a2a', (mx, side * 0.15, 6.9), (x, side * (ship_w(x) + 0.05), SHIP_Z + 0.4), 0.025, 4)
            line(m, '#4a3a2a', (mx, side * 0.12, 11.0), (q0 + 0.4, side * 1.4, qz + 0.6), 0.025, 4)             # backstays
    else:
        m.cyl('#d8c49a', (mx, 0, mz + mh - 0.05), 0.16, 0.12, 8, r2=0.05)                                     # splintered top
        m.box('sail', (mx + 0.3, 0.9, mz + 2.4), (0.05, 2.2, 1.6), (12, 20, -8))                              # torn sail draped
        line(m, '#5e3d24', (mx + 0.5, -0.6, dz(mx) + 0.2), (mx + 5.5, -2.4, dz(mx) - 0.6), 0.16, 8)            # fallen spar
        for k in range(7):
            m.box(WOOD, (R(-5, 7), R(-4, 4), R(-0.3, 0.1)), (R(1.0, 2.2), 0.24, 0.07), (R(-8, 8), 0, R(0, 180)))
        for x, z in ((-1.0, 0.7), (0.4, 0.4), (1.8, 0.8)):                                                   # holes in the hull
            m.box('#1c140e', (x, ship_w(x) + 0.02, z), (0.9, 0.08, 0.45), (R(-10, 10), 0, R(-15, 15)))
    return m.done()


ship('intro_ship')
w = ship('shipwreck', True)
w.rotation_euler = (0.32, 0.18, 0.5)
bpy.context.view_layer.update()
w.data.transform(w.matrix_basis)
w.matrix_basis.identity()

ms = Model('intro_mainsails')                       # origin on the main mast axis
for zb, zt, wb, wt, bl in ((3.3, 6.5, 6.0, 5.2, 0.75), (7.6, 9.9, 4.8, 3.8, 0.55), (10.2, 11.5, 3.2, 2.6, 0.35)):
    sail(ms, 'sail', 0.32, zb, zt, wb, wt, bl)
    line(ms, '#5e3d24', (0.22, -wt / 2 - 0.3, zt + 0.05), (0.22, wt / 2 + 0.3, zt + 0.05), 0.08, 6)
    line(ms, '#5e3d24', (0.22, -wb / 2 - 0.2, zb - 0.1), (0.22, wb / 2 + 0.2, zb - 0.1), 0.06, 6)
ms.box('#b8403a', (0.32 + 0.75 * 0.97, 0, 4.9), (0.04, 1.2, 1.2), (45, 0, 0))                     # red diamond on the course
ms.done()

fm = Model('intro_foremast')                        # origin at the foot of the fore mast (x=3.2, on deck)
FX = 3.2
fd = ship_deck(FX)
fm.cyl('#5e3d24', (0, 0, 0), 0.17, 9.6, 10, r2=0.11)
fm.cyl('#6b4226', (0, 0, 5.3), 0.6, 0.1, 10)
for zb, zt, wb, wt, bl in ((1.5, 5.0, 5.0, 4.3, 0.65), (5.6, 7.7, 3.9, 3.1, 0.45), (8.0, 9.2, 2.6, 2.1, 0.3)):
    sail(fm, 'sail', 0.28, zb, zt, wb, wt, bl)
    line(fm, '#5e3d24', (0.18, -wt / 2 - 0.25, zt + 0.05), (0.18, wt / 2 + 0.25, zt + 0.05), 0.07, 6)
bow = Vector((SHIP_X1 + 3.1 - FX, 0, ship_deck(SHIP_X1) + 1.55 - fd))
for k, (top, back) in enumerate(((8.6, 0.0), (6.2, 0.3))):                  # two jibs from the mast to the bowsprit
    a, b = Vector((0.15, 0, top)), bow - Vector((back * 3, 0, back * 0.6))
    c = Vector((b.x * 0.55, 0, 1.2 + k * 0.4))
    v = [fm.bm.verts.new(p + Vector((0, dy, 0))) for dy in (0.02, -0.02) for p in (a, b, c)]
    fm.bm.faces.new(v[:3])
    fm.bm.faces.new(v[3:][::-1])
    for i in range(3):
        j = (i + 1) % 3
        fm.bm.faces.new((v[i], v[j], v[3 + j], v[3 + i]))
    fm._fin(v, 'sail', 0)
    line(fm, '#4a3a2a', a, b, 0.025, 4)
for side in (1, -1):                                 # fore shrouds (fall with the mast)
    for dx in (-1.0, -0.4, 0.2):
        line(fm, '#4a3a2a', (0, side * 0.12, 5.3), (dx, side * (ship_w(FX + dx) + 0.05), SHIP_Z + 0.4 - fd), 0.025, 4)
fm.done()
print('SHIP fore mast foot', FX, round(fd, 3), 'main mast', -0.4, round(ship_deck(-0.4), 3))


def factory(name, wallc, roofc, extra):
    m = Model(name)
    walls(m, 3.4, 3.0, 2.2, wallc)
    door_win(m, 3.4, 3.0)
    m.prism(roofc, (0, 0, 2.2), 3.9, 3.5, 1.3)
    extra(m)
    return m.done()


factory('bakery', '#e8d4b0', '#b85c38', lambda m: (m.box(STONE, (1.0, 0.6, 3.0), (0.6, 0.6, 2.0)),
                                                   m.cyl(STONE2, (2.1, 0, 0), 0.6, 1.1, 8, 0.4), m.box('emit_fire', (2.1, -0.5, 0.45), (0.4, 0.06, 0.35))))
factory('juicer', '#f2c879', '#2fb7b0', lambda m: (m.cyl(WOOD, (2.2, 0, 0), 0.55, 0.9, 10), m.cyl(DARKWOOD, (2.2, 0, 0.9), 0.08, 0.9, 6),
                                                    m.ball('#f9a03f', (2.2, 0.2, 1.0), 0.15, 1), m.ball('#f6e05e', (2.0, -0.2, 1.0), 0.15, 1)))
factory('sugar_mill', '#d6b48c', '#7a3b2e', lambda m: (m.cyl(STONE, (2.2, 0, 0.6), 0.7, 0.25, 12, rot=(90, 0, 0)),
                                                       m.cyl(DARKWOOD, (2.2, 0, 0), 0.08, 1.3, 6), m.box('#8a9a3c', (2.2, 0.8, 0.3), (0.2, 0.9, 0.2))))
factory('loom', '#c9a27a', THATCH, lambda m: (m.box(WOOD2, (2.2, 0, 0.8), (0.12, 1.4, 1.6)), m.box(WOOD2, (2.6, 0, 0.8), (0.12, 1.4, 1.6)),
                                               m.box('#f8f4ec', (2.4, 0, 0.9), (0.4, 1.2, 0.04), (0, 30, 0))))
factory('chocolate_maker', '#8a5a36', '#4a2c1a', lambda m: (m.cyl('#5e3d24', (2.2, 0, 0), 0.6, 0.8, 10), m.cyl('#3b2414', (2.2, 0, 0.8), 0.5, 0.05, 10),
                                                             m.box('emit_fire', (2.2, -0.62, 0.25), (0.35, 0.04, 0.2))))
factory('coffee_roaster', '#d6b48c', '#5e3d24', lambda m: (m.cyl('#3a3a3a', (2.2, 0, 0.7), 0.5, 1.0, 10, rot=(90, 0, 0)),
                                                            m.cyl('#3a3a3a', (2.2, 0, 1.2), 0.1, 1.2, 6), m.box('#6b4423', (2.2, 0.75, 0.3), (0.4, 0.4, 0.5))))

m = Model('greenhouse')
for x in (-4.8, 0, 4.8):
    for y in (-4.8, 0, 4.8):
        m.cyl(WHITE, (x, y, 0), 0.08, 3.0, 6)
for x in (-4.8, 4.8):
    m.box('glass', (x, 0, 1.5), (0.04, 9.6, 3.0))
for y in (-4.8, 4.8):
    m.box('glass', (0, y, 1.5), (9.6, 0.04, 3.0))
m.box(WHITE, (0, 0, 3.0), (9.8, 9.8, 0.08))
m.box('glass', (0, -2.4, 3.6), (9.6, 5.0, 0.04), (-14, 0, 0)).box('glass', (0, 2.4, 3.6), (9.6, 5.0, 0.04), (14, 0, 0))
m.box(WHITE, (0, 0, 4.2), (9.8, 0.15, 0.15))
m.done()

m = Model('crop_cover')
for x in (-2.8, 2.8):
    for y in (-2.8, 2.8):
        m.cyl(WOOD2, (x, y, 0), 0.06, 1.8, 6)
m.box('net', (0, 0, 1.85), (5.8, 5.8, 0.03))
m.done()

m = Model('bridge')
m.box('#9b7653', (0, 0, 1.6), (2.4, 9.0, 0.2))
for i in range(12):
    m.box('#8a6845' if i % 2 else '#9b7653', (0, -4.2 + i * 0.75, 1.72), (2.4, 0.65, 0.05))
for x in (-1.2, 1.2):
    for y in (-4.4, -1.5, 1.5, 4.4):
        m.cyl(DARKWOOD, (x, y, -1.2), 0.1, 3.8, 6)
    m.box(ROPE, (x, 0, 2.4), (0.06, 9.0, 0.06))
m.done()

m = Model('sea_wall')
for i in range(3):
    m.box(STONE if i % 2 else STONE2, ((i - 1) * 0.66, 0, 0.5), (0.68, 1.0, 1.0), jit=0.04)
    m.box(STONE2 if i % 2 else STONE, ((i - 1) * 0.66 + 0.2, 0, 1.3), (0.66, 0.9, 0.6), jit=0.04)
m.done()
Model('lightning_rod').box(STONE, (0, 0, 0.2), (0.7, 0.7, 0.4)).cyl('#8a8f94', (0, 0, 0.4), 0.06, 5.0, 6).cone('#c8783a', (0, 0, 5.4), 0.1, 0.6, 6) \
    .cyl('#c8783a', (0, 0, 5.2), 0.2, 0.06, 8).done()
Model('rain_barrel').cyl('#8a6845', (0, 0, 0), 0.45, 1.0, 10, 0.5).cyl('#5a5a5a', (0, 0, 0.25), 0.47, 0.08, 10).cyl('#5a5a5a', (0, 0, 0.75), 0.5, 0.08, 10) \
    .cyl('#2b5d78', (0, 0, 0.95), 0.44, 0.03, 10).box(WOOD2, (0.5, 0, 1.4), (0.1, 0.1, 1.0)).done()
m = Model('windbreak')
for i in range(4):
    m.ball('#3a8a33' if i % 2 else '#2f7a2d', ((i - 1.5) * 0.5, 0, 0.8), 0.6, 1, (1, 0.6, 1.4), jit=0.06)
m.done()
Model('raised_bed').box(WOOD, (0, 0, 0.2), (1.9, 1.9, 0.4)).box(SOIL, (0, 0, 0.38), (1.7, 1.7, 0.06)).done()


def sprinkler(name, k):
    Model(name).cyl('#5a6a72', (0, 0, 0), 0.08 * k, 0.7 * k, 6).cyl('#3d8bb5', (0, 0, 0), 0.25 * k, 0.12, 8).done()
    Model(name + '_head').cyl('#c9d2d8', (0, 0, 0), 0.1 * k, 0.1, 6).box('#c9d2d8', (0, 0, 0.05), (0.7 * k, 0.06, 0.06)) \
        .cone('#3d8bb5', (0.35 * k, 0, 0.05), 0.05, 0.12, 5, (0, 90, 0)).cone('#3d8bb5', (-0.35 * k, 0, 0.05), 0.05, 0.12, 5, (0, -90, 0)).done()


sprinkler('sprinkler', 1.0)
sprinkler('sprinkler_big', 1.5)

m = Model('scarecrow')
m.cyl(WOOD2, (0, 0, 0), 0.06, 2.0, 6).cyl(WOOD2, (0, 0, 1.45), 0.05, 1.5, 6, rot=(0, 90, 0))
m.box('#b85c38', (0, 0, 1.25), (0.55, 0.3, 0.65)).box(THATCH, (0, 0, 0.85), (0.4, 0.25, 0.3))
m.ball('#e9d8a6', (0, 0, 1.85), 0.2, 1).cyl(THATCH, (0, 0, 2.0), 0.36, 0.05, 10).cone(THATCH, (0, 0, 2.03), 0.2, 0.3, 8)
for x in (-0.7, 0.7):
    m.cone(THATCH, (x, 0, 1.45), 0.08, 0.2, 5, (0, 90 if x > 0 else -90, 0))
m.done()

Model('auto_planter').box('#5a6a72', (0, 0, 0.3), (0.9, 0.9, 0.6)).cone('#e8536b', (0, 0, 1.3), 0.45, -0.6, 8) \
    .cyl('#e8536b', (0, 0, 0.6), 0.12, 0.2, 8).box('emit_eye', (0, -0.46, 0.4), (0.3, 0.04, 0.1)).done()

m = Model('harvester_bot')
m.box('#f2b33d', (0, 0, 0.45), (0.8, 1.0, 0.45)).box('#e8a82a', (0, 0.1, 0.78), (0.6, 0.6, 0.25))
for x in (-0.45, 0.45):
    for y in (-0.35, 0.35):
        m.cyl('#333333', (x, y, 0.2), 0.2, 0.14, 10, rot=(0, 90, 0))
m.box('emit_eye', (0, -0.51, 0.55), (0.45, 0.04, 0.12))
m.cyl('#5a6a72', (0, -0.3, 0.9), 0.04, 0.5, 5, rot=(-40, 0, 0)).box('#5a6a72', (0, -0.62, 1.2), (0.3, 0.08, 0.2))
m.done()
Model('bot_dock').box('#5a6a72', (0, 0, 0.05), (1.8, 1.8, 0.1)).box('#f2b33d', (0, 0.8, 0.4), (1.6, 0.15, 0.8)).box('emit_eye', (0, 0.72, 0.65), (0.5, 0.04, 0.1)).done()
m = Model('conveyor')
m.box('#5a6a72', (0, 0, 0.3), (2.0, 1.2, 0.12)).box('#2b2b2b', (0, 0, 0.38), (2.0, 1.0, 0.04))
for x in (-0.8, 0.8):
    for y in (-0.55, 0.55):
        m.cyl('#5a6a72', (x, y, 0), 0.05, 0.3, 5)
for y in (-0.6, 0.6):
    m.box('#f2b33d', (0, y, 0.42), (2.0, 0.06, 0.1))
m.cone('#f2b33d', (0.3, 0, 0.42), 0.25, 0.01, 3, (0, 0, -90))
m.done()
m = Model('auto_market')
walls(m, 3.4, 3.2, 2.4, '#2fb7b0')
m.box('#f2ede2', (0, -1.63, 1.4), (2.4, 0.06, 0.9)).box(WOOD, (0, -1.9, 1.0), (3.2, 0.6, 0.1))
m.cone('#f2b33d', (0, 0, 2.4), 2.6, 1.4, 4, (0, 0, 45))
m.cyl('#f2b33d', (0, -1.68, 3.0), 0.4, 0.08, 12, rot=(90, 0, 0)).cyl('#d99a1e', (0, -1.75, 3.0), 0.25, 0.05, 12, rot=(90, 0, 0))
m.done()
m = Model('fence')
for x in (-0.9, 0.9):
    m.box(WOOD2, (x, 0, 0.5), (0.14, 0.14, 1.0))
for z in (0.4, 0.75):
    m.box(WOOD, (0, 0, z), (2.0, 0.08, 0.12))
m.done()
m = Model('path')
for i in range(5):
    random.seed(80 + i)
    m.cyl('#c9c1ad' if i % 2 else '#b9b19d', (R(-0.6, 0.6), R(-0.6, 0.6), 0), R(0.3, 0.45), 0.05, 7, jit=0.03)
m.done()
m = Model('flowers')
for i in range(9):
    random.seed(90 + i)
    x, y = R(-0.8, 0.8), R(-0.8, 0.8)
    c = ('#ffd23f', '#ff6fa3', '#ffffff', '#ff8c42')[i % 4]
    m.cyl(STEM, (x, y, 0), 0.015, 0.3, 4).ball(c, (x, y, 0.32), 0.08, 1, (1, 1, 0.5))
m.done()
m = Model('statue')
m.box(STONE2, (0, 0, 0.3), (1.0, 1.0, 0.6)).box(STONE, (0, 0, 1.3), (0.6, 0.5, 1.4), jit=0.02)
m.box('#5a5650', (0, -0.26, 1.6), (0.4, 0.04, 0.12)).box('#5a5650', (0, -0.26, 1.25), (0.3, 0.04, 0.2))
m.prism(STONE2, (0, 0, 2.0), 0.7, 0.6, 0.4)
m.done()
Model('sign_forsale').cyl(WOOD2, (0, 0, 0), 0.06, 1.4, 6).box('#e9d8a6', (0, -0.05, 1.2), (0.9, 0.06, 0.55)).box('#e8536b', (0, -0.09, 1.2), (0.7, 0.02, 0.15)).done()
def soil(name, base, ridge, top, seed, extra=()):
    """Tilled bed: dark base, four rounded furrow ridges (top at ~0.135), crumbs and pebbles."""
    random.seed(seed)
    m = Model(name)
    m.rbox(base, (0, 0, 0.04), (1.86, 1.86, 0.1), 0.05)
    for k in range(4):                                      # each furrow ridge: overlapping crumbly lumps
        y = -0.675 + k * 0.45
        for q in range(9):
            x = -0.76 + q * 0.19 + R(-0.03, 0.03)
            m.ball(ridge if R(0, 1) < 0.6 else top, (x, y + R(-0.02, 0.02), 0.075), 0.3, 1,
                   (R(0.5, 0.62), R(0.56, 0.64), R(0.2, 0.26)), (0, 0, R(0, 60)), jit=0.015)
    for k in range(14):                                     # clods along the crests
        m.ball(ridge if k % 2 else top, (R(-0.8, 0.8), -0.675 + (k % 4) * 0.45 + R(-0.1, 0.1), 0.135), R(0.025, 0.05), 0, (1, 1, 0.7), jit=0.008)
    for k in range(4):                                      # pebbles in the grooves
        m.ball('#a39a8a', (R(-0.8, 0.8), -0.45 + (k % 3) * 0.45, 0.1), R(0.025, 0.04), 0, (1.2, 1, 0.6))
    for col, n in extra:
        for k in range(n):
            m.ball(col, (R(-0.8, 0.8), -0.675 + (k % 4) * 0.45 + R(-0.12, 0.12), 0.14), R(0.018, 0.03), 0, (1, 1, 0.6))
    m.done()


soil('soil_tile', '#5c3b25', '#7a5134', '#8c6040', 61)
soil('soil_fertile', '#3d2716', '#553621', '#654330', 62, (('#7fbf6a', 8), ('#e8dcc0', 6)))   # sprouts + compost flecks


def soil_joins(pre, base, ridge, top, seed):
    """Fillers laid between neighbouring soil tiles (tiles are 2 m, beds 1.86 m) so a field reads as one bed.
    _row bridges along the furrows (ridges carry on), _side across them, _corner where four tiles meet."""
    random.seed(seed)
    m = Model(pre + '_row').rbox(base, (0, 0, 0.0), (0.5, 1.86, 0.18), 0.03)
    for k in range(4):
        y = -0.675 + k * 0.45
        for x in (-0.1, 0.1):
            m.ball(ridge if R(0, 1) < 0.6 else top, (x + R(-0.02, 0.02), y + R(-0.02, 0.02), 0.075), 0.3, 1,
                   (R(0.5, 0.62), R(0.56, 0.64), R(0.2, 0.26)), (0, 0, R(0, 60)), jit=0.015)
    m.done()
    m = Model(pre + '_side').rbox(base, (0, 0, 0.0), (1.86, 0.5, 0.18), 0.03)
    for k in range(3):
        m.ball(top, (R(-0.8, 0.8), R(-0.1, 0.1), 0.1), R(0.025, 0.045), 0, (1, 1, 0.7), jit=0.008)
    m.done()
    Model(pre + '_corner').rbox(base, (0, 0, 0.0), (0.5, 0.5, 0.18), 0.03).done()


soil_joins('soil_join', '#5c3b25', '#7a5134', '#8c6040', 63)
soil_joins('soil_fjoin', '#3d2716', '#553621', '#654330', 64)
Model('quest_board').cyl(WOOD2, (-0.8, 0, 0), 0.07, 2.0, 6).cyl(WOOD2, (0.8, 0, 0), 0.07, 2.0, 6).box(WOOD, (0, 0, 1.5), (1.9, 0.1, 1.0)) \
    .box('#f2ede2', (-0.45, -0.06, 1.55), (0.45, 0.02, 0.55), (0, 4, 0)).box('#f2ede2', (0.2, -0.06, 1.5), (0.4, 0.02, 0.5), (0, -6, 0)) \
    .box('#f9eeda', (0.65, -0.06, 1.6), (0.3, 0.02, 0.4)).prism(THATCH, (0, 0, 2.0), 2.2, 0.6, 0.4).done()
Model('crate').box('#c9a36b', (0, 0, 0.3), (0.6, 0.6, 0.6)).box(WOOD2, (0, -0.31, 0.3), (0.62, 0.02, 0.1), (0, 45, 0)).done()
Model('barrel').cyl('#8a6845', (0, 0, 0), 0.32, 0.8, 9, 0.35).cyl('#5a5a5a', (0, 0, 0.2), 0.35, 0.06, 9).cyl('#5a5a5a', (0, 0, 0.6), 0.35, 0.06, 9).done()
Model('lantern').cyl(DARKWOOD, (0, 0, 0), 0.06, 2.2, 6).box(DARKWOOD, (0.2, 0, 2.15), (0.5, 0.06, 0.06)).box('emit_warm', (0.42, 0, 1.9), (0.2, 0.2, 0.28)).done()
Model('fire').cone('emit_fire', (0, 0, 0), 0.35, 1.0, 5).cone('emit_warm', (0.15, 0.1, 0), 0.2, 0.7, 5).cone('emit_fire', (-0.2, -0.1, 0), 0.22, 0.6, 5).done()
Model('ruin_pillar').cyl('#bdb5a1', (0, 0, 0), 0.4, 2.6, 8, jit=0.05).box('#a69f8b', (0, 0, 2.7), (1.0, 1.0, 0.25), jit=0.03).done()
m = Model('ruin_arch')
for x in (-1.3, 1.3):
    m.box('#bdb5a1', (x, 0, 1.4), (0.6, 0.6, 2.8), jit=0.05)
m.box('#a69f8b', (0, 0, 3.0), (3.4, 0.7, 0.5), jit=0.05)
m.done()
Model('journal').box('#7a3b2e', (0, 0, 0.04), (0.45, 0.32, 0.08)).box('#f2ede2', (0.02, 0, 0.05), (0.42, 0.3, 0.06)).done()
Model('chest').box('#8a5a36', (0, 0, 0.3), (0.9, 0.6, 0.5)).cyl('#8a5a36', (0, 0, 0.55), 0.3, 0.9, 8, rot=(0, 90, 0), sy=1.0) \
    .box('#f2b33d', (0, -0.31, 0.45), (0.15, 0.04, 0.2)).box('#f2b33d', (-0.35, 0, 0.3), (0.06, 0.62, 0.52)).box('#f2b33d', (0.35, 0, 0.3), (0.06, 0.62, 0.52)).done()

# ----------------------------------------------------------------- tools, items, characters
def handle(m, L=0.9):
    m.cyl(WOOD, (0, 0, -L * 0.15), 0.025, L, 6)


# hoe: tapered ash handle, rope grip (hand sits at z 0.12), steel ferrule, gooseneck, angled trapezoid blade
m = Model('tool_hoe')
m.sm = True
m.cyl('#b98552', (0, 0, -0.16), 0.027, 0.88, 10, 0.022)
m.ball(DARKWOOD, (0, 0, -0.165), 0.036, 2, (1, 1, 0.75))
m.cyl(ROPE, (0, 0, 0.02), 0.031, 0.2, 10)
for z in (0.02, 0.215):
    m.cyl('#7a5a36', (0, 0, z), 0.033, 0.012, 10)
m.cyl('metal', (0, 0, 0.64), 0.028, 0.09, 10, 0.024)
for z in (0.64, 0.715):
    m.cyl('metal', (0, 0, z), 0.032, 0.014, 10)
m.cyl('metal', (0, 0, 0.72), 0.016, 0.09, 8, 0.015, (35, 0, 0))
m.ball('metal', (0, -0.052, 0.794), 0.017, 1)
m.cyl('metal', (0, -0.052, 0.794), 0.015, 0.085, 8, 0.014, (95, 0, 0))
m.sm = False
m.sm = True
m.ball('metal', (0, -0.135, 0.79), 0.02, 1, (1.3, 1, 1))   # neck flows into the blade
m.sm = False
m.plate('metal', (0, -0.142, 0.80), [(-0.035, 0.012), (0.035, 0.012), (0.06, -0.02), (0.085, -0.13), (-0.085, -0.13), (-0.06, -0.02)], 0.016, (18, 0, 0))
m.plate('#e4e8eb', (0, -0.142, 0.80), [(-0.083, -0.118), (0.083, -0.118), (0.087, -0.14), (-0.087, -0.14)], 0.02, (18, 0, 0))
for x in (-0.022, 0.022):
    m.ball('#4a4f55', (x, -0.128, 0.775), 0.008, 1)
m.done()
# axe: curved hickory handle, knob, leather grip, bearded head with a bright bit (metal tints by tier)
EDGE = '#e4e8eb'
def grip(m, z0, z1, r):
    m.cyl('#7a4b2a', (0, 0, z0), r, z1 - z0, 10)
    for k in range(6):
        m.cyl('#5e3d24', (0, 0, z0 + (z1 - z0) * (k + 0.5) / 6), r + 0.003, 0.01, 10, rot=(12, 0, 0))

m = Model('tool_axe')
m.sm = True
line(m, '#b98552', (0, 0, -0.105), (0, 0.012, 0.2), 0.024, 10)
line(m, '#b98552', (0, 0.012, 0.2), (0, 0, 0.6), 0.022, 10)
m.ball('#b98552', (0, 0.006, 0.2), 0.0235, 2)
m.ball(DARKWOOD, (0, 0.002, -0.11), 0.032, 2, (1, 1.15, 0.8))
m.sm = False
grip(m, -0.08, 0.1, 0.027)
m.rbox('metal', (0, -0.005, 0.52), (0.05, 0.075, 0.13), 0.012)                       # eye around the handle
m.box('metal', (0, 0.045, 0.52), (0.045, 0.03, 0.09))                               # poll
m.plate('metal', (0, 0, 0.52), [(-0.03, 0.05), (-0.13, 0.075), (-0.2, 0.1), (-0.215, 0.02), (-0.2, -0.09), (-0.16, -0.11), (-0.12, -0.05), (-0.03, -0.05)], 0.028, (0, 0, 90))
m.plate(EDGE, (0, 0, 0.52), [(-0.198, 0.1), (-0.222, 0.1), (-0.237, 0.02), (-0.222, -0.09), (-0.198, -0.088), (-0.213, 0.02)], 0.03, (0, 0, 90))
m.box(DARKWOOD, (0, -0.005, 0.59), (0.02, 0.05, 0.02))                              # wedge
m.done()

# pickaxe: straight handle, collar, crescent head tapering to a point and a chisel
m = Model('tool_pickaxe')
m.sm = True
line(m, '#b98552', (0, 0, -0.18), (0, 0, 0.62), 0.024, 10)
m.ball(DARKWOOD, (0, 0, -0.185), 0.032, 2, (1, 1, 0.8))
m.sm = False
grip(m, -0.15, 0.05, 0.027)
m.rbox('metal', (0, 0, 0.56), (0.055, 0.07, 0.09), 0.012)
pts = []
for k in range(9):
    t = -1 + 2 * k / 8
    pts.append(Vector((0, t * 0.3, 0.56 - 0.07 * t * t)))
for k in range(8):
    a, b = pts[k], pts[k + 1]
    mid = abs((k + 0.5) / 4 - 1)
    line(m, 'metal', a, b, 0.03 * (1 - mid * 0.6), 8)
    m.ball('metal', b, 0.03 * (1 - abs((k + 1) / 4 - 1) * 0.6), 1)
m.cone(EDGE, tuple(pts[0]), 0.013, 0.05, 6, (95, 0, 0))                            # point (pick end, -y)
m.box(EDGE, tuple(pts[-1] + Vector((0, 0.018, -0.01))), (0.05, 0.03, 0.02), (20, 0, 0))   # chisel end
m.done()

# sickle: short turned handle, rope wrap, brass ferrule, crescent blade with a bright inner edge
m = Model('tool_sickle')
m.sm = True
m.cyl('#b98552', (0, 0, -0.06), 0.022, 0.31, 10, 0.027)
m.ball(DARKWOOD, (0, 0, -0.065), 0.028, 2, (1, 1, 0.7))
m.sm = False
m.cyl(ROPE, (0, 0, 0.0), 0.029, 0.14, 10)
m.cyl('#d9a441', (0, 0, 0.24), 0.026, 0.035, 10)
m.cyl('metal', (0, 0, 0.27), 0.012, 0.05, 6)
cx, cz, R1, R0 = -0.12, 0.34, 0.135, 0.105
outer, inner = [], []
for k in range(15):
    a = math.radians(-60 + 230 * k / 14)
    taper = 1 - k / 14
    outer.append((cx + math.cos(a) * R1, cz + math.sin(a) * R1))
    inner.append((cx + math.cos(a) * (R1 - (R1 - R0) * taper - 0.004), cz + math.sin(a) * (R1 - (R1 - R0) * taper - 0.004)))
m.plate('metal', (0, 0, 0), outer + inner[::-1], 0.012, (0, 0, 90))
edge = []
for k in range(15):
    a = math.radians(-60 + 230 * k / 14)
    taper = 1 - k / 14
    r_in = R1 - (R1 - R0) * taper
    edge.append((cx + math.cos(a) * (r_in - 0.002), cz + math.sin(a) * (r_in - 0.002)))
edge2 = [(cx + (x - cx) * 1.12, cz + (z - cz) * 1.12) for x, z in edge]
m.plate(EDGE, (0, 0, 0), [(cx + (x - cx) * 0.985, cz + (z - cz) * 0.985) for x, z in edge] + [(cx + (x - cx) * 1.09, cz + (z - cz) * 1.09) for x, z in edge][::-1], 0.014, (0, 0, 90))
m.done()

# bucket: wooden staves, metal hoops (tinted by tier), rope-wrapped bail, water inside
m = Model('tool_bucket')
for k in range(14):
    a = k / 14 * math.tau
    c = WOOD if k % 2 else '#b98a58'
    m.box(c, (math.cos(a) * 0.17, math.sin(a) * 0.17, 0.15), (0.075, 0.03, 0.3), (0, 4, math.degrees(a) + 90))
m.cyl(WOOD2, (0, 0, 0.0), 0.16, 0.03, 14)
for z in (0.05, 0.25):
    m.cyl('metal', (0, 0, z), 0.183 + (z - 0.05) * 0.06, 0.03, 16)
m.cyl('#3fa7c9', (0, 0, 0.22), 0.165, 0.02, 14).cyl('#8fd8ec', (0, 0, 0.235), 0.1, 0.008, 12)
for x in (-1, 1):
    m.box('metal', (x * 0.195, 0, 0.29), (0.02, 0.04, 0.05))
for k in range(10):
    a0, a1 = math.pi * k / 10, math.pi * (k + 1) / 10
    line(m, '#5a5a5a', (math.cos(a0) * 0.195, 0, 0.3 + math.sin(a0) * 0.19), (math.cos(a1) * 0.195, 0, 0.3 + math.sin(a1) * 0.19), 0.009, 6)
m.cyl(ROPE, (-0.05, 0, 0.488), 0.016, 0.1, 8, rot=(0, 90, 0))
m.done()

# seed pouch: burlap, tied neck, a tag and a few seeds
m = Model('tool_seeds')
m.sm = True
m.ball('#c9a36b', (0, 0, 0.12), 0.14, 2, (1, 0.85, 1.05))
m.ball('#c9a36b', (0, 0, 0.27), 0.06, 2, (1, 0.9, 0.9))
m.sm = False
m.cyl(ROPE, (0, 0, 0.225), 0.055, 0.03, 10)
for a in range(0, 360, 60):
    m.cone('#b8925a', (math.cos(math.radians(a)) * 0.04, math.sin(math.radians(a)) * 0.04, 0.29), 0.025, 0.06, 4, (math.sin(math.radians(a)) * -30, math.cos(math.radians(a)) * 30, 0))
m.box('#f2ede2', (0.09, -0.08, 0.17), (0.05, 0.01, 0.07), (0, 0, 20))
m.box('#7cc444', (0.09, -0.086, 0.17), (0.025, 0.005, 0.03), (0, 0, 20))
for x, y in ((0.12, 0.08), (0.15, 0.03), (0.09, 0.12)):
    m.ball('#8a5a36', (x, y, 0.01), 0.012, 1, (1, 0.7, 0.6))
m.done()

# fertilizer: paper sack with a folded top and a leaf label (the 'tint' stripe turns gold for golden fertilizer)
m = Model('tool_fertilizer')
m.rbox('#7fbf6a', (0, 0, 0.18), (0.28, 0.15, 0.36), 0.04)
m.rbox('#6aa857', (0, 0, 0.385), (0.28, 0.1, 0.05), 0.015)
m.box('tint', (0, -0.077, 0.08), (0.282, 0.01, 0.05))
m.box('#f2ede2', (0, -0.078, 0.22), (0.17, 0.01, 0.14))
m.frond('#4a8f2c', (0, -0.086, 0.17), math.pi / 2 + 0.6, 0.08, 0.06, 0.02, 0.025, 3)
m.frond('#5fae6b', (0, -0.086, 0.17), math.pi / 2 - 0.6, 0.07, 0.05, 0.02, 0.022, 3)
for x in (-0.12, 0.12):
    m.box(ROPE, (x, 0, 0.36), (0.015, 0.16, 0.02))
m.done()

# coin bag: plump leather pouch, drawstring, coins spilling
m = Model('tool_coinbag')
m.sm = True
m.ball('#a8743f', (0, 0, 0.13), 0.15, 2, (1, 1, 0.95))
m.ball('#a8743f', (0, 0, 0.27), 0.055, 2)
m.sm = False
m.cyl('#5e3d24', (0, 0, 0.235), 0.05, 0.025, 10)
m.cyl('#f2b33d', (0, 0, 0.3), 0.045, 0.015, 12).cyl('#f2b33d', (0.03, 0.01, 0.315), 0.04, 0.012, 12, rot=(20, 10, 0))
for x, y, r in ((0.15, -0.06, 15), (0.13, 0.08, -25)):
    m.cyl('#f2b33d', (x, y, 0.0), 0.04, 0.012, 12, rot=(r, 0, 0)).cyl('#d99a1e', (x, y, 0.011), 0.028, 0.003, 12, rot=(r, 0, 0))
m.cyl('#e0b04a', (0, -0.145, 0.13), 0.035, 0.01, 12, rot=(90, 0, 0))
m.done()

# blueprint: rolled blue paper with a white edge, tied with a red ribbon
m = Model('tool_blueprint')
m.cyl('#3d7fb8', (-0.25, 0, 0), 0.06, 0.5, 14, rot=(0, 90, 0))
for x in (-0.25, 0.25):
    m.cyl('#f2ede2', (x - 0.002 * (1 if x > 0 else -1), 0, 0), 0.061, 0.006, 14, rot=(0, 90, 0))
    m.cyl('#2b5d8a', (x, 0, 0), 0.025, 0.008, 10, rot=(0, 90, 0))
m.cyl('#e8536b', (0.0, 0, 0), 0.064, 0.03, 14, rot=(0, 90, 0))
m.box('#e8536b', (0.02, -0.06, -0.04), (0.02, 0.006, 0.08), (0, 25, 0)).box('#e8536b', (-0.02, -0.06, -0.04), (0.02, 0.006, 0.08), (0, -25, 0))
m.plate('#3d7fb8', (0.15, 0, -0.055), [(-0.08, 0), (0.08, 0), (0.08, -0.05), (-0.08, -0.04)], 0.004, (0, 0, 0))
m.done()

# basket: woven sides, rim, arched handle
m = Model('tool_basket')
m.cyl('#a8844f', (0, 0, 0), 0.16, 0.03, 14)
for k in range(4):
    m.cyl('#c9a36b' if k % 2 else '#b8925a', (0, 0, 0.03 + k * 0.045), 0.165 + k * 0.012, 0.045, 14, 0.177 + k * 0.012)
for k in range(14):
    a = k / 14 * math.tau
    line(m, '#8a6a3a', (math.cos(a) * 0.165, math.sin(a) * 0.165, 0.03), (math.cos(a) * 0.21, math.sin(a) * 0.21, 0.21), 0.006, 4)
m.cyl('#8a6a3a', (0, 0, 0.2), 0.215, 0.025, 16)
for k in range(10):
    a0, a1 = math.pi * k / 10, math.pi * (k + 1) / 10
    line(m, '#a8844f', (math.cos(a0) * 0.2, 0, 0.22 + math.sin(a0) * 0.2), (math.cos(a1) * 0.2, 0, 0.22 + math.sin(a1) * 0.2), 0.014, 6)
m.done()

# broom: handle, bound straw head with twine
m = Model('tool_broom')
m.sm = True
m.cyl('#b98552', (0, 0, -0.1), 0.022, 0.9, 10)
m.sm = False
m.cone(THATCH, (0, 0, 0.78), 0.06, -0.1, 8)
m.cyl(THATCH, (0, 0, 0.68), 0.06, 0.32, 10, 0.16, sy=0.45)
for z in (0.71, 0.77):
    m.cyl(ROPE, (0, 0, z), 0.07 + (z - 0.68) * 0.3, 0.02, 10, sy=0.55)
for k in range(9):
    x = -0.14 + k * 0.035
    m.box('#c99e58', (x, 0, 1.0), (0.02, 0.06, 0.03))
m.done()
# first-person right arm: rolled sleeve, forearm, rope bracelet, closed fist around a vertical grip at (0, -0.53, 0)
SKIN, SKIN2 = '#e8b48a', '#d89c72'
m = Model('fp_arm')
m.sm = True
m.cyl('shirt', (0, 0.05, 0), 0.068, 0.35, 12, 0.062, (90, 0, 0))
m.cyl('shirt', (0, -0.26, 0), 0.074, 0.07, 12, 0.07, (90, 0, 0))            # rolled cuff
m.cyl(SKIN, (0, -0.3, 0), 0.047, 0.17, 12, 0.037, (90, 0, 0), sx=0.9)        # forearm, wider than deep
m.cyl(ROPE, (0, -0.432, 0), 0.04, 0.012, 12, rot=(90, 0, 0), sx=0.9)         # thin rope bracelet
m.ball('#2c7f86', (0.037, -0.425, 0), 0.008, 1)                              # a bead
def capsule(m, col, a, b, r):
    line(m, col, a, b, r, 10)
    m.ball(col, b, r, 2)


m.cyl(SKIN, (0, -0.462, 0), 0.037, 0.035, 12, 0.034, (90, 0, 0), sx=0.85)     # wrist
m.ball(SKIN, (0.004, -0.518, 0), 1, 2, (0.026, 0.056, 0.05))                # palm, soft and rounded
m.ball(SKIN2, (-0.014, -0.505, 0.026), 1, 2, (0.016, 0.032, 0.02))          # thumb pad
FING = [(0.033, 0.86, 0.0102), (0.011, 0.94, 0.0106), (-0.011, 0.88, 0.0101), (-0.031, 0.72, 0.0091)]
for k, (z, L, r) in enumerate(FING):                                       # relaxed fingers, three joints each
    p = Vector((0.006, -0.562 + (0.004 if k in (0, 3) else 0), z))
    m.ball(SKIN, (p.x + 0.004, p.y + 0.006, p.z), r * 1.15, 2)               # knuckle
    ang, dz = 0.0, (k - 1.5) * 0.003
    for j, (seg, bend) in enumerate(((0.046, 20), (0.03, 32), (0.024, 26))):
        ang += math.radians(bend)
        q = p + Vector((-math.sin(ang), -math.cos(ang), dz)) * seg * L
        capsule(m, SKIN if j < 2 else SKIN2, p, q, r * (1 - j * 0.1))
        p = q
    m.ball('#f2cdbd', (p.x + r * 0.55, p.y + 0.004, p.z), 1, 1, (r * 0.45, r * 0.95, r * 0.8))   # nail
t0 = Vector((-0.02, -0.492, 0.038))                                         # thumb: two joints, resting over the index
t1 = t0 + Vector((-0.012, -0.036, 0.014))
t2 = t1 + Vector((-0.014, -0.028, 0.004))
m.ball(SKIN, t0, 0.0145, 2)
capsule(m, SKIN, t0, t1, 0.0132)
capsule(m, SKIN2, t1, t2, 0.0118)
m.ball('#f2cdbd', (t2.x + 0.006, t2.y + 0.003, t2.z + 0.008), 1, 1, (0.006, 0.011, 0.006))
# built as a left hand; mirror it into the right hand the player sees
bmesh.ops.scale(m.bm, vec=(-1, 1, 1), verts=m.bm.verts[:])
bmesh.ops.reverse_faces(m.bm, faces=m.bm.faces[:])
m.done()
m = Model('trader')
for x in (-0.12, 0.12):
    m.cyl('#5e3d24', (x, 0, 0), 0.09, 0.8, 6)
m.box('#2f7d6b', (0, 0, 1.1), (0.55, 0.32, 0.65)).box('#f2b33d', (0, -0.17, 1.0), (0.56, 0.02, 0.08))
m.ball('#c98a5e', (0, 0, 1.62), 0.19, 1, (1, 1, 1.1)).ball('#e8e1d4', (0, -0.1, 1.5), 0.15, 1, (1, 0.7, 1))
m.cyl('#7a3b2e', (0, 0, 1.76), 0.36, 0.05, 10).cyl('#7a3b2e', (0, 0, 1.78), 0.2, 0.22, 10)
m.done()


# --- the donkey: head toward -Y, ground at z=0, ~1.25 m at the withers. Built from parts so the game can animate it:
# donkey_body[_bags|_cart] (origin on the ground), donkey_head (origin at the neck root), donkey_leg (origin at the
# hip, used four times), donkey_tail (origin at the tail root). donkey / donkey_bags / donkey_cart are the whole
# animal in one piece, for icons.
DK_COAT, DK_COAT2, DK_CREAM, DK_DARK, DK_PINK = '#9b8f7f', '#887c6d', '#ebe2d1', '#4a3f36', '#d9a49c'
DK_NECK = (0, -0.55, 1.12)
DK_TAIL = (0, 0.8, 1.16)
DK_LEGS = [(-0.2, -0.38), (0.2, -0.38), (-0.2, 0.46), (0.2, 0.46)]
DK_HIP = 0.84


def dk_body(m, bags=False, cart=False):
    m.sm = True
    m.ball(DK_COAT, (0, 0.04, 0.98), 0.4, 2, (0.82, 1.5, 0.82))
    m.ball(DK_COAT, (0, -0.4, 1.02), 0.33, 2, (0.95, 0.9, 1.0))          # chest
    m.ball(DK_COAT, (0, 0.48, 1.0), 0.34, 2, (0.95, 0.95, 0.95))          # rump
    m.ball(DK_CREAM, (0, 0.02, 0.8), 0.36, 2, (0.72, 1.35, 0.42))         # pale belly
    for x, y in DK_LEGS:                                                  # shoulders / haunches the legs hang from
        m.ball(DK_COAT2 if y > 0 else DK_COAT, (x * 0.9, y, DK_HIP + 0.06), 0.15, 2, (0.8, 1.2, 1.3))
    m.sm = False
    m.box(DK_DARK, (0, 0.05, 1.31), (0.05, 1.05, 0.04))                   # the dorsal stripe and shoulder cross
    m.box(DK_DARK, (0, -0.34, 1.27), (0.62, 0.05, 0.04), (0, 0, 0))
    if bags or cart:
        m.plate('#2c7f86', (0, 0.0, 1.36), [(-0.42, -0.02), (0.42, -0.02), (0.42, 0.02), (-0.42, 0.02)], 0.62)        # blanket top
        for x in (-1, 1):
            m.box('#2c7f86', (x * 0.36, 0, 1.18), (0.04, 0.62, 0.34), (0, x * -12, 0))
            m.box('#e8536b', (x * 0.37, 0, 1.03), (0.045, 0.64, 0.05), (0, x * -12, 0))
            m.rbox('#a8743f', (x * 0.47, 0.02, 0.98), (0.2, 0.48, 0.42), 0.05)                # saddle bag
            m.box('#7a5134', (x * 0.575, 0.02, 1.06), (0.03, 0.3, 0.2))                        # flap
            m.box('#e0b04a', (x * 0.59, 0.02, 0.98), (0.02, 0.08, 0.06))                       # buckle
        m.box('#6b4226', (0, -0.1, 1.38), (0.86, 0.06, 0.03))                                  # girth strap
        m.box('#6b4226', (0, 0.2, 1.38), (0.86, 0.06, 0.03))
        m.cyl('#c9a36b', (-0.36, 0.05, 1.5), 0.11, 0.72, 10, rot=(0, 90, 0))                   # bedroll
        for x in (-0.15, 0.15):
            m.cyl('#7a5134', (x, 0.05, 1.5), 0.115, 0.04, 10, rot=(0, 90, 0))
    if cart:
        cy = 1.85
        m.rbox(WOOD, (0, cy, 0.78), (1.1, 1.3, 0.1), 0.02)
        for x in (-0.55, 0.55):
            m.box(WOOD2, (x, cy, 0.98), (0.06, 1.3, 0.34))
        m.box(WOOD2, (0, cy + 0.64, 0.98), (1.1, 0.06, 0.34))
        for k in range(4):
            m.box(DARKWOOD, (-0.45 + k * 0.3, cy, 0.84), (0.05, 1.28, 0.02))
        for x in (-0.35, 0.35):
            line(m, WOOD2, (x, cy - 0.65, 0.84), (x * 1.3, 0.2, 1.08), 0.04, 6)                  # shafts to the harness
        m.ball('#c9a36b', (-0.2, cy + 0.1, 1.05), 0.26, 1, (1, 1, 0.8)).ball('#d9b26f', (0.22, cy - 0.2, 1.0), 0.22, 1, (1, 1, 0.8))
        crate(m, (0.2, cy + 0.35, 1.08), 0.42, 15)
        for x in (-0.66, 0.66):
            m.cyl(DARKWOOD, (x, cy, 0.42), 0.4, 0.07, 14, rot=(0, 90, 0))
            m.cyl('#3b2a1e', (x * 1.03, cy, 0.42), 0.36, 0.08, 14, rot=(0, 90, 0))
            m.cyl(WOOD, (x * 1.06, cy, 0.42), 0.08, 0.1, 8, rot=(0, 90, 0))
            for k in range(6):
                a = k * math.pi / 3
                line(m, WOOD, (x * 1.05, cy, 0.42), (x * 1.05, cy + math.cos(a) * 0.34, 0.42 + math.sin(a) * 0.34), 0.025, 4)
        line(m, DARKWOOD, (-0.66, cy, 0.42), (0.66, cy, 0.42), 0.04, 6)


def dk_head(m):
    m.sm = True
    nx, ny, nz = DK_NECK
    m.ball(DK_COAT, (0, ny - 0.1, nz + 0.12), 0.2, 2, (0.75, 1.0, 1.2))
    m.ball(DK_COAT, (0, ny - 0.25, nz + 0.3), 0.17, 2, (0.75, 1.0, 1.2))
    m.ball(DK_COAT, (0, -0.98, 1.56), 0.19, 2, (0.82, 1.15, 1.0))                     # skull
    m.ball(DK_COAT, (0, -1.13, 1.5), 0.17, 2, (0.82, 1.2, 0.92), (-18, 0, 0))         # face
    m.ball(DK_CREAM, (0, -1.27, 1.43), 0.14, 2, (0.95, 0.95, 0.85))                   # pale muzzle
    for x in (-1, 1):
        m.ball(DK_CREAM, (x * 0.12, -1.0, 1.62), 0.06, 1)                             # eye ring
        m.ball('#1c140e', (x * 0.145, -1.01, 1.625), 0.042, 1)
        m.ball('#ffffff', (x * 0.175, -1.03, 1.645), 0.012, 1)
        m.ball('#3b2a1e', (x * 0.06, -1.39, 1.45), 0.025, 1)                         # nostrils
        m.ball(DK_COAT2, (x * 0.1, -0.95, 1.73), 0.05, 1, (1, 0.8, 1))
    m.sm = False
    for x in (-1, 1):                                                                  # the long ears
        m.cyl(DK_COAT, (x * 0.09, -0.9, 1.7), 0.075, 0.42, 6, r2=0.02, rot=(14, x * 22, 0), sy=0.55)
        m.cyl(DK_PINK, (x * 0.095, -0.925, 1.72), 0.05, 0.33, 6, r2=0.012, rot=(14, x * 22, 0), sy=0.3)
    for k in range(7):                                                                 # upright brush mane
        t = k / 6
        y, z = lerp3(ny + 0.02, -0.88, t), lerp3(nz + 0.28, 1.76, t)
        m.box(DK_DARK, (0, y, z), (0.07, 0.1, 0.16 - 0.04 * abs(t - 0.5)), (25, 0, 0))
    m.box(DK_DARK, (0, -0.94, 1.78), (0.08, 0.1, 0.1), (-30, 0, 0))                    # forelock
    m.cyl('#c8463c', (0, -1.18, 1.5), 0.165, 0.05, 12, rot=(72, 0, 0), sx=0.86)        # red halter
    m.cyl('#c8463c', (0, -0.9, 1.6), 0.19, 0.05, 12, rot=(-18, 0, 0), sx=0.8)
    m.cyl('#e0b04a', (0, -1.18, 1.34), 0.04, 0.02, 8)


def lerp3(a, b, t):
    return a + (b - a) * t


def dk_leg(m, x, y, back):
    top = DK_HIP
    m.sm = True
    m.cyl(DK_COAT2 if back else DK_COAT, (x, y, 0.42), 0.085, top - 0.42 + 0.05, 8, r2=0.11)   # upper leg
    m.ball(DK_COAT, (x, y - (0.02 if back else -0.02), 0.42), 0.075, 1)                       # knee / hock
    m.cyl(DK_CREAM, (x, y, 0.1), 0.06, 0.34, 8, r2=0.07)                                       # pale lower leg
    m.sm = False
    m.cyl(DK_DARK, (x, y, 0.0), 0.075, 0.11, 8, r2=0.065)                                      # hoof


def dk_tail(m):
    x, y, z = DK_TAIL
    line(m, DK_COAT2, (x, y, z), (x, y + 0.14, z - 0.42), 0.035, 6)
    m.sm = True
    m.ball(DK_DARK, (x, y + 0.17, z - 0.55), 0.07, 1, (0.9, 0.9, 1.8))
    m.sm = False


def dk_part(name, fn, pivot):
    m = Model(name)
    fn(m)
    bmesh.ops.translate(m.bm, verts=m.bm.verts[:], vec=-Vector(pivot))
    return m.done()


def donkey(name, bags=False, cart=False):
    m = Model(name)
    dk_body(m, bags, cart)
    dk_head(m)
    for x, y in DK_LEGS:
        dk_leg(m, x, y, y > 0)
    dk_tail(m)
    m.done()
    dk_part(name.replace('donkey', 'donkey_body'), lambda mm: dk_body(mm, bags, cart), (0, 0, 0))


donkey('donkey')
donkey('donkey_bags', bags=True)
donkey('donkey_cart', cart=True)
dk_part('donkey_head', dk_head, DK_NECK)
dk_part('donkey_leg', lambda mm: dk_leg(mm, 0, 0, False), (0, 0, DK_HIP))
dk_part('donkey_tail', dk_tail, DK_TAIL)
# --- the player character (seen by friends): faces -Y, ~1.8 m with the hat. Built from lofted rounded-rectangle
# sections (clothes-like, not balls) and split at the joints so the game can animate it:
#   player_body (origin on the ground), player_thigh (origin at the hip, z 0.92; knee 0.4 below),
#   player_shin (origin at the knee), player_upperarm (origin at the shoulder, z 1.38; elbow 0.3 below),
#   player_forearm (origin at the elbow; hand 0.25 below). 'player' is the whole figure (icons, fallback).
# 'shirt' is tinted with the player's outfit colour.
PL_SKIN, PL_SKIN2, PL_PANTS, PL_PANTS2, PL_HAIR, PL_BOOT = '#e0a77a', '#cf9168', '#3b4a6b', '#4d5f86', '#5a3a24', '#6b4226'
PL_HIP, PL_KNEE, PL_SHOULDER, PL_ELBOW = 0.92, 0.52, 1.38, 1.08


def loft(m, col, rings, n=16, p=3.2, cap=True):
    """Rings of (z, cx, cy, rx, ry) as superellipses, joined into a smooth closed tube."""
    vs = []
    for z, cx, cy, rx, ry in rings:
        ring = []
        for k in range(n):
            a = k / n * math.tau
            c, s_ = math.cos(a), math.sin(a)
            ring.append(m.bm.verts.new((cx + rx * math.copysign(abs(c) ** (2 / p), c), cy + ry * math.copysign(abs(s_) ** (2 / p), s_), z)))
        vs.append(ring)
    idx = mi(m, col)
    faces = []
    for r0, r1 in zip(vs, vs[1:]):
        for k in range(n):
            faces.append(m.bm.faces.new((r0[k], r0[(k + 1) % n], r1[(k + 1) % n], r1[k])))
    if cap:
        for ring, (z, cx, cy, _, _) in ((vs[0], rings[0]), (vs[-1], rings[-1])):
            c = m.bm.verts.new((cx, cy, z))
            for k in range(n):
                faces.append(m.bm.faces.new((ring[k], ring[(k + 1) % n], c)))
    for f in faces:
        f.material_index = idx
        f.smooth = True
    return m


def pl_body(m):
    # trousers top + shirt torso, tapering from the waist up to square shoulders and a sloped collar
    loft(m, PL_PANTS, [(0.84, 0, 0, 0.15, 0.1), (0.9, 0, 0, 0.165, 0.11), (0.98, 0, 0, 0.16, 0.108)])
    loft(m, 'shirt', [(0.95, 0, 0, 0.158, 0.104), (1.08, 0, 0, 0.165, 0.108), (1.22, 0, -0.005, 0.182, 0.114),
                      (1.33, 0, 0, 0.2, 0.11), (1.4, 0, 0, 0.19, 0.095), (1.44, 0, 0, 0.12, 0.07), (1.46, 0, 0, 0.06, 0.05)])
    loft(m, '#5e3d24', [(0.925, 0, 0, 0.163, 0.109), (0.975, 0, 0, 0.163, 0.109)])                    # belt
    m.box('#e0b04a', (0, -0.112, 0.95), (0.05, 0.012, 0.04))
    loft(m, PL_SKIN, [(1.42, 0, 0, 0.045, 0.045), (1.52, 0, 0.005, 0.042, 0.042)], 12, 2)               # neck
    m.box(PL_SKIN, (0, -0.07, 1.425), (0.05, 0.01, 0.05), (0, 0, 45))                                 # open collar
    # head: a rounded block, slightly squarer than a ball
    loft(m, PL_SKIN, [(1.5, 0, -0.01, 0.07, 0.07), (1.53, 0, -0.01, 0.1, 0.1), (1.6, 0, 0, 0.118, 0.118),
                      (1.69, 0, 0, 0.122, 0.12), (1.76, 0, 0, 0.1, 0.1), (1.785, 0, 0, 0.05, 0.05)], 16, 2.6)
    for x in (-1, 1):
        m.sm = True
        m.ball(PL_SKIN2, (x * 0.12, 0.0, 1.635), 0.028, 2, (0.55, 1, 1.25))                         # ears
        m.ball('#1c140e', (x * 0.045, -0.115, 1.655), 0.017, 2)                                      # eyes
        m.ball('#ffffff', (x * 0.045 + 0.006, -0.129, 1.66), 0.005, 1)
        m.sm = False
        m.box(PL_HAIR, (x * 0.048, -0.118, 1.69), (0.04, 0.012, 0.011), (0, x * -8, 0))              # brows
    m.sm = True
    m.ball(PL_SKIN2, (0, -0.125, 1.615), 0.019, 2, (1, 1.1, 1))                                       # nose
    m.sm = False
    m.box('#9a4a3a', (0, -0.116, 1.565), (0.045, 0.01, 0.008))                                        # smile
    m.box('#9a4a3a', (-0.027, -0.113, 1.57), (0.014, 0.01, 0.008), (0, 30, 0)).box('#9a4a3a', (0.027, -0.113, 1.57), (0.014, 0.01, 0.008), (0, -30, 0))
    loft(m, PL_HAIR, [(1.64, 0, 0.025, 0.124, 0.115), (1.72, 0, 0.01, 0.128, 0.126), (1.77, 0, 0.005, 0.108, 0.106), (1.8, 0, 0, 0.05, 0.05)], 16, 2.6)
    for x in (-0.06, 0.0, 0.06):                                                                      # fringe tufts
        m.cone(PL_HAIR, (x, -0.1, 1.745), 0.04, -0.06, 5, (20, 0, 0))
    # straw hat: wide brim, crown, red band
    m.cyl(THATCH, (0, 0.01, 1.755), 0.3, 0.022, 18)
    m.cyl('#c99e58', (0, 0.01, 1.77), 0.145, 0.12, 14, 0.12)
    m.cyl('#b8403a', (0, 0.01, 1.775), 0.147, 0.035, 14)
    # buttons, pocket
    for z in (1.06, 1.16, 1.26):
        m.ball('#f2ede2', (0, -0.112 - (z - 1.06) * 0.025, z), 0.01, 1)
    m.box('shirt', (0.075, -0.12, 1.24), (0.065, 0.012, 0.065))
    # leather satchel on the left hip, strap over the right shoulder
    line(m, '#7a4b2a', (0.15, -0.105, 1.39), (0.0, -0.125, 1.2), 0.014, 5)
    line(m, '#7a4b2a', (0.0, -0.125, 1.2), (-0.19, -0.1, 0.99), 0.014, 5)
    line(m, '#7a4b2a', (0.15, 0.1, 1.39), (-0.19, 0.1, 0.99), 0.014, 5)
    m.rbox('#a8743f', (-0.2, 0, 0.92), (0.065, 0.19, 0.16), 0.02)
    m.box('#7a5134', (-0.235, 0, 0.955), (0.012, 0.19, 0.09))
    m.box('#e0b04a', (-0.243, 0, 0.93), (0.008, 0.03, 0.024))


def pl_thigh(m, x=0.0):
    loft(m, PL_PANTS, [(PL_HIP + 0.04, x, 0, 0.08, 0.085), (PL_HIP - 0.15, x, 0, 0.077, 0.08), (PL_KNEE - 0.02, x, -0.005, 0.064, 0.068)])


def pl_shin(m, x=0.0):
    loft(m, PL_PANTS, [(PL_KNEE + 0.02, x, -0.005, 0.064, 0.068), (0.32, x, 0, 0.066, 0.068)])
    loft(m, PL_PANTS2, [(0.33, x, 0, 0.074, 0.076), (0.27, x, 0, 0.074, 0.076)])                     # rolled cuff
    loft(m, PL_SKIN, [(0.28, x, 0, 0.042, 0.042), (0.11, x, 0, 0.045, 0.045)], 10, 2)                 # ankle
    m.rbox(PL_BOOT, (x, -0.035, 0.065), (0.1, 0.22, 0.12), 0.035)                                     # boot
    m.rbox('#4a2e1c', (x, -0.035, 0.012), (0.106, 0.23, 0.024), 0.008)
    loft(m, PL_BOOT, [(0.06, x, 0.005, 0.052, 0.055), (0.17, x, 0.005, 0.05, 0.052)], 12, 2.4)


def pl_upperarm(m, x=0.0):
    S = PL_SHOULDER
    loft(m, 'shirt', [(S + 0.035, x, 0, 0.035, 0.04), (S + 0.01, x, 0, 0.056, 0.06), (S - 0.1, x, 0, 0.054, 0.057),
                      (PL_ELBOW + 0.03, x, 0, 0.05, 0.052)], 14, 2.6)
    loft(m, 'shirt', [(PL_ELBOW + 0.05, x, 0, 0.056, 0.058), (PL_ELBOW + 0.005, x, 0, 0.056, 0.058)], 14, 2.6)   # rolled sleeve


def pl_forearm(m, x=0.0):
    E = PL_ELBOW
    loft(m, PL_SKIN, [(E + 0.02, x, 0, 0.04, 0.042), (E - 0.1, x, 0, 0.038, 0.04), (E - 0.2, x, 0, 0.031, 0.033)], 12, 2.2)
    loft(m, ROPE, [(E - 0.165, x, 0, 0.036, 0.038), (E - 0.18, x, 0, 0.036, 0.038)], 12, 2)                 # bracelet
    loft(m, PL_SKIN, [(E - 0.2, x, 0, 0.026, 0.034), (E - 0.24, x, -0.004, 0.024, 0.045), (E - 0.29, x, -0.004, 0.02, 0.04), (E - 0.305, x, -0.004, 0.01, 0.02)], 12, 2.4)  # hand
    m.sm = True
    m.ball(PL_SKIN, (x, -0.04, E - 0.235), 0.016, 2, (0.8, 1.3, 1))                                       # thumb
    m.sm = False


m = Model('player')
pl_body(m)
for x in (-0.1, 0.1):
    pl_thigh(m, x)
    pl_shin(m, x)
for x in (-0.215, 0.215):
    pl_upperarm(m, x)
    pl_forearm(m, x)
m.done()
for nm, fn, pivot in (('player_body', pl_body, (0, 0, 0)), ('player_thigh', pl_thigh, (0, 0, PL_HIP)), ('player_shin', pl_shin, (0, 0, PL_KNEE)),
                      ('player_upperarm', pl_upperarm, (0, 0, PL_SHOULDER)), ('player_forearm', pl_forearm, (0, 0, PL_ELBOW))):
    pm = Model(nm)
    fn(pm)
    bmesh.ops.translate(pm.bm, verts=pm.bm.verts[:], vec=-Vector(pivot))
    pm.done()

# --- beach shack: a stilted bamboo hut with a porch facing -Y, layered thatch, net, oar and lantern
m = Model('beach_shack')
BAM, BAM2, BAMD = '#d2ae6e', '#bf9a5c', '#8a6a3a'
DZ = 1.0
for x in (-1.25, 0, 1.25):                                                  # stilts on footing stones
    for y in (-1.55, -0.6, 1.3):
        m.cyl(DARKWOOD, (x, y, -0.3), 0.09, DZ + 0.3, 7)
        m.ball(STONE2, (x, y, 0.0), 0.17, 1, (1, 1, 0.5), jit=0.02)
for y in (-0.6, 1.3):                                                       # cross bracing
    line(m, WOOD2, (-1.25, y, 0.15), (0, y, 0.85), 0.04, 5)
    line(m, WOOD2, (1.25, y, 0.15), (0, y, 0.85), 0.04, 5)
m.box(DARKWOOD, (0, -0.12, DZ - 0.05), (2.8, 3.1, 0.1))                     # joists
for k in range(12):                                                         # deck planks
    m.box(WOOD if k % 2 else '#b98a58', (-1.35 + k * 0.245, -0.12, DZ + 0.03), (0.23, 3.2, 0.06))
# walls: vertical bamboo poles with lashing bands
x0, x1, y0, y1, h = -1.15, 1.15, -0.7, 1.25, 1.75
def bamboo_wall(a, b, gaps=()):
    a, b = Vector(a), Vector(b)
    n = int((b - a).length / 0.11)
    for k in range(n + 1):
        p = a + (b - a) * (k / n)
        if any(g0 <= k / n <= g1 for g0, g1 in gaps):
            continue
        m.cyl(BAM if k % 3 else BAM2, (p.x, p.y, DZ + 0.06), 0.055, h, 6)
    for z in (0.35, 1.25):
        line(m, BAMD, (a.x, a.y, DZ + z), (b.x, b.y, DZ + z), 0.03, 4)
bamboo_wall((x0, y1), (x1, y1))
bamboo_wall((x0, y0), (x0, y1), gaps=((0.35, 0.68),))
bamboo_wall((x1, y0), (x1, y1), gaps=((0.35, 0.68),))
bamboo_wall((x0, y0), (x1, y0), gaps=((0.36, 0.64),))
for x in (x0, x1):
    for y in (y0, y1):
        m.cyl(DARKWOOD, (x, y, DZ), 0.08, h + 0.15, 7)
m.box('#3b2a1e', (0, y0 + 0.02, DZ + 0.75), (0.7, 0.04, 1.45))              # doorway shadow
m.box(DARKWOOD, (0, y0 - 0.02, DZ + 1.5), (0.95, 0.08, 0.1))               # lintel
for x in (-0.4, 0.4):
    m.box(DARKWOOD, (x, y0 - 0.02, DZ + 0.75), (0.08, 0.08, 1.5))
m.box('#e8536b', (-0.25, y0 + 0.05, DZ + 1.05), (0.3, 0.04, 0.9), (0, 0, 0))   # cloth curtain, tied back
for x in (x0, x1):                                                          # side windows, shutters propped open
    yc = y0 + (y1 - y0) * 0.515
    m.box('#3b2a1e', (x, yc, DZ + 1.05), (0.04, 0.6, 0.5))
    m.box(DARKWOOD, (x, yc, DZ + 1.32), (0.1, 0.72, 0.06)).box(DARKWOOD, (x, yc, DZ + 0.78), (0.1, 0.72, 0.06))
    s = 1 if x > 0 else -1
    m.box(WOOD2, (x + s * 0.18, yc, DZ + 1.5), (0.04, 0.66, 0.42), (0, s * 55, 0))
    line(m, DARKWOOD, (x + s * 0.02, yc, DZ + 0.8), (x + s * 0.34, yc, DZ + 1.32), 0.02, 4)
# porch rail + steps
for x in (-1.3, 1.3):
    line(m, BAMD, (x, -1.62, DZ + 0.7), (x, y0, DZ + 0.7), 0.04, 5)
    for y in (-1.62, -1.15):
        m.cyl(BAM2, (x, y, DZ), 0.05, 0.75, 6)
line(m, BAMD, (-1.3, -1.62, DZ + 0.7), (-0.5, -1.62, DZ + 0.7), 0.04, 5)
line(m, BAMD, (0.5, -1.62, DZ + 0.7), (1.3, -1.62, DZ + 0.7), 0.04, 5)
m.cyl(BAM2, (-0.5, -1.62, DZ), 0.05, 0.75, 6).cyl(BAM2, (0.5, -1.62, DZ), 0.05, 0.75, 6)
for k in range(4):
    z = DZ - 0.25 * (k + 1)
    m.box(WOOD if k % 2 else '#b98a58', (0, -1.78 - k * 0.26, z + 0.05), (0.95, 0.28, 0.06))
for x in (-0.5, 0.5):
    line(m, DARKWOOD, (x, -1.66, DZ), (x, -2.85, -0.05), 0.05, 6)
# roof: two layers of thatch over a hip frame, a fringe, and a ridge knot
m.cone(THATCH, (0, -0.15, DZ + h + 0.05), 2.75, 1.75, 4, (0, 0, 45))
m.cone('#c99e58', (0, -0.15, DZ + h + 0.65), 1.95, 1.3, 4, (0, 0, 45))
m.cone('#e3bf7c', (0, -0.15, DZ + h + 1.3), 0.95, 0.7, 4, (0, 0, 45))
m.cyl(BAMD, (0, -0.15, DZ + h + 1.85), 0.07, 0.35, 6)
for sx in (-1, 1):                                                          # hip ridges + thatch bands
    for sy in (-1, 1):
        line(m, '#a8803f', (0, -0.15, DZ + h + 1.8), (sx * 1.945, -0.15 + sy * 1.945, DZ + h + 0.05), 0.06, 5)
for f in (0.33, 0.62):
    r = 1.945 * (1 - f)
    zz = DZ + h + 0.05 + 1.75 * f + 0.02
    for a, b in (((-r, -r), (r, -r)), ((r, -r), (r, r)), ((r, r), (-r, r)), ((-r, r), (-r, -r))):
        line(m, '#b8904c', (a[0], -0.15 + a[1], zz), (b[0], -0.15 + b[1], zz), 0.035, 4)
e = 2.75 * math.sqrt(2) / 2
for k in range(15):
    t = -e + 2 * e * k / 14
    for x, y in ((t, -0.15 - e), (t, -0.15 + e), (-e, -0.15 + t), (e, -0.15 + t)):
        m.cone(THATCH if k % 2 else '#c99e58', (x, y, DZ + h + 0.1), 0.13, -0.28, 4, (0, 0, 45))
# lived-in details
m.box(DARKWOOD, (0.6, -1.6, DZ + h - 0.05), (0.05, 0.05, 0.4))
lantern(m, (0.6, -1.6, DZ + h - 0.45))
m.plate('net', (x1 + 0.08, 0.35, DZ + 0.85), [(-0.55, 0.0), (0.55, 0.05), (0.42, 0.75), (-0.4, 0.7)], 0.02, (0, 0, 90))
for k in range(4):                                                          # floats on the net
    m.ball('#e8536b' if k % 2 else WHITE, (x1 + 0.12, -0.15 + k * 0.32, DZ + 1.58), 0.06, 1)
line(m, WOOD, (x0 - 0.15, -0.5, DZ + 0.05), (x0 - 0.12, 0.9, DZ + 1.75), 0.035, 5)  # oar leaning on the wall
m.plate(WOOD2, (x0 - 0.16, 0.95, DZ + 1.55), [(-0.12, -0.35), (0.12, -0.35), (0.09, 0.2), (-0.09, 0.2)], 0.03, (0, 0, 90))
crate(m, (-0.85, -1.3, DZ + 0.22), 0.4, 20)
for k, (x, y) in enumerate(((-0.75, -1.05), (-0.95, -1.0), (-0.85, -0.88))):
    m.ball('#6b4a2a', (x, y, DZ + 0.12), 0.11, 1)
m.cyl('#b85c38', (0.9, -1.35, DZ + 0.06), 0.16, 0.28, 8, r2=0.2)            # potted palm
for k in range(5):
    m.frond(LEAF, (0.9, -1.35, DZ + 0.32), k * 1.26, 0.38, 0.2, 0.2, 0.06, 3)
m.plate(WOOD, (-0.55, -1.62, DZ + 0.42), [(-0.32, -0.12), (0.32, -0.12), (0.32, 0.12), (-0.32, 0.12)], 0.04)  # sign
m.box('#2c7f86', (-0.55, -1.645, DZ + 0.42), (0.4, 0.02, 0.06))
m.done()
m = Model('crow')
m.ball('#2b2b33', (0, 0, 0.18), 0.12, 1, (0.8, 1.4, 0.8)).ball('#2b2b33', (0, -0.15, 0.27), 0.08, 1).cone('#f2b33d', (0, -0.22, 0.27), 0.025, 0.08, 4, (90, 0, 0))
m.box('#22222a', (0.12, 0.02, 0.2), (0.22, 0.16, 0.02), (0, -20, 0)).box('#22222a', (-0.12, 0.02, 0.2), (0.22, 0.16, 0.02), (0, 20, 0))
m.done()

# produce + goods (inventory icons, pickups)
PRODUCE_SHAPE = {
    'wheat': lambda m, c: [m.cyl('#d9b25a', (0.0 + i * 0.03 - 0.06, 0, 0), 0.015, 0.5, 4, rot=(0, (i - 2) * 6, 0)) for i in range(5)] + [m.ball(c, (i * 0.05 - 0.1, 0, 0.55), 0.04, 1, (0.8, 0.8, 2)) for i in range(5)] + [m.box(ROPE, (0, 0, 0.25), (0.2, 0.08, 0.05))],
    'carrot': lambda m, c: [m.cone(c, (0, 0, 0.45), 0.08, -0.4, 7), m.cone(LEAF, (0, 0, 0.45), 0.05, 0.2, 4)],
    'corn': lambda m, c: [m.cyl(c, (0, 0, 0), 0.08, 0.38, 8, 0.05), m.cone('#9cc95a', (0.05, 0, 0), 0.06, 0.4, 4, (0, 10, 0))],
    'cucumber': lambda m, c: [m.cyl(c, (0, 0, 0), 0.06, 0.32, 7, 0.05, (0, 70, 0))],
    'beans': lambda m, c: [m.cyl(c, (i * 0.05, 0, 0), 0.025, 0.3, 5, 0.02, (0, 30, 0)) for i in range(3)],
    'sugarcane': lambda m, c: [m.cyl(c if i % 2 else '#6f7d2e', (0, 0, i * 0.15), 0.04, 0.15, 6) for i in range(4)],
    'rice': lambda m, c: [m.cyl('#e8dcc0', (0, 0, 0), 0.14, 0.22, 8, 0.16), m.cyl(c, (0, 0, 0.22), 0.13, 0.04, 8)],
    'cotton': lambda m, c: [m.ball(c, (0, 0, 0.15), 0.12, 1, jit=0.02), m.ball('#f2ede2', (0.08, 0.05, 0.12), 0.08, 1)],
    'banana': lambda m, c: [m.cyl(c, (i * 0.05 - 0.05, 0, 0.05), 0.035, 0.3, 6, 0.02, (0, 30 - i * 10, 0)) for i in range(3)],
    'vanilla': lambda m, c: [m.cyl('#5e3d24', (i * 0.04, 0, 0), 0.015, 0.35, 5) for i in range(3)],
}


def produce(pid, c, big=1.0):
    m = Model('produce_' + pid)
    if pid in PRODUCE_SHAPE:
        PRODUCE_SHAPE[pid](m, c)
    elif pid in ('pineapple', 'goldpineapple'):
        m.ball(c, (0, 0, 0.18), 0.13, 1, (1, 1, 1.4), jit=0.008)
        for i in range(5):
            a = i * 1.26
            m.cone(LEAF2, (0, 0, 0.33), 0.04, 0.2, 3, (math.sin(a) * 25, -math.cos(a) * 25, 0))
    elif pid in ('pumpkin', 'watermelon'):
        m.ball(c, (0, 0, 0.2), 0.22, 1, (1.15 if pid == 'pumpkin' else 1.35, 1.1, 0.85), jit=0.01).cyl('#4d6b2a', (0, 0, 0.36), 0.025, 0.08, 5)
    elif pid == 'dragonfruit':
        m.ball(c, (0, 0, 0.15), 0.13, 1, (1, 1, 1.25))
        for i in range(6):
            m.cone('#7fbf6a', (math.cos(i) * 0.1, math.sin(i) * 0.1, 0.15), 0.03, 0.1, 3, (math.sin(i) * 70, -math.cos(i) * 70, 0))
    elif pid == 'starfruit':
        for a in range(0, 360, 72):
            m.box(c, (math.cos(a * D2R) * 0.05, math.sin(a * D2R) * 0.05, 0.15), (0.12, 0.05, 0.28), (0, 0, a))
    elif pid == 'coconut':
        m.ball(c, (0, 0, 0.15), 0.15, 1, jit=0.01)
    elif pid == 'cacao':
        m.ball(c, (0, 0, 0.16), 0.11, 1, (1, 1, 1.7))
    elif pid == 'lettuce':
        m.ball(c, (0, 0, 0.13), 0.15, 1, jit=0.02).ball('#79c25a', (0.05, 0.05, 0.12), 0.12, 1)
    elif pid == 'coffee':
        for i in range(5):
            m.ball(c, (math.cos(i * 1.3) * 0.06, math.sin(i * 1.3) * 0.06, 0.06 + i * 0.02), 0.05, 1)
    else:
        m.ball(c, (0, 0, 0.13), 0.13 * big, 1, (1, 1, 0.95), jit=0.006)
        m.cyl('#4d6b2a', (0, 0, 0.25 * big), 0.015, 0.06, 4)
    return m.done()


for cid, (_, pc) in CROPS.items():
    produce(cid, pc)
for tid, (_, pc) in TREES.items():
    produce(tid, pc)
Model('good_bread').ball('#c98a44', (0, 0, 0.1), 0.18, 1, (1.5, 0.9, 0.6)).box('#e6b06a', (0, 0, 0.17), (0.3, 0.04, 0.03), (0, 0, 30)).done()
Model('good_juice').cyl('glass', (0, 0, 0), 0.07, 0.28, 8).cyl('#f9a03f', (0, 0, 0.01), 0.065, 0.22, 8).cyl('#e8536b', (0, 0, 0.28), 0.03, 0.08, 6).done()
Model('good_sugar').ball(WHITE, (0, 0, 0.15), 0.16, 1, (1, 0.8, 1.1)).cyl(ROPE, (0, 0, 0.28), 0.05, 0.05, 6).done()
Model('good_cloth').cyl('#f8f4ec', (0, 0, 0.1), 0.1, 0.4, 10, rot=(0, 90, 0)).cyl('#e8536b', (0, 0, 0.1), 0.105, 0.05, 10, rot=(0, 90, 0)).done()
Model('good_chocolate').box('#4a2c1a', (0, 0, 0.03), (0.3, 0.15, 0.04)).box('#5e3d24', (0, 0, 0.055), (0.28, 0.13, 0.02)).done()
Model('good_roastcoffee').box('#8a5a36', (0, 0, 0.15), (0.2, 0.12, 0.3)).box('#f2ede2', (0, -0.061, 0.17), (0.12, 0.01, 0.1)).done()
Model('item_wood').cyl(WOOD2, (0, -0.06, 0.08), 0.08, 0.45, 7, rot=(0, 90, 0)).cyl(WOOD, (0, 0.08, 0.08), 0.08, 0.45, 7, rot=(0, 90, 0)).cyl(WOOD2, (0, 0, 0.21), 0.08, 0.45, 7, rot=(0, 90, 0)).done()
Model('item_stone').ball(STONE, (0, 0, 0.1), 0.14, 1, (1.2, 1, 0.8), jit=0.02).ball(STONE2, (0.1, 0.05, 0.08), 0.08, 1, jit=0.01).done()
Model('item_gem').cone('#3fd0c9', (0, 0, 0.1), 0.12, 0.14, 6).cone('#2fb7b0', (0, 0, 0.1), 0.12, -0.1, 6).done()
Model('item_coin').cyl('#f2b33d', (0, 0, 0), 0.12, 0.04, 14).cyl('#d99a1e', (0, 0, 0.04), 0.08, 0.005, 14).done()
Model('seed_packet').box('tint', (0, 0, 0.18), (0.24, 0.04, 0.34)).box('#f2ede2', (0, -0.022, 0.25), (0.2, 0.01, 0.14)).done()
Model('sapling').cyl(WOOD2, (0, 0, 0), 0.025, 0.35, 5).ball(LEAF, (0, 0, 0.38), 0.12, 1, jit=0.02).cyl('#8a5a36', (0, 0, -0.05), 0.12, 0.12, 8, 0.09).done()

# the island terrain + assets/heights.json come from tools/make_island.py (no Blender needed)

bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'models.glb'), export_format='GLB', export_yup=True, export_apply=False, export_vertex_color='ACTIVE')   # leaf cards carry their shading in vertex colours
# meshopt compression (6.8 MB -> ~2 MB); the game loads it with three's MeshoptDecoder
import shutil, subprocess
_npx = shutil.which('npx')
if _npx:
    _glb = os.path.join(OUT, 'models.glb')
    subprocess.run([_npx, '--yes', '@gltf-transform/cli', 'meshopt', _glb, _glb, '--level', 'high'], check=True)
else:
    print('WARNING: npx not found, models.glb left uncompressed')
print('MODELS', len(bpy.data.objects))
