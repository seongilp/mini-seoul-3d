"""전동차 모델을 만들어 public/models/train.glb 로 내보낸다.

    blender --background --python scripts/build-train-model.py

전동차 중간차(mid)·운전실차(cab), 고속열차 중간차(hsmid)·앞머리차(hscab)를 만든다. 부품은 재질별로 한 오브젝트에
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


# ── 고속열차(KTX·SRT) ─────────────────────────────────────────────
# 전동차보다 낮고 둥글며, 앞머리가 길게 누워 있다. 차체는 흰색으로 두고
# 허리띠(trim)에 운행사 색을 입힌다.
HS_FLOOR_Z = 0.1 * H
HS_TOP = 0.86 * H
HS_BODY_H = HS_TOP - HS_FLOOR_Z
HS_BEVEL = 0.8
# 앞머리가 눕는 길이와, 앞끝에서 폭·높이가 줄어드는 비율.
HS_NOSE = 0.42 * L
HS_NOSE_WIDTH = 0.55
HS_NOSE_DROP = 0.5
# 앞머리 차의 옆면 부품은 여기까지만 놓는다. 그 앞은 차체가 좁아진다.
HS_SIDE_FRONT = 0.02 * L


def hs_nose_shell():
    """앞으로 갈수록 낮아지고 좁아지는 차체."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= L
        v.co.y *= W
        v.co.z *= HS_BODY_H
    # 길이 방향으로 잘라 앞머리가 시작되는 단면을 만든다.
    cut = L / 2 - HS_NOSE
    bmesh.ops.bisect_plane(
        bm,
        geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
        plane_co=(cut, 0, 0),
        plane_no=(1, 0, 0),
    )
    for v in bm.verts:
        if v.co.x > cut + 0.01:
            v.co.y *= HS_NOSE_WIDTH
            if v.co.z > 0:
                v.co.z -= HS_BODY_H * HS_NOSE_DROP
    bmesh.ops.bevel(
        bm, geom=list(bm.edges), offset=HS_BEVEL, segments=2, profile=0.5, affect="EDGES"
    )
    obj = new_object("part", bm)
    obj.location = (0, 0, HS_FLOOR_Z + HS_BODY_H / 2)
    return obj


def hs_side_span(cab):
    return (-0.46 * L, HS_SIDE_FRONT if cab else 0.46 * L)


def hs_body_parts(cab):
    if cab:
        return [hs_nose_shell()]
    return [box((0, 0, HS_FLOOR_Z + HS_BODY_H / 2), (L, W, HS_BODY_H), bevel=HS_BEVEL)]


def hs_trim_parts(cab):
    """창 아래 굵은 허리띠. 운행사 색이 여기에 들어간다."""
    lo, hi = hs_side_span(cab)
    return [
        box(((lo + hi) / 2, side * W / 2, HS_FLOOR_Z + 0.36 * HS_BODY_H), (hi - lo, 0.12, 0.2 * HS_BODY_H))
        for side in (-1, 1)
    ]


def hs_glass_parts(cab):
    parts = []
    lo, hi = hs_side_span(cab)
    lo += 0.07 * L
    hi -= 0.02 * L if cab else 0.07 * L
    panes = 4 if cab else 7
    pitch = (hi - lo) / panes
    for side in (-1, 1):
        for i in range(panes):
            parts.append(
                box(
                    (lo + pitch * (i + 0.5), side * W / 2, HS_FLOOR_Z + 0.63 * HS_BODY_H),
                    (pitch * 0.84, 0.14, 0.24 * HS_BODY_H),
                )
            )
    if cab:
        # 누운 앞유리. 앞머리 윗면의 기울기를 따라 붙인다.
        drop = HS_BODY_H * HS_NOSE_DROP
        slope = math.atan2(drop, HS_NOSE)
        parts.append(
            box(
                (L / 2 - HS_NOSE * 0.6, 0, HS_TOP - drop * 0.4 + 0.05),
                (HS_NOSE * 0.44, 0.4 * W, 0.3),
                tilt=slope,
            )
        )
    return parts


def hs_lamp_parts():
    return [
        box((L / 2 - 0.02 * L, side * 0.16 * W, HS_FLOOR_Z + 0.22 * HS_BODY_H), (0.25, 0.1 * W, 0.08 * HS_BODY_H))
        for side in (-1, 1)
    ]


def hs_roof_parts(cab):
    length = 0.5 * L if cab else 0.9 * L
    x = -0.22 * L if cab else 0
    return [box((x, 0, HS_TOP), (length, 0.5 * W, 0.04 * H))]


def hs_under_parts(cab):
    """바퀴를 가리는 치마. 고속열차는 하부가 덮여 있다."""
    length = 0.86 * L if cab else 0.92 * L
    x = -0.05 * L if cab else 0
    return [box((x, 0, HS_FLOOR_Z / 2 + 0.02 * H), (length, 0.88 * W, HS_FLOOR_Z))]


def build_highspeed(prefix, cab):
    groups = {
        "body": hs_body_parts(cab),
        "trim": hs_trim_parts(cab),
        "glass": hs_glass_parts(cab),
        "roof": hs_roof_parts(cab),
        "under": hs_under_parts(cab),
    }
    if cab:
        groups["lamp"] = hs_lamp_parts()
    export_groups(prefix, groups)


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


def export_groups(prefix, groups):
    for part, parts in groups.items():
        obj = join(f"{prefix}_{part}", parts)
        smooth(obj)
        normalize(obj)
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        print(f"  {obj.name}: {tris} tris")


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
    export_groups(prefix, groups)


def main():
    reset_scene()
    build_car("mid", cab=False)
    build_car("cab", cab=True)
    build_highspeed("hsmid", cab=False)
    build_highspeed("hscab", cab=True)
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
