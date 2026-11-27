# Harvest Haven — the mountain as its own detailed asset, built in Blender from the island heightmap.
# Run AFTER tools/make_island.py:
#   blender -b --factory-startup --python tools/make_mountain.py -- assets
# 1. the heightmap around the summit becomes a closed solid and is voxel-remeshed, so the cliffs get as many
#    triangles as the ledges (a heightmap stretches one triangle down a 10 m face);
# 2. the cliff faces are sculpted: blocky jointed rock (Voronoi), weathering (noise) and horizontal strata;
# 3. ambient occlusion is baked into the vertex colours (crevices, overhangs, the foot of each cliff);
# 4. writes assets/mountain.glb and patches assets/heights.json with the sculpted surface, so walking matches.
# The game draws it with the ground shader (grass ledges, rock faces with the cliff texture + parallax).
import bpy, bmesh, json, math, os, sys
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'assets'
HJ = os.path.join(OUT, 'heights.json')
R0 = 122.0          # footprint radius round the summit; the game's ground is cut away inside it
VOXEL = 0.65
bpy.ops.wm.read_factory_settings(use_empty=True)

H = json.load(open(HJ))
n, off, step = H['n'], H['off'], H['step']
hh = np.array(H['h'], float).reshape(n, n)            # [j (z), i (x)]
MX, MZ = H['meta']['summit']


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------ 1. heightfield -> closed solid -> remesh
i0, i1 = max(0, int((MX - R0 - 4 - off) / step)), min(n - 1, int((MX + R0 + 4 - off) / step) + 1)
j0, j1 = max(0, int((MZ - R0 - 4 - off) / step)), min(n - 1, int((MZ + R0 + 4 - off) / step) + 1)
bm = bmesh.new()
V = {}
for j in range(j0, j1 + 1):
    for i in range(i0, i1 + 1):
        x, z = off + i * step, off + j * step
        V[i, j] = bm.verts.new((x, -z, hh[j, i]))       # blender y = -game z
for j in range(j0, j1):
    for i in range(i0, i1):
        bm.faces.new((V[i, j], V[i, j + 1], V[i + 1, j + 1], V[i + 1, j]))
bm.normal_update()
edges = [e for e in bm.edges if e.is_boundary]
ext = bmesh.ops.extrude_edge_only(bm, edges=edges)
for v in [g for g in ext['geom'] if isinstance(g, bmesh.types.BMVert)]:
    v.co.z = -30.0
bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
me = bpy.data.meshes.new('mountain')
bm.to_mesh(me); bm.free()
ob = bpy.data.objects.new('mountain', me)
bpy.context.scene.collection.objects.link(ob)
bpy.context.view_layer.objects.active = ob
ob.select_set(True)
me.remesh_voxel_size = VOXEL
me.remesh_voxel_adaptivity = 0.0
bpy.ops.object.voxel_remesh()
print('remeshed', len(ob.data.vertices))

# keep the top surface inside the footprint: drop the skirt, the bottom and everything outside the circle
bm = bmesh.new(); bm.from_mesh(ob.data)
dead = [v for v in bm.verts if v.co.z < -18 or math.hypot(v.co.x - MX, -v.co.y - MZ) > R0 + 1.5]
bmesh.ops.delete(bm, geom=dead, context='VERTS')
dead = [f for f in bm.faces if f.normal.z < -0.3 and f.calc_center_median().z < -10]
bmesh.ops.delete(bm, geom=dead, context='FACES')
bm.normal_update()
if sum(f.normal.z * f.calc_area() for f in bm.faces) < 0:   # the remesher can hand the surface back inside out
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.normal_update()
    print('flipped faces')
bm.to_mesh(ob.data); bm.free()

# ------------------------------------------------------------------ 2. sculpt the cliffs
me = ob.data
me.update()
vg = ob.vertex_groups.new(name='cliff')
for v in me.vertices:
    r = math.hypot(v.co.x - MX, -v.co.y - MZ)
    steep = 1 - smooth(0.5, 0.86, v.normal.z)
    w = float(steep * smooth(-0.5, 1.5, v.co.z) * (1 - smooth(R0 - 14, R0 - 4, r)))
    if w > 0.001:
        vg.add([v.index], w, 'REPLACE')
def displace(tex, strength, mid=0.5):
    m = ob.modifiers.new(tex.name, 'DISPLACE')
    m.texture = tex; m.texture_coords = 'GLOBAL'; m.strength = strength; m.mid_level = mid; m.vertex_group = 'cliff'; m.direction = 'NORMAL'
vor = bpy.data.textures.new('blocks', 'VORONOI'); vor.noise_scale = 3.2; vor.distance_metric = 'DISTANCE'; vor.color_mode = 'INTENSITY'
vor.noise_intensity = 1.0
displace(vor, 1.4, 0.45)
cl = bpy.data.textures.new('weather', 'CLOUDS'); cl.noise_scale = 1.1; cl.noise_depth = 4; cl.noise_basis = 'ORIGINAL_PERLIN'
displace(cl, 0.55)
st = bpy.data.textures.new('strata', 'WOOD'); st.wood_type = 'BANDNOISE'; st.noise_basis_2 = 'SIN'; st.noise_scale = 0.9; st.turbulence = 3
displace(st, 0.35)
for m in list(ob.modifiers):
    bpy.ops.object.modifier_apply(modifier=m.name)
dec = ob.modifiers.new('dec', 'DECIMATE'); dec.ratio = 0.42
bpy.ops.object.modifier_apply(modifier='dec')

# the outer ring dips a few centimetres under the island ground, which takes over from R0 (no seam, no flicker)
for v in ob.data.vertices:
    r = math.hypot(v.co.x - MX, -v.co.y - MZ)
    v.co.z -= 0.08 * smooth(R0 - 2.5, R0, r)
ob.data.update()
for p in ob.data.polygons:
    p.use_smooth = True
print('final verts', len(ob.data.vertices), 'tris', sum(len(p.vertices) - 2 for p in ob.data.polygons))

# ------------------------------------------------------------------ 3. bake ambient occlusion into vertex colours
sc = bpy.context.scene
sc.render.engine = 'CYCLES'; sc.cycles.samples = 48; sc.cycles.device = 'CPU'
sc.world = bpy.data.worlds.new('w'); sc.world.light_settings.distance = 7.0
col = ob.data.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
ob.data.color_attributes.active_color = col
mat = bpy.data.materials.new('mtn'); mat.use_nodes = True
ob.data.materials.append(mat)
bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
print('baked AO')

# ------------------------------------------------------------------ 4. export + patch the heightmap
mat.use_nodes = False
bpy.ops.export_scene.gltf(filepath=os.path.abspath(os.path.join(OUT, 'mountain.glb')), export_format='GLB', use_selection=True,
                          export_yup=True, export_apply=True, export_materials='NONE', export_vertex_color='ACTIVE', export_texcoords=False)
dg = bpy.context.evaluated_depsgraph_get()
bvh = BVHTree.FromObject(ob, dg)
patched = 0
for j in range(j0, j1 + 1):
    for i in range(i0, i1 + 1):
        x, z = off + i * step, off + j * step
        if math.hypot(x - MX, z - MZ) > R0 - 3:
            continue
        hit = bvh.ray_cast(Vector((x, -z, 400.0)), Vector((0, 0, -1)), 600.0)
        if hit[0] is not None:
            hh[j, i] = round(hit[0].z, 3); patched += 1
H['h'] = hh.ravel().tolist()
H['meta']['mountainR'] = R0
json.dump(H, open(HJ, 'w'), separators=(',', ':'))
print('patched heights', patched)
import shutil, subprocess
npx = shutil.which('npx')
if npx:
    glb = os.path.join(OUT, 'mountain.glb')
    subprocess.run([npx, '--yes', '@gltf-transform/cli', 'meshopt', glb, glb, '--level', 'high'], check=False)
print('MOUNTAIN DONE')
