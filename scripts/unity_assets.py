"""Helpers for reading the game's raw Unity data (data-inspect/) without Unity.

- BundleIndex / load_env: open the prefixed UnityFS bundles from the iOS dump by asset name
- decode_clip: decode a Mecanim AnimationClip (streamed + dense + constant curves)
- Avatar / HumanoidBaker: Unity's humanoid math (muscles -> bone rotations, body -> hips)
- GlbBuilder / write_motion_glb: minimal glTF 2.0 binary writer for the baked clips

Everything here was verified against the raw data itself: baked poses put the hands near the
IK-goal curves stored in the same clips (export_motions.py --check). Over episode 1's 580 main
clips the median error is 0.3 cm, with a worst case of 2.8 cm.
See docs/unity-crash-course.md for the background.
"""

from __future__ import annotations

import json
import os
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import UnityPy

# ---------------------------------------------------------------------------
# Bundles
# ---------------------------------------------------------------------------


class BundleIndex:
    """data-inspect bundle index (scripts/build_bundle_index.py output, one JSON object per line)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.base = self.path.parent
        self.by_container: dict[str, dict] = {}
        self.by_cab: dict[str, dict] = {}
        with open(self.path) as fh:
            for line in fh:
                rec = json.loads(line)
                for c in rec.get("containers", []):
                    self.by_container[c] = rec
                for cab in rec.get("cabs", []):
                    self.by_cab[cab.split(".")[0]] = rec

    def bundle_path(self, container: str) -> Path | None:
        rec = self.by_container.get(container)
        if rec is None:
            return None
        return (self.base / rec["file"]).resolve()

    def load_env(self, container: str) -> UnityPy.Environment:
        """Load the bundle that holds `container` (game bundles carry a 2-byte prefix before 'UnityFS')."""
        path = self.bundle_path(container)
        if path is None:
            raise KeyError(f"{container} not found in {self.path}")
        data = path.read_bytes()
        if data[2:9] == b"UnityFS":
            data = data[2:]
        env = UnityPy.Environment()
        env.load_file(data, name=path.name)
        return env


def objects_of_type(env: UnityPy.Environment, type_name: str) -> list[dict]:
    return [o.read_typetree() for o in env.objects if o.type.name == type_name]


# ---------------------------------------------------------------------------
# Mecanim clips
# ---------------------------------------------------------------------------


def _streamed_keys(words: list[int]) -> dict[int, tuple[np.ndarray, np.ndarray]]:
    """StreamedClip payload -> {curve index: (key times, cubic coefficients [n, 4])}."""
    buf = np.asarray(words, dtype=np.uint32).tobytes()
    per_curve: dict[int, list] = {}
    off = 0
    while off < len(buf):
        t, n = struct.unpack_from("<fi", buf, off)
        off += 8
        for _ in range(n):
            idx = struct.unpack_from("<i", buf, off)[0]
            coeffs = struct.unpack_from("<4f", buf, off + 4)
            off += 20
            per_curve.setdefault(idx, []).append((t, coeffs))
    out = {}
    for idx, keys in per_curve.items():
        keys.sort(key=lambda k: k[0])
        out[idx] = (np.array([k[0] for k in keys]), np.array([k[1] for k in keys]))
    return out


def decode_clip(clip: dict, fps: float | None = None) -> tuple[np.ndarray, np.ndarray, list[int]]:
    """Sample a Mecanim AnimationClip typetree on its frame grid.

    Returns (times[F], values[C, F], attributes[C]). Curve order is streamed, then dense, then
    constant, matching m_ClipBindingConstant.genericBindings. For humanoid clips every binding
    is an Animator (typeID 95) float whose `attribute` is the humanoid channel number.
    """
    mc = clip["m_MuscleClip"]
    data = mc["m_Clip"].get("data", mc["m_Clip"])
    sc, dc, cc = data["m_StreamedClip"], data["m_DenseClip"], data["m_ConstantClip"]
    rate = fps or clip.get("m_SampleRate") or 30.0
    start, stop = mc["m_StartTime"], mc["m_StopTime"]
    n_frames = int(round((stop - start) * rate)) + 1
    times = start + np.arange(n_frames) / rate

    n_stream, n_dense, const = sc["curveCount"], dc["m_CurveCount"], list(cc["data"])
    values = np.zeros((n_stream + n_dense + len(const), n_frames))

    # Streamed: each key starts a cubic segment f(dt) = ((c0*dt + c1)*dt + c2)*dt + c3
    for idx, (kt, coeffs) in _streamed_keys(sc["data"]).items():
        if idx >= n_stream:
            continue
        seg = np.clip(np.searchsorted(kt, times, side="right") - 1, 0, len(kt) - 1)
        t0 = kt[seg]
        dt = np.where(np.isfinite(t0), times - t0, 0.0)
        c = coeffs[seg]
        values[idx] = ((c[:, 0] * dt + c[:, 1]) * dt + c[:, 2]) * dt + c[:, 3]

    if n_dense:
        samples = np.asarray(dc["m_SampleArray"], dtype=np.float64).reshape(dc["m_FrameCount"], n_dense)
        ftimes = dc["m_BeginTime"] + np.arange(dc["m_FrameCount"]) / dc["m_SampleRate"]
        for k in range(n_dense):
            values[n_stream + k] = np.interp(times, ftimes, samples[:, k])

    for k, v in enumerate(const):
        values[n_stream + n_dense + k] = v

    attrs = [b["attribute"] for b in clip["m_ClipBindingConstant"]["genericBindings"]]
    return times, values, attrs


# ---------------------------------------------------------------------------
# Quaternion helpers (x, y, z, w)
# ---------------------------------------------------------------------------


def qmul(a, b):
    ax, ay, az, aw = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw,
                     aw * bw - ax * bx - ay * by - az * bz], axis=-1)


def qconj(a):
    return a * np.array([-1.0, -1.0, -1.0, 1.0])


def qnorm(a):
    return a / np.linalg.norm(a, axis=-1, keepdims=True)


def qrot(a, v):
    p = np.concatenate([v, np.zeros(v.shape[:-1] + (1,))], axis=-1)
    return qmul(qmul(a, p), qconj(a))[..., :3]


def _q(d):
    return np.array([d["x"], d["y"], d["z"], d["w"]], dtype=np.float64)


def _v(d):
    return np.array([d["x"], d["y"], d["z"]], dtype=np.float64)


def mat_to_quat(m):
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        return qnorm(np.array([(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]))
    i = int(np.argmax([m[0, 0], m[1, 1], m[2, 2]]))
    if i == 0:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        return qnorm(np.array([0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]))
    if i == 1:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        return qnorm(np.array([(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]))
    s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
    return qnorm(np.array([(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]))


# ---------------------------------------------------------------------------
# Humanoid
# ---------------------------------------------------------------------------

# Mecanim's internal bone order (m_HumanBoneIndex). Note UpperChest comes right after Chest,
# unlike the public HumanBodyBones enum.
BONES = ["Hips", "LeftUpperLeg", "RightUpperLeg", "LeftLowerLeg", "RightLowerLeg", "LeftFoot", "RightFoot",
         "Spine", "Chest", "UpperChest", "Neck", "Head", "LeftShoulder", "RightShoulder", "LeftUpperArm",
         "RightUpperArm", "LeftLowerArm", "RightLowerArm", "LeftHand", "RightHand", "LeftToes", "RightToes",
         "LeftEye", "RightEye", "Jaw"]

# Humanoid clip channels (genericBinding.attribute for typeID 95):
#   0-6 MotionT/Q (not stored in these clips), 7-9 RootT, 10-13 RootQ,
#   14-41 IK goals (LeftFoot, RightFoot, LeftHand, RightHand: T xyz + Q xyzw each),
#   42-96 the 55 body muscles below, 97-136 the 40 finger muscles.
ROOT_T, ROOT_Q, GOALS, MUSCLE_BASE, FINGER_BASE = 7, 10, 14, 42, 97
GOAL_NAMES = ["LeftFoot", "RightFoot", "LeftHand", "RightHand"]

# Body muscles in channel order -> (bone, axis); axis 0 = x (twist/roll), 1 = y, 2 = z.
MUSCLES = [
    ("Spine", 2), ("Spine", 1), ("Spine", 0), ("Chest", 2), ("Chest", 1), ("Chest", 0),
    ("UpperChest", 2), ("UpperChest", 1), ("UpperChest", 0), ("Neck", 2), ("Neck", 1), ("Neck", 0),
    ("Head", 2), ("Head", 1), ("Head", 0), ("LeftEye", 2), ("LeftEye", 1), ("RightEye", 2), ("RightEye", 1),
    ("Jaw", 2), ("Jaw", 1),
    ("LeftUpperLeg", 2), ("LeftUpperLeg", 1), ("LeftUpperLeg", 0), ("LeftLowerLeg", 2), ("LeftLowerLeg", 0),
    ("LeftFoot", 2), ("LeftFoot", 0), ("LeftToes", 2),
    ("RightUpperLeg", 2), ("RightUpperLeg", 1), ("RightUpperLeg", 0), ("RightLowerLeg", 2), ("RightLowerLeg", 0),
    ("RightFoot", 2), ("RightFoot", 0), ("RightToes", 2),
    ("LeftShoulder", 2), ("LeftShoulder", 1), ("LeftUpperArm", 2), ("LeftUpperArm", 1), ("LeftUpperArm", 0),
    ("LeftLowerArm", 2), ("LeftLowerArm", 0), ("LeftHand", 2), ("LeftHand", 1),
    ("RightShoulder", 2), ("RightShoulder", 1), ("RightUpperArm", 2), ("RightUpperArm", 1), ("RightUpperArm", 0),
    ("RightLowerArm", 2), ("RightLowerArm", 0), ("RightHand", 2), ("RightHand", 1),
]
# Unity's names for the body muscles above (HumanTrait.MuscleName order).
MUSCLE_NAMES = [
    "Spine Front-Back", "Spine Left-Right", "Spine Twist Left-Right",
    "Chest Front-Back", "Chest Left-Right", "Chest Twist Left-Right",
    "UpperChest Front-Back", "UpperChest Left-Right", "UpperChest Twist Left-Right",
    "Neck Nod Down-Up", "Neck Tilt Left-Right", "Neck Turn Left-Right",
    "Head Nod Down-Up", "Head Tilt Left-Right", "Head Turn Left-Right",
    "Left Eye Down-Up", "Left Eye In-Out", "Right Eye Down-Up", "Right Eye In-Out",
    "Jaw Close", "Jaw Left-Right",
    "Left Upper Leg Front-Back", "Left Upper Leg In-Out", "Left Upper Leg Twist In-Out",
    "Left Lower Leg Stretch", "Left Lower Leg Twist In-Out",
    "Left Foot Up-Down", "Left Foot Twist In-Out", "Left Toes Up-Down",
    "Right Upper Leg Front-Back", "Right Upper Leg In-Out", "Right Upper Leg Twist In-Out",
    "Right Lower Leg Stretch", "Right Lower Leg Twist In-Out",
    "Right Foot Up-Down", "Right Foot Twist In-Out", "Right Toes Up-Down",
    "Left Shoulder Down-Up", "Left Shoulder Front-Back",
    "Left Arm Down-Up", "Left Arm Front-Back", "Left Arm Twist In-Out",
    "Left Forearm Stretch", "Left Forearm Twist In-Out", "Left Hand Down-Up", "Left Hand In-Out",
    "Right Shoulder Down-Up", "Right Shoulder Front-Back",
    "Right Arm Down-Up", "Right Arm Front-Back", "Right Arm Twist In-Out",
    "Right Forearm Stretch", "Right Forearm Twist In-Out", "Right Hand Down-Up", "Right Hand In-Out",
]
assert len(MUSCLE_NAMES) == len(MUSCLES)
FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"]
# Finger muscles per hand and finger: 1 Stretched (proximal z), Spread (proximal y),
# 2 Stretched (intermediate z), 3 Stretched (distal z).
FINGER_MUSCLES = [(hand, f, ph, ax) for hand in ("Left", "Right") for f in FINGERS
                  for ph, ax in ((0, 2), (0, 1), (1, 2), (2, 2))]

# Segment end used for the center-of-mass computation (mass-weighted segment midpoints).
SEGMENT_CHILD = {"Hips": "Spine", "Spine": "Chest", "Chest": "UpperChest", "UpperChest": "Neck", "Neck": "Head",
                 "LeftUpperLeg": "LeftLowerLeg", "LeftLowerLeg": "LeftFoot", "LeftFoot": "LeftToes",
                 "RightUpperLeg": "RightLowerLeg", "RightLowerLeg": "RightFoot", "RightFoot": "RightToes",
                 "LeftShoulder": "LeftUpperArm", "LeftUpperArm": "LeftLowerArm", "LeftLowerArm": "LeftHand",
                 "RightShoulder": "RightUpperArm", "RightUpperArm": "RightLowerArm", "RightLowerArm": "RightHand"}


@dataclass
class Axes:
    pre: np.ndarray
    post: np.ndarray
    sgn: np.ndarray
    lo: np.ndarray
    hi: np.ndarray


def axes_unproject(ax: Axes, muscles: np.ndarray) -> np.ndarray:
    """Unity's muscle -> local rotation: PreQ * ZYRoll(halfTan(limit(muscle) * sgn)) * PostQ^-1.

    Muscle values in [-1, 1] scale to the [min, max] limits (radians). ZYRoll builds
    swing(y, z) * twist(x) from half-angle tangents.
    """
    ang = np.where(muscles >= 0, muscles * ax.hi, -muscles * ax.lo)
    h = np.tan(0.5 * ang * ax.sgn)
    x, y, z = h[..., 0], h[..., 1], h[..., 2]
    zyroll = qnorm(np.stack([x, y + x * z, z - x * y, np.ones_like(x)], axis=-1))
    return qnorm(qmul(qmul(ax.pre, zyroll), qconj(ax.post)))


class Avatar:
    """A humanoid Avatar asset (e.g. from the character's body .fbx bundle)."""

    def __init__(self, avatar_typetree: dict):
        tt = avatar_typetree
        av = tt["m_Avatar"]
        self.name = tt.get("m_Name", "")
        tos = {int(k): v for k, v in tt["m_TOS"]}

        # Full skeleton (every transform under the model) for the GLB node tree.
        ask = av["m_AvatarSkeleton"]["data"]
        self.node_names = [tos.get(i, "?").split("/")[-1] or "Root" for i in ask["m_ID"]]
        self.node_parent = [n["m_ParentId"] for n in ask["m_Node"]]
        pose = av["m_AvatarSkeletonPose"]["data"]["m_X"]
        self.node_t = np.array([_v(x["t"]) for x in pose])
        self.node_r = np.array([_q(x["q"]) for x in pose])
        self.node_s = np.array([_v(x["s"]) for x in pose])

        # Human skeleton (the minimal subtree holding the human bones) + per-bone axes.
        h = av["m_Human"]["data"]
        hs = h["m_Skeleton"]["data"]
        self.h_parent = [n["m_ParentId"] for n in hs["m_Node"]]
        self.h_axes_id = [n["m_AxesId"] for n in hs["m_Node"]]
        self.axes = [Axes(_q(a["m_PreQ"]), _q(a["m_PostQ"]), _v(a["m_Sgn"]), _v(a["m_Limit"]["m_Min"]),
                          _v(a["m_Limit"]["m_Max"])) for a in hs["m_AxesArray"]]
        hp = h["m_SkeletonPose"]["data"]["m_X"]
        self.h_t = np.array([_v(x["t"]) for x in hp])
        self.h_r = np.array([_q(x["q"]) for x in hp])
        self.h_to_node = av["m_HumanSkeletonIndexArray"]
        self.bone_index = h["m_HumanBoneIndex"]
        hand = lambda k: h[k]["data"]["m_HandBoneIndex"] if "data" in h[k] else h[k]["m_HandBoneIndex"]
        self.left_hand, self.right_hand = hand("m_LeftHand"), hand("m_RightHand")
        self.mass = h["m_HumanBoneMass"]
        self.scale = h["m_Scale"]
        self.hips = self.bone_index[0]

    def bone_node(self, bone: str) -> int:
        return self.bone_index[BONES.index(bone)]

    def global_pose(self, local_t: np.ndarray, local_r: np.ndarray):
        n = len(self.h_parent)
        gt, gr = np.zeros((n, 3)), np.zeros((n, 4))
        for i in range(n):
            p = self.h_parent[i]
            if p < 0:
                gt[i], gr[i] = local_t[i], local_r[i]
            else:
                gt[i] = gt[p] + qrot(gr[p], local_t[i])
                gr[i] = qmul(gr[p], local_r[i])
        return gt, gr

    def body_frame(self, gt: np.ndarray):
        """Unity's body root: mass-weighted segment-midpoint center of mass + hips/shoulders frame."""
        pos = {BONES[b]: gt[n] for b, n in enumerate(self.bone_index) if n >= 0}
        num, den = np.zeros(3), 0.0
        for b, n in enumerate(self.bone_index):
            if n < 0 or self.mass[b] == 0:
                continue
            name = BONES[b]
            child = SEGMENT_CHILD.get(name)
            p = (pos[name] + pos[child]) / 2 if child in pos else pos[name]
            num += self.mass[b] * p
            den += self.mass[b]
        up = (pos["LeftUpperArm"] + pos["RightUpperArm"]) / 2 - (pos["LeftUpperLeg"] + pos["RightUpperLeg"]) / 2
        right = (pos["RightUpperLeg"] - pos["LeftUpperLeg"]) + (pos["RightUpperArm"] - pos["LeftUpperArm"])
        up = up / np.linalg.norm(up)
        fwd = np.cross(right, up)
        fwd /= np.linalg.norm(fwd)
        right = np.cross(up, fwd)
        return num / den, mat_to_quat(np.stack([right, up, fwd], axis=1))


class HumanoidBaker:
    """Turns humanoid clip channels into per-node local transforms of an Avatar's skeleton."""

    def __init__(self, avatar: Avatar):
        self.av = avatar
        # node -> list of (channel attribute, axis)
        self.driven: dict[int, list[tuple[int, int]]] = {}
        for i, (bone, axis) in enumerate(MUSCLES):
            node = avatar.bone_node(bone)
            if node >= 0 and avatar.h_axes_id[node] >= 0:
                self.driven.setdefault(node, []).append((MUSCLE_BASE + i, axis))
        for i, (hand, finger, phal, axis) in enumerate(FINGER_MUSCLES):
            arr = avatar.left_hand if hand == "Left" else avatar.right_hand
            node = arr[FINGERS.index(finger) * 3 + phal]
            if node >= 0 and avatar.h_axes_id[node] >= 0:
                self.driven.setdefault(node, []).append((FINGER_BASE + i, axis))

    def bake(self, times: np.ndarray, values: np.ndarray, attrs: list[int]):
        """-> (local rotations [F, human nodes, 4], hips translation [F, 3]) in Unity space."""
        av = self.av
        ch = {a: values[i] for i, a in enumerate(attrs)}
        nf = len(times)
        local_r = np.repeat(av.h_r[None], nf, axis=0)
        for node, chans in self.driven.items():
            m = np.zeros((nf, 3))
            for attr, axis in chans:
                if attr in ch:
                    m[:, axis] = ch[attr]
            local_r[:, node] = axes_unproject(av.axes[av.h_axes_id[node]], m)

        root_t = np.stack([ch.get(ROOT_T + k, np.zeros(nf)) for k in range(3)], axis=1) * av.scale
        root_q = qnorm(np.stack([ch.get(ROOT_Q + k, np.full(nf, 1.0 if k == 3 else 0.0)) for k in range(4)], axis=1))

        hips_t = np.zeros((nf, 3))
        identity = np.array([0.0, 0.0, 0.0, 1.0])
        above_hips = _ancestors(av.h_parent, av.hips)
        for f in range(nf):
            # Pose with the hips at the origin -> body frame relative to the hips, then place the
            # hips so the body frame lands on the clip's RootT/RootQ.
            lt, lr = av.h_t.copy(), local_r[f].copy()
            for i in above_hips | {av.hips}:
                lt[i], lr[i] = 0.0, identity
            g, _ = av.global_pose(lt, lr)
            com, qb = av.body_frame(g)
            hq = qmul(root_q[f], qconj(qb))
            local_r[f, av.hips] = hq
            hips_t[f] = root_t[f] - qrot(hq, com)
        return local_r, hips_t

    def check(self, times, values, attrs, local_r, hips_t) -> float:
        """Mean distance (m) between baked wrists and the clip's own hand IK goals."""
        av = self.av
        ch = {a: values[i] for i, a in enumerate(attrs)}
        if GOALS + 20 not in ch:
            return float("nan")
        root_t = np.stack([ch[ROOT_T + k] for k in range(3)], axis=1) * av.scale
        root_q = qnorm(np.stack([ch[ROOT_Q + k] for k in range(4)], axis=1))
        errs = []
        for f in range(len(times)):
            lt = av.h_t.copy()
            lt[av.hips] = hips_t[f]
            g, _ = av.global_pose(lt, local_r[f])
            for gi, bone in ((2, "LeftHand"), (3, "RightHand")):
                base = GOALS + gi * 7
                goal = np.array([ch[base + k][f] for k in range(3)]) * av.scale
                errs.append(np.linalg.norm(g[av.bone_node(bone)] - (root_t[f] + qrot(root_q[f], goal))))
        return float(np.mean(errs))


def _ancestors(parent: list[int], node: int) -> set[int]:
    out, p = set(), parent[node]
    while p >= 0:
        out.add(p)
        p = parent[p]
    return out


# ---------------------------------------------------------------------------
# glTF output
# ---------------------------------------------------------------------------


def unity_to_gltf_t(t: np.ndarray) -> np.ndarray:
    """Unity (left-handed) -> glTF position: negate x. Matches the costume GLBs."""
    return t * np.array([-1.0, 1.0, 1.0])


def unity_to_gltf_q(q: np.ndarray) -> np.ndarray:
    """Unity -> glTF rotation: (x, y, z, w) -> (x, -y, -z, w). Matches the costume GLBs."""
    return q * np.array([1.0, -1.0, -1.0, 1.0])


def continuous(q: np.ndarray) -> np.ndarray:
    """Flip quaternion signs so consecutive keys stay in the same hemisphere (clean slerp)."""
    q = q.copy()
    for i in range(1, len(q)):
        if np.dot(q[i - 1], q[i]) < 0:
            q[i] = -q[i]
    return q


class GlbBuilder:
    def __init__(self):
        self.gltf: dict = {"asset": {"version": "2.0", "generator": "hasu-web-reader export_motions.py"},
                           "buffers": [], "bufferViews": [], "accessors": []}
        self.bin = bytearray()

    def accessor(self, arr: np.ndarray, kind: str, with_minmax: bool = False) -> int:
        arr = np.ascontiguousarray(arr, dtype=np.float32)
        while len(self.bin) % 4:
            self.bin.append(0)
        offset = len(self.bin)
        self.bin += arr.tobytes()
        self.gltf["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": arr.nbytes})
        acc = {"bufferView": len(self.gltf["bufferViews"]) - 1, "componentType": 5126,
               "count": int(arr.shape[0]), "type": kind}
        if with_minmax:
            flat = arr.reshape(arr.shape[0], -1)
            acc["min"] = [float(x) for x in flat.min(axis=0)]
            acc["max"] = [float(x) for x in flat.max(axis=0)]
        self.gltf["accessors"].append(acc)
        return len(self.gltf["accessors"]) - 1

    def write(self, path: str | Path) -> None:
        while len(self.bin) % 4:
            self.bin.append(0)
        self.gltf["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.gltf, separators=(",", ":")).encode("utf-8")
        js += b" " * ((4 - len(js) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, "wb") as fh:
            fh.write(struct.pack("<4sII", b"glTF", 2, total))
            fh.write(struct.pack("<I4s", len(js), b"JSON"))
            fh.write(js)
            fh.write(struct.pack("<I4s", len(self.bin), b"BIN\x00"))
            fh.write(bytes(self.bin))


def write_motion_glb(path: str | Path, avatar: Avatar, baked_clips: list[tuple[str, np.ndarray, np.ndarray, np.ndarray]],
                     driven_nodes: set[int]) -> None:
    """baked_clips: [(name, times, local_r[F, human nodes, 4], hips_t[F, 3])] in Unity space."""
    b = GlbBuilder()
    nodes = []
    for i, name in enumerate(avatar.node_names):
        node = {"name": name}
        t = unity_to_gltf_t(avatar.node_t[i])
        r = unity_to_gltf_q(avatar.node_r[i])
        if np.any(np.abs(t) > 1e-9):
            node["translation"] = [float(x) for x in t]
        if np.any(np.abs(r - [0, 0, 0, 1]) > 1e-9):
            node["rotation"] = [float(x) for x in r]
        if np.any(np.abs(avatar.node_s[i] - 1) > 1e-9):
            node["scale"] = [float(x) for x in avatar.node_s[i]]
        nodes.append(node)
    for i, p in enumerate(avatar.node_parent):
        if p >= 0:
            nodes[p].setdefault("children", []).append(i)
    b.gltf["nodes"] = nodes
    roots = [i for i, p in enumerate(avatar.node_parent) if p < 0]
    b.gltf["scenes"] = [{"nodes": roots}]
    b.gltf["scene"] = 0

    animations = []
    hips_node = avatar.h_to_node[avatar.hips]
    for name, times, local_r, hips_t in baked_clips:
        samplers, channels = [], []
        t_acc = b.accessor(times[:, None] - times[0], "SCALAR", with_minmax=True)
        for hnode in sorted(driven_nodes | {avatar.hips}):
            q = continuous(unity_to_gltf_q(local_r[:, hnode]))
            samplers.append({"input": t_acc, "output": b.accessor(q, "VEC4"), "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": avatar.h_to_node[hnode], "path": "rotation"}})
        samplers.append({"input": t_acc, "output": b.accessor(unity_to_gltf_t(hips_t), "VEC3"), "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": hips_node, "path": "translation"}})
        animations.append({"name": name, "samplers": samplers, "channels": channels})
    b.gltf["animations"] = animations
    b.write(path)
