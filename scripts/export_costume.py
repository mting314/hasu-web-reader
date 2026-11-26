#!/usr/bin/env python3
"""Export story costumes from the raw game data (data-inspect/) as GLB files for the reader.

A costume (`3d_costume_<id>`) is a prefab bundle: the body rig with the face rig nested under its
head, skinned mesh renderers whose meshes live in the body and face `.fbx` bundles, and materials
(MELPOT/Toon/UberToonShader for body, hair and face; Character/ToonShader_CharacterEye,
..._CharacterHighlight and Highlight_Distortion for the eyes) whose textures sit in other bundles.
The whole dependency closure is loaded into one UnityPy environment so references resolve.

The GLB holds:
  - every transform under the prefab root, with Unity names (bones `<Chr>DeA_*`, the face rig)
  - one skinned mesh per renderer (positions, normals, tangents, uv0/uv1, vertex colours,
    joints/weights), blendshapes as morph targets named like Unity's channels (`Face_.Mouth_A`)
  - materials named like Unity's, with the complete Unity material in `extras.unity`:
    shader, keywords, render queue, every float / colour, and every texture slot (texture index,
    tiling/offset). Colour textures are lossy WebP; control maps and masks lossless WebP.
Conversion matches the motion GLBs: position (-x, y, z), rotation (x, -y, -z, w), triangle winding
reversed, tangent w negated, inverse bind matrices mirrored.

Usage:
  uv run scripts/export_costume.py 3d_costume_1001103101 [...] [--out public/assets/3d/costume]
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
import pygltflib
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unity_assets as UA  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INDEX = ROOT / ".inspect-tmp" / "ios_index.jsonl"
DEFAULT_OUT = ROOT / "public" / "assets" / "3d" / "costume"
MIRROR = np.diag([-1.0, 1.0, 1.0, 1.0])
DATA_TEXTURE_HINTS = ("controlmap", "mask", "normal", "gloss", "matcap", "_nml", "_ctrl")


class Glb:
    def __init__(self) -> None:
        self.gltf: dict = {
            "asset": {"version": "2.0", "generator": "hasu-web-reader export_costume.py"},
            "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [], "skins": [],
            "materials": [], "textures": [], "images": [], "samplers": [],
            "buffers": [], "bufferViews": [], "accessors": [],
            "extensionsUsed": ["EXT_texture_webp"],
        }
        self.bin = bytearray()

    def view(self, data: bytes, target: int | None = None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        bv = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            bv["target"] = target
        self.bin += data
        self.gltf["bufferViews"].append(bv)
        return len(self.gltf["bufferViews"]) - 1

    def accessor(self, arr: np.ndarray, kind: str, ctype: int = 5126, minmax: bool = False,
                 target: int | None = None, normalized: bool = False) -> int:
        dtype = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[ctype]
        arr = np.ascontiguousarray(arr, dtype=dtype)
        acc = {"bufferView": self.view(arr.tobytes(), target), "componentType": ctype,
               "count": int(arr.shape[0]), "type": kind}
        if normalized:
            acc["normalized"] = True
        if minmax:
            flat = arr.reshape(arr.shape[0], -1).astype(np.float64)
            acc["min"] = [float(x) for x in flat.min(axis=0)]
            acc["max"] = [float(x) for x in flat.max(axis=0)]
        self.gltf["accessors"].append(acc)
        return len(self.gltf["accessors"]) - 1

    def write(self, path: Path) -> None:
        """Serialize with pygltflib (it validates the structure and writes the GLB container)."""
        g = dict(self.gltf)
        for key in ("skins", "materials", "textures", "images", "samplers", "meshes"):
            if not g[key]:
                del g[key]
        g["buffers"] = [{"byteLength": len(self.bin)}]
        gltf = pygltflib.GLTF2.from_dict(g)
        gltf.set_binary_blob(bytes(self.bin))
        gltf.save_binary(str(path))


def vec(d: dict, keys="xyz") -> list[float]:
    return [float(d[k]) for k in keys]


def matrix(m) -> np.ndarray:
    """UnityPy Matrix4x4f (column-major eRC fields) -> 4x4 numpy, row-major."""
    if isinstance(m, dict):
        return np.array([[m[f"e{r}{c}"] for c in range(4)] for r in range(4)], dtype=np.float64)
    return np.array([[getattr(m, f"e{r}{c}") for c in range(4)] for r in range(4)], dtype=np.float64)


class CostumeExporter:
    data_texture_hints = DATA_TEXTURE_HINTS  # texture names saved as lossless WebP

    def __init__(self, env: UnityPy.Environment, costume_file: str, glb: Glb):
        self.env, self.glb = env, glb
        self.costume_file = costume_file
        self.node_of: dict[tuple[str, int], int] = {}   # (assets file name, transform path id) -> node
        self.textures: dict[tuple[str, int], int] = {}  # Texture2D -> glTF texture index
        self.materials: dict[tuple[str, int], int] = {}
        self.sampler_of: dict[tuple[int, int], int] = {}

    # --- transforms ---------------------------------------------------------------------------
    def roots(self) -> list:
        """Root transforms of the costume prefab (in the costume bundle itself)."""
        out = []
        for obj in self.env.objects:
            if obj.type.name != "Transform" or obj.assets_file.parent.name != self.costume_file:
                continue
            tt = obj.read_typetree()
            if tt["m_Father"]["m_PathID"] == 0:
                out.append(obj)
        return out

    def add_node(self, tobj) -> int:
        tt = tobj.read_typetree()
        go = tobj.assets_file.objects[tt["m_GameObject"]["m_PathID"]].read_typetree()
        t = np.array(vec(tt["m_LocalPosition"]))
        q = np.array(vec(tt["m_LocalRotation"], "xyzw"))
        s = vec(tt["m_LocalScale"])
        node = {"name": go["m_Name"],
                "translation": [float(-t[0]), float(t[1]), float(t[2])],
                "rotation": [float(q[0]), float(-q[1]), float(-q[2]), float(q[3])]}
        if any(abs(x - 1.0) > 1e-6 for x in s):
            node["scale"] = [float(x) for x in s]
        if not go.get("m_IsActive", True):
            node["extras"] = {"active": False}
        idx = len(self.glb.gltf["nodes"])
        self.glb.gltf["nodes"].append(node)
        self.node_of[(tobj.assets_file.name, tobj.path_id)] = idx
        children = []
        for c in tt["m_Children"]:
            cobj = self.resolve(tobj.assets_file, c)
            if cobj is not None:
                children.append(self.add_node(cobj))
        if children:
            node["children"] = children
        return idx

    def resolve(self, assets_file, pptr: dict):
        fid, pid = pptr["m_FileID"], pptr["m_PathID"]
        if pid == 0:
            return None
        if fid == 0:
            target = assets_file
        else:
            ext = assets_file.externals[fid - 1].path.split("/")[-1].lower()
            target = next((sf for sf in self.all_assets() if sf.name.lower() == ext), None)
            if target is None:
                return None
        return target.objects.get(pid)

    def all_assets(self):
        if not hasattr(self, "_assets"):
            self._assets = []
            for f in self.env.files.values():
                for sf in getattr(f, "files", {}).values():
                    if hasattr(sf, "objects"):
                        self._assets.append(sf)
        return self._assets

    # --- textures and materials -----------------------------------------------------------------
    def texture(self, assets_file, pptr: dict) -> int | None:
        obj = self.resolve(assets_file, pptr)
        if obj is None or obj.type.name != "Texture2D":
            return None
        key = (obj.assets_file.name, obj.path_id)
        if key in self.textures:
            return self.textures[key]
        tex = obj.read()
        img = tex.image
        name = tex.m_Name
        buf = io.BytesIO()
        if any(h in name.lower() for h in self.data_texture_hints):
            # exact: keep RGB under alpha 0 (control maps store data there; WebP drops it by default)
            img.save(buf, "WEBP", lossless=True, exact=True, method=4)
        else:
            img.save(buf, "WEBP", quality=92, method=4)
        g = self.glb.gltf
        g["images"].append({"name": name, "mimeType": "image/webp", "bufferView": self.glb.view(buf.getvalue())})
        ts = tex.m_TextureSettings
        wrap = {0: 10497, 1: 33071, 2: 33648, 3: 33071}  # Repeat, Clamp, Mirror, MirrorOnce
        skey = (int(ts.m_WrapU), int(ts.m_WrapV))
        if skey not in self.sampler_of:
            g["samplers"].append({"wrapS": wrap.get(skey[0], 10497), "wrapT": wrap.get(skey[1], 10497)})
            self.sampler_of[skey] = len(g["samplers"]) - 1
        g["textures"].append({"name": name, "sampler": self.sampler_of[skey],
                              "extensions": {"EXT_texture_webp": {"source": len(g["images"]) - 1}}})
        self.textures[key] = len(g["textures"]) - 1
        return self.textures[key]

    def material(self, assets_file, pptr: dict) -> int | None:
        obj = self.resolve(assets_file, pptr)
        if obj is None:
            return None
        key = (obj.assets_file.name, obj.path_id)
        if key in self.materials:
            return self.materials[key]
        tt = obj.read_typetree()
        shader_obj = self.resolve(obj.assets_file, tt["m_Shader"])
        shader = shader_obj.read_typetree()["m_ParsedForm"]["m_Name"] if shader_obj is not None else None
        props = tt["m_SavedProperties"]
        textures = {}
        for slot, env in props["m_TexEnvs"]:
            ti = self.texture(obj.assets_file, env["m_Texture"])
            if ti is not None:
                textures[slot] = {"index": ti, "scale": vec(env["m_Scale"], "xy"), "offset": vec(env["m_Offset"], "xy")}
        unity = {
            "shader": shader,
            "keywords": tt.get("m_ValidKeywords") or (tt.get("m_ShaderKeywords") or "").split(),
            "renderQueue": tt.get("m_CustomRenderQueue", -1),
            "floats": {k: float(v) for k, v in props["m_Floats"]},
            "colors": {k: [float(v["r"]), float(v["g"]), float(v["b"]), float(v["a"])] for k, v in props["m_Colors"]},
            "textures": textures,
        }
        mat = {"name": tt["m_Name"], "extras": {"unity": unity}}
        main = textures.get("_MainTex") or textures.get("_MainTexture")
        if main:
            mat["pbrMetallicRoughness"] = {"baseColorTexture": {"index": main["index"]}, "metallicFactor": 0, "roughnessFactor": 1}
        g = self.glb.gltf
        g["materials"].append(mat)
        self.materials[key] = len(g["materials"]) - 1
        return self.materials[key]

    # --- skinned meshes -------------------------------------------------------------------------
    def renderers(self):
        for obj in self.env.objects:
            if obj.type.name == "SkinnedMeshRenderer" and obj.assets_file.parent.name == self.costume_file:
                yield obj

    def add_renderer(self, robj) -> None:
        tt = robj.read_typetree()
        go_obj = robj.assets_file.objects[tt["m_GameObject"]["m_PathID"]]
        go = go_obj.read_typetree()
        tr_pptr = next(c["component"] for c in go["m_Component"] if self.resolve(robj.assets_file, c["component"]).type.name == "Transform")
        node_idx = self.node_of.get((robj.assets_file.name, tr_pptr["m_PathID"]))
        mesh_obj = self.resolve(robj.assets_file, tt["m_Mesh"])
        if node_idx is None or mesh_obj is None:
            print(f"  [skip] renderer on {go['m_Name']}: no node/mesh")
            return
        mesh = mesh_obj.read()
        h = MeshHandler(mesh)
        h.process()
        nv = h.m_VertexCount
        pos = np.array(h.m_Vertices, dtype=np.float64).reshape(nv, -1)[:, :3] * [-1, 1, 1]
        attrs = {"POSITION": self.glb.accessor(pos, "VEC3", minmax=True)}
        if h.m_Normals:
            nrm = np.array(h.m_Normals, dtype=np.float64).reshape(nv, -1)[:, :3] * [-1, 1, 1]
            attrs["NORMAL"] = self.glb.accessor(nrm, "VEC3")
        if h.m_Tangents:
            tan = np.array(h.m_Tangents, dtype=np.float64).reshape(nv, 4) * [-1, 1, 1, -1]
            attrs["TANGENT"] = self.glb.accessor(tan, "VEC4")
        for i, uv in enumerate((h.m_UV0, h.m_UV1)):
            if uv:
                a = np.array(uv, dtype=np.float64).reshape(nv, -1)[:, :2].copy()
                a[:, 1] = 1.0 - a[:, 1]   # Unity uv origin bottom-left -> glTF top-left
                attrs[f"TEXCOORD_{i}"] = self.glb.accessor(a, "VEC2")
        if h.m_Colors:
            col = np.array(h.m_Colors, dtype=np.float64).reshape(nv, -1)
            if col.max() > 1.0:
                col = col / 255.0
            attrs["COLOR_0"] = self.glb.accessor(col[:, :4] if col.shape[1] >= 4 else col, "VEC4" if col.shape[1] >= 4 else "VEC3")
        bones = [self.node_of.get(self._tkey(robj.assets_file, b)) for b in tt["m_Bones"]]
        skin_idx = None
        if bones and all(b is not None for b in bones):
            if h.m_BoneWeights:
                w = np.array(h.m_BoneWeights, dtype=np.float64).reshape(nv, -1)[:, :4]
                j = np.array(h.m_BoneIndices, dtype=np.int64).reshape(nv, -1)[:, :4]
                if w.shape[1] < 4:  # meshes skinned with 1-2 influences per vertex
                    w = np.pad(w, ((0, 0), (0, 4 - w.shape[1])))
                    j = np.pad(j, ((0, 0), (0, 4 - j.shape[1])))
                w = w / np.maximum(w.sum(axis=1, keepdims=True), 1e-9)
            elif h.m_BoneIndices:
                # One bone per vertex: Unity stores only a blend-index channel and no weights
                # (the Eye mesh: each iris follows its own <Chr>_LEye / _REye at weight 1).
                j = np.zeros((nv, 4), dtype=np.int64)
                j[:, 0] = np.array(h.m_BoneIndices, dtype=np.int64).reshape(nv, -1)[:, 0]
                w = np.tile([1.0, 0.0, 0.0, 0.0], (nv, 1))
            else:
                # No blend channels at all when a mesh is bound to a single bone (the face meshes
                # all hang off <Chr>_Head): every vertex follows bone 0.
                w = np.tile([1.0, 0.0, 0.0, 0.0], (nv, 1))
                j = np.zeros((nv, 4), dtype=np.int64)
            attrs["JOINTS_0"] = self.glb.accessor(j, "VEC4", ctype=5123)
            attrs["WEIGHTS_0"] = self.glb.accessor(w, "VEC4")
            ibm = np.array([MIRROR @ matrix(m) @ MIRROR for m in mesh.m_BindPose])
            # glTF stores matrices column-major
            ibm_cm = np.array([m.T.reshape(16) for m in ibm])
            g = self.glb.gltf
            g["skins"].append({"joints": bones, "inverseBindMatrices": self.glb.accessor(ibm_cm, "MAT4"),
                               "name": go["m_Name"]})
            skin_idx = len(g["skins"]) - 1
        elif tt["m_Bones"]:
            print(f"  [warn] {go['m_Name']}: bones outside the costume hierarchy, exported unskinned")
        # morph targets from blendshape channels (last frame of each channel = full weight)
        targets, names = [], []
        shapes = mesh.m_Shapes
        if shapes and shapes.channels:
            sv = shapes.vertices
            for ch in shapes.channels:
                shape = shapes.shapes[ch.frameIndex + ch.frameCount - 1]
                dp = np.zeros((nv, 3)); dn = np.zeros((nv, 3))
                for k in range(shape.firstVertex, shape.firstVertex + shape.vertexCount):
                    v = sv[k]
                    dp[v.index] = (-v.vertex.x, v.vertex.y, v.vertex.z)
                    dn[v.index] = (-v.normal.x, v.normal.y, v.normal.z)
                t = {"POSITION": self.glb.accessor(dp, "VEC3", minmax=True)}
                if "NORMAL" in attrs:
                    t["NORMAL"] = self.glb.accessor(dn, "VEC3")
                targets.append(t)
                names.append(ch.name)
        # one primitive per sub-mesh, with the renderer's material for that slot
        idx = np.array(h.m_IndexBuffer, dtype=np.int64)
        prims = []
        for si, sm in enumerate(mesh.m_SubMeshes):
            stride = 2 if h.m_Use16BitIndices else 4
            first = sm.firstByte // stride
            tri = idx[first:first + sm.indexCount].reshape(-1, 3)[:, [0, 2, 1]]  # reverse winding
            prim = {"attributes": attrs, "indices": self.glb.accessor(tri.reshape(-1), "SCALAR", ctype=5125)}
            if si < len(tt["m_Materials"]):
                mi = self.material(robj.assets_file, tt["m_Materials"][si])
                if mi is not None:
                    prim["material"] = mi
            if targets:
                prim["targets"] = targets
            prims.append(prim)
        g = self.glb.gltf
        gmesh = {"name": mesh.m_Name, "primitives": prims}
        if names:
            gmesh["extras"] = {"targetNames": names}
            gmesh["weights"] = [0.0] * len(names)
        g["meshes"].append(gmesh)
        node = g["nodes"][node_idx]
        node["mesh"] = len(g["meshes"]) - 1
        if skin_idx is not None:
            node["skin"] = skin_idx
        if not tt.get("m_Enabled", 1):
            node.setdefault("extras", {})["rendererEnabled"] = False
        # Unity draws a skinned mesh in its root bone's space: that is the shaders' "object space"
        root_bone = self.node_of.get(self._tkey(robj.assets_file, tt["m_RootBone"])) if tt["m_RootBone"]["m_PathID"] else None
        if root_bone is not None:
            node.setdefault("extras", {})["rootBone"] = g["nodes"][root_bone]["name"]

    def _tkey(self, assets_file, pptr):
        obj = self.resolve(assets_file, pptr)
        return (obj.assets_file.name, obj.path_id) if obj is not None else None

    # --- runtime components ---------------------------------------------------------------------
    def face_bones_copier(self) -> None:
        """Inspix.FaceBonesCopier on the face rig (`3d_face_<id>`, a sibling of the body, not its
        child). Its LateUpdate (RVA 0x4F4A440) copies the body's bones onto the face rig every
        frame: spine03 gets UpperChest's world position and rotation; neck, head and the eyes get
        the local rotations of Neck, Head, LeftEye, RightEye. Start (RVA 0x4F4A300) finds those
        through Animator.GetBoneTransform, i.e. the body Avatar's human bone mapping. Recorded as
        node extras `faceBonesCopier`: {field: [face bone, body bone]}."""
        body_avatar = None
        copiers = []
        for obj in self.env.objects:
            if obj.assets_file.parent.name != self.costume_file:
                continue
            if obj.type.name == "MonoBehaviour":
                tt = obj.read_typetree()
                script = self.resolve(obj.assets_file, tt["m_Script"])
                if script is not None and script.read_typetree()["m_ClassName"] == "FaceBonesCopier":
                    copiers.append((obj, tt))
            elif obj.type.name == "Animator":
                tt = obj.read_typetree()
                av = self.resolve(obj.assets_file, tt["m_Avatar"])
                # the body's Animator (the face rig has its own, with the face Avatar)
                if av is not None and "_Face" not in av.read_typetree()["m_Name"]:
                    body_avatar = UA.Avatar(av.read_typetree())
        if not copiers or body_avatar is None:
            return
        body_bone = lambda b: body_avatar.node_names[body_avatar.h_to_node[body_avatar.bone_node(b)]]
        fields = {"spine03": "UpperChest", "neck": "Neck", "head": "Head", "leftEye": "LeftEye", "rightEye": "RightEye"}
        nodes = self.glb.gltf["nodes"]
        for obj, tt in copiers:
            pairs = {}
            for field, bone in fields.items():
                face = self.node_of.get(self._tkey(obj.assets_file, tt[field]))
                if face is not None:
                    pairs[field] = [nodes[face]["name"], body_bone(bone)]
            go_tr = next(c["component"] for c in obj.assets_file.objects[tt["m_GameObject"]["m_PathID"]].read_typetree()["m_Component"]
                         if self.resolve(obj.assets_file, c["component"]).type.name == "Transform")
            host = self.node_of.get((obj.assets_file.name, go_tr["m_PathID"]))
            if host is not None:
                nodes[host].setdefault("extras", {})["faceBonesCopier"] = pairs

    def run(self) -> None:
        roots = self.roots()
        self.glb.gltf["scenes"][0]["nodes"] = [self.add_node(r) for r in roots]
        for r in self.renderers():
            self.add_renderer(r)
        self.face_bones_copier()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("costumes", nargs="+")
    ap.add_argument("--index", default=str(DEFAULT_INDEX))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()
    index = UA.BundleIndex(args.index)
    for cid in args.costumes:
        env, costume_file = index.load_closure(cid)
        glb = Glb()
        ex = CostumeExporter(env, costume_file, glb)
        ex.run()
        out = Path(args.out) / cid / f"{cid}.glb"
        out.parent.mkdir(parents=True, exist_ok=True)
        glb.write(out)
        g = glb.gltf
        print(f"{cid}: {len(g['nodes'])} nodes, {len(g.get('meshes', []))} meshes, {len(g.get('materials', []))} materials, "
              f"{len(g.get('textures', []))} textures -> {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
