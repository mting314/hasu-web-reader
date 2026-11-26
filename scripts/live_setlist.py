#!/usr/bin/env python3
"""Label the setlist in a live's index.json from the iOS bundle index.

alst_export.py records which stage timeline (3d_timeline_NNNNNNNNNN) the TimelineReceiver started
and when. A timeline bundle's dependencies are Timeline playables named after the song or
segment, e.g. `__aishii_2603root_copied_aishii_2603.playable`, so the label is the common stem
(`aishii_2603`). Timelines with cameras/animators are songs; the small ones are talk/MC parts.

With --songs, song timelines also get their official Japanese/English titles from
hamproductions/the-sorter's data/song-info.json (matched on the romanized title):
  gh api -H "Accept: application/vnd.github.raw" repos/hamproductions/the-sorter/contents/data/song-info.json > song-info.json

Usage: live_setlist.py <index.json> [--bundle-index <ios_index.jsonl>] [--songs song-info.json]
"""
from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path

# <main checkout>/.claude/worktrees/<name>/scripts/live_setlist.py -> <main checkout>
DEFAULT_INDEX = Path(__file__).resolve().parents[4] / ".inspect-tmp" / "ios_index.jsonl"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("index", type=Path)
    ap.add_argument("--bundle-index", type=Path, default=DEFAULT_INDEX)
    ap.add_argument("--songs", type=Path, help="the-sorter data/song-info.json for official titles")
    a = ap.parse_args()

    norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())  # noqa: E731
    songs = json.loads(a.songs.read_text()) if a.songs else []

    def official(label: str) -> dict | None:
        key = norm(label)
        for match in (lambda e: e == key, lambda e: e.startswith(key), lambda e: key in e):
            hits = [s for s in songs if norm(s.get("englishName")) and match(norm(s.get("englishName")))]
            if hits:
                s = max(hits, key=lambda s: s.get("releasedOn") or "")
                return {"songId": s["id"], "titleJa": s["name"], "titleEn": s.get("englishName") or s["name"]}
        return None

    rows = [json.loads(l) for l in a.bundle_index.open()]
    by_cab = {c.split(".")[0]: r for r in rows for c in r["cabs"]}
    by_container = {c: r for r in rows for c in r["containers"]}

    live = json.loads(a.index.read_text())
    for tl in live["timelines"]:
        rec = by_container.get(tl["timeline"])
        if not rec:
            tl["label"], tl["kind"] = tl["timeline"], "unknown"
            continue
        stems = collections.Counter()
        for dep in rec["deps"]:
            for c in by_cab.get(dep, {}).get("containers", []):
                m = re.match(r"__(.+?)(?:root|common|ch|cam|bg|fs|mfs|effect|audience|pinspot|screen)?_copied_(.+)\.playable$", c)
                if m:
                    stems[m.group(2)] += 1
        song = rec["types"].get("Camera", 0) > 0
        tl["label"] = stems.most_common(1)[0][0] if stems else tl["timeline"]
        tl["kind"] = "song" if song else "talk"
        for k in ("songId", "titleJa", "titleEn"):
            tl.pop(k, None)
        if song and songs:
            tl.update(official(re.sub(r"_\d{4}$", "", tl["label"])) or {})
    a.index.write_text(json.dumps(live, indent=1, ensure_ascii=False))
    for tl in live["timelines"]:
        m, s = divmod(int(max(0, tl["start"])), 60)
        title = f"{tl.get('titleEn', '')} / {tl.get('titleJa', '')}" if tl.get("titleEn") else ""
        print(f"{m:3d}:{s:02d}  {tl['kind']:5s} {tl['label']:28s} {title}")


if __name__ == "__main__":
    main()
