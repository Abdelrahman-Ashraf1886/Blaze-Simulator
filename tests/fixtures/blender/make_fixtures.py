"""
Builds the Blender-exported glTF fixtures used by the import tests.

Run with Blender 4.2 (headless):
  blender -b --factory-startup --python tests/fixtures/blender/make_fixtures.py -- <output dir>

Scene: a 'camera pod' made of a 80 x 60 x 50 mm box (Blender X, Y, Z; Z is up in
Blender) with a 30 mm diameter, 20 mm long lens cylinder on its +X face, and one
material. Blender works in metres and its glTF exporter converts Z-up to Y-up, so
the exported files follow the glTF conventions (metres, +Y up).
"""
import os
import sys

import bpy

out = sys.argv[sys.argv.index("--") + 1]
os.makedirs(out, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.025))
body = bpy.context.active_object
body.name = "Pod body"
body.scale = (0.08, 0.06, 0.05)

bpy.ops.mesh.primitive_cylinder_add(radius=0.015, depth=0.02, location=(0.05, 0, 0.025), rotation=(0, 1.5707963267948966, 0))
lens = bpy.context.active_object
lens.name = "Pod lens"

mat = bpy.data.materials.new("Pod grey")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.35, 0.37, 0.4, 1)
for obj in (body, lens):
    obj.data.materials.append(mat)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

common = dict(use_selection=False, export_apply=True, export_yup=True)
bpy.ops.export_scene.gltf(filepath=os.path.join(out, "pod.glb"), export_format="GLB", **common)
# Separate .gltf + .bin: must be refused (references another file).
bpy.ops.export_scene.gltf(filepath=os.path.join(out, "pod-separate.gltf"), export_format="GLTF_SEPARATE", **common)
# Draco-compressed GLB: must be refused (no decoder bundled).
bpy.ops.export_scene.gltf(
    filepath=os.path.join(out, "pod-draco.glb"), export_format="GLB", export_draco_mesh_compression_enable=True, **common
)
print("fixtures written to", out)
