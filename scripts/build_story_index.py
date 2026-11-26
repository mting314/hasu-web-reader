#!/usr/bin/env python3
"""Build the story index behind the reader's story selector, modelled on the game's 活動記録 screen.

The game's activity-record screen (`ActivityRecordSceneController` and friends in
data-inspect/client-dump/dump.cs) is driven by two master tables:
  AdvSeries  one row per monthly episode (or special chapter): name, synopsis, YearText ("103期"),
             MonthText ("April"), FiscalYearDisplay, StorySegment (0 = main story, 1 = chapters)
  AdvDatas   one row per part: AdvSeriesId, ScriptId (= story_main_<id>.txt), OrderId, and its
             label (Description: "PART 1", or a real title for 102期's Shades of Stars)
The client only receives them from the game's servers, so they aren't in data-inspect. Their
decoded contents come from vertesan/link-like-diff (the final master data, checked out in
../hasu-dub/refs/link-like-diff). The artwork comes from the iOS bundles in data-inspect:
  image_record_monthly_<seriesId>        series card (portrait 657x1115; wide 1000x380 for chapters)
  image_record_monthly_part_<scriptId>   part thumbnail (828x238, rounded corners)
  image_record_monthly_part_00000000     the game's placeholder thumbnail

Writes public/data/story_index.json and public/assets/story/activity_record/{series,parts}/*.webp.

Usage:
  uv run --group data scripts/build_story_index.py            # index + any missing images
  uv run --group data scripts/build_story_index.py --force    # re-export every image
  uv run --group data scripts/build_story_index.py --no-images
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unity_assets as UA  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MASTER_DIR = Path("/Users/michaelting/github/hasu-dub/refs/link-like-diff")
INDEX = ROOT / ".inspect-tmp" / "ios_index.jsonl"
SCENARIO_DIR = ROOT / "public" / "data" / "scenarios"
CATALOG = ROOT / "public" / "data" / "catalog.json"
OUT_JSON = ROOT / "public" / "data" / "story_index.json"
ART_REL = "story/activity_record"
ART_DIR = ROOT / "public" / "assets" / ART_REL
PLACEHOLDER_PART = "00000000"


def slug_for_script_id(script_id: str) -> str:
    """Same as src/storySlug.ts and build_scenarios.slug_for_script_id."""
    m = re.fullmatch(r"(\d{3})(\d{3})(\d{2})", script_id)
    return f"{m[1]}-ep{int(m[2])}-part{int(m[3])}" if m else script_id


def unwrap(text: str) -> str:
    """The master data hard-wraps synopses for the game's text box; undo that (keep spaces
    only where both sides of a break are Latin letters/digits)."""
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    out = ""
    for ln in lines:
        if out and re.match(r"[A-Za-z0-9]", ln) and re.search(r"[A-Za-z0-9!?.,]$", out):
            out += " "
        out += ln
    return out


def export_image(index: UA.BundleIndex, container: str, dest: Path, force: bool) -> tuple[int, int] | None:
    if dest.exists() and not force:
        from PIL import Image

        with Image.open(dest) as im:
            return im.size
    if index.bundle_path(container) is None:
        return None
    for obj in index.load_env(container).objects:
        if obj.type.name == "Texture2D":
            img = obj.read().image
            dest.parent.mkdir(parents=True, exist_ok=True)
            img.save(dest, "WEBP", quality=82, method=6)
            return img.size
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="re-export images that already exist")
    ap.add_argument("--no-images", action="store_true", help="only write the index")
    args = ap.parse_args()

    series_rows = yaml.safe_load((MASTER_DIR / "AdvSeries.yaml").read_text(encoding="utf-8"))
    part_rows = yaml.safe_load((MASTER_DIR / "AdvDatas.yaml").read_text(encoding="utf-8"))
    master_rev = subprocess.run(
        ["git", "-C", str(MASTER_DIR), "log", "-1", "--format=%h %s"], capture_output=True, text=True
    ).stdout.strip()
    catalog = {e["scriptId"]: e for e in json.loads(CATALOG.read_text(encoding="utf-8")).get("episodes", [])}
    index = None if args.no_images else UA.BundleIndex(INDEX)

    def art(kind: str, key: str) -> tuple[str | None, tuple[int, int] | None]:
        rel = f"{ART_REL}/{kind}/{key}.webp"
        if index is None:
            path = ROOT / "public" / "assets" / rel
            return (f"/assets/{rel}", None) if path.exists() else (None, None)
        container = f"image_record_monthly_{key}" if kind == "series" else f"image_record_monthly_part_{key}"
        size = export_image(index, container, ROOT / "public" / "assets" / rel, args.force)
        return (f"/assets/{rel}", size) if size else (None, None)

    placeholder, _ = art("parts", PLACEHOLDER_PART)
    parts_by_series: dict[int, list[dict]] = {}
    for p in part_rows:
        parts_by_series.setdefault(p["AdvSeriesId"], []).append(p)

    series_out, missing_art = [], []
    for s in sorted(series_rows, key=lambda r: (r["StorySegment"], r["FiscalYearDisplay"], r["Id"])):
        card, size = art("series", str(s["Id"]))
        if card is None:
            missing_art.append(f"image_record_monthly_{s['Id']}")
        parts = []
        for p in sorted(parts_by_series.get(s["Id"], []), key=lambda r: r["OrderId"]):
            script_id = str(p["ScriptId"])
            slug = slug_for_script_id(script_id)
            thumb, _ = art("parts", script_id)
            if thumb is None:
                missing_art.append(f"image_record_monthly_part_{script_id}")
            ep = catalog.get(script_id)
            parts.append({
                "scriptId": script_id,
                "slug": slug,
                "label": unwrap(p["Description"]),       # "PART 1", or a title (Shades of Stars)
                "number": str(p["SubTitleName"]),          # "1" / "第1話"
                "thumbnail": thumb or placeholder,
                "available": (SCENARIO_DIR / f"{slug}.json").exists(),
                "titleEn": ep.get("partTitleEn") if ep else None,
            })
        ep_en = next((catalog[p["scriptId"]] for p in parts if p["scriptId"] in catalog), None)
        series_out.append({
            "id": s["Id"],
            "segment": s["StorySegment"],
            "fiscalYear": s["FiscalYearDisplay"],
            "yearText": (s.get("YearText") or "").strip(),
            "monthText": (s.get("MonthText") or "").replace("\xa0", " ").strip(),
            "title": s["Name"],
            "description": unwrap(s["Description"]),
            "titleEn": ep_en.get("seriesTitleEn") if ep_en else None,
            "descriptionEn": ep_en.get("descriptionEn") if ep_en else None,
            "card": card,
            "cardShape": "wide" if size and size[0] > size[1] else "portrait",
            "parts": parts,
        })

    years = sorted({(s["fiscalYear"], s["yearText"]) for s in series_out if s["segment"] == 0})
    out = {
        "source": {
            "master": f"AdvSeries/AdvDatas from vertesan/link-like-diff ({master_rev})",
            "art": "image_record_monthly_* sprites from the iOS asset bundles (data-inspect)",
            "layout": "ActivityRecordSceneView / StorySegment1View / Segment2View (client dump)",
        },
        "segments": [{"id": 0, "label": "Story"}, {"id": 1, "label": "Chapter"}],
        "years": [{"fiscalYear": fy, "yearText": yt} for fy, yt in years],
        "series": series_out,
    }
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_parts = sum(len(s["parts"]) for s in series_out)
    n_avail = sum(p["available"] for s in series_out for p in s["parts"])
    print(f"Wrote {OUT_JSON.relative_to(ROOT)}: {len(series_out)} series, {n_parts} parts ({n_avail} readable)")
    if missing_art:
        print(f"[WARN] {len(missing_art)} sprite(s) not in the bundle index: {', '.join(missing_art[:8])}")


if __name__ == "__main__":
    main()
