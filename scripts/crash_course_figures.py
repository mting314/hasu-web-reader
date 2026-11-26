#!/usr/bin/env python3
"""Figures for docs/unity-crash-course.md, generated from the raw game data and our exports.

  uv run --group docs scripts/crash_course_figures.py [--out docs/media/crash-course]

Writes:
  skeleton.png        Kaho's body rig: human bones vs. the other transforms
  muscle-sweeps.png   four muscles swept from -1 to +1 on top of the standing pose
  muscle-curves.png   the busiest muscle curves of mot_00_01060 across @i/@a/@l/@o
  ik-goals.png        the clip's own hand IK goals vs. where our baked wrists land
  clip-filmstrip.png  mot_00_01060 through its in / action / loop / out clips
Needs the bundle index (.inspect-tmp/ios_index.jsonl) and public/assets (costume + motion GLBs).
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_motion_preview as RP  # noqa: E402
import unity_assets as UA  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / ".inspect-tmp" / "ios_index.jsonl"
COSTUME = RP.ASSETS / "costume" / "3d_costume_1001103101" / "3d_costume_1001103101.glb"
MOTIONS = RP.ASSETS / "motions"
AVATAR = "__scsch011kahdea.fbx"
IDLE, IDLE_CLIP = "mot_00_00010", "m_00_00010@l"
DEMO, DEMO_BASE = "mot_00_01060", "m_00_01060"

# dataviz reference palette, dark mode (validated: scripts/validate_palette.js --mode dark)
SURFACE_HEX, TEXT_HEX, TEXT2_HEX, GRID_HEX = "#1a1a19", "#f0efec", "#c3c2b7", "#383835"
SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"]
TEXT, TEXT2, MUTED = (240, 239, 236), (195, 194, 183), (120, 120, 112)
CAM = dict(target=(0.0, 0.88, 0.0), dist=4.2, fov_deg=24.0)


def hex_rgb(h: str) -> tuple[int, int, int]:
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def project(points, size, target=CAM["target"], dist=CAM["dist"], fov_deg=CAM["fov_deg"]) -> np.ndarray:
    """World points -> pixel coordinates, with the same camera as render_motion_preview.render."""
    W, H = size
    eye = np.array([target[0], target[1], target[2] + dist])
    f = 0.5 * H / np.tan(np.radians(fov_deg) / 2)
    rel = np.atleast_2d(points) - eye
    z = -rel[:, 2]
    return np.stack([W / 2 + f * rel[:, 0] / z, H / 2 - f * rel[:, 1] / z], axis=1)


def yaw(deg: float) -> np.ndarray:
    c, s = np.cos(np.radians(deg)), np.sin(np.radians(deg))
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def turned(skinned, deg: float):
    R = yaw(deg)
    return [(p, v @ R.T, n @ R.T) for p, v, n in skinned]


class Scene:
    def __init__(self):
        self.index = UA.BundleIndex(INDEX)
        self.avatar = UA.Avatar(UA.objects_of_type(self.index.load_env(AVATAR), "Avatar")[0])
        self.baker = UA.HumanoidBaker(self.avatar)
        self.costume = RP.Costume(COSTUME)
        self.node = {n: i for i, n in enumerate(self.costume.names)}
        self.idle = RP.Motion(MOTIONS / f"{IDLE}.glb")
        self.demo = RP.Motion(MOTIONS / f"{DEMO}.glb")

    def bone_transform(self, bone: str) -> str | None:
        """Human bone (e.g. 'LeftHand') -> transform name in the rig (e.g. 'KahDeA_LeftHand')."""
        hi = self.avatar.bone_index[UA.BONES.index(bone)]
        return None if hi < 0 else self.avatar.node_names[self.avatar.h_to_node[hi]]

    def clip(self, motion_id: str, clip_name: str):
        env = self.index.load_env(motion_id)
        clip = next(c for c in UA.objects_of_type(env, "AnimationClip") if c["m_Name"] == clip_name)
        return UA.decode_clip(clip)

    def posed(self, overrides):
        G = self.costume.pose(overrides)
        return G, self.costume.skin(G)


def caption(img: Image.Image, xy, text: str, size=15, fill=TEXT, anchor="la"):
    ImageDraw.Draw(img).text(xy, text, fill=fill, font=RP.font(size), anchor=anchor)


def titled(body: Image.Image, title: str, subtitle: str = "") -> Image.Image:
    top = 64 if subtitle else 42
    out = Image.new("RGB", (body.width, body.height + top), hex_rgb(SURFACE_HEX))
    out.paste(body, (0, top))
    caption(out, (16, 10), title, 19)
    if subtitle:
        caption(out, (16, 38), subtitle, 14, TEXT2)
    return out


# ---------------------------------------------------------------------------
def fig_skeleton(sc: Scene, out: Path) -> None:
    size = (520, 800)
    cam = dict(target=(0.0, 0.80, 0.0), dist=4.3, fov_deg=24.0)
    G, sk = sc.posed(sc.idle.sample(IDLE_CLIP, 0.0))
    body = RP.render(sk, size=size, **cam)
    body = Image.blend(body, Image.new("RGB", size, hex_rgb(SURFACE_HEX)), 0.6)
    canvas = Image.new("RGB", (size[0] + 300, size[1] + 92), hex_rgb(SURFACE_HEX))
    canvas.paste(body, (0, 0))
    d = ImageDraw.Draw(canvas)

    pos = lambda name: G[sc.node[name]][:3, 3]
    human = {b: sc.bone_transform(b) for b in UA.BONES}
    human = {b: t for b, t in human.items() if t and t in sc.node}
    av = sc.avatar
    fingers = {av.node_names[av.h_to_node[i]] for i in list(av.left_hand) + list(av.right_hand) if i >= 0}
    human_nodes = {sc.node[t] for t in human.values()} | {sc.node[t] for t in fingers if t in sc.node}
    skinned_meshes = {i for i, n in enumerate(sc.costume.names) if n in {p["name"] for p in sc.costume.prims}}
    rig = [i for i, n in enumerate(sc.costume.names) if n in set(sc.avatar.node_names)]
    others = [i for i in rig if i not in human_nodes and i not in skinned_meshes]
    for i in others:
        x, y = project(G[i][:3, 3], size, **cam)[0]
        d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=MUTED)

    chain = ["Hips", "Spine", "Chest", "UpperChest", "Neck", "Head"]
    segments = list(zip(chain, chain[1:]))
    for side in ("Left", "Right"):
        arm = ["UpperChest", f"{side}Shoulder", f"{side}UpperArm", f"{side}LowerArm", f"{side}Hand"]
        leg = ["Hips", f"{side}UpperLeg", f"{side}LowerLeg", f"{side}Foot", f"{side}Toes"]
        segments += list(zip(arm, arm[1:])) + list(zip(leg, leg[1:]))
    accent = hex_rgb(SERIES[0])
    for a, b in segments:
        if a in human and b in human:
            (x0, y0), (x1, y1) = project(np.stack([pos(human[a]), pos(human[b])]), size, **cam)
            d.line([x0, y0, x1, y1], fill=accent, width=3)
    for b, t in human.items():
        x, y = project(pos(t), size, **cam)[0]
        d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=TEXT, outline=hex_rgb(SURFACE_HEX), width=2)
    for t in fingers:
        if t in sc.node:
            x, y = project(pos(t), size, **cam)[0]
            d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=TEXT)

    labelled = ["Head", "Neck", "UpperChest", "Chest", "Spine", "Hips", "LeftShoulder", "LeftUpperArm",
                "LeftLowerArm", "LeftHand", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes"]
    pts = {b: project(pos(human[b]), size, **cam)[0] for b in labelled if b in human}
    order = sorted(pts, key=lambda b: pts[b][1])
    ys = np.linspace(70, size[1] - 70, len(order))
    for b, ly in zip(order, ys):
        x, y = pts[b]
        lx = size[0] + 24
        d.line([x + 6, y, lx - 6, ly], fill=MUTED, width=1)
        caption(canvas, (lx, ly), f"{b}", 14, TEXT, "lm")
        caption(canvas, (lx + 132, ly), human[b], 12, TEXT2, "lm")
    n_sp = sum(sc.costume.names[i].split("_", 1)[-1].startswith("SP_") for i in others)
    caption(canvas, (16, size[1] + 12), f"● {len(human)} body bones + {len(fingers)} finger bones: the humanoid skeleton "
                                         "the Avatar maps (what muscles drive)", 14, TEXT)
    caption(canvas, (16, size[1] + 38), f"· {len(av.node_names) - len(human) - len(fingers)} other transforms: "
                                         f"{n_sp} SP_* spring bones (hair, necktie, collar, chest, thighs),", 14, TEXT2)
    caption(canvas, (30, size[1] + 60), "roll/bend helper bones, eye and end nodes", 14, TEXT2)
    titled(canvas, "One rig, two views of it", "Kaho's body model SCSch011KahDeA: every Transform vs. the humanoid bones").save(out)


# ---------------------------------------------------------------------------
def fig_muscle_sweeps(sc: Scene, out: Path) -> None:
    rows = [("Left Arm Down-Up", 0), ("Left Forearm Stretch", 0), ("Head Nod Down-Up", -90),
            ("Left Upper Leg Front-Back", -90)]
    values = np.array([-1.0, -0.5, 0.0, 0.5, 1.0])
    cell = (220, 330)
    cam = dict(target=(0.0, 0.84, 0.0), dist=4.9, fov_deg=24.0)
    times0, base, attrs = sc.clip(IDLE, IDLE_CLIP)
    label_w, head_h = 230, 34
    sheet = Image.new("RGB", (label_w + cell[0] * len(values), head_h + cell[1] * len(rows)), hex_rgb(SURFACE_HEX))
    for c, v in enumerate(values):
        caption(sheet, (label_w + c * cell[0] + cell[0] // 2, 10), f"{v:+.1f}" if v else "0", 15, TEXT, "ma")
    with tempfile.TemporaryDirectory() as tmp:
        for r, (muscle, view) in enumerate(rows):
            attr = UA.MUSCLE_BASE + UA.MUSCLE_NAMES.index(muscle)
            vals = np.repeat(base[:, :1], len(values), axis=1)
            a = list(attrs)
            if attr not in a:
                vals = np.vstack([vals, np.zeros((1, len(values)))])
                a.append(attr)
            vals[a.index(attr)] = values
            times = np.arange(len(values)) / 30.0
            local_r, hips_t = sc.baker.bake(times, vals, a)
            glb = Path(tmp) / f"sweep{r}.glb"
            UA.write_motion_glb(glb, sc.avatar, [("sweep", times, local_r, hips_t)], set(sc.baker.driven))
            m = RP.Motion(glb)
            y0 = head_h + r * cell[1]
            caption(sheet, (16, y0 + cell[1] // 2 - 22), muscle, 16, TEXT)
            caption(sheet, (16, y0 + cell[1] // 2 + 2), f"channel {attr}", 13, TEXT2)
            caption(sheet, (16, y0 + cell[1] // 2 + 22), "front view" if view == 0 else "seen from her left", 13, TEXT2)
            for c, t in enumerate(times):
                _, sk = sc.posed(m.sample("sweep", float(t)))
                img = RP.render(turned(sk, view), size=cell, **cam)
                sheet.paste(img, (label_w + c * cell[0], y0))
    titled(sheet, "Muscles: one number per degree of freedom, -1 … +1",
           "Each row changes one muscle of the standing pose (mot_00_00010) and bakes it with our humanoid code").save(out)


# ---------------------------------------------------------------------------
def fig_muscle_curves(sc: Scene, out: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    segments, t0 = [], 0.0
    for suffix, state in (("@i", "in"), ("@a", "action"), ("@l", "loop"), ("@o", "out")):
        times, values, attrs = sc.clip(DEMO, DEMO_BASE + suffix)
        segments.append((suffix, state, t0, times + t0, values, attrs))
        t0 += times[-1] + 1 / 30  # the clips are consecutive slices: @a's first frame follows @i's last
    body = range(UA.MUSCLE_BASE, UA.MUSCLE_BASE + len(UA.MUSCLES))

    def series(attr):
        xs, ys = [], []
        for _, _, _, t, v, a in segments:
            xs.append(t)
            ys.append(v[a.index(attr)] if attr in a else np.zeros_like(t))
        return np.concatenate(xs), np.concatenate(ys)

    ranked = sorted(body, key=lambda at: -np.ptp(series(at)[1]))[:4]
    plt.rcParams.update({"font.size": 10, "axes.edgecolor": GRID_HEX, "text.color": TEXT_HEX,
                         "axes.labelcolor": TEXT2_HEX, "xtick.color": TEXT2_HEX, "ytick.color": TEXT2_HEX})
    fig, ax = plt.subplots(figsize=(9.6, 4.6), dpi=150)
    fig.patch.set_facecolor(SURFACE_HEX)
    ax.set_facecolor(SURFACE_HEX)
    for k, (suffix, state, start, t, _, _) in enumerate(segments):
        if k % 2 == 1:
            ax.axvspan(start, t[-1], color="#232322", lw=0)
        ax.text((start + t[-1]) / 2, 1.06, f"{suffix} {state}", ha="center", va="bottom", color=TEXT2_HEX, fontsize=9.5)
    ends = []
    for k, attr in enumerate(ranked):
        x, y = series(attr)
        name = UA.MUSCLE_NAMES[attr - UA.MUSCLE_BASE]
        ax.plot(x, y, color=SERIES[k], lw=1.0, solid_joinstyle="round", solid_capstyle="round", label=f"{name} (ch {attr})")
        ends.append([y[-1], name, SERIES[k]])
    ends.sort(key=lambda e: e[0])
    for i in range(1, len(ends)):  # keep the direct labels apart
        ends[i][0] = max(ends[i][0], ends[i - 1][0] + 0.11)
    for y, name, color in ends:
        ax.plot([t0 + 0.03, t0 + 0.09], [y, y], color=color, lw=1.0, clip_on=False)
        ax.text(t0 + 0.12, y, name, va="center", color=TEXT_HEX, fontsize=9, clip_on=False)
    ax.set_xlim(0, t0)
    ax.set_ylim(-1.05, 1.05)
    ax.set_xlabel("time (s), clips played back to back")
    ax.set_ylabel("muscle value")
    ax.grid(axis="y", color=GRID_HEX, lw=0.5, ls="-")
    ax.axhline(0, color=GRID_HEX, lw=0.8)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    leg = ax.legend(loc="lower left", frameon=False, fontsize=8.5, ncol=2)
    for txt in leg.get_texts():
        txt.set_color(TEXT2_HEX)
    ax.set_title(f"{DEMO} (よく見て確認, look closely): the four body muscles that move most",
                 loc="left", color=TEXT_HEX, fontsize=11, pad=22, fontfamily=["Hiragino Sans GB", "DejaVu Sans"])
    fig.tight_layout()
    fig.subplots_adjust(right=0.80)
    fig.savefig(out, facecolor=SURFACE_HEX)
    plt.close(fig)


# ---------------------------------------------------------------------------
def fig_ik_goals(sc: Scene, out: Path) -> None:
    clip_name = DEMO_BASE + "@l"
    times, values, attrs = sc.clip(DEMO, clip_name)
    local_r, hips_t = sc.baker.bake(times, values, attrs)
    av, f = sc.avatar, 0
    ch = {a: values[i][f] for i, a in enumerate(attrs)}
    root_t = np.array([ch[UA.ROOT_T + k] for k in range(3)]) * av.scale
    root_q = UA.qnorm(np.array([ch[UA.ROOT_Q + k] for k in range(4)]))
    lt = av.h_t.copy()
    lt[av.hips] = hips_t[f]
    g, _ = av.global_pose(lt, local_r[f])

    G, sk = sc.posed(sc.demo.sample(clip_name, 0.0))
    hips_node = sc.node[sc.bone_transform("Hips")]
    M = G[sc.costume.parent[hips_node]]
    to_world = lambda p_unity: (M @ np.append(UA.unity_to_gltf_t(p_unity), 1.0))[:3]

    marks = []
    for gi, bone in ((2, "LeftHand"), (3, "RightHand")):
        base = UA.GOALS + gi * 7
        goal_u = root_t + UA.qrot(root_q, np.array([ch[base + k] for k in range(3)]) * av.scale)
        wrist_w = G[sc.node[sc.bone_transform(bone)]][:3, 3]
        fk_w = to_world(g[av.bone_node(bone)])
        marks.append((bone, to_world(goal_u), wrist_w, np.linalg.norm(to_world(goal_u) - wrist_w),
                      np.linalg.norm(fk_w - wrist_w)))

    size = (430, 720)
    cam = dict(target=(0.0, 0.9, 0.0), dist=4.0, fov_deg=24.0)
    panels = []
    for view, name in ((0, "front"), (-90, "from her left")):
        img = RP.render(turned(sk, view), size=size, **cam)
        d = ImageDraw.Draw(img)
        R = yaw(view)
        for k, (bone, goal, wrist, err, _) in enumerate(marks):
            color = hex_rgb(SERIES[k])
            (gx, gy), (wx, wy) = project(np.stack([R @ goal, R @ wrist]), size, **cam)
            d.ellipse([gx - 11, gy - 11, gx + 11, gy + 11], outline=color, width=3)
            d.ellipse([wx - 3, wy - 3, wx + 3, wy + 3], fill=(255, 255, 255))
        caption(img, (12, 12), name, 15, TEXT)
        panels.append(img)
    body = Image.new("RGB", (size[0] * 2, size[1] + 70), hex_rgb(SURFACE_HEX))
    for i, p in enumerate(panels):
        body.paste(p, (i * size[0], 0))
    d = ImageDraw.Draw(body)
    for k, (bone, _, _, err, fk_err) in enumerate(marks):
        y = size[1] + 14 + k * 26
        d.ellipse([16, y - 1, 34, y + 17], outline=hex_rgb(SERIES[k]), width=3)
        caption(body, (46, y + 8), f"{bone} IK goal (from the clip's own curves) vs. the baked wrist ● : "
                                     f"{err * 100:.1f} cm apart", 14, TEXT, "lm")
    print(f"  ik-goals: python FK vs. GLB-in-renderer wrist: {max(m[4] for m in marks) * 1000:.2f} mm; "
          f"goal errors: {', '.join(f'{m[0]} {m[3] * 100:.2f} cm' for m in marks)}")
    titled(body, "Checking the bake against the clip itself",
           f"{clip_name}: the rings are where Unity's IK goals put the hands, the dots are our exported pose").save(out)


# ---------------------------------------------------------------------------
def fig_filmstrip(sc: Scene, out: Path) -> None:
    shots = [("@i", 0.0, "in"), ("@i", 0.2, "in"), ("@a", 0.2, "action"), ("@a", 0.5, "action"),
             ("@l", 0.1, "loop"), ("@o", 0.6, "out"), ("@o", 9.0, "out (end)")]
    cell = (190, 330)
    cam = dict(target=(0.0, 0.84, 0.0), dist=4.3, fov_deg=24.0)
    strip = Image.new("RGB", (cell[0] * len(shots), cell[1] + 40), hex_rgb(SURFACE_HEX))
    for k, (suffix, t, state) in enumerate(shots):
        clip = DEMO_BASE + suffix
        t = min(t, sc.demo.duration(clip))
        _, sk = sc.posed(sc.demo.sample(clip, t))
        strip.paste(RP.render(sk, size=cell, **cam), (k * cell[0], 0))
        caption(strip, (k * cell[0] + cell[0] // 2, cell[1] + 8), f"{suffix} {state}  {t:.2f}s", 14, TEXT, "ma")
    titled(strip, f"{DEMO} (よく見て確認, look closely) through its four clips",
           "in → action → loop (repeats until the next motion) → out").save(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "docs" / "media" / "crash-course"))
    ap.add_argument("--only", nargs="*", help="subset of: skeleton sweeps curves ik filmstrip")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    sc = Scene()
    figs = {"skeleton": (fig_skeleton, "skeleton.png"), "sweeps": (fig_muscle_sweeps, "muscle-sweeps.png"),
            "curves": (fig_muscle_curves, "muscle-curves.png"), "ik": (fig_ik_goals, "ik-goals.png"),
            "filmstrip": (fig_filmstrip, "clip-filmstrip.png")}
    for key, (fn, name) in figs.items():
        if args.only and key not in args.only:
            continue
        fn(sc, out / name)
        print(f"wrote {out / name}")


if __name__ == "__main__":
    main()
