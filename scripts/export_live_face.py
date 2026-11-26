#!/usr/bin/env python3
"""Export each character's facial-expression rig for the Fes×LIVE viewer.

The live recording drives faces with ExpressionData (crossfade from expression LastId to NextId by
Weight) and LipSyncData (Mouth_A/I/U/E/O/Close weights); blinking is generated on the client
(Inspix AutoBlink). The costume prefab's ExpressionSettings maps an expression index to a key
("expression_laugh", ...) and says whether that expression may blink. The character's expression
AnimatorController (<char>_expression_controller.controller) has two layers:

  Face   direct blend tree, one child per expression key; each child is a pose clip, or a 1D blend
         on "blink" between the open-eye clip and its blink clip
  Mouth  direct blend tree, one child per expression key; each child is a nested direct blend of
         six mouth clips weighted by the lip-sync parameters (close, a, i, u, e, o)

The clips only hold SkinnedMeshRenderer blendShape curves (constant poses). Each binding's
attribute is CRC32 of the blendshape channel name, which is matched against the costume GLB's
morph target names (e.g. "Face_.Mouth_Smile").

Writes <out>/face/<character>_face.json:
  {"character", "expressions": [{"index", "key", "label", "ableBlink", "enable"}],
   "face":  {key: {"open": {shape: weight}, "blink": {shape: weight} | null}},
   "mouth": {key: {"params": [param names in clip order], "clips": [{shape: weight}, ...]}}}
Weights are as stored in the clips (0..100).

Usage (main checkout's uv environment):
  uv run --project <main> python -I scripts/export_live_face.py <out dir> 3d_costume_3033102111 ...
"""
from __future__ import annotations

import json
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAIN = HERE.parents[3]
sys.path.insert(0, str(MAIN / "scripts"))
import unity_assets as UA  # noqa: E402

INDEX = MAIN / ".inspect-tmp" / "ios_index.jsonl"
NONE = 4294967295
SMR_TYPE = 137  # SkinnedMeshRenderer


def glb_morph_names(path: Path) -> list[str]:
    b = path.read_bytes()
    (n,) = struct.unpack_from("<I", b, 12)
    j = json.loads(b[20:20 + n])
    names = []
    for m in j.get("meshes", []):
        names += (m.get("extras") or {}).get("targetNames", [])
    return names


def expression_settings(index: UA.BundleIndex, costume: str) -> list[dict]:
    env = index.load_env(costume)
    scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
    for o in env.objects:
        if o.type.name == "MonoBehaviour":
            t = o.read_typetree()
            if scripts.get(t["m_Script"]["m_PathID"]) == "ExpressionSettings":
                return [{"index": i, "key": e["key"], "label": e["label"], "ableBlink": bool(e["ableBlink"]),
                         "enable": bool(e["enable"])} for i, e in enumerate(t["expressionData"])]
    raise SystemExit(f"{costume}: no ExpressionSettings")


class ClipReader:
    def __init__(self, index: UA.BundleIndex, crc_names: dict[int, str]):
        self.index, self.crc_names, self.cache, self.unknown = index, crc_names, {}, set()

    def pose(self, container: str) -> dict[str, float]:
        if container not in self.cache:
            env = self.index.load_env(container)
            clip = UA.objects_of_type(env, "AnimationClip")[0]
            times, values, _ = UA.decode_clip(clip)
            out = {}
            for k, b in enumerate(clip["m_ClipBindingConstant"]["genericBindings"]):
                if b["typeID"] != SMR_TYPE:
                    continue
                name = self.crc_names.get(b["attribute"])
                if name is None:
                    self.unknown.add(b["attribute"])
                    continue
                v = float(values[k, 0])
                if abs(v) > 1e-4:
                    out[name] = round(v, 3)
            self.cache[container] = out
        return self.cache[container]


def export(costume: str, out_dir: Path, index: UA.BundleIndex) -> Path:
    rec = index.by_container[costume]
    deps = [index.by_cab.get(d) for d in rec["deps"]]
    ctrl_name = next(c for d in deps if d for c in d["containers"] if c.endswith("expression_controller.controller"))
    character = ctrl_name.strip("_").split("_expression_controller")[0]

    glb = next((out_dir / "costume").glob(f"*/{costume}.glb"), None)
    if glb is None:  # second-set costumes share the character's face model; use any of her GLBs
        avatars = sorted((out_dir / "costume").glob("*/*_avatar.json"))
        for a in avatars:
            if character[:3] in json.loads(a.read_text())["model"]:
                cand = a.parent / f"{a.parent.name}.glb"
                if cand.exists():
                    glb = cand
                    break
    if glb is None:
        raise SystemExit(f"{costume}: no costume GLB to read blendshape names from")
    # binding attribute = CRC32 of the blendshape channel name itself (e.g. "Face_.Mouth_Smile")
    crc_names = {zlib.crc32(n.encode()): n for n in glb_morph_names(glb)}
    clips = ClipReader(index, crc_names)

    cenv = index.load_env(ctrl_name)
    obj = next(o for o in cenv.objects if o.type.name == "AnimatorController")
    c = obj.read_typetree()
    externals = [e.path.split("/")[-1].split(".")[0] for e in obj.assets_file.externals]
    tos = {int(k): v for k, v in c["m_TOS"]}

    def clip_container(cid: int) -> str:
        pp = c["m_AnimationClips"][cid]
        cab = externals[pp["m_FileID"] - 1]
        r = index.by_cab.get(cab) or index.by_cab.get(cab.upper())
        return r["containers"][0]

    sms = c["m_Controller"]["m_StateMachineArray"]

    def direct_params(node) -> list[str]:
        d = node["m_BlendDirectData"].get("data", node["m_BlendDirectData"])
        return [tos.get(x, str(x)) for x in d.get("m_ChildBlendEventIDArray", [])]

    # Layer names vary per character ("Face"/"Mouth", ...); tell them apart by content: the mouth
    # layer's children are nested direct blends over the lip parameters.
    trees = []
    for l in c["m_Controller"]["m_LayerArray"]:
        st = sms[l["data"]["m_StateMachineIndex"]]["data"]["m_StateConstantArray"]
        if st and st[0]["data"]["m_BlendTreeConstantArray"]:
            trees.append([n["data"] for n in st[0]["data"]["m_BlendTreeConstantArray"][0]["data"]["m_NodeArray"]])

    def is_mouth(nodes) -> bool:
        return any(any(p.startswith("lip_") for p in direct_params(nodes[k])) for k in nodes[0]["m_ChildIndices"])

    mouth_trees = [t for t in trees if is_mouth(t)]
    face_trees = [t for t in trees if not is_mouth(t)]
    if not mouth_trees or not face_trees:
        raise SystemExit(f"{ctrl_name}: couldn't identify face/mouth layers")

    def tree(layer: str):
        return (face_trees if layer == "Face" else mouth_trees)[0]

    face, mouth = {}, {}
    nodes = tree("Face")
    for key, child in zip(direct_params(nodes[0]), nodes[0]["m_ChildIndices"]):
        n = nodes[child]
        if n["m_ClipID"] != NONE:
            face[key] = {"open": clips.pose(clip_container(n["m_ClipID"])), "blink": None}
        else:  # 1D blend on blink: [open, blink]
            kids = [nodes[k]["m_ClipID"] for k in n["m_ChildIndices"]]
            face[key] = {"open": clips.pose(clip_container(kids[0])), "blink": clips.pose(clip_container(kids[1]))}
    nodes = tree("Mouth")
    for key, child in zip(direct_params(nodes[0]), nodes[0]["m_ChildIndices"]):
        n = nodes[child]
        params = direct_params(n)
        mouth[key] = {"params": params,
                      "clips": [clips.pose(clip_container(nodes[k]["m_ClipID"])) for k in n["m_ChildIndices"]]}

    data = {"character": character, "costume": costume, "expressions": expression_settings(index, costume),
            "face": face, "mouth": mouth}
    path = out_dir / "face" / f"{costume}_face.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    shapes = {s for f in face.values() for p in (f["open"], f["blink"] or {}) for s in p}
    print(f"{costume} ({character}): {len(data['expressions'])} expressions, {len(face)} face keys, "
          f"{len(mouth)} mouth keys, {len(shapes)} shapes used, {len(clips.unknown)} unresolved curves -> {path}")
    return path


def main() -> None:
    out_dir = Path(sys.argv[1])
    index = UA.BundleIndex(INDEX)
    for costume in sys.argv[2:]:
        export(costume, out_dir, index)


if __name__ == "__main__":
    main()
