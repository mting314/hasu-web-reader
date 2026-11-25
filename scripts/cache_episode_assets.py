#!/usr/bin/env python3
"""
Local Asset Cacher for hasu-web-reader.

Scans one or more raw ADV script files (story_main_<ScriptId>.txt), resolves all referenced:
  - 3D Costume GLBs + eye highlight textures
  - 3D Story Prop (ppadv) GLBs + extraGlbs + textureMap textures
  - Character facial expression JSONs (<char>_expressions.json)
  - 3D Skeletal Motion GLBs (mot_*.glb)
  - 2D Story Background WebPs (story_bg_image_*.webp)
  - Character mini portrait icons (charamini_icon_face_sd_<charId>_01.webp)
  - Story Voice WebMs (vo_adv_*.webm)
  - Sound Effect WebMs (se_adv_*.webm)
  - Story BGM MP3s (copying from /Users/michaelting/github/hasu-dub/bgm/ first, then GCS)

Downloads everything once with a thread pool into `public/assets/` so the web reader
runs 100% against local static files without hammering GCS.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import shutil
import urllib.error
import urllib.request
from pathlib import Path

GCS_BASE = "https://storage.googleapis.com/llll-card"
ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_CACHE_DIR = ROOT_DIR / "data_cache"
PUBLIC_ASSETS_DIR = ROOT_DIR / "public" / "assets"
HASU_DUB_DIR = Path("/Users/michaelting/github/hasu-dub")

CHAR_JP_TO_INFO = {
    "花帆": {"id": 1031, "en": "kaho"},
    "さやか": {"id": 1032, "en": "sayaka"},
    "瑠璃乃": {"id": 1033, "en": "rurino"},
    "梢": {"id": 1021, "en": "kozue"},
    "綴理": {"id": 1022, "en": "tsuzuri"},
    "慈": {"id": 1023, "en": "megumi"},
    "吟子": {"id": 1041, "en": "ginko"},
    "小鈴": {"id": 1042, "en": "kosuzu"},
    "姫芽": {"id": 1043, "en": "hime"},
    "セラス": {"id": 1051, "en": "ceras"},
    "泉": {"id": 1052, "en": "izumi"},
    "沙知": {"id": 1011, "en": "sachi"},
}

BGM_ALIASES = {
    "BgmAdvMorning0001": "bgm_adv_morning_0001",
    "Morning_0001": "bgm_adv_morning_0001",
    "BgmAdvComical0001": "bgm_adv_comical_0001",
    "Comical_0001": "bgm_adv_comical_0001",
    "BgmAdvSentimental0001": "bgm_adv_sentimental_0001",
    "Sentimental_0001": "bgm_adv_sentimental_0001",
    "BgmAdvEvening0001": "bgm_adv_evening_0001",
    "Evening_0001": "bgm_adv_evening_0001",
    "BgmAdvAfternoon0001": "bgm_adv_afternoon_0001",
    "Afternoon_0001": "bgm_adv_afternoon_0001",
    "BgmAdvSerious0001": "bgm_adv_serious_0001",
    "Serious_0001": "bgm_adv_serious_0001",
}


def normalize_bgm_id(raw_bgm: str) -> str:
    if raw_bgm in BGM_ALIASES:
        return BGM_ALIASES[raw_bgm]
    # Convert PascalCase BgmAdvXxx0001 -> bgm_adv_xxx_0001
    if raw_bgm.startswith("Bgm"):
        s = re.sub(r"([a-z])([A-Z])", r"\1_\2", raw_bgm)
        s = re.sub(r"([A-Za-z])(\d+)", r"\1_\2", s)
        return s.lower()
    return raw_bgm.lower()


def download_task(url: str, dest: Path) -> tuple[str, bool, str]:
    if dest.exists() and dest.stat().st_size > 0:
        return (str(dest.relative_to(ROOT_DIR)), True, "cached")
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "hasu-web-reader-local-cacher/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(dest)
        return (str(dest.relative_to(ROOT_DIR)), True, f"downloaded ({len(data)} B)")
    except urllib.error.HTTPError as e:
        return (str(dest.relative_to(ROOT_DIR)), False, f"HTTP {e.code} ({url})")
    except Exception as e:
        return (str(dest.relative_to(ROOT_DIR)), False, f"Error {e} ({url})")


def cache_scripts(script_ids: list[str]) -> None:
    model_ctx = json.loads((DATA_CACHE_DIR / "model_viewer_context.json").read_text(encoding="utf-8"))
    assets_by_id = {a["id"]: a for a in model_ctx["data"]["assets"]}

    bgm_catalog_path = HASU_DUB_DIR / "bgm_catalog.json"
    bgm_catalog = json.loads(bgm_catalog_path.read_text(encoding="utf-8")) if bgm_catalog_path.exists() else {}

    costumes: set[str] = set()
    props: set[str] = set()
    motions: set[str] = {"mot_00_00010", "mot_00_20910"}  # standing & seated default idle motions
    bgs: set[str] = set()
    voices: set[str] = set()
    ses: set[str] = set()
    bgms: set[str] = set()
    chars_en: set[str] = {"kaho", "sayaka", "kozue", "tsuzuri", "rurino", "megumi"}
    char_ids: set[int] = {info["id"] for info in CHAR_JP_TO_INFO.values()}

    for sid in script_ids:
        txt_path = HASU_DUB_DIR / "story_main_txt" / f"story_main_{sid}.txt"
        if not txt_path.exists():
            raise FileNotFoundError(f"Missing script file: {txt_path}")
        text = txt_path.read_text(encoding="utf-8")
        costumes |= set(re.findall(r"3d_costume_\d+", text))
        props |= set(
            re.findall(
                r"\[(?:3Dオブジェクト表示|キャラ小物直接表示|キャラ小物表示)\s+(?:[^\s\]]+\s+)*?(ppadv\S+)",
                text,
            )
        )
        motions |= set(re.findall(r"mot_\d+_\d+", text))
        bgs |= set(re.findall(r"story_bg_image_\d+", text))
        voices |= set(re.findall(r"vo_adv_[^\s\]]+", text))
        ses |= set(re.findall(r"se_adv_[^\s\]]+", text))
        for raw_bgm in re.findall(r"\[BGM(?:クロスフェード)?再生\s+(\S+)", text):
            bgms.add(normalize_bgm_id(raw_bgm))

    tasks: list[tuple[str, Path]] = []

    # 1. Motions metadata & Expression JSONs
    tasks.append((f"{GCS_BASE}/3d/metadata/motions.json", PUBLIC_ASSETS_DIR / "3d/metadata/motions.json"))
    for cen in sorted(chars_en):
        rel = f"3d/animations/{cen}_expressions.json"
        tasks.append((f"{GCS_BASE}/{rel}", PUBLIC_ASSETS_DIR / rel))

    # 2. Costumes & Props (GLB + extraGlbs + textures + textureMap)
    for model_id in sorted(costumes | props):
        info = assets_by_id.get(model_id)
        if not info:
            print(f"[WARN] Model ID {model_id} not found in model_viewer_context.json")
            continue
        glb_rel = f"3d/{info['glbPath']}"
        tasks.append((f"{GCS_BASE}/{glb_rel}", PUBLIC_ASSETS_DIR / glb_rel))

        for extra in info.get("extraGlbs") or []:
            extra_rel = f"3d/{extra}"
            tasks.append((f"{GCS_BASE}/{extra_rel}", PUBLIC_ASSETS_DIR / extra_rel))

        tex_dir = info.get("textureDir") or ""
        if tex_dir and not tex_dir.endswith("/"):
            tex_dir += "/"

        # Only download matching character highlight texture for costumes, or all textures for props
        char_en = (info.get("metadata") or {}).get("characterName", "")
        char_prefix = char_en[:3].lower() if char_en else ""
        for tex in info.get("textures") or []:
            if info["category"] == "costume" and char_prefix and f"{char_prefix}_eye" not in tex.lower():
                continue
            tex_rel = f"3d/{tex_dir}{tex}"
            tasks.append((f"{GCS_BASE}/{tex_rel}", PUBLIC_ASSETS_DIR / tex_rel))

        tmap = info.get("textureMap") or {}
        for mat_entry in tmap.values():
            if isinstance(mat_entry, dict):
                for tex_file in mat_entry.values():
                    if isinstance(tex_file, str):
                        tex_rel = f"3d/{tex_dir}{tex_file}"
                        tasks.append((f"{GCS_BASE}/{tex_rel}", PUBLIC_ASSETS_DIR / tex_rel))
                        # Also check _col0 if _1stShadowTex has _col1
                        if "_col1" in tex_file:
                            col0 = tex_file.replace("_col1", "_col0")
                            col0_rel = f"3d/{tex_dir}{col0}"
                            tasks.append((f"{GCS_BASE}/{col0_rel}", PUBLIC_ASSETS_DIR / col0_rel))

    # 3. Motions
    for mot_id in sorted(motions):
        rel = f"3d/motions/{mot_id}.glb"
        tasks.append((f"{GCS_BASE}/{rel}", PUBLIC_ASSETS_DIR / rel))

    # 4. Story Backgrounds
    for bg_id in sorted(bgs):
        if bg_id == "story_bg_image_000":
            continue
        rel = f"story/backgrounds/{bg_id}.webp"
        tasks.append((f"{GCS_BASE}/{rel}", PUBLIC_ASSETS_DIR / rel))

    # 5. Character Face Icons
    for cid in sorted(char_ids):
        rel = f"assets/charaicon/charamini_icon_face_sd_{cid}_01.webp"
        tasks.append((f"{GCS_BASE}/{rel}", PUBLIC_ASSETS_DIR / rel))

    # 6. Story Voices
    for v_id in sorted(voices):
        if v_id == "なし":
            continue
        rel = f"story/voice/{v_id}.webm"
        tasks.append((f"{GCS_BASE}/{rel}", PUBLIC_ASSETS_DIR / rel))

    # 7. Sound Effects
    for se_id in sorted(ses):
        rel = f"sound/effects/{se_id}.webm"
        tasks.append((f"{GCS_BASE}/{rel}", PUBLIC_ASSETS_DIR / rel))

    # 8. BGM tracks (copy from hasu-dub/bgm first if available, else GCS)
    local_bgm_dir = HASU_DUB_DIR / "bgm"
    PUBLIC_BGM_DIR = PUBLIC_ASSETS_DIR / "bgm"
    PUBLIC_BGM_DIR.mkdir(parents=True, exist_ok=True)
    for bgm_id in sorted(bgms):
        dest = PUBLIC_BGM_DIR / f"{bgm_id}.mp3"
        local_src = local_bgm_dir / f"{bgm_id}.mp3"
        if local_src.exists() and not dest.exists():
            shutil.copy2(local_src, dest)
            print(f"[BGM] Copied local {local_src.name} -> {dest.relative_to(ROOT_DIR)}")
        elif not dest.exists():
            tasks.append((f"{GCS_BASE}/music/bgm-mp3/{bgm_id}.mp3", dest))

    # Deduplicate tasks by destination path
    unique_tasks: dict[Path, str] = {}
    for url, dest in tasks:
        unique_tasks[dest] = url

    print(f"Queuing {len(unique_tasks)} asset files for local caching (scripts: {', '.join(script_ids)})...")
    downloaded = 0
    cached = 0
    failed: list[tuple[str, str]] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(download_task, url, dest) for dest, url in unique_tasks.items()]
        for fut in concurrent.futures.as_completed(futures):
            rel_path, ok, msg = fut.result()
            if ok:
                if msg == "cached":
                    cached += 1
                else:
                    downloaded += 1
            else:
                failed.append((rel_path, msg))

    print(f"Done! Downloaded: {downloaded}, Already cached: {cached}, Failed: {len(failed)}")
    for rel_path, msg in failed[:15]:
        print(f"  [WARN] {rel_path}: {msg}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("scripts", nargs="*", default=["10300101"], help="Script IDs to cache")
    args = parser.parse_args()
    cache_scripts(args.scripts)
