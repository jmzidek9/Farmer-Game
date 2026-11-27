# Harvest Haven: the island heightmap (assets/heights.json) + a top-down preview (screenshots/island-remake/map.png).
# Run: python tools/make_island.py
# Layout follows the reference art: the farm meadow in the middle, a wide sand crescent on the south shore with the
# pier, a stepped grey-cliff mountain at the back-right with a waterfall into the river's spring pool, and a broad
# turquoise reef shelf all round before the drop to deep water. x = east, z = south (the spawn looks north, -z).
import json, math, os, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N, STEP, OFF = 401, 1.0, -200.0
FARM, FZ0, FZ1 = 40, 0, 80                 # farm grid x in [-40, 40], z in [0, 80] (unchanged: saves are by tile)
C0 = (0.0, -8.0)                           # island centre
MC = (88.0, -80.0)                         # mountain summit
MTOP = 104.0
RIVER_Z0 = -52.0
PIER = (-54.0, 0.0)                        # pier x; its land end z is found on the beach below
WRECK = (30.0, 124.0)


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def vnoise(x, z):
    def h(ix, iz):
        n = np.sin(ix * 127.1 + iz * 311.7) * 43758.5453
        return n - np.floor(n)
    ix, iz = np.floor(x), np.floor(z)
    fx, fz = x - ix, z - iz
    u, v = fx * fx * (3 - 2 * fx), fz * fz * (3 - 2 * fz)
    a, b, c, d = h(ix, iz), h(ix + 1, iz), h(ix, iz + 1), h(ix + 1, iz + 1)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v


def fbm(x, z):
    return vnoise(x, z) * 0.6 + vnoise(x * 2.1, z * 2.1) * 0.3 + vnoise(x * 4.3, z * 4.3) * 0.1


def farm_h(z):
    return 1.9 - 0.01 * (z - FZ0)


def coast(X, Z):
    """(metres inland of the shoreline (negative = offshore), how 'south beach' this spot is 0..1)"""
    dx, dz = X - C0[0], Z - C0[1]
    r, th = np.hypot(dx, dz), np.arctan2(dz, dx)
    a = 134.0
    b = 111.0 - 8.0 * np.sin(th)                       # 103 m to the south shore, 119 m to the north
    rc = a * b / np.sqrt((b * np.cos(th)) ** 2 + (a * np.sin(th)) ** 2)
    rc = rc * (1 + 0.035 * np.sin(3 * th + 0.5) + 0.02 * np.sin(7 * th + 1.3) + 0.012 * np.sin(13 * th + 2.0))
    rc += (fbm(X * 0.02 + 40, Z * 0.02) - 0.5) * 6
    south = smooth(0.25, 0.75, np.sin(th))
    return rc - r, south


def mountain(X, Z):
    """lobed peak at MC with two shoulder summits, cut into flat grassy ledges and steep grey cliff bands"""
    dx, dz = X - MC[0], Z - MC[1]
    r, th = np.hypot(dx, dz), np.arctan2(dz, dx)
    th = th + (fbm(X * 0.03 + 5, Z * 0.03 + 1) - 0.5) * 1.0
    R = 98 + 10 * np.sin(2 * th + 0.6) + 6 * np.sin(3 * th + 1.0) + 3 * np.sin(5 * th + 2.0)
    u = r / R
    base = np.clip(1 - u, 0, 1) ** 1.3          # a cone: broad foot, pointed summit
    ridge = 1 - np.abs(2 * fbm(X * 0.05 + 11, Z * 0.05 - 4) - 1)
    crag = (fbm(X * 0.16 - 3, Z * 0.16 + 9) - 0.5) + (fbm(X * 0.4 + 1, Z * 0.4 - 6) - 0.5) * 0.4
    m = MTOP * base * (0.74 + 0.3 * ridge) + crag * 7 * np.minimum(1.0, base * 2.5)
    m += 12 * np.exp(-(np.hypot(dx + 2, dz + 3) / 6) ** 2)           # the summit crag
    m += 14 * np.exp(-(np.hypot(dx + 28, dz + 6) / 12) ** 2)         # west shoulder
    m += 10 * np.exp(-(np.hypot(dx - 20, dz - 14) / 10) ** 2)        # east shoulder
    # terraces: ~7 m bands, flat ledge then a near-vertical riser; the band edges wander so they read as strata
    S = 11.0
    warp = (fbm(X * 0.035 - 20, Z * 0.035 + 8) - 0.5) * 2.6 + (fbm(X * 0.11 + 4, Z * 0.11 - 9) - 0.5) * 0.6
    k = m / S + warp
    f = k - np.floor(k)
    terr = S * (np.floor(k) + smooth(0.6, 0.97, f))   # ledges stay level: the warp only moves where the cliffs fall
    w = smooth(4, 12, m) * (1 - smooth(MTOP + 10, MTOP + 30, m) * 0.6)
    return m * (1 - w) + terr * w


def river_x(z):
    k = smooth(0, -20, z)
    s = 1 - smooth(-50, -14, z)                 # north of the farm the river swings east to the falls
    return 31 + 0.5 * np.sin(z * 0.15) * (1 - k) + k * (3 * np.sin(z * 0.17 + 1.1) + 21 * s)


P0 = (float(river_x(np.array(RIVER_Z0))), RIVER_Z0)   # spring pool centre, the waterfall's plunge pool
_d = (MC[0] - P0[0], MC[1] - P0[1])
FALL_DIR = (_d[0] / math.hypot(*_d), _d[1] / math.hypot(*_d))   # from the pool toward the summit
LIP_ALONG, LIP_H = 12.5, 30.0                                   # the cliff the waterfall drops over


def falls(X, Z, h):
    """a sheer cliff behind the plunge pool topped by a ledge, with a notch the stream runs out of"""
    rx, rz = X - P0[0], Z - P0[1]
    al = rx * FALL_DIR[0] + rz * FALL_DIR[1]
    sd = -rx * FALL_DIR[1] + rz * FALL_DIR[0]
    wob = (fbm(X * 0.15, Z * 0.15) - 0.5) * 2.0
    mask = smooth(LIP_ALONG - 1.5, LIP_ALONG + 0.3, al + wob * 0.5) * (1 - smooth(13, 20, np.abs(sd) + wob * 2)) * (1 - smooth(26, 40, al))
    shelf = LIP_H * mask - 1.4 * (1 - smooth(1.2, 2.6, np.abs(sd))) * smooth(LIP_ALONG, LIP_ALONG + 1.0, al) * (1 - smooth(22, 28, al))   # the stream's notch
    return np.where((al > 0) & (mask > 0.02), np.maximum(h, shelf), h)


def H0(X, Z):
    dC, south = coast(X, Z)
    # land: the farm plateau sloping gently south, rolling meadow round it, jungle hills behind it
    cx, cz = np.clip(X, -FARM, FARM), np.clip(Z, FZ0, FZ1)
    e = np.hypot(X - cx, Z - cz)
    hills = ((fbm(X * 0.045 + 3, Z * 0.045) - 0.5) * 6 + 2.0) * (0.3 + 0.7 * smooth(12, -12, Z))
    land = farm_h(cz) + smooth(0, 20, e) * hills
    # beach: a wide crescent on the south shore, narrower round the back
    wb = 9 + 15 * south
    sand = 0.62 * smooth(0, wb * 0.7, dC) + 0.12 * (fbm(X * 0.08, Z * 0.08) - 0.5)
    t = smooth(wb * 0.55, wb + 4, dC)
    t = np.maximum(t, 0) * (1 - smooth(66, 84, Z) * (np.abs(X) < 60))   # the farm's south rows run onto the sand
    h = sand * (1 - t) + land * t
    # sea: glassy shallows, a broad reef shelf with coral heads and sand channels, then the drop to deep blue
    off = -dC
    reef = (fbm(X * 0.07 + 9, Z * 0.07 - 3) - 0.5) * 1.6 + (fbm(X * 0.3, Z * 0.3) - 0.5) * 0.5
    shelf = -1.3 * smooth(0, 7, off) - 1.2 * smooth(7, 30, off) + reef * smooth(5, 12, off) * (1 - smooth(25, 34, off))
    deep = -15 * smooth(30, 48, off)
    sea = np.minimum(shelf + deep, 0.42)
    h = np.where(dC < 0, sea + 0.0 * dC, h)
    h = np.where((dC >= 0) & (dC < 3), np.minimum(h, 0.62 * smooth(0, wb * 0.7, dC) + 0.0), h)
    h = np.maximum(h, -15)
    # a cove is cut into the mountain's foot in front of the falls, so the pool and the plunge are in the open
    rx, rz = X - P0[0], Z - P0[1]
    al, sd = rx * FALL_DIR[0] + rz * FALL_DIR[1], -rx * FALL_DIR[1] + rz * FALL_DIR[0]
    cove = (1 - smooth(LIP_ALONG - 3, LIP_ALONG + 1, al)) * (1 - smooth(16, 30, np.abs(sd) + (fbm(X * 0.1, Z * 0.1) - 0.5) * 8))
    h = h + mountain(X, Z) * smooth(-30, 0, dC + 30) * (1 - cove)   # the mountain rises straight out of the sea on the north-east
    return falls(X, Z, h)


def H0s(x, z):
    return float(H0(np.array(x, float), np.array(z, float)))


# ---------------------------------------------------------------- river + ponds (same banks as before)
def bank(h, d, w0, w1, bed, grow=0.6):
    w1 = w1 + grow * np.minimum(6.0, np.maximum(0.0, h - 2.2))
    return np.minimum(h, bed + (h - bed) * smooth(w0, w1, d))


def water(X, Z, h):
    rx0 = P0[0]
    inR = (Z > RIVER_Z0 - 12) & (Z < 130)
    d = np.where(Z >= RIVER_Z0, np.abs(X - river_x(Z)), np.hypot(X - rx0, Z - RIVER_Z0))
    h = np.where(inR, bank(h, d, 1.3, np.where(Z > -2, 7.5, 8.5), -1.2), h)   # wide, grassy banks
    dp, a = np.hypot(X - rx0, Z - RIVER_Z0), np.arctan2(Z - RIVER_Z0, X - rx0)
    rp = 12.0 + 1.2 * np.sin(2 * a + 0.7) + 0.7 * np.sin(3 * a + 2.0)
    h = np.where(inR, bank(h, dp / rp, 0.55, 1.12, -1.6, 0.0), h)
    dp, a = np.hypot(X + 14, Z - 6), np.arctan2(Z - 6, X + 14)   # the farm pond
    rp = 5.5 + 0.9 * np.sin(2 * a + 1.0) + 0.5 * np.sin(3 * a + 2.0)
    h = np.where(dp < 14, bank(h, dp / rp, 0.4, 1.5, -1.0, 0.0), h)
    return h


# ---------------------------------------------------------------- paths: the mountain trail + dirt tracks across the meadow
def polyline(pts, step=1.0):
    out = []
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        L = math.hypot(x1 - x0, z1 - z0)
        for k in range(max(1, int(L / step))):
            t = k * step / L
            out.append([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t])
    out.append(list(pts[-1]))
    return out


def graded(pts, passes=60):
    ys = [H0s(x, z) for x, z in pts]
    for _ in range(passes):
        ys = [ys[0]] + [(ys[k - 1] + ys[k] + ys[k + 1]) / 3 for k in range(1, len(ys) - 1)] + [ys[-1]]
    return [[x, z, y] for (x, z), y in zip(pts, ys)]


def trail():
    foot = (30.0, -92.0)
    lead = graded(polyline([(-8.0, -3.0), (-8.0, -30.0), (5.0, -62.0), foot]))
    a = math.atan2(foot[1] - MC[1], foot[0] - MC[0])
    r = math.hypot(foot[0] - MC[0], foot[1] - MC[1])
    y, y1, G = H0s(*foot), H0s(*MC) - 4.0, 0.14
    spiral = []
    while y < y1:
        spiral.append([MC[0] + math.cos(a) * r, MC[1] + math.sin(a) * r, y])
        a += 1.0 / max(r, 4.0)          # clockwise seen from above: round the west face, away from the falls
        y += G
        lo, hi = 0.0, r + 12.0
        for _ in range(30):
            mid = (lo + hi) / 2
            if H0s(MC[0] + math.cos(a) * mid, MC[1] + math.sin(a) * mid) > y:
                lo = mid
            else:
                hi = mid
        r = max(r - 0.6, min(r + 0.4, lo))
        if r < 2.5:
            break
    rs = [math.hypot(px - MC[0], pz - MC[1]) for px, pz, _ in spiral]
    for _ in range(30):
        rs = [rs[0]] + [(rs[k - 1] + rs[k] * 2 + rs[k + 1]) / 4 for k in range(1, len(rs) - 1)] + [rs[-1]]
    for k, (px, pz, py) in enumerate(spiral):
        aa = math.atan2(pz - MC[1], px - MC[0])
        spiral[k] = [MC[0] + math.cos(aa) * rs[k], MC[1] + math.sin(aa) * rs[k], py]
    return lead + spiral


def seg_dist(X, Z, path):
    """distance to a polyline [[x, z, y], ...] and the path height there (vectorised over the grid)"""
    best = np.full(X.shape, 1e9)
    by = np.zeros(X.shape)
    P = np.array(path)
    for k in range(len(P) - 1):
        x0, z0, y0 = P[k]
        x1, z1, y1 = P[k + 1]
        bx0, bx1 = min(x0, x1) - 16, max(x0, x1) + 16
        bz0, bz1 = min(z0, z1) - 16, max(z0, z1) + 16
        i0, i1 = int(max(0, (bx0 - OFF) / STEP)), int(min(N - 1, (bx1 - OFF) / STEP)) + 1
        j0, j1 = int(max(0, (bz0 - OFF) / STEP)), int(min(N - 1, (bz1 - OFF) / STEP)) + 1
        if i1 <= i0 or j1 <= j0:
            continue
        xs, zs = X[j0:j1, i0:i1], Z[j0:j1, i0:i1]
        vx, vz = x1 - x0, z1 - z0
        t = np.clip(((xs - x0) * vx + (zs - z0) * vz) / (vx * vx + vz * vz + 1e-9), 0, 1)
        d = np.hypot(xs - x0 - vx * t, zs - z0 - vz * t)
        sub, suby = best[j0:j1, i0:i1], by[j0:j1, i0:i1]
        m = d < sub
        sub[m] = d[m]
        suby[m] = (y0 + (y1 - y0) * t)[m]
    return best, by


def beach_z(x):
    """z of the sand just above the waterline south of the farm at column x"""
    for z in np.arange(70, 140, 0.25):
        if H0s(x, z) < 0.18:
            return float(z)
    return 100.0


def main():
    xs = OFF + np.arange(N) * STEP
    X, Z = np.meshgrid(xs, xs)                    # row j = z, column i = x
    h = H0(X, Z)
    TR = trail()
    d, y = seg_dist(X, Z, TR)
    w = 1 - smooth(1.9, 4.5 + np.minimum(9.0, np.maximum(0.0, y - h) * 0.9), d)
    h = h + (y - h) * w
    p = 1 - smooth(1.2, 2.3, d)
    top = TR[-1]
    ds = np.hypot(X - top[0], Z - top[1])
    h = h + (top[2] - h) * (1 - smooth(4.0, 7.5, ds))
    p = np.maximum(p, 1 - smooth(3.5, 5.0, ds))
    # dirt tracks: pier -> farm's south-west corner, and the farm's east edge -> the shop hut (colour only, no cut)
    pz = beach_z(PIER[0])
    tracks = [polyline([(-54, 78), (-48, 72), (-42, 64)]), polyline([(41, 40), (48, 38), (55, 36)]),
              polyline([(20, -2), (27, -22), (34, -38), (40, -48)])]   # pier, shop hut, and up the river to the falls
    for tr in tracks:
        dd, _ = seg_dist(X, Z, [[a, b, 0] for a, b in tr])
        wav = (fbm(X * 0.3, Z * 0.3) - 0.5) * 0.6
        p = np.maximum(p, (1 - smooth(1.4, 2.6, dd + wav)) * 0.7)
    h = water(X, Z, h)
    dw = np.hypot(X - WRECK[0], Z - WRECK[1])      # the reef the wreck sits on
    h = np.maximum(h, -0.6 - dw * 0.12 - 14 * smooth(7, 16, dw))   # a rocky reef rising to just under the surface
    h = np.round(h, 3)
    p = np.round(np.clip(p, 0, 1), 2)

    out = os.path.join(ROOT, 'assets', 'heights.json')
    meta = {'pier': [PIER[0], round(pz, 2)], 'pool': [round(P0[0], 2), P0[1]], 'fallDir': [round(FALL_DIR[0], 4), round(FALL_DIR[1], 4)],
            'lip': [LIP_ALONG, LIP_H], 'wreck': list(WRECK), 'summit': list(MC)}
    with open(out, 'w') as f:
        json.dump({'n': N, 'step': STEP, 'off': OFF, 'h': h.ravel().tolist(), 'p': p.ravel().tolist(),
                   'path': [[round(a, 2), round(b, 2), round(c, 2)] for a, b, c in TR[::4]] + [[round(v, 2) for v in TR[-1]]],
                   'meta': meta}, f, separators=(',', ':'))
    print('wrote', out, 'min', h.min(), 'max', h.max(), 'pier land end z', pz, meta)
    preview(h, p)


def preview(h, p):
    from PIL import Image
    gx, gz = np.gradient(h)
    slope = np.hypot(gx, gz)
    lightv = np.clip(0.75 + (gz * -0.6 + gx * -0.4) * 0.5, 0.35, 1.25)
    img = np.zeros(h.shape + (3,))
    deepc, midc, turq, shal = np.array([13, 88, 214]), np.array([18, 180, 230]), np.array([47, 210, 216]), np.array([166, 242, 234])
    d = -h[..., None]
    sea = shal + (turq - shal) * np.clip(d / 1.2, 0, 1)
    sea = sea + (midc - turq) * np.clip((d - 1.2) / 2.5, 0, 1)
    sea = sea + (deepc - midc) * np.clip((d - 3.7) / 6, 0, 1)
    sand, grass, rock, dirt = np.array([238, 220, 170]), np.array([96, 180, 60]), np.array([128, 126, 118]), np.array([176, 140, 92])
    land = np.where(h[..., None] < 0.8, sand, grass)
    land = np.where((slope[..., None] > 0.55) | ((h[..., None] > 30) & (slope[..., None] > 0.3)), rock, land)
    land = land * (1 - p[..., None] * 0.8) + dirt * p[..., None] * 0.8
    img = np.where(h[..., None] < 0, sea, land * lightv[..., None])
    farm = (np.abs(OFF + np.arange(N)[None, :]) <= 40) & ((OFF + np.arange(N)[:, None] >= 0) & (OFF + np.arange(N)[:, None] <= 80))
    edge = farm & ~np.roll(farm, 2, 0) | farm & ~np.roll(farm, -2, 0) | farm & ~np.roll(farm, 2, 1) | farm & ~np.roll(farm, -2, 1)
    img[edge] = [255, 255, 255]
    os.makedirs(os.path.join(ROOT, 'screenshots', 'island-remake'), exist_ok=True)
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).resize((802, 802), Image.NEAREST).save(
        os.path.join(ROOT, 'screenshots', 'island-remake', 'map.png'))


if __name__ == '__main__':
    main()
