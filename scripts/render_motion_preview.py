#!/usr/bin/env python3
"""Render motion GLBs on a costume to MP4/PNG without a browser (CPU skinning + z-buffer + ffmpeg).

For each motion it renders a side-by-side clip:
  left  "before": what the reader showed while the motion file was missing. A missing motion is
        skipped, so the character keeps playing its previous motion (usually the standing idle,
        mot_00_00010).
  right "after":  the motion as exported from data-inspect by export_motions.py, played in the
        order the game's AnimatorController uses: @i (in) -> @a (action) -> @l (loop) -> @o (out).

Usage:
  uv run scripts/render_motion_preview.py mot_00_01060 mot_00_00320 \
      [--costume 3d_costume_1001103101] [--out docs/media/motion-proof.mp4]

Writes the MP4 plus a PNG contact sheet next to it (one before/after still per motion).
Shading is a simple two-tone toon (main texture lit, the material's shadow texture in shade,
unlit face and eyes). It's good enough to judge poses, but it isn't the reader's renderer.
"""

from __future__ import annotations

import argparse
import json
import struct
import subprocess
import tempfile
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "public" / "assets" / "3d"
HIDDEN_MESHES = {"IndoorShoes", "EyeShadow"}  # hidden in the reader as well
SKIP_MATERIALS = ("EyeHi",)  # additive eye highlights
UNLIT_MESHES = {"Face", "Brow", "Eye"}
LIGHT = np.array([0.35, 0.55, 0.76]) / np.linalg.norm([0.35, 0.55, 0.76])
BG_TOP, BG_BOTTOM = np.array([46, 52, 70]), np.array([16, 18, 26])
FONTS = ["/System/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/Helvetica.ttc"]
GLOSS = {  # English for the motion descriptions in 3d/metadata/motions.json
    "mot_00_00010": "standing idle",
    "mot_00_00040": "move to the left",
    "mot_00_00300": "back turned, then looks round",
    "mot_00_00320": "hang head",
    "mot_00_01060": "look closely to check",
    "mot_00_01140": "stroke someone's head",
    "mot_00_01280": "run",
    "mot_00_01750": "breathe hard",
    "mot_00_20880": "stand up and refuse",
}


# ---------------------------------------------------------------------------
# GLB reading
# ---------------------------------------------------------------------------
COMP = {5126: (np.float32, 4), 5125: (np.uint32, 4), 5123: (np.uint16, 2), 5121: (np.uint8, 1),
        5122: (np.int16, 2), 5120: (np.int8, 1)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Glb:
    def __init__(self, path: Path):
        d = path.read_bytes()
        n = struct.unpack_from("<I", d, 12)[0]
        self.j = json.loads(d[20:20 + n])
        off = 20 + n
        blen = struct.unpack_from("<I", d, off)[0]
        self.bin = d[off + 8: off + 8 + blen]

    def view(self, i: int) -> bytes:
        bv = self.j["bufferViews"][i]
        o = bv.get("byteOffset", 0)
        return self.bin[o: o + bv["byteLength"]]

    def acc(self, i: int) -> np.ndarray:
        a = self.j["accessors"][i]
        dtype, size = COMP[a["componentType"]]
        nc = NCOMP[a["type"]]
        count = a["count"]
        if "bufferView" not in a:
            return np.zeros((count, nc))
        bv = self.j["bufferViews"][a["bufferView"]]
        base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride", size * nc)
        if stride == size * nc:
            arr = np.frombuffer(self.bin, dtype=dtype, count=count * nc, offset=base).reshape(count, nc)
        else:
            raw = np.frombuffer(self.bin, dtype=np.uint8, count=stride * count, offset=base).reshape(count, stride)
            arr = raw[:, : size * nc].copy().view(dtype).reshape(count, nc)
        arr = arr.astype(np.float64)
        if a.get("normalized"):
            arr /= np.iinfo(dtype).max
        return arr


# ---------------------------------------------------------------------------
# Math
# ---------------------------------------------------------------------------
def quat_to_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def trs(t, r, s):
    m = np.eye(4)
    m[:3, :3] = quat_to_mat(r) * s
    m[:3, 3] = t
    return m


def nlerp(a, b, k):
    if np.dot(a, b) < 0:
        b = -b
    q = a * (1 - k) + b * k
    return q / np.linalg.norm(q)


# ---------------------------------------------------------------------------
# Costume (skinned meshes) and motion (glTF animations)
# ---------------------------------------------------------------------------
class Costume:
    def __init__(self, path: Path):
        g = Glb(path)
        j = g.j
        self.names = [n.get("name", "") for n in j["nodes"]]
        self.parent = [-1] * len(j["nodes"])
        for i, n in enumerate(j["nodes"]):
            for c in n.get("children", []):
                self.parent[c] = i
        self.order = self._topo()
        self.rest = [(np.array(n.get("translation", [0, 0, 0]), float), np.array(n.get("rotation", [0, 0, 0, 1]), float),
                      np.array(n.get("scale", [1, 1, 1]), float)) for n in j["nodes"]]
        images: dict[int, np.ndarray] = {}

        def texture(info):
            if not info:
                return None
            ti = info["index"]
            if ti not in images:
                img = j["images"][j["textures"][ti]["source"]]
                images[ti] = np.asarray(Image.open(BytesIO(g.view(img["bufferView"]))).convert("RGBA"))
            return images[ti]

        self.prims = []
        for node in j["nodes"]:
            if "mesh" not in node or node.get("name") in HIDDEN_MESHES:
                continue
            skin = j["skins"][node["skin"]]
            ibm = g.acc(skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
            for prim in j["meshes"][node["mesh"]]["primitives"]:
                mat = j["materials"][prim["material"]]
                if any(w in mat.get("name", "") for w in SKIP_MATERIALS):
                    continue
                main = texture((mat.get("pbrMetallicRoughness") or {}).get("baseColorTexture"))
                if main is None:
                    continue
                at = prim["attributes"]
                self.prims.append(dict(
                    name=node["name"], pos=g.acc(at["POSITION"]), nrm=g.acc(at["NORMAL"]), uv=g.acc(at["TEXCOORD_0"]),
                    joints=g.acc(at["JOINTS_0"]).astype(np.int64), weights=g.acc(at["WEIGHTS_0"]),
                    idx=g.acc(prim["indices"]).astype(np.int64).reshape(-1, 3),
                    skin_joints=skin["joints"], ibm=ibm, main=main, shade=texture(mat.get("occlusionTexture")),
                    unlit=node["name"] in UNLIT_MESHES, double_sided=bool(mat.get("doubleSided"))))

    def _topo(self):
        order, seen = [], set()

        def visit(i):
            if i in seen:
                return
            if self.parent[i] >= 0:
                visit(self.parent[i])
            seen.add(i)
            order.append(i)

        for i in range(len(self.parent)):
            visit(i)
        return order

    def pose(self, overrides: dict[str, tuple]) -> list[np.ndarray]:
        """overrides: node name -> (translation | None, rotation | None). Returns each node's global matrix."""
        G = [None] * len(self.names)
        for i in self.order:
            t, r, s = self.rest[i]
            o = overrides.get(self.names[i])
            if o:
                t = o[0] if o[0] is not None else t
                r = o[1] if o[1] is not None else r
            m = trs(t, r, s)
            G[i] = m if self.parent[i] < 0 else G[self.parent[i]] @ m
        return G

    def skin(self, G):
        out = []
        for p in self.prims:
            jm = np.stack([G[j] @ p["ibm"][k] for k, j in enumerate(p["skin_joints"])])
            m = np.einsum("nk,nkij->nij", p["weights"], jm[p["joints"]])
            v = np.einsum("nij,nj->ni", m[:, :3, :3], p["pos"]) + m[:, :3, 3]
            n = np.einsum("nij,nj->ni", m[:, :3, :3], p["nrm"])
            n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
            out.append((p, v, n))
        return out


class Motion:
    def __init__(self, path: Path):
        g = Glb(path)
        self.clips = {}
        for a in g.j.get("animations", []):
            chans = {}
            for ch in a["channels"]:
                s = a["samplers"][ch["sampler"]]
                name = g.j["nodes"][ch["target"]["node"]]["name"]
                chans.setdefault(name, {})[ch["target"]["path"]] = (g.acc(s["input"])[:, 0], g.acc(s["output"]))
            dur = max(v[0][-1] for c in chans.values() for v in c.values())
            self.clips[a["name"]] = (chans, dur)

    def duration(self, clip: str) -> float:
        return self.clips[clip][1]

    def sample(self, clip: str, t: float) -> dict[str, tuple]:
        chans, _ = self.clips[clip]
        out = {}
        for name, c in chans.items():
            res = [None, None]
            for path, (times, vals) in c.items():
                if len(times) == 1:
                    v = vals[0]
                else:
                    tt = min(max(t, times[0]), times[-1])
                    i = int(np.clip(np.searchsorted(times, tt) - 1, 0, len(times) - 2))
                    k = float(np.clip((tt - times[i]) / max(1e-9, times[i + 1] - times[i]), 0, 1))
                    v = nlerp(vals[i], vals[i + 1], k) if path == "rotation" else vals[i] * (1 - k) + vals[i + 1] * k
                res[0 if path == "translation" else 1] = v
            out[name] = tuple(res)
        return out


# ---------------------------------------------------------------------------
# Rasterizer
# ---------------------------------------------------------------------------
def rasterize(P: np.ndarray, W: int, H: int, budget: int = 1_500_000):
    """Yield (tri, pixel, lambdas) for every pixel centre inside the screen-space triangles P (T,3,2).

    Triangles are grouped by bounding-box size so each group can be tested on a fixed SxS grid
    with numpy, instead of looping over triangles in Python."""
    if len(P) == 0:
        return
    lo = np.ceil(P.min(axis=1) - 0.5).astype(np.int64)
    hi = np.floor(P.max(axis=1) - 0.5).astype(np.int64)
    lo = np.maximum(lo, 0)
    hi = np.minimum(hi, [W - 1, H - 1])
    ext = hi - lo + 1
    remaining = (ext > 0).all(axis=1)
    big = ext.max(axis=1)
    x0, y0, x1, y1, x2, y2 = P[:, 0, 0], P[:, 0, 1], P[:, 1, 0], P[:, 1, 1], P[:, 2, 0], P[:, 2, 1]
    area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
    S = 1
    while remaining.any():
        sel = np.nonzero(remaining & (big <= S))[0]
        remaining[sel] = False
        per = max(1, budget // (S * S))
        ar = np.arange(S)
        for c in range(0, len(sel), per):
            t = sel[c: c + per]
            gx = lo[t, 0][:, None, None] + ar[None, None, :]
            gy = lo[t, 1][:, None, None] + ar[None, :, None]
            px, py = gx + 0.5, gy + 0.5
            X0, Y0, X1, Y1, X2, Y2 = (a[t][:, None, None] for a in (x0, y0, x1, y1, x2, y2))
            A = area[t][:, None, None]
            l0 = ((X2 - X1) * (py - Y1) - (Y2 - Y1) * (px - X1)) / A
            l1 = ((X0 - X2) * (py - Y2) - (Y0 - Y2) * (px - X2)) / A
            l2 = 1.0 - l0 - l1
            inside = ((l0 >= 0) & (l1 >= 0) & (l2 >= 0)
                      & (gx <= hi[t, 0][:, None, None]) & (gy <= hi[t, 1][:, None, None]))
            k, yy, xx = np.nonzero(inside)
            pix = (lo[t[k], 1] + yy) * W + (lo[t[k], 0] + xx)
            yield t[k], pix, np.stack([l0[inside], l1[inside], l2[inside]], axis=1)
        S *= 2


def sample_tex(tex: np.ndarray, uv: np.ndarray) -> np.ndarray:
    h, w = tex.shape[:2]
    x = ((uv[:, 0] % 1.0) * w).astype(np.int64).clip(0, w - 1)
    y = ((uv[:, 1] % 1.0) * h).astype(np.int64).clip(0, h - 1)
    return tex[y, x]


def render(skinned, size=(420, 680), ss=2, target=(0.0, 0.88, 0.0), dist=4.2, fov_deg=24.0) -> Image.Image:
    W, H = size[0] * ss, size[1] * ss
    eye = np.array([target[0], target[1], target[2] + dist])
    f = 0.5 * H / np.tan(np.radians(fov_deg) / 2)
    pix_all, depth_all, col_all = [], [], []
    for p, v, n in skinned:
        rel = v - eye
        z = -rel[:, 2]
        sx = W / 2 + f * rel[:, 0] / z
        sy = H / 2 - f * rel[:, 1] / z
        tri = p["idx"]
        P = np.stack([sx[tri], sy[tri]], axis=-1)
        a = (P[:, 1, 0] - P[:, 0, 0]) * (P[:, 2, 1] - P[:, 0, 1]) - (P[:, 1, 1] - P[:, 0, 1]) * (P[:, 2, 0] - P[:, 0, 0])
        # glTF front faces are counter-clockwise; with screen y pointing down they have negative area
        keep = np.nonzero((np.abs(a) > 1e-9) if p["double_sided"] else (a < -1e-9))[0]
        Z = z[tri]
        for tl, pix, lam in rasterize(P[keep], W, H):
            t = keep[tl]
            vi = tri[t]
            wz = lam / Z[t]
            invz = wz.sum(axis=1)
            b = wz / invz[:, None]  # perspective-correct barycentrics
            uv = np.einsum("mk,mkc->mc", b, p["uv"][vi])
            main = sample_tex(p["main"], uv)[:, :3].astype(np.float32)
            if p["unlit"]:
                col = main
            else:
                nn = np.einsum("mk,mkc->mc", b, n[vi])
                nn /= np.linalg.norm(nn, axis=1, keepdims=True) + 1e-12
                lit = np.clip((nn @ LIGHT + 0.02) / 0.12, 0, 1)[:, None]
                shade = sample_tex(p["shade"], uv)[:, :3].astype(np.float32) if p["shade"] is not None else main * 0.72
                col = shade * (1 - lit) + main * lit
            pix_all.append(pix)
            depth_all.append(1.0 / invz)
            col_all.append(col)
    img = BG_TOP[None, :] + (BG_BOTTOM - BG_TOP)[None, :] * np.linspace(0, 1, H)[:, None]
    img = np.repeat(img[:, None, :], W, axis=1).reshape(-1, 3)
    if pix_all:
        pix, depth, col = np.concatenate(pix_all), np.concatenate(depth_all), np.concatenate(col_all)
        order = np.lexsort((depth, pix))
        ps = pix[order]
        first = np.ones(len(order), bool)
        first[1:] = ps[1:] != ps[:-1]
        win = order[first]
        img[pix[win]] = col[win]
    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8).reshape(H, W, 3))
    return out.resize(size, Image.LANCZOS)


# ---------------------------------------------------------------------------
# Compositing
# ---------------------------------------------------------------------------
def font(size: int):
    for f in FONTS:
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def label(img: Image.Image, title: str, sub: str, accent) -> Image.Image:
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, img.width, 54], fill=(10, 12, 18))
    d.rectangle([0, 52, img.width, 54], fill=accent)
    d.text((12, 7), title, fill=accent, font=font(18))
    d.text((12, 31), sub, fill=(200, 206, 220), font=font(14))
    return img


def footer(frame: Image.Image, text: str) -> None:
    d = ImageDraw.Draw(frame)
    d.rectangle([0, frame.height - 30, frame.width, frame.height], fill=(10, 12, 18))
    d.text((12, frame.height - 24), text, fill=(150, 158, 176), font=font(13))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("motions", nargs="+")
    ap.add_argument("--costume", default="3d_costume_1001103101")
    ap.add_argument("--idle", default="mot_00_00010", help="motion the reader kept playing while one was missing")
    ap.add_argument("--out", default=str(ROOT / "docs" / "media" / "motion-proof.mp4"))
    ap.add_argument("--hold", type=float, default=1.2, help="seconds to keep looping the @l clip")
    ap.add_argument("--fps", type=int, default=30)
    args = ap.parse_args()

    meta = {m["id"]: m for m in json.loads((ASSETS / "metadata" / "motions.json").read_text(encoding="utf-8"))}
    costume = Costume(ASSETS / "costume" / args.costume / f"{args.costume}.glb")
    idle = Motion(ASSETS / "motions" / f"{args.idle}.glb")
    idle_clip = "m_" + args.idle[4:] + "@l"
    idle_dur = idle.duration(idle_clip)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    gold, blue = (255, 206, 110), (120, 200, 255)

    stills, idle_cache = [], {}
    with tempfile.TemporaryDirectory() as tmp:
        fi_total = 0
        for mid in args.motions:
            motion = Motion(ASSETS / "motions" / f"{mid}.glb")
            main_clip = "m_" + mid[4:]
            seq = [(main_clip + s, args.hold if s == "@l" else motion.duration(main_clip + s))
                   for s in ("@i", "@a", "@l", "@o") if main_clip + s in motion.clips]
            seq.append((seq[-1][0], 0.4))  # rest on the final pose
            desc = meta.get(mid, {}).get("description", "")
            gloss = GLOSS.get(mid, "")
            frames = int(round(sum(d for _, d in seq) * args.fps))
            still_at = int(sum(d for _, d in seq[:2]) * args.fps) if len(seq) > 2 else frames // 2
            for fi in range(frames):
                t = fi / args.fps
                for k, (clip, d) in enumerate(seq):
                    if k == len(seq) - 1:
                        ct = motion.duration(clip) if not clip.endswith("@l") else t % motion.duration(clip)
                        break
                    if t < d:
                        # @l loops for as long as the motion stays active; the other clips play once
                        ct = t % motion.duration(clip) if clip.endswith("@l") else min(t, motion.duration(clip))
                        break
                    t -= d
                idle_frame = fi_total % max(1, int(round(idle_dur * args.fps)))
                if idle_frame not in idle_cache:
                    idle_cache[idle_frame] = render(costume.skin(costume.pose(idle.sample(idle_clip, idle_frame / args.fps))))
                before = idle_cache[idle_frame].copy()
                after = render(costume.skin(costume.pose(motion.sample(clip, ct))))
                label(before, "Before: motion missing", f"keeps playing {args.idle} (standing idle)", gold)
                label(after, f"After: {mid}", f"{desc}  ({gloss})" if gloss else desc, blue)
                frame = Image.new("RGB", (before.width * 2, before.height + 30), (10, 12, 18))
                frame.paste(before, (0, 0))
                frame.paste(after, (before.width, 0))
                footer(frame, f"exported from data-inspect · playing @{clip.split('@')[-1]}  t={ct:0.2f}s"
                              f"   ·   game order @i → @a → @l → @o")
                frame.save(f"{tmp}/f{fi_total:05d}.png")
                if fi == still_at:
                    stills.append(frame)
                fi_total += 1
            print(f"  {mid}: {frames} frames ({' → '.join('@' + c.split('@')[-1] for c, _ in seq[:-1])})")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(args.fps), "-i", f"{tmp}/f%05d.png",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-movflags", "+faststart", str(out)],
                       check=True)
    sheet = Image.new("RGB", (stills[0].width, stills[0].height * len(stills)))
    for i, s in enumerate(stills):
        sheet.paste(s, (0, i * s.height))
    sheet_path = out.with_suffix(".png")
    sheet.save(sheet_path)
    print(f"wrote {out} ({fi_total} frames, {fi_total / args.fps:.1f}s) and {sheet_path}")


if __name__ == "__main__":
    main()
