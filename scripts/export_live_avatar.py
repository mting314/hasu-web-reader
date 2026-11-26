#!/usr/bin/env python3
"""Export each live costume's humanoid Avatar as JSON, so the browser can turn muscle values into
bone rotations itself (a port of unity_assets.HumanoidBaker, see src/live/humanoid.ts).

For costume <id> it finds the body model among the costume bundle's dependencies (the .fbx bundle
with an Avatar and the most GameObjects) and writes <out>/<id>/<id>_avatar.json with, in Unity space:

  scale            human scale (Avatar m_Human.m_Scale)
  nodes[]          human skeleton: name (GameObject name), parent, rest t/r, axes index
  axes[]           per-axes pre/post quaternions, sign, min/max limits (radians)
  muscles[95]      [node, axis] driven by each muscle in Unity HumanTrait order (or null)
  bones{}          humanoid bone name -> human skeleton node (for the body frame / centre of mass)
  mass{}           humanoid bone name -> mass
  segments[]       [bone, child bone] pairs used for the centre of mass
  hips             human skeleton node of the hips
  subBones         {"move": [16 names], "rotate": [26 names]}: helper bones (SubBoneReference) whose
                   local position/rotation the motion packet sends, in packet order

unity_assets.py lives in the main checkout (uncommitted), so it is imported from there.

Usage (main checkout's uv environment):
  uv run --project <main checkout> python -I scripts/export_live_avatar.py <out dir> 3d_costume_3033102111 ...
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAIN = HERE.parents[3]
sys.path.insert(0, str(MAIN / "scripts"))
import unity_assets as UA  # noqa: E402

INDEX = MAIN / ".inspect-tmp" / "ios_index.jsonl"


def body_model(costume: str, rows: list[dict], by_cab: dict) -> str:
    rec = next(r for r in rows if costume in r["containers"])
    best, best_n = None, -1
    for dep in rec["deps"]:
        d = by_cab.get(dep)
        if not d or "Avatar" not in d["types"]:
            continue
        name = next((c for c in d["containers"] if c.endswith(".fbx")), None)
        n = d["types"].get("GameObject", 0)
        if name and "_face" not in name and n > best_n:
            best, best_n = name, n
    if best is None:
        raise SystemExit(f"{costume}: no body model with an Avatar among its dependencies")
    return best


def sub_bones(index: UA.BundleIndex, costume: str) -> dict[str, list[str]]:
    """Names of the helper bones the motion packet carries, in packet order (SubBoneReference)."""
    env = index.load_env(costume)
    scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
    go = {o.path_id: o.read_typetree()["m_Name"] for o in env.objects if o.type.name == "GameObject"}
    tr = {o.path_id: o.read_typetree()["m_GameObject"]["m_PathID"] for o in env.objects if o.type.name == "Transform"}
    for o in env.objects:
        if o.type.name == "MonoBehaviour":
            t = o.read_typetree()
            if scripts.get(t["m_Script"]["m_PathID"]) == "SubBoneReference":
                names = lambda key: [go.get(tr.get(p["m_PathID"]), "") for p in t[key]]  # noqa: E731
                return {"move": names("moveSubBones"), "rotate": names("rotateSubBones")}
    return {"move": [], "rotate": []}


def export(costume: str, index: UA.BundleIndex, rows, by_cab, out: Path) -> Path:
    fbx = body_model(costume, rows, by_cab)
    av = UA.Avatar(UA.objects_of_type(index.load_env(fbx), "Avatar")[0])
    baker = UA.HumanoidBaker(av)
    muscles: list = [None] * 95
    for node, chans in baker.driven.items():
        for attr, axis in chans:
            muscles[attr - UA.MUSCLE_BASE] = [node, axis]
    rnd = lambda xs: [round(float(x), 7) for x in xs]  # noqa: E731
    bones = {b: int(av.bone_index[i]) for i, b in enumerate(UA.BONES) if av.bone_index[i] >= 0}
    data = {
        "costume": costume,
        "model": fbx,
        "avatar": av.name,
        "scale": float(av.scale),
        "hips": int(av.hips),
        "nodes": [{"name": av.node_names[av.h_to_node[i]], "parent": int(av.h_parent[i]),
                   "t": rnd(av.h_t[i]), "r": rnd(av.h_r[i]), "axes": int(av.h_axes_id[i])}
                  for i in range(len(av.h_parent))],
        "axes": [{"pre": rnd(a.pre), "post": rnd(a.post), "sgn": rnd(a.sgn), "min": rnd(a.lo), "max": rnd(a.hi)}
                 for a in av.axes],
        "muscles": muscles,
        "bones": bones,
        "mass": {b: float(av.mass[i]) for i, b in enumerate(UA.BONES) if av.bone_index[i] >= 0},
        "segments": [[b, c] for b, c in UA.SEGMENT_CHILD.items()],
        # helper bones whose local transforms the motion packet carries (16 positions, 26 rotations)
        "subBones": sub_bones(index, costume),
    }
    path = out / costume / f"{costume}_avatar.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")))
    return path


def main() -> None:
    out = Path(sys.argv[1])
    rows = [json.loads(l) for l in open(INDEX)]
    by_cab = {c.split(".")[0]: r for r in rows for c in r["cabs"]}
    index = UA.BundleIndex(INDEX)
    for costume in sys.argv[2:]:
        p = export(costume, index, rows, by_cab, out)
        d = json.loads(p.read_text())
        print(f"{costume}: {d['model']} ({d['avatar']}), {len(d['nodes'])} human nodes, scale {d['scale']:.3f}, "
              f"{sum(m is not None for m in d['muscles'])}/95 muscles driven -> {p}")


if __name__ == "__main__":
    main()
