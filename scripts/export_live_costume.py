#!/usr/bin/env python3
"""Export Link! Like! Love Live! costume prefabs (3d_costume_<id>) from the raw iOS dump to skinned GLBs.

For each costume it loads the prefab bundle plus its whole dependency closure into one UnityPy
environment (so cross-bundle PPtrs resolve) and writes, under <out>/<id>/:

  <id>.glb             the prefab's full Transform hierarchy (node names = GameObject names), one
                       skinned mesh per SkinnedMeshRenderer (one primitive per submesh), blendshapes
                       as morph targets (`Face_.Mouth_Smile`, ...), toon materials with embedded PNGs
  <id>_materials.json  UberToon values in the format scripts/export_toon_materials.py writes

Conversion (Unity left-handed -> glTF right-handed, the project convention): positions, normals and
morph deltas (-x, y, z); rotations (x, -y, -z, w); scale unchanged; triangle winding flipped; UV
v' = 1 - v; bind poses M' = S M S with S = diag(-1, 1, 1), stored column-major.

Face rig: in the prefab the face (`3d_face_<id>`: `<Chr>_Spine_03/Neck/Head`, eye bones, Face/Brow/Eye
meshes) is a sibling of the body, and the game's FaceBonesCopier copies the body's spine03/neck/head/
eye transforms onto it every frame. glTF can't express that, so `3d_face_<id>` is re-parented under
the body's humanoid Head bone with a compensating transform: the rest pose is unchanged and the face
follows the head rigidly. Don't animate the face rig's own Spine_03/Neck/Head nodes (that would apply
the head motion twice); animate the body bones. The body Avatar's humanoid bone -> node name map is
stored in scenes[0].extras.humanoidBones.

Materials: baseColorTexture = main texture (_MainTex / _MainTexture), occlusionTexture = the toon
1st-shadow texture (_1stShadowTex, project convention), doubleSided from _CullMode/_Cull == 0, alphaMode
BLEND for alpha-blended materials (SrcAlpha/OneMinusSrcAlpha, _SurfaceMode 1, eye highlight/lens shaders).
Unity shader name, render queue and texture slots go to material extras.

Usage (main checkout's uv environment; pygltflib is pulled in with --with):
  uv run --project <main checkout> --with pygltflib python -I scripts/export_live_costume.py \
      [costume ids ...] [--out public/assets/live/costume] [--all-textures] [--no-morphs] \
      [--check] [--render /tmp/live-costume-check]

With no ids it exports the 11 costumes of the Fes×LIVE choreography study. --check compares
vertex/triangle counts per mesh against the Unity Mesh objects and the GLB's bind matrices against the
rest pose; --render draws the rest pose with render_motion_preview.render() to <dir>/<id>.png.
The dump is untrusted input: always run with `python -I`.
"""
from __future__ import annotations

import argparse
import io
import json
import struct
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
WORKTREE = HERE.parent


def _find_main() -> Path:
    """The checkout that holds scripts/unity_assets.py and the bundle index (main checkout)."""
    for p in [WORKTREE, *WORKTREE.parents]:
        if (p / "scripts" / "unity_assets.py").exists() and (p / ".inspect-tmp" / "ios_index.jsonl").exists():
            return p
    raise SystemExit("can't find the main checkout (scripts/unity_assets.py + .inspect-tmp/ios_index.jsonl)")


MAIN = _find_main()
sys.path.insert(0, str(MAIN / "scripts"))
import unity_assets as UA  # noqa: E402
import UnityPy  # noqa: E402
from UnityPy.helpers.MeshHelper import MeshHandler  # noqa: E402
from export_toon_materials import COLORS, FLOATS, UBER  # noqa: E402
import pygltflib as G  # noqa: E402

LIVE_COSTUMES = [
    "3d_costume_3033102111", "3d_costume_3033102210", "3d_costume_3033102310",
    "3d_costume_3033103110", "3d_costume_3033103211", "3d_costume_3033103310",
    "3d_costume_3033104104", "3d_costume_3033104203", "3d_costume_3033104303",
    "3d_costume_3033105103", "3d_costume_3033105204",
]
MAIN_TEX_SLOTS = ("_MainTex", "_MainTexture", "_BaseMap")
SHADOW1_SLOT, SHADOW2_SLOT = "_1stShadowTex", "_2ndShadowTex"
BLEND_SHADERS = ("Highlight", "Distortion")  # Character/ToonShader_CharacterHighlight, Character/Highlight_Distortion
S = np.diag([-1.0, 1.0, 1.0, 1.0])

FLOAT, UBYTE, USHORT, UINT = 5126, 5121, 5123, 5125


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def load_closure(index: UA.BundleIndex, container: str):
    """Prefab bundle + every bundle reachable through deps, in one Environment. -> (env, prefab objects)."""
    rec = index.by_container.get(container)
    if rec is None:
        raise KeyError(f"{container} not in {index.path}")
    seen, stack, missing = {}, [rec], set()
    while stack:
        r = stack.pop()
        if r["file"] in seen:
            continue
        seen[r["file"]] = r
        for d in r.get("deps", []):
            dr = index.by_cab.get(d.split(".")[0])
            if dr is None:
                missing.add(d)
            elif dr["file"] not in seen:
                stack.append(dr)
    env = UnityPy.Environment()
    for f in seen:
        p = (index.base / f).resolve()
        data = p.read_bytes()
        if data[2:9] == b"UnityFS":  # iOS bundles carry a 2-byte AB 00 prefix
            data = data[2:]
        env.load_file(data, name=p.name)
    cabs = {c.split(".")[0] for c in rec["cabs"]}
    prefab = [o for o in env.objects if o.assets_file.name.split(".")[0] in cabs]
    missing.discard("unity default resources")
    return env, prefab, len(seen), sorted(missing)


def ref_key(obj) -> tuple:
    return (obj.assets_file.name, obj.path_id)


def try_deref(pptr):
    try:
        if pptr is None or not pptr.m_PathID:
            return None
        return pptr.deref()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Math
# ---------------------------------------------------------------------------
def quat_to_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def trs_mat(t, r, s):
    m = np.eye(4)
    m[:3, :3] = quat_to_mat(r) * s
    m[:3, 3] = t
    return m


def decompose(m):
    t = m[:3, 3].copy()
    s = np.linalg.norm(m[:3, :3], axis=0)
    r = UA.mat_to_quat(m[:3, :3] / s)
    return t, r, s


def unity_matrix(m4) -> np.ndarray:
    return np.array([[getattr(m4, f"e{r}{c}") for c in range(4)] for r in range(4)], dtype=np.float64)


# ---------------------------------------------------------------------------
# glTF assembly (pygltflib)
# ---------------------------------------------------------------------------
class Gltf:
    def __init__(self):
        self.g = G.GLTF2(asset=G.Asset(version="2.0", generator="hasu-web-reader export_live_costume.py (UnityPy)"))
        self.blob = bytearray()

    def view(self, data: bytes, target: int | None = None) -> int:
        while len(self.blob) % 4:
            self.blob.append(0)
        self.g.bufferViews.append(G.BufferView(buffer=0, byteOffset=len(self.blob), byteLength=len(data), target=target))
        self.blob += data
        return len(self.g.bufferViews) - 1

    def accessor(self, arr: np.ndarray, ctype: int, kind: str, target: int | None = None, minmax=False,
                 normalized=None) -> int:
        dt = {FLOAT: np.float32, UBYTE: np.uint8, USHORT: np.uint16, UINT: np.uint32}[ctype]
        arr = np.ascontiguousarray(arr, dtype=dt)
        acc = G.Accessor(bufferView=self.view(arr.tobytes(), target), componentType=ctype, count=int(arr.shape[0]),
                         type=kind, normalized=normalized)
        if minmax:
            flat = arr.reshape(arr.shape[0], -1)
            acc.min = [float(x) for x in flat.min(axis=0)]
            acc.max = [float(x) for x in flat.max(axis=0)]
        self.g.accessors.append(acc)
        return len(self.g.accessors) - 1

    def sparse_vec3(self, count: int, idx: np.ndarray, vals: np.ndarray) -> int:
        """VEC3 float accessor of `count` zeros with `vals` at `idx` (morph target deltas)."""
        acc = G.Accessor(componentType=FLOAT, count=count, type="VEC3")
        if len(idx):
            order = np.argsort(idx)
            idx, vals = idx[order].astype(np.uint32), vals[order].astype(np.float32)
            acc.sparse = G.Sparse(count=int(len(idx)),
                                  indices=G.AccessorSparseIndices(bufferView=self.view(idx.tobytes()), componentType=UINT),
                                  values=G.AccessorSparseValues(bufferView=self.view(vals.tobytes())))
            lo, hi = np.minimum(vals.min(axis=0), 0), np.maximum(vals.max(axis=0), 0)
        else:
            lo = hi = np.zeros(3)
        acc.min, acc.max = [float(x) for x in lo], [float(x) for x in hi]
        self.g.accessors.append(acc)
        return len(self.g.accessors) - 1

    def save(self, path: Path):
        while len(self.blob) % 4:
            self.blob.append(0)
        self.g.buffers = [G.Buffer(byteLength=len(self.blob))]
        self.g.set_binary_blob(bytes(self.blob))
        self.g.save_binary(str(path))


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
class CostumeExporter:
    def __init__(self, cid: str, env, prefab, all_textures: bool, morphs: bool):
        self.cid, self.env, self.prefab = cid, env, prefab
        self.all_textures, self.morphs = all_textures, morphs
        self.out = Gltf()
        self.node_of: dict[int, int] = {}  # Transform path_id -> node index
        self.images: dict[tuple, int] = {}  # Texture2D key -> glTF texture index
        self.materials: dict[tuple, int] = {}
        self.toon: dict[str, dict] = {}
        self.mesh_report: list[dict] = []
        self.notes: list[str] = []

    # -- hierarchy ---------------------------------------------------------
    def build_nodes(self):
        trs = {o.path_id: o for o in self.prefab if o.type.name == "Transform"}
        roots = [o for o in trs.values() if not o.read().m_Father.m_PathID]
        if len(roots) != 1:
            raise RuntimeError(f"{self.cid}: expected one root Transform, found {len(roots)}")
        nodes, parent, rest, go_names = [], [], [], []

        def visit(o, p):
            t = o.read()
            go = t.m_GameObject.read()
            i = len(nodes)
            self.node_of[o.path_id] = i
            lp, lr, ls = t.m_LocalPosition, t.m_LocalRotation, t.m_LocalScale
            tt = UA.unity_to_gltf_t(np.array([lp.x, lp.y, lp.z], float))
            rr = UA.unity_to_gltf_q(np.array([lr.x, lr.y, lr.z, lr.w], float))
            rr /= np.linalg.norm(rr)
            ss = np.array([ls.x, ls.y, ls.z], float)
            nodes.append(G.Node(name=go.m_Name))
            parent.append(p)
            rest.append([tt, rr, ss])
            go_names.append(go.m_Name)
            for c in t.m_Children:
                co = trs.get(c.m_PathID)
                if co is None:
                    self.notes.append(f"child Transform {c.m_PathID} of {go.m_Name} not in prefab")
                    continue
                visit(co, i)

        visit(roots[0], -1)
        self.nodes, self.parent, self.rest, self.names = nodes, parent, rest, go_names
        if len(nodes) != len(trs):
            self.notes.append(f"{len(trs) - len(nodes)} Transforms not reachable from the root")

    def world(self) -> list[np.ndarray]:
        W = []
        for i, (t, r, s) in enumerate(self.rest):
            m = trs_mat(t, r, s)
            W.append(m if self.parent[i] < 0 else W[self.parent[i]] @ m)
        return W

    def humanoid(self) -> dict[str, str]:
        """Humanoid bone -> node name, from the body Animator's Avatar (Animator closest to the root)."""
        best = None  # the body Animator (the face rig has its own Animator/Avatar)
        for o in self.prefab:
            if o.type.name != "Animator":
                continue
            a = o.read()
            av = try_deref(a.m_Avatar)
            if av is None:
                continue
            name = a.m_GameObject.read().m_Name
            if best is None or ("face" not in name.lower() and "face" in best[0].lower()):
                best = (name, av)
        if best is None:
            self.notes.append("no Animator with an Avatar; humanoidBones empty")
            return {}
        avatar = UA.Avatar(best[1].read_typetree())
        # bone/hand indices point into the human skeleton; m_HumanSkeletonIndexArray maps those to
        # the avatar skeleton, whose m_TOS paths give the transform names
        name = lambda h: avatar.node_names[avatar.h_to_node[h]]  # noqa: E731
        out = {}
        for b, n in enumerate(avatar.bone_index):
            if n >= 0:
                out[UA.BONES[b]] = name(n)
        fingers = ["Thumb", "Index", "Middle", "Ring", "Little"]
        phal = ["Proximal", "Intermediate", "Distal"]
        for side, arr in (("Left", avatar.left_hand), ("Right", avatar.right_hand)):
            for k, n in enumerate(arr):
                if n >= 0:
                    out[f"{side}{fingers[k // 3]}{phal[k % 3]}"] = name(n)
        missing = sorted(v for v in out.values() if v not in set(self.names))
        if missing:
            self.notes.append(f"humanoid bones not in the prefab: {missing}")
        return out

    def attach_face(self, head_name: str | None):
        """Re-parent 3d_face_<id> under the body head, keeping its rest world transform."""
        root_children = [i for i, p in enumerate(self.parent) if p == 0]
        face = next((i for i in root_children if self.names[i].startswith("3d_face")), None)
        if face is None:
            self.notes.append("no 3d_face_* node under the root; face left as is")
            return None
        head = None
        if head_name:
            cands = [i for i, n in enumerate(self.names) if n == head_name and not self._under(i, face)]
            head = cands[0] if cands else None
        if head is None:
            cands = [i for i, n in enumerate(self.names) if n.endswith("_Head") and not self._under(i, face)]
            head = cands[0] if cands else None
        if head is None:
            self.notes.append("body head bone not found; face left as is")
            return None
        W = self.world()
        t, r, s = decompose(np.linalg.inv(W[head]) @ W[face])
        self.rest[face] = [t, r / np.linalg.norm(r), s]
        self.parent[face] = head
        return face, head

    def _under(self, i, anc):
        while i >= 0:
            if i == anc:
                return True
            i = self.parent[i]
        return False

    # -- textures / materials ---------------------------------------------
    def texture(self, tex_reader) -> int | None:
        key = ref_key(tex_reader)
        if key in self.images:
            return self.images[key]
        tex = tex_reader.read()
        try:
            img = tex.image
        except Exception as ex:  # noqa: BLE001
            self.notes.append(f"texture {tex.m_Name}: decode failed ({ex})")
            self.images[key] = None
            return None
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        g = self.out.g
        g.images.append(G.Image(name=tex.m_Name, mimeType="image/png", bufferView=self.out.view(buf.getvalue())))
        g.textures.append(G.Texture(name=tex.m_Name, source=len(g.images) - 1, sampler=0))
        self.images[key] = len(g.textures) - 1
        return self.images[key]

    def material(self, mat_reader) -> int:
        key = ref_key(mat_reader)
        if key in self.materials:
            return self.materials[key]
        m = mat_reader.read()
        tt = mat_reader.read_typetree()
        props = tt.get("m_SavedProperties", {})
        floats = dict(props.get("m_Floats", []))
        colors = dict(props.get("m_Colors", []))
        shader = ""
        sh = try_deref(m.m_Shader)
        if sh is not None:
            try:
                shader = sh.read().m_ParsedForm.m_Name
            except Exception:  # noqa: BLE001
                shader = getattr(sh.read(), "m_Name", "") or ""
        slots: dict[str, object] = {}
        for name, env in m.m_SavedProperties.m_TexEnvs:
            tr = try_deref(env.m_Texture)
            if tr is not None and tr.type.name == "Texture2D":
                slots[name] = tr
        tex_names = {k: v.read().m_Name for k, v in slots.items()}
        main_slot = next((s for s in MAIN_TEX_SLOTS if s in slots), None)
        embed = set(slots) if self.all_textures else {main_slot, SHADOW1_SLOT, SHADOW2_SLOT}
        tex_idx = {k: self.texture(v) for k, v in slots.items() if k in embed}

        cull = floats.get("_CullMode", floats.get("_Cull", 2.0))
        blend = (floats.get("_SurfaceMode", 0) == 1 or floats.get("_Surface", 0) == 1
                 or (floats.get("_BlendRGBSrc") == 5 and floats.get("_BlendRGBDst") == 10)
                 or (floats.get("_SrcBlend") == 5 and floats.get("_DstBlend") == 10)
                 or any(w in shader for w in BLEND_SHADERS))
        clip = floats.get("_AlphaClip", 0) == 1
        gm = G.Material(name=m.m_Name, doubleSided=bool(cull == 0),
                        pbrMetallicRoughness=G.PbrMetallicRoughness(baseColorFactor=[1, 1, 1, 1], metallicFactor=0.0,
                                                                    roughnessFactor=1.0))
        if main_slot and tex_idx.get(main_slot) is not None:
            gm.pbrMetallicRoughness.baseColorTexture = G.TextureInfo(index=tex_idx[main_slot])
        if tex_idx.get(SHADOW1_SLOT) is not None:
            gm.occlusionTexture = G.OcclusionTextureInfo(index=tex_idx[SHADOW1_SLOT])
        if blend:
            gm.alphaMode = "BLEND"
        elif clip:
            gm.alphaMode = "MASK"
            gm.alphaCutoff = float(floats.get("_AlphaClipThreshold", 0.5))
        gm.extras = {"unityShader": shader, "renderQueue": tt.get("m_CustomRenderQueue"),
                     "cullMode": cull, "textures": tex_names}
        self.out.g.materials.append(gm)
        self.materials[key] = len(self.out.g.materials) - 1

        if shader == UBER:  # same entry format as export_toon_materials.py
            uniforms = {u: floats[k] for k, u in FLOATS.items() if k in floats}
            uniforms.update({u: [round(colors[k][c], 4) for c in ("r", "g", "b")] for k, u in COLORS.items() if k in colors})
            self.toon[m.m_Name] = {
                "uniforms": uniforms,
                "mainTex": tex_names.get("_MainTex"),
                "shadow1Tex": tex_names.get(SHADOW1_SLOT),
                "shadow2Tex": tex_names.get(SHADOW2_SLOT),
                "gameTextures": {k: v for k, v in tex_names.items() if v},
            }
        return self.materials[key]

    # -- meshes ------------------------------------------------------------
    def skinned_mesh(self, smr_obj):
        r = smr_obj.read()
        go = r.m_GameObject.read()
        node = self.node_of.get(go.m_Transform.m_PathID)
        mesh_r = try_deref(r.m_Mesh)
        if node is None or mesh_r is None:
            self.notes.append(f"SMR {go.m_Name}: no node or mesh, skipped")
            return
        mesh = mesh_r.read()
        h = MeshHandler(mesh)
        h.process()
        V = h.m_VertexCount
        pos = np.asarray(h.m_Vertices, np.float64).reshape(V, 3) * [-1, 1, 1]
        attrs = {"POSITION": self.out.accessor(pos, FLOAT, "VEC3", 34962, minmax=True)}
        if h.m_Normals:
            nrm = np.asarray(h.m_Normals, np.float64).reshape(V, 3) * [-1, 1, 1]
            nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-12
            attrs["NORMAL"] = self.out.accessor(nrm, FLOAT, "VEC3", 34962)
        for k, uv in enumerate((h.m_UV0, h.m_UV1)):
            if uv:
                uv = np.asarray(uv, np.float64).reshape(V, -1)[:, :2].copy()
                uv[:, 1] = 1.0 - uv[:, 1]
                attrs[f"TEXCOORD_{k}"] = self.out.accessor(uv, FLOAT, "VEC2", 34962)
        if h.m_Colors:
            col = np.clip(np.asarray(h.m_Colors, np.float64).reshape(V, 4), 0, 1)
            attrs["COLOR_0"] = self.out.accessor(col, FLOAT, "VEC4", 34962)

        # Skin: m_Bones -> nodes; Unity omits weights for single-influence meshes (weight 1).
        bones = [self.node_of.get(b.m_PathID) if b.m_PathID else None for b in r.m_Bones]
        root_bone = self.node_of.get(r.m_RootBone.m_PathID) if r.m_RootBone.m_PathID else None
        fallback = root_bone if root_bone is not None else node
        joints_nodes = [b if b is not None else fallback for b in bones]
        if not joints_nodes:
            self.notes.append(f"SMR {go.m_Name}: no bones, skipped")
            return
        bi = np.zeros((V, 4), np.int64)
        bw = np.zeros((V, 4), np.float64)
        if h.m_BoneIndices is not None:
            ai = np.asarray(h.m_BoneIndices, np.int64).reshape(V, -1)[:, :4]
            bi[:, :ai.shape[1]] = ai
            if h.m_BoneWeights is not None:
                aw = np.asarray(h.m_BoneWeights, np.float64).reshape(V, -1)[:, :4]
                bw[:, :aw.shape[1]] = aw
            else:
                bw[:, 0] = 1.0
        else:
            bw[:, 0] = 1.0
        bw[bi >= len(joints_nodes)] = 0.0
        bi[bi >= len(joints_nodes)] = 0
        bi[bw <= 0] = 0
        bw[bw < 0] = 0
        tot = bw.sum(axis=1, keepdims=True)
        empty = tot[:, 0] <= 0
        bw[empty] = [1, 0, 0, 0]
        bw /= bw.sum(axis=1, keepdims=True)
        attrs["JOINTS_0"] = self.out.accessor(bi, UBYTE if len(joints_nodes) <= 256 else USHORT, "VEC4", 34962)
        attrs["WEIGHTS_0"] = self.out.accessor(bw, FLOAT, "VEC4", 34962)

        bind = [unity_matrix(m4) for m4 in mesh.m_BindPose]
        if len(bind) != len(joints_nodes):
            self.notes.append(f"{go.m_Name}: {len(bind)} bind poses for {len(joints_nodes)} bones")
            bind = (bind + [np.eye(4)] * len(joints_nodes))[:len(joints_nodes)]
        ibm = np.stack([S @ m @ S for m in bind])
        ibm_acc = self.out.accessor(ibm.transpose(0, 2, 1).reshape(-1, 16), FLOAT, "MAT4")
        g = self.out.g
        # (no `skeleton`: Unity's root bone isn't always a common ancestor of the joints)
        g.skins.append(G.Skin(name=go.m_Name, joints=joints_nodes, inverseBindMatrices=ibm_acc))
        skin = len(g.skins) - 1

        # Morph targets
        targets, target_names = [], []
        shapes = mesh.m_Shapes
        if self.morphs and shapes is not None and shapes.channels:
            sv = shapes.vertices
            s_idx = np.array([v.index for v in sv], np.int64)
            s_pos = np.array([[v.vertex.x, v.vertex.y, v.vertex.z] for v in sv], np.float64) * [-1, 1, 1]
            s_nrm = np.array([[v.normal.x, v.normal.y, v.normal.z] for v in sv], np.float64) * [-1, 1, 1]
            for ch in shapes.channels:
                fi = ch.frameIndex + ch.frameCount - 1  # last (full-weight) frame
                sh = shapes.shapes[fi]
                sl = slice(sh.firstVertex, sh.firstVertex + sh.vertexCount)
                t = {"POSITION": self.out.sparse_vec3(V, s_idx[sl], s_pos[sl])}
                if sh.hasNormals:
                    t["NORMAL"] = self.out.sparse_vec3(V, s_idx[sl], s_nrm[sl])
                targets.append(t)
                target_names.append(ch.name)
                if ch.frameCount > 1:
                    self.notes.append(f"{go.m_Name}.{ch.name}: {ch.frameCount} frames, only the last exported")

        # Primitives, one per submesh (winding flipped by the handedness flip)
        tris = h.get_triangles()
        prims, tri_total = [], 0
        mats = list(r.m_Materials)
        for k, (sm, tri) in enumerate(zip(mesh.m_SubMeshes, tris)):
            tri = np.asarray(tri, np.int64).reshape(-1, 3) + int(getattr(sm, "baseVertex", 0) or 0)
            tri_total += len(tri)
            if len(tri) == 0:
                continue
            tri = tri[:, [0, 2, 1]]
            idx_acc = self.out.accessor(tri.reshape(-1, 1), USHORT if V <= 65535 else UINT, "SCALAR", 34963)
            p = G.Primitive(attributes=G.Attributes(**attrs), indices=idx_acc, mode=4)
            mr = try_deref(mats[k]) if k < len(mats) else None
            if mr is not None:
                p.material = self.material(mr)
            if targets:
                p.targets = [G.Attributes(**t) for t in targets]
            prims.append(p)
        if len(mats) > len(mesh.m_SubMeshes):
            self.notes.append(f"{go.m_Name}: {len(mats)} materials for {len(mesh.m_SubMeshes)} submeshes (extra ignored)")
        gmesh = G.Mesh(name=mesh.m_Name, primitives=prims)
        if targets:
            gmesh.weights = [0.0] * len(targets)
            gmesh.extras = {"targetNames": target_names}
        g.meshes.append(gmesh)
        self.nodes[node].mesh = len(g.meshes) - 1
        self.nodes[node].skin = skin
        self.mesh_report.append({
            "node": go.m_Name, "mesh": mesh.m_Name, "unity_vertices": int(mesh.m_VertexData.m_VertexCount),
            "unity_triangles": int(sum(s.indexCount for s in mesh.m_SubMeshes) // 3), "vertices": int(V),
            "triangles": int(tri_total), "submeshes": len(mesh.m_SubMeshes), "bones": len(joints_nodes),
            "morphs": len(targets), "enabled": bool(r.m_Enabled),
            "materials": [self.out.g.materials[p.material].name for p in prims if p.material is not None],
        })

    # -- main --------------------------------------------------------------
    def run(self, out_dir: Path) -> tuple[Path, Path]:
        self.build_nodes()
        hum = self.humanoid()
        attached = self.attach_face(hum.get("Head"))
        g = self.out.g
        g.samplers = [G.Sampler(magFilter=9729, minFilter=9987, wrapS=10497, wrapT=10497)]
        smrs = [o for o in self.prefab if o.type.name == "SkinnedMeshRenderer"]
        smrs.sort(key=lambda o: self.node_of.get(o.read().m_GameObject.read().m_Transform.m_PathID, 1 << 30))
        for o in smrs:
            self.skinned_mesh(o)
        for i, (t, r, s) in enumerate(self.rest):
            n = self.nodes[i]
            if np.any(np.abs(t) > 1e-9):
                n.translation = [float(x) for x in t]
            if np.any(np.abs(r - [0, 0, 0, 1]) > 1e-9):
                n.rotation = [float(x) for x in r]
            if np.any(np.abs(s - 1) > 1e-9):
                n.scale = [float(x) for x in s]
        for i, p in enumerate(self.parent):
            if p >= 0:
                self.nodes[p].children.append(i)
        g.nodes = self.nodes
        extras = {"costume": self.cid, "humanoidBones": hum}
        if attached:
            extras["faceAttachedTo"] = self.names[attached[1]]
        g.scenes = [G.Scene(name=self.cid, nodes=[0], extras=extras)]
        g.scene = 0
        out_dir.mkdir(parents=True, exist_ok=True)
        glb = out_dir / f"{self.cid}.glb"
        self.out.save(glb)
        mats_json = out_dir / f"{self.cid}_materials.json"
        mats_json.write_text(json.dumps({"source": "Unity material export (UnityPy, export_live_costume.py)",
                                         "shader": UBER, "materials": self.toon}, indent=2))
        return glb, mats_json


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def glb_json(path: Path) -> dict:
    d = path.read_bytes()
    return json.loads(d[20:20 + struct.unpack("<I", d[12:16])[0]])


def check(glb: Path, report: list[dict]) -> list[str]:
    """Counts in the written GLB vs. the Unity Mesh objects, and bind matrices vs. the rest pose."""
    problems = []
    j = glb_json(glb)
    by_name = {m["name"]: m for m in j["meshes"]}
    for r in report:
        m = by_name.get(r["mesh"])
        if m is None:
            problems.append(f"{r['mesh']}: missing from GLB")
            continue
        v = j["accessors"][m["primitives"][0]["attributes"]["POSITION"]]["count"]
        t = sum(j["accessors"][p["indices"]]["count"] for p in m["primitives"]) // 3
        ok = v == r["unity_vertices"] and t == r["unity_triangles"]
        r["glb_vertices"], r["glb_triangles"], r["count_ok"] = v, t, ok
        if not ok:
            problems.append(f"{r['mesh']}: GLB {v} v / {t} tris vs Unity {r['unity_vertices']} / {r['unity_triangles']}")
    # bind pose vs rest pose: joint world @ IBM should be ~ the same matrix for every joint of a skin
    import render_motion_preview as RMP  # local import: needs Pillow, only used for checks
    c = RMP.Costume(glb)
    Gw = c.pose({})
    g = RMP.Glb(glb)
    for skin in j["skins"]:
        ibm = g.acc(skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
        mats = np.stack([Gw[jn] @ ibm[k] for k, jn in enumerate(skin["joints"])])
        dev = float(np.abs(mats - mats[0]).max()) if len(mats) else 0.0
        if dev > 1e-3:
            problems.append(f"skin {skin['name']}: bind pose differs from rest pose by up to {dev:.4f}")
    return problems


def render_rest(glb: Path, dest: Path):
    import render_motion_preview as RMP
    c = RMP.Costume(glb)
    img = RMP.render(c.skin(c.pose({})))
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest)
    return dest


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("costumes", nargs="*", default=LIVE_COSTUMES)
    ap.add_argument("--index", default=str(MAIN / ".inspect-tmp" / "ios_index.jsonl"))
    ap.add_argument("--out", default=str(WORKTREE / "public" / "assets" / "live" / "costume"))
    ap.add_argument("--all-textures", action="store_true",
                    help="embed every material texture (control maps, matcaps, ...) instead of main + shadow")
    ap.add_argument("--no-morphs", action="store_true", help="skip blendshapes")
    ap.add_argument("--check", action="store_true", help="verify counts and bind poses after writing")
    ap.add_argument("--render", metavar="DIR", help="render the rest pose of each costume to DIR/<id>.png")
    args = ap.parse_args()

    index = UA.BundleIndex(args.index)
    failed = 0
    for cid in args.costumes:
        env, prefab, nbundles, missing = load_closure(index, cid)
        ex = CostumeExporter(cid, env, prefab, args.all_textures, not args.no_morphs)
        glb, mats = ex.run(Path(args.out) / cid)
        size = glb.stat().st_size / 1e6
        print(f"{cid}: {nbundles} bundles, {len(ex.nodes)} nodes, {len(ex.mesh_report)} meshes, "
              f"{len(ex.out.g.materials)} materials, {len(ex.out.g.images)} images -> {glb} ({size:.1f} MB), "
              f"{mats.name} ({len(ex.toon)} toon)")
        if missing:
            print(f"  missing dependency bundles: {missing}")
        for n in ex.notes:
            print(f"  note: {n}")
        if args.check:
            problems = check(glb, ex.mesh_report)
            for r in ex.mesh_report:
                print(f"  {r['node']:<16} {r['vertices']:>6} v {r['triangles']:>6} tris  {r['submeshes']} sub  "
                      f"{r['bones']:>3} bones {r['morphs']:>3} morphs  {'ok' if r.get('count_ok') else 'MISMATCH'}"
                      f"{'' if r['enabled'] else '  (renderer disabled)'}  {', '.join(r['materials'])}")
            for p in problems:
                print(f"  CHECK: {p}")
            failed += bool([p for p in problems if "bind pose" not in p])
        if args.render:
            print(f"  rendered {render_rest(glb, Path(args.render) / f'{cid}.png')}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
