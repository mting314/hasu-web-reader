#!/usr/bin/env python3
"""Export a Project Sekai 3D character (body + head) as one GLB for the PJSK cast swap.

PJSK splits a character into a body bundle (`live_pv/model/characterv2/body/<cc>/<nnnn>/<figure>`,
prefab `body`) and a head bundle (`live_pv/model/characterv2/face/<cc>/<nnnn>`, prefab `face`:
face, hair, eyes). Both are fetched with scripts/pjsk_fetch.py. The head prefab repeats the body's
spine chain `Position/Hip/Waist/Spine/Chest/Neck/Head` with zero translations up to Neck and the
body's rotations, so it only differs from the body rig by a translation. The exporter merges the
two into one skeleton:
  - the body prefab is exported as is (CostumeExporter from export_costume.py: nodes, skinned
    meshes, blendshapes, materials with `extras.unity`)
  - head transforms named like a body spine bone map onto that body bone; everything else in the
    head prefab (hair spring bones, accessory sockets a01..a10, the renderer objects) is grafted
    under the mapped parent with its own local transform
  - head meshes get new inverse bind matrices against the merged skeleton, moved by the offset
    between the two rigs' Head bones (vertices are unchanged)
The model keeps PJSK's native size (about 0.98 m for a 161 cm character); the root node's extras
record `pjsk: {characterId, heightM, ...}` so the reader can scale it.

Usage (needs only UnityPy; bundles are stored de-obfuscated):
  uv run python -I scripts/export_pjsk_model.py --bundles data-inspect/pjsk/bundles \\
      --body live_pv/model/characterv2/body/01/0001/ladies_m \\
      --face live_pv/model/characterv2/face/01/0001 \\
      --character 1 --id 01ichika --master data-inspect/pjsk/master
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import UnityPy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_costume import CostumeExporter, Glb  # noqa: E402

UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.52f1"  # PJSK bundles carry no Unity version
warnings.filterwarnings("ignore", module="UnityPy")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "public" / "assets" / "pjsk" / "3d" / "model"
# Head-prefab transforms that are the same bone as the body's (the head rig's copy of the spine).
SHARED_BONES = ("Position", "Hip", "Waist", "Spine", "Chest", "Neck", "Head")


def load_closure(bundles: Path, names: list[str]) -> UnityPy.Environment:
    """One environment holding the bundles and every bundle they depend on (AssetBundle deps)."""
    env = UnityPy.Environment()
    seen: set[str] = set()
    todo = list(names)
    while todo:
        name = todo.pop(0)
        if name in seen:
            continue
        seen.add(name)
        path = bundles / name
        if not path.exists():
            sys.exit(f"missing bundle {path}; fetch it with scripts/pjsk_fetch.py get {name}")
        env.load_file(path.read_bytes(), name=name)
        for sf in env.files[name].files.values():
            for obj in getattr(sf, "objects", {}).values():
                if obj.type.name == "AssetBundle":
                    todo += obj.read_typetree().get("m_Dependencies") or []
    return env


def trs_matrix(t, q) -> np.ndarray:
    x, y, z, w = q
    m = np.eye(4)
    m[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                 [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                 [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    m[:3, 3] = t
    return m


class PjskModelExporter(CostumeExporter):
    data_texture_hints = ("_h", "sdf", "dither", "mask")  # _h = _ValueTex control map
    uv_sets = 3  # Toon-v3's Outline pass reads TEXCOORD2 (the hair's second outline normal)

    def __init__(self, env: UnityPy.Environment, body: str, face: str, glb: Glb):
        super().__init__(env, body, glb)
        self.body, self.face = body, face
        self.face_nodes: set[int] = set()

    def prefab_root(self, bundle: str, name: str):
        for obj in self.env.objects:
            if obj.type.name != "Transform" or obj.assets_file.parent is not self.env.files[bundle]:
                continue
            tt = obj.read_typetree()
            go = obj.assets_file.objects[tt["m_GameObject"]["m_PathID"]].read_typetree()
            if tt["m_Father"]["m_PathID"] == 0 and go["m_Name"] == name:
                return obj
        sys.exit(f"no root '{name}' in {bundle}")

    def body_bone(self, name: str) -> int | None:
        hits = [i for i, n in enumerate(self.glb.gltf["nodes"]) if n["name"] == name and i not in self.face_nodes]
        return hits[0] if len(hits) == 1 else None

    def graft(self, tobj, parent: int) -> None:
        """Map a head-prefab transform onto the body bone of the same name, or add it under parent."""
        tt = tobj.read_typetree()
        name = tobj.assets_file.objects[tt["m_GameObject"]["m_PathID"]].read_typetree()["m_Name"]
        shared = self.body_bone(name) if name in SHARED_BONES else None
        if shared is not None:
            self.node_of[(tobj.assets_file.name, tobj.path_id)] = shared
            for c in tt["m_Children"]:
                cobj = self.resolve(tobj.assets_file, c)
                if cobj is not None:
                    self.graft(cobj, shared)
            return
        before = len(self.glb.gltf["nodes"])
        idx = self.add_node(tobj)
        self.face_nodes.update(range(before, len(self.glb.gltf["nodes"])))
        self.glb.gltf["nodes"][parent].setdefault("children", []).append(idx)

    def world_matrices(self) -> list[np.ndarray]:
        """Rest world matrices of every glTF node (glTF space)."""
        nodes = self.glb.gltf["nodes"]
        world: list[np.ndarray | None] = [None] * len(nodes)

        def walk(i: int, parent: np.ndarray) -> None:
            n = nodes[i]
            m = parent @ trs_matrix(n.get("translation", [0, 0, 0]), n.get("rotation", [0, 0, 0, 1]))
            if "scale" in n:
                m = m @ np.diag([*n["scale"], 1.0])
            world[i] = m
            for c in n.get("children", []):
                walk(c, m)

        for r in self.glb.gltf["scenes"][0]["nodes"]:
            walk(r, np.eye(4))
        return world

    def head_offset(self, face_root) -> np.ndarray:
        """Body Head minus head-rig Head, rest world positions (glTF space)."""
        def find(tobj, path):
            tt = tobj.read_typetree()
            if not path:
                return tobj
            for c in tt["m_Children"]:
                cobj = self.resolve(tobj.assets_file, c)
                go = cobj.assets_file.objects[cobj.read_typetree()["m_GameObject"]["m_PathID"]].read_typetree()
                if go["m_Name"] == path[0]:
                    return find(cobj, path[1:])
            sys.exit(f"head prefab has no {'/'.join(path)}")

        m = np.eye(4)
        tobj = face_root
        for step in ["Position", "Hip", "Waist", "Spine", "Chest", "Neck", "Head"]:
            tobj = find(tobj, [step])
            tt = tobj.read_typetree()
            p, q = tt["m_LocalPosition"], tt["m_LocalRotation"]
            m = m @ trs_matrix([-p["x"], p["y"], p["z"]], [q["x"], -q["y"], -q["z"], q["w"]])
        face_head = m[:3, 3]
        body_head = self.world_matrices()[self.body_bone("Head")][:3, 3]
        return body_head - face_head

    def rebind_head_meshes(self, first_skin: int, offset: np.ndarray) -> None:
        """Inverse bind matrices for the head meshes against the merged skeleton: the mesh moves by
        `offset` (the gap between the two Head bones) and keeps its vertices."""
        world = self.world_matrices()
        shift = np.eye(4)
        shift[:3, 3] = offset
        g = self.glb.gltf
        for skin in g["skins"][first_skin:]:
            ibm = np.array([np.linalg.inv(world[j]) @ shift for j in skin["joints"]])
            skin["inverseBindMatrices"] = self.glb.accessor(np.array([m.T.reshape(16) for m in ibm]), "MAT4")

    def bundle_of(self, obj) -> str | None:
        for name in (self.body, self.face):
            if obj.assets_file.parent is self.env.files[name]:
                return name
        return None

    def renderers(self):
        """Skinned mesh renderers inside the exported prefabs (not the raw .fbx model copies)."""
        for obj in self.env.objects:
            if obj.type.name != "SkinnedMeshRenderer" or self.bundle_of(obj) is None:
                continue
            tt = obj.read_typetree()
            go = obj.assets_file.objects[tt["m_GameObject"]["m_PathID"]].read_typetree()
            tr = next(c["component"] for c in go["m_Component"]
                      if self.resolve(obj.assets_file, c["component"]).type.name == "Transform")
            if (obj.assets_file.name, tr["m_PathID"]) in self.node_of:
                yield obj

    def character_hair(self) -> None:
        """Sekai.Rendering.SekaiCharacterHair on the hair renderer: each update (OnUpdate, JP RVA
        0xA81CD18) sets the hair materials' _HeadPosition = headTransform.TransformPoint(offset).
        Recorded as node extras `sekaiCharacterHair: {head, offset}` (offset in glTF axes)."""
        nodes = self.glb.gltf["nodes"]
        for obj in self.env.objects:
            if obj.type.name != "MonoBehaviour" or self.bundle_of(obj) != self.face:
                continue
            try:
                tt = obj.read_typetree()
            except Exception:  # noqa: BLE001 - scripts without a type tree
                continue
            if "offset" not in tt or "headTransform" not in tt:
                continue
            head = self.node_of.get(self._tkey(obj.assets_file, tt["headTransform"]))
            go = obj.assets_file.objects[tt["m_GameObject"]["m_PathID"]].read_typetree()
            tr = next(c["component"] for c in go["m_Component"]
                      if self.resolve(obj.assets_file, c["component"]).type.name == "Transform")
            host = self.node_of.get((obj.assets_file.name, tr["m_PathID"]))
            if head is None or host is None:
                continue
            o = tt["offset"]
            nodes[host].setdefault("extras", {})["sekaiCharacterHair"] = {
                "head": nodes[head]["name"], "offset": [-o["x"], o["y"], o["z"]]}

    def run(self) -> None:
        body_root = self.prefab_root(self.body, "body")
        face_root = self.prefab_root(self.face, "face")
        root = self.add_node(body_root)
        self.glb.gltf["scenes"][0]["nodes"] = [root]
        self.node_of[(face_root.assets_file.name, face_root.path_id)] = root
        for c in face_root.read_typetree()["m_Children"]:
            cobj = self.resolve(face_root.assets_file, c)
            if cobj is not None:
                self.graft(cobj, root)
        offset = self.head_offset(face_root)
        body_skins = None
        for r in sorted(self.renderers(), key=lambda o: self.bundle_of(o) != self.body):
            if body_skins is None and self.bundle_of(r) == self.face:
                body_skins = len(self.glb.gltf["skins"])
            self.add_renderer(r)
        if body_skins is not None:
            self.rebind_head_meshes(body_skins, offset)
        self.character_hair()


def export_one(bundles: Path, body: str, face: str, model_id: str, character: dict | None, out_dir: Path) -> None:
    env = load_closure(bundles, [body, face])
    glb = Glb()
    glb.gltf["asset"]["generator"] = "hasu-web-reader export_pjsk_model.py"
    ex = PjskModelExporter(env, body, face, glb)
    ex.run()

    info = {"body": body, "face": face}
    if character:
        info.update(characterId=character["id"], heightM=character["height"] / 100,
                    name=" ".join(n for n in (character.get("givenName"), character.get("firstName")) if n),
                    unit=character["unit"])
    world = ex.world_matrices()
    hip = ex.body_bone("Hip")
    info["restHipHeight"] = float(world[hip][1, 3]) if hip is not None else None
    root = glb.gltf["nodes"][glb.gltf["scenes"][0]["nodes"][0]]
    root.setdefault("extras", {})["pjsk"] = info

    out = out_dir / model_id / f"{model_id}.glb"
    out.parent.mkdir(parents=True, exist_ok=True)
    glb.write(out)
    # The reader's cast picker lists every model in <out>/../../models.json (pjsk/models.json).
    catalog = out_dir.parent.parent / "models.json"
    entries = [e for e in (json.loads(catalog.read_text()) if catalog.exists() else []) if e["id"] != model_id]
    if character:
        rel = out.relative_to(out_dir.parent.parent.parent)  # path below public/assets/
        entries.append({"id": model_id, "name": info["name"], "characterId": info["characterId"],
                        "heightM": info["heightM"], "glbUrl": f"/assets/{rel.as_posix()}"})
        catalog.write_text(json.dumps(sorted(entries, key=lambda e: e["id"]), ensure_ascii=False, indent=1) + "\n")
    g = glb.gltf
    print(f"{model_id}: {len(g['nodes'])} nodes, {len(g.get('meshes', []))} meshes, {len(g.get('materials', []))} materials, "
          f"{len(g.get('textures', []))} textures -> {out} ({out.stat().st_size / 1e6:.1f} MB)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bundles", type=Path, required=True, help="pjsk_fetch.py's bundles/ directory")
    ap.add_argument("--master", type=Path, help="pjsk_fetch.py's master/ directory (heights, names)")
    ap.add_argument("--defaults", action="store_true",
                    help="every character's default look: body/<cc>/0001/<figure> + face/<cc>/0001, id = modelName")
    ap.add_argument("--body", help="body bundle name")
    ap.add_argument("--face", help="head bundle name")
    ap.add_argument("--id", help="output model id, e.g. 01ichika")
    ap.add_argument("--character", type=int, help="gameCharacters id")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    a = ap.parse_args()
    chars = {c["id"]: c for c in json.loads((a.master / "gameCharacters.json").read_text())} if a.master else {}

    if a.defaults:
        if not chars:
            ap.error("--defaults needs --master")
        model_root = a.bundles / "live_pv" / "model" / "characterv2"
        for c in chars.values():
            cc = f"{c['id']:02d}"
            body_dir = model_root / "body" / cc / "0001"
            bodies = sorted(body_dir.iterdir()) if body_dir.exists() else []
            face = f"live_pv/model/characterv2/face/{cc}/0001"
            if not bodies or not (a.bundles / face).exists():
                print(f"[skip] {c['modelName']}: bundles not fetched")
                continue
            export_one(a.bundles, bodies[0].relative_to(a.bundles).as_posix(), face, c["modelName"], c, a.out)
        return
    if not (a.body and a.face and a.id):
        ap.error("give --body, --face and --id, or --defaults")
    export_one(a.bundles, a.body, a.face, a.id, chars.get(a.character), a.out)


if __name__ == "__main__":
    main()
