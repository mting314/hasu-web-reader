#!/usr/bin/env python3
"""Export story backgrounds (`story_bg_image_NNN`) from the raw game data as WebP for the reader.

Each background is a self-contained bundle: one Texture2D and the Sprite drawn from it. The
image is the whole texture (the sprite rect covers it, pivot centred), so it is written as is;
the store's existing backgrounds are the same pixels (lossy WebP of the same texture).

Sizes differ: most are 1940x1100 at 100 pixels per unit (a 19.4 x 11.0 m quad), but e.g.
story_bg_image_002 is 1823x2048 at 93.94. The Sprite's size and pixels-per-unit go to
data_cache/background_sizes.json (id -> [width, height, pixelsPerUnit]), merged across runs.

Usage:
  uv run scripts/export_backgrounds.py story_bg_image_006 [...] [--out public/assets/story/backgrounds]
  uv run scripts/export_backgrounds.py --list ids.txt
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unity_assets as UA  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INDEX = ROOT / ".inspect-tmp" / "ios_index.jsonl"
DEFAULT_OUT = ROOT / "public" / "assets" / "story" / "backgrounds"
SIZES_PATH = ROOT / "data_cache" / "background_sizes.json"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("backgrounds", nargs="*")
    ap.add_argument("--list", help="file with one background id per line")
    ap.add_argument("--index", default=str(DEFAULT_INDEX))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--quality", type=int, default=90, help="WebP quality (lossy)")
    args = ap.parse_args()
    ids = list(args.backgrounds)
    if args.list:
        ids += Path(args.list).read_text().split()
    if not ids:
        ap.error("give background ids or --list")

    index = UA.BundleIndex(args.index)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    sizes = json.loads(SIZES_PATH.read_text()) if SIZES_PATH.exists() else {}
    failed = []
    for bid in ids:
        try:
            env = index.load_env(bid)
            tex = next(o.read() for o in env.objects if o.type.name == "Texture2D")
            sprite = next(o.read_typetree() for o in env.objects if o.type.name == "Sprite")
            img = tex.image
            img = img.convert("RGBA" if img.mode in ("RGBA", "LA") and img.getextrema()[-1][0] < 255 else "RGB")
            dest = out / f"{bid}.webp"
            img.save(dest, "WEBP", quality=args.quality, method=4)
            rect = sprite["m_Rect"]
            sizes[bid] = [int(rect["width"]), int(rect["height"]), round(float(sprite["m_PixelsToUnits"]), 4)]
            print(f"{bid}: {img.size[0]}x{img.size[1]} {img.mode}, {sizes[bid][2]} px/unit -> {dest} ({dest.stat().st_size // 1024} KB)")
        except Exception as e:  # noqa: BLE001 - report and carry on with the rest
            failed.append(bid)
            print(f"[FAIL] {bid}: {e!r}")
    lines = [f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in sorted(sizes.items())]
    SIZES_PATH.write_text("{\n" + ",\n".join(lines) + "\n}\n")
    print(f"Wrote {len(ids) - len(failed)} background(s); sizes in {SIZES_PATH.relative_to(ROOT)}")
    if failed:
        print(f"[WARN] failed: {' '.join(failed)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
