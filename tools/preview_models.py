# Contact sheet of every model in assets/models.glb (workbench render). Debug aid.
import bpy, sys, math
out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath='assets/models.glb')
objs = sorted([o for o in bpy.data.objects if o.type == 'MESH' and o.name != 'island'], key=lambda o: o.name)
bpy.data.objects['island'].hide_render = True
cols = 18
for i, o in enumerate(objs):
    d = max(o.dimensions) or 1
    s = 2.0 / d
    o.scale = (s, s, s)
    o.location = ((i % cols) * 3, -(i // cols) * 3, 0)
sc = bpy.context.scene
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
sc.collection.objects.link(cam)
rows = math.ceil(len(objs) / cols)
cam.data.type = 'ORTHO'
cam.data.ortho_scale = max(cols, rows) * 3 + 2
cam.location = (cols * 1.5 - 1.5, -rows * 1.5 + 1.5 - 4, 40)
cam.rotation_euler = (math.radians(10), 0, 0)
sc.camera = cam
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'
sc.display.shading.color_type = 'MATERIAL'
sc.render.resolution_x = 1800
sc.render.resolution_y = int(1800 * rows / cols) + 100
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
