"""전동차 모델을 만들어 public/models/train.glb 로 내보낸다.

    blender --background --python scripts/build-train-model.py

중간차(mid)와 운전실차(cab) 두 가지를 만든다. 부품은 재질별로 한 오브젝트에
합쳐 `<차종>_<부품>` 이름으로 내보낸다. 색은 지도 쪽에서 입히므로 여기서는
형상만 다룬다.

지도에서는 칸을 실제보다 통통하게 그린다(src/map/trains.ts 의 CAR_WIDTH).
그 비율로 모델링한 뒤 단위 상자(길이 x ±0.5, 폭 ±0.5, 높이 0~1)로 눌러
내보내면, 지도에서 다시 늘렸을 때 모서리 둥글기가 찌그러지지 않는다.
"""

import math
import os

import bmesh
import bpy

# 지도에 그려지는 칸의 비율(m). 길이 20 × 0.93, 폭 20 × 0.42, 높이 20 × 0.32.
L = 18.6
W = 8.4
H = 6.4

# 높이 구획.
FLOOR_Z = 0.15 * H
BODY_TOP = 0.93 * H
BODY_H = BODY_TOP - FLOOR_Z
BODY_BEVEL = 0.55
# 운전실 앞면이 위로 갈수록 뒤로 눕는 정도.
NOSE_SLANT = 0.07 * L
SMOOTH_ANGLE = math.radians(40)

OUT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "public", "models", "train.glb"
)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def new_object(name, bm):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def box(center, size, bevel=0.0, slant=0.0, tilt=0.0):
    """상자 하나. slant 는 +x 쪽 윗변을 뒤로 민다. tilt 는 y축 회전(rad)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z *= size[2]
        if slant and v.co.x > 0 and v.co.z > 0:
            v.co.x -= slant
    if bevel:
        bmesh.ops.bevel(
            bm,
            geom=list(bm.edges),
            offset=bevel,
            segments=2,
            profile=0.5,
            affect="EDGES",
        )
    obj = new_object("part", bm)
    obj.rotation_euler = (0.0, tilt, 0.0)
    obj.location = center
    return obj


def wheel(center, radius, width):
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        segments=10,
        radius1=radius,
        radius2=radius,
        depth=width,
    )
    obj = new_object("wheel", bm)
    obj.rotation_euler = (math.radians(90), 0.0, 0.0)
    obj.location = center
    return obj


def join(name, parts):
    """부품들을 한 오브젝트로 합치고 변환을 굳힌다."""
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def side_x_limit(cab):
    """옆면 부품이 놓일 수 있는 x 범위. 운전실차는 앞쪽을 비운다."""
    return (-0.46 * L, 0.33 * L if cab else 0.46 * L)


def body_parts(cab):
    shell = box(
        (0, 0, FLOOR_Z + BODY_H / 2),
        (L, W, BODY_H),
        bevel=BODY_BEVEL,
        slant=NOSE_SLANT if cab else 0.0,
    )
    return [shell]


def door_centers(cab):
    xs = [-0.36 * L, -0.12 * L, 0.12 * L, 0.36 * L]
    return xs[:3] if cab else xs


def trim_parts(cab):
    """문짝과 허리띠. 차체 색 위에 은색으로 얹힌다."""
    parts = []
    lo, hi = side_x_limit(cab)
    belt_len = hi - lo
    belt_x = (hi + lo) / 2
    door_w = 0.085 * L
    door_h = 0.6 * BODY_H
    door_z = FLOOR_Z + 0.06 * BODY_H + door_h / 2
    for side in (-1, 1):
        y = side * W / 2
        parts.append(box((belt_x, y, FLOOR_Z + 0.2 * BODY_H), (belt_len, 0.1, 0.07 * BODY_H)))
        for x in door_centers(cab):
            parts.append(box((x, y, door_z), (door_w, 0.14, door_h)))
    return parts


def glass_parts(cab):
    parts = []
    win_h = 0.27 * BODY_H
    win_z = FLOOR_Z + 0.58 * BODY_H
    doors = door_centers(cab)
    door_w = 0.085 * L
    pane_w = door_w * 0.36
    lo, hi = side_x_limit(cab)
    # 문 사이사이, 그리고 양 끝의 창.
    edges = [lo] + doors + [hi]
    for side in (-1, 1):
        y = side * W / 2
        for x in doors:
            for dx in (-1, 1):
                parts.append(
                    box((x + dx * pane_w * 0.62, y, win_z + 0.02 * BODY_H), (pane_w, 0.2, win_h * 1.1))
                )
        for i in range(len(edges) - 1):
            a = edges[i] + (door_w * 0.5 + 0.02 * L if i > 0 else 0.0)
            b = edges[i + 1] - (door_w * 0.5 + 0.02 * L if i < len(edges) - 2 else 0.0)
            if b - a < 0.03 * L:
                continue
            parts.append(box(((a + b) / 2, y, win_z), (b - a, 0.12, win_h)))
    if cab:
        parts.extend(cab_glass())
    return parts


def nose_point(t):
    """운전실 앞면 위의 점. t 는 아래(0)에서 위(1)까지."""
    return (L / 2 - NOSE_SLANT * t, FLOOR_Z + BODY_H * t)


NOSE_TILT = -math.atan2(NOSE_SLANT, BODY_H)


def cab_glass():
    parts = []
    # 앞유리. 눕힌 앞면을 따라 붙인다.
    x, z = nose_point(0.63)
    parts.append(box((x, 0, z), (0.16, 0.74 * W, 0.4 * BODY_H), tilt=NOSE_TILT))
    # 운전실 옆창.
    for side in (-1, 1):
        parts.append(
            box(
                (0.395 * L, side * W / 2, FLOOR_Z + 0.6 * BODY_H),
                (0.07 * L, 0.12, 0.3 * BODY_H),
            )
        )
    return parts


def lamp_parts():
    parts = []
    x, z = nose_point(0.24)
    for side in (-1, 1):
        parts.append(
            box((x, side * 0.27 * W, z), (0.2, 0.2 * W, 0.09 * BODY_H), tilt=NOSE_TILT)
        )
    return parts


def roof_parts(cab):
    return [box((-0.01 * L if cab else 0, 0, BODY_TOP), (0.84 * L if cab else 0.9 * L, 0.66 * W, 0.05 * H))]


def aircon_parts(cab):
    """지붕 위 냉방기 두 대. 은색이라 지붕 색과 갈려 보인다."""
    return [
        box((x, 0, BODY_TOP + 0.05 * H), (0.2 * L, 0.46 * W, 0.09 * H), bevel=0.12)
        for x in (-0.23 * L, 0.2 * L if cab else 0.23 * L)
    ]


def under_parts(cab):
    parts = [box((0, 0, FLOOR_Z - 0.03 * H), (0.5 * L, 0.72 * W, 0.08 * H))]
    wheel_r = 0.07 * H
    for bx in (-0.31 * L, 0.31 * L):
        parts.append(box((bx, 0, 0.085 * H), (0.2 * L, 0.84 * W, 0.09 * H)))
        for dx in (-0.055 * L, 0.055 * L):
            for side in (-1, 1):
                parts.append(wheel((bx + dx, side * 0.4 * W, wheel_r), wheel_r, 0.07 * W))
    if cab:
        # 앞 범퍼.
        parts.append(box((0.475 * L, 0, FLOOR_Z - 0.02 * H), (0.05 * L, 0.8 * W, 0.07 * H)))
    return parts


def smooth(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_smooth_by_angle(angle=SMOOTH_ANGLE)


def normalize(obj):
    """단위 상자로 누른다."""
    obj.scale = (1 / L, 1 / W, 1 / H)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def build_car(prefix, cab):
    groups = {
        "body": body_parts(cab),
        "trim": trim_parts(cab) + aircon_parts(cab),
        "glass": glass_parts(cab),
        "roof": roof_parts(cab),
        "under": under_parts(cab),
    }
    if cab:
        groups["lamp"] = lamp_parts()
    for part, parts in groups.items():
        obj = join(f"{prefix}_{part}", parts)
        smooth(obj)
        normalize(obj)
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        print(f"  {obj.name}: {tris} tris")


def main():
    reset_scene()
    build_car("mid", cab=False)
    build_car("cab", cab=True)
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_PATH,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_materials="NONE",
        export_texcoords=False,
        export_normals=True,
    )
    print(f"wrote {OUT_PATH} ({os.path.getsize(OUT_PATH)} bytes)")


main()
