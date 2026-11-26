#!/usr/bin/env python3
"""Proof render: decode one member's MotionCommunicator stream from an alst segment, bake it on
the member's own Avatar with the story-motion pipeline (unity_assets.HumanoidBaker), and render
it on a costume with render_motion_preview's CPU renderer.

unity_assets.py and render_motion_preview.py currently live only in the main checkout (the other
session's uncommitted work), so this script imports them from there.

Usage (from the main checkout's uv environment, which has UnityPy/numpy/Pillow):
  uv run --project <main checkout> python -I scripts/alst_render_proof.py SEGMENT.ts \
      --character 1021 --avatar __scsch012kozdea.fbx --costume 3d_costume_1001102101 \
      --seconds 6 --out /tmp/kozue.mp4
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MAIN = HERE.parents[3]  # <main checkout>/.claude/worktrees/<name>/scripts -> <main checkout>
sys.path[:0] = [str(HERE), str(MAIN / "scripts")]

import alst_decode as A  # noqa: E402
import render_motion_preview as R  # noqa: E402
import unity_assets as UA  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("segments", nargs="+", type=Path)
    ap.add_argument("--character", type=int, default=1021)
    ap.add_argument("--avatar", default="__scsch012kozdea.fbx")
    ap.add_argument("--costume", default="3d_costume_1001102101")
    ap.add_argument("--seconds", type=float, default=6.0)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--out", type=Path, default=Path("/tmp/alst-proof.mp4"))
    a = ap.parse_args()

    packets = A.motion_streams(a.segments)[a.character]
    times = np.array([p["time"] for p in packets])
    times -= times[0]
    keep = times <= a.seconds
    packets = [p for p, k in zip(packets, keep) if k]
    times = times[keep]
    print(f"{A.CHARACTERS[a.character]}: {len(packets)} packets over {times[-1]:.2f}s")

    index = UA.BundleIndex(MAIN / ".inspect-tmp" / "ios_index.jsonl")
    avatar = UA.Avatar(UA.objects_of_type(index.load_env(a.avatar), "Avatar")[0])
    baker = UA.HumanoidBaker(avatar)

    pos = np.array([p["body_position"] for p in packets])
    pos[:, [0, 2]] -= pos[:, [0, 2]].mean(axis=0)  # centre the member on the camera, keep height
    rot = np.array([p["body_rotation"] for p in packets])
    mus = np.array([p["muscles"] for p in packets])
    attrs = list(range(UA.ROOT_T, UA.ROOT_T + 3)) + list(range(UA.ROOT_Q, UA.ROOT_Q + 4)) + \
        list(range(UA.MUSCLE_BASE, UA.MUSCLE_BASE + 95))
    values = np.concatenate([pos.T / avatar.scale, rot.T, mus.T], axis=0)
    local_r, hips_t = baker.bake(times, values, attrs)

    with tempfile.TemporaryDirectory() as tmp:
        glb = Path(tmp) / "live.glb"
        UA.write_motion_glb(glb, avatar, [("live", times, local_r, hips_t)], set(baker.driven))
        motion = R.Motion(glb)
        costume = R.Costume(R.ASSETS / "costume" / a.costume / f"{a.costume}.glb")
        frames_dir = Path(tmp) / "frames"
        frames_dir.mkdir()
        n = int(times[-1] * a.fps)
        for i in range(n):
            t = i / a.fps
            img = R.render(costume.skin(costume.pose(motion.sample("live", t))))
            img.save(frames_dir / f"{i:05d}.png")
            if i % 30 == 0:
                print(f"  frame {i}/{n}")
        a.out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(a.fps), "-i",
                        str(frames_dir / "%05d.png"), "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                        str(a.out)], check=True)
        mid = frames_dir / f"{n // 2:05d}.png"
        sheet = [R.Image.open(frames_dir / f"{int(k * (n - 1) / 5):05d}.png") for k in range(6)]
        w, h = sheet[0].size
        contact = R.Image.new("RGB", (w * 6, h))
        for k, im in enumerate(sheet):
            contact.paste(im, (k * w, 0))
        contact.save(a.out.with_suffix(".png"))
    print("wrote", a.out, "and", a.out.with_suffix(".png"))


if __name__ == "__main__":
    main()
