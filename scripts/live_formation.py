#!/usr/bin/env python3
"""Place the members on stage: per-member offsets from motion-capture space to stage slots.

Each performer is captured in her own space, so raw body positions don't line up on stage. The
game parents every avatar to an anchor (Inspix PositionController), and in this recording nothing
moves the anchors: the song/MC timelines have no CharacterMove tracks and no position stream is
sent. So within one costume period (avatars are re-spawned at a costume change) each member's
offset is constant. The recording doesn't carry the slots themselves, so they are read off the
archive video at an MC lineup: the left-to-right order (as seen from the audience) and the
spacing. Every member returns to the same capture spot at MC lineups, which makes this
reproducible.

For each period: home_i = member i's median raw position around the reference time,
slot_i = an evenly spaced line along x facing the audience (+z), offset_i = slot_i - home_i
(x and z; height untouched). Seen from the audience, screen-left is +x in Unity space.

Writes members[].offsets = [{"from": t, "dx": .., "dz": ..}] into index.json.

Usage:
  live_formation.py <live dir> --lineup FROM REF_TIME SPACING NAME,NAME,... [--lineup ...]
"""
from __future__ import annotations

import argparse
import json
import statistics
import struct
from pathlib import Path


def read_chunk(path: Path) -> dict[int, tuple[list[float], list[tuple[float, float, float]]]]:
    buf = path.read_bytes()
    o, out = 16, {}
    for _ in range(struct.unpack_from("<H", buf, 6)[0]):
        cid, _, n = struct.unpack_from("<HHI", buf, o)
        o += 8
        times = list(struct.unpack_from(f"<{n}f", buf, o))
        o += 4 * n
        flat = struct.unpack_from(f"<{3 * n}f", buf, o)
        o += 12 * n + 16 * n + 190 * n
        o = (o + 3) & ~3
        out[cid] = (times, [tuple(flat[3 * i: 3 * i + 3]) for i in range(n)])
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("live_dir", type=Path)
    ap.add_argument("--lineup", nargs=4, action="append", required=True,
                    metavar=("FROM", "REF_TIME", "SPACING", "ORDER"))
    a = ap.parse_args()

    index_path = a.live_dir / "index.json"
    index = json.loads(index_path.read_text())
    by_name = {m["name"].lower(): m for m in index["members"]}
    for m in index["members"]:
        m["offsets"] = []

    for start_s, ref_s, spacing_s, order_s in sorted(a.lineup, key=lambda l: float(l[0])):
        start, ref, spacing = float(start_s), float(ref_s), float(spacing_s)
        order = [n.strip().lower() for n in order_s.split(",")]
        missing = set(by_name) - set(order)
        if missing:
            raise SystemExit(f"lineup at {ref}s is missing {sorted(missing)}")
        chunk = read_chunk(a.live_dir / "motion" / f"chunk_{int(ref // index['chunkSeconds']):04d}.bin")
        n = len(order)
        print(f"period from {start:.0f}s, lineup at {ref:.0f}s, spacing {spacing} m:")
        for i, name in enumerate(order):
            m = by_name[name]
            times, pos = chunk[m["characterId"]]
            near = [p for t, p in zip(times, pos) if abs(t - ref) <= 1.0]
            home = [statistics.median(p[k] for p in near) for k in range(3)]
            slot_x = ((n - 1) / 2 - i) * spacing
            dx, dz = slot_x - home[0], 0.0 - home[2]
            m["offsets"].append({"from": start, "dx": round(dx, 4), "dz": round(dz, 4)})
            print(f"  {i + 1:2d} {m['name']:8s} home x {home[0]:8.2f} z {home[2]:6.2f} -> slot x {slot_x:6.2f}")
    index_path.write_text(json.dumps(index, indent=1, ensure_ascii=False))
    print("wrote", index_path)


if __name__ == "__main__":
    main()
