#!/usr/bin/env python3
"""Add Hasu-KO's English episode titles and synopses to public/data/story_index.json.

The Hasunosora Activity Record Translation (hasu-ko.vercel.app) has one page per monthly episode,
keyed by the game's AdvSeries id: /en/story/series/<id>, with the English title in its <h1> and the
synopsis in the <p> right after it. Pages are cached in data_cache/hasuko_en_series_<id>.html (like
the build's per-part caches). Series without a page keep titleEn / descriptionEn = null.

Usage: uv run scripts/hasuko_series_en.py [--refresh]
"""

from __future__ import annotations

import argparse
import html
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "public" / "data" / "story_index.json"
CACHE = ROOT / "data_cache"
URL = "https://hasu-ko.vercel.app/en/story/series/{}"


def page(series_id: int, refresh: bool) -> str | None:
    cache = CACHE / f"hasuko_en_series_{series_id}.html"
    if cache.exists() and not refresh:
        text = cache.read_text(encoding="utf-8")
        return text or None
    req = urllib.request.Request(URL.format(series_id), headers={"User-Agent": "hasu-web-reader (story index)"})
    try:
        text = urllib.request.urlopen(req, timeout=20).read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        text = ""
    cache.write_text(text, encoding="utf-8")  # an empty file remembers "no page"
    time.sleep(0.3)
    return text or None


def parse(text: str) -> tuple[str | None, str | None]:
    m = re.search(r"<h1[^>]*>(.*?)</h1>\s*(?:<p>(.*?)</p>)?", text, re.S)
    if not m:
        return None, None
    clean = lambda s: html.unescape(re.sub(r"<[^>]+>", "", s)).strip() if s else None
    return clean(m.group(1)), clean(m.group(2))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="re-download cached pages")
    args = ap.parse_args()
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    found = 0
    for s in index["series"]:
        text = page(s["id"], args.refresh)
        title, desc = parse(text) if text else (None, None)
        s["titleEn"], s["descriptionEn"] = title, desc
        found += title is not None
    index["source"]["en"] = "English episode titles and synopses from hasu-ko.vercel.app (/en/story/series/<id>)"
    INDEX.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{found}/{len(index['series'])} series have an English title -> {INDEX}")


if __name__ == "__main__":
    main()
