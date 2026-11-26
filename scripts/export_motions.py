#!/usr/bin/env python3
"""Export story motions from the raw game data (data-inspect/) as GLB files for the reader.

Each motion (`mot_00_NNNNN`) is a Unity asset bundle holding Mecanim *humanoid* AnimationClips
(`m_00_NNNNN@i/@a/@l/@o` = in / action / loop / out, plus `m_breathing@l` and hand-grip clips)
and an AnimatorController. Humanoid clips store muscle values, not bone transforms, so they are
baked onto a reference Avatar (Kaho's body rig by default, the skeleton the reader retargets
from) using Unity's humanoid math, and written as glTF animations with the same coordinate
conventions as the costume GLBs.

Usage:
  uv run scripts/export_motions.py --scripts 10300101 10300102     # every motion those parts use
  uv run scripts/export_motions.py mot_00_01060 mot_00_20110         # specific motions
Options:
  --index PATH      bundle index (default: .inspect-tmp/ios_index.jsonl, see build_bundle_index.py)
  --avatar NAME     reference rig container (default: __scsch011kahdea.fbx)
  --out DIR         output directory (default: public/assets/3d/motions)
  --check           report how far baked wrists land from each clip's own hand IK goals
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unity_assets as UA  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HASU_DUB_DIR = Path("/Users/michaelting/github/hasu-dub")
DEFAULT_INDEX = ROOT / ".inspect-tmp" / "ios_index.jsonl"
DEFAULT_OUT = ROOT / "public" / "assets" / "3d" / "motions"
CLIP_ORDER = ("@i", "@a", "@l", "@o")


def motions_in_scripts(script_ids: list[str]) -> list[str]:
    found = {"mot_00_00010"}  # default standing motion every character spawns with
    for sid in script_ids:
        text = (HASU_DUB_DIR / "story_main_txt" / f"story_main_{sid}.txt").read_text(encoding="utf-8")
        found.update(re.findall(r"\[キャラモーション(?:即時)?再生\s+\S+\s+(mot_[0-9_]+)", text))
    return sorted(found)


def clip_sort_key(name: str, motion_id: str) -> tuple:
    main = "m_" + motion_id[len("mot_"):]
    for i, suffix in enumerate(CLIP_ORDER):
        if name == main + suffix:
            return (0, i, name)
    return (1, 0, name)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("motions", nargs="*")
    ap.add_argument("--scripts", nargs="*", default=[])
    ap.add_argument("--index", default=str(DEFAULT_INDEX))
    ap.add_argument("--avatar", default="__scsch011kahdea.fbx")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    motion_ids = sorted(set(args.motions) | set(motions_in_scripts(args.scripts) if args.scripts else []))
    if not motion_ids:
        ap.error("give motion ids or --scripts")
    if not Path(args.index).exists():
        sys.exit(f"bundle index not found: {args.index} (build it with scripts/build_bundle_index.py)")

    index = UA.BundleIndex(args.index)
    avatars = UA.objects_of_type(index.load_env(args.avatar), "Avatar")
    if not avatars:
        sys.exit(f"no Avatar in {args.avatar}")
    avatar = UA.Avatar(avatars[0])
    baker = UA.HumanoidBaker(avatar)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Reference rig: {avatar.name} ({len(avatar.node_names)} transforms, human scale {avatar.scale:.3f})")

    missing, worst = [], 0.0
    for mid in motion_ids:
        if index.bundle_path(mid) is None:
            missing.append(mid)
            continue
        clips = UA.objects_of_type(index.load_env(mid), "AnimationClip")
        baked, notes = [], []
        for clip in sorted(clips, key=lambda c: clip_sort_key(c["m_Name"], mid)):
            times, values, attrs = UA.decode_clip(clip)
            local_r, hips_t = baker.bake(times, values, attrs)
            baked.append((clip["m_Name"], times, local_r, hips_t))
            if args.check and clip["m_Name"].startswith("m_" + mid[4:]):
                err = baker.check(times, values, attrs, local_r, hips_t)
                worst = max(worst, err)
                notes.append(f"{clip['m_Name'].split('@')[-1]}={err * 100:.2f}cm")
        UA.write_motion_glb(out_dir / f"{mid}.glb", avatar, baked, set(baker.driven))
        print(f"  {mid}: {len(baked)} clips" + (f"  (hand-goal error {' '.join(notes)})" if notes else ""))

    print(f"Wrote {len(motion_ids) - len(missing)} motion(s) to {out_dir}")
    if args.check:
        print(f"Worst mean hand-goal error: {worst * 100:.2f} cm")
    if missing:
        print(f"[WARN] not in the bundle index: {', '.join(missing)}")


if __name__ == "__main__":
    main()
