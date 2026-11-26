#!/usr/bin/env python3
"""
Local Asset Cacher for hasu-web-reader.

Scans one or more raw ADV script files (story_main_<ScriptId>.txt), resolves all referenced:
  - 3D Costume GLBs + eye highlight textures
  - 3D Story Prop (ppadv) GLBs + extraGlbs + textureMap textures
  - Character emotion data (3d/emotions/emotion_<name>.json, from scripts/export_emotions.py)
  - 3D Skeletal Motion GLBs (mot_*.glb)
  - 2D Story Background WebPs (story_bg_image_*.webp)
  - Character mini portrait icons (charamini_icon_face_sd_<charId>_01.webp)
  - Story Voice WebMs (vo_adv_*.webm)
  - Sound Effect WebMs (se_adv_*.webm)
  - Story BGM MP3s (copying from /Users/michaelting/github/hasu-dub/bgm/ first, then the bucket)
  - Per-costume toon material files (<costume>_materials.json), when published

Downloads everything once with a thread pool into `public/assets/` from our own asset
bucket (`gs://hasu-web-reader-assets`, which mirrors the `public/assets/` layout) using
authenticated `gcloud storage cp` so the web reader can run against local static files even
while the bucket is private. Assets that aren't in the bucket yet have to be exported from
the raw game data and uploaded with `scripts/upload_assets_gcs.sh` first.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

GCS_BUCKET = os.environ.get("HASU_ASSET_BUCKET", "gs://hasu-web-reader-assets").rstrip("/")
HTTP_BASE = os.environ.get("HASU_ASSET_BASE_URL", "").rstrip("/")
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
    "セラス": {"id": 1052, "en": "ceras"},
    "泉": {"id": 1051, "en": "izumi"},
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


def download_task(rel_path: str, dest: Path) -> tuple[str, bool, str]:
    rel_display = str(dest.relative_to(ROOT_DIR))
    if dest.exists() and dest.stat().st_size > 0:
        return (rel_display, True, "cached")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")

    # Prefer authenticated `gcloud storage cp` against gs://hasu-web-reader-assets unless the
    # caller explicitly pointed HASU_ASSET_BASE_URL at an HTTP mirror.
    if not HTTP_BASE and shutil.which("gcloud"):
        gcs_uri = f"{GCS_BUCKET}/{rel_path}"
        try:
            proc = subprocess.run(
                ["gcloud", "storage", "cp", "--quiet", gcs_uri, str(tmp)],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            if proc.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
                size = tmp.stat().st_size
                tmp.replace(dest)
                return (rel_display, True, f"downloaded ({size} B)")
            tmp.unlink(missing_ok=True)
            err = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip().splitlines()
            msg = err[-1] if err else f"exit {proc.returncode}"
            return (rel_display, False, f"gcloud: {msg} ({gcs_uri})")
        except Exception as e:  # noqa: BLE001
            tmp.unlink(missing_ok=True)
            return (rel_display, False, f"gcloud error {e} ({gcs_uri})")

    base = HTTP_BASE or "https://storage.googleapis.com/hasu-web-reader-assets"
    url = f"{base}/{rel_path}"
    req = urllib.request.Request(url, headers={"User-Agent": "hasu-web-reader-local-cacher/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        tmp.write_bytes(data)
        tmp.replace(dest)
        return (rel_display, True, f"downloaded ({len(data)} B)")
    except urllib.error.HTTPError as e:
        return (rel_display, False, f"HTTP {e.code} ({url})")
    except Exception as e:  # noqa: BLE001
        return (rel_display, False, f"Error {e} ({url})")


def cache_scripts(script_ids: list[str]) -> None:
    model_ctx = json.loads((DATA_CACHE_DIR / "model_viewer_context.json").read_text(encoding="utf-8"))
    assets_by_id = {a["id"]: a for a in model_ctx["data"]["assets"]}

    costumes: set[str] = set()
    props: set[str] = set()
    motions: set[str] = {"mot_00_00010", "mot_00_20910"}  # standing & seated default idle motions
    bgs: set[str] = set()
    voices: set[str] = set()
    ses: set[str] = set()
    bgms: set[str] = set()
    emotions: set[str] = set()
    char_ids: set[int] = {info["id"] for info in CHAR_JP_TO_INFO.values()}

    for sid in script_ids:
        txt_path = DATA_CACHE_DIR / "story_main_txt" / f"story_main_{sid}.txt"
        if not txt_path.exists():
            txt_path = HASU_DUB_DIR / "story_main_txt" / f"story_main_{sid}.txt"
        if not txt_path.exists():
            raise FileNotFoundError(f"Missing script file: {txt_path}")
        text = txt_path.read_text(encoding="utf-8")
        costumes |= set(re.findall(r"3d_costume_\d+", text))
        emotions |= set(re.findall(r"\[キャラ表示\s+\S+\s+\S+\s+(emotion_[^\s\]]+)", text))
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
    optional: set[Path] = set()  # may legitimately be absent from the bucket

    # 1. Motions metadata & emotion data
    tasks.append(("3d/metadata/motions.json", PUBLIC_ASSETS_DIR / "3d/metadata/motions.json"))
    for name in sorted(emotions):
        rel = f"3d/emotions/{name}.json"
        tasks.append((rel, PUBLIC_ASSETS_DIR / rel))

    # 2. Costumes & Props (GLB + extraGlbs + textures + textureMap)
    for model_id in sorted(costumes | props):
        info = assets_by_id.get(model_id)
        if not info:
            print(f"[WARN] Model ID {model_id} not found in model_viewer_context.json")
            continue
        glb_rel = f"3d/{info['glbPath']}"
        tasks.append((glb_rel, PUBLIC_ASSETS_DIR / glb_rel))
        if model_id in costumes and glb_rel.endswith(".glb"):
            # toon material values exported from the game (scripts/export_toon_materials.py)
            mat_rel = f"{glb_rel[:-len('.glb')]}_materials.json"
            tasks.append((mat_rel, PUBLIC_ASSETS_DIR / mat_rel))
            optional.add(PUBLIC_ASSETS_DIR / mat_rel)

        for extra in info.get("extraGlbs") or []:
            extra_rel = f"3d/{extra}"
            tasks.append((extra_rel, PUBLIC_ASSETS_DIR / extra_rel))

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
            tasks.append((tex_rel, PUBLIC_ASSETS_DIR / tex_rel))

        tmap = info.get("textureMap") or {}
        for mat_entry in tmap.values():
            if isinstance(mat_entry, dict):
                for tex_file in mat_entry.values():
                    if isinstance(tex_file, str):
                        tex_rel = f"3d/{tex_dir}{tex_file}"
                        tasks.append((tex_rel, PUBLIC_ASSETS_DIR / tex_rel))
                        # Also check _col0 if _1stShadowTex has _col1
                        if "_col1" in tex_file:
                            col0 = tex_file.replace("_col1", "_col0")
                            col0_rel = f"3d/{tex_dir}{col0}"
                            tasks.append((col0_rel, PUBLIC_ASSETS_DIR / col0_rel))

    # 3. Motions
    for mot_id in sorted(motions):
        rel = f"3d/motions/{mot_id}.glb"
        tasks.append((rel, PUBLIC_ASSETS_DIR / rel))

    # 4. Story Backgrounds
    for bg_id in sorted(bgs):
        if bg_id == "story_bg_image_000":
            continue
        rel = f"story/backgrounds/{bg_id}.webp"
        tasks.append((rel, PUBLIC_ASSETS_DIR / rel))

    # 5. Character Face Icons
    for cid in sorted(char_ids):
        rel = f"assets/charaicon/charamini_icon_face_sd_{cid}_01.webp"
        tasks.append((rel, PUBLIC_ASSETS_DIR / rel))

    # 6. Story Voices
    for v_id in sorted(voices):
        if v_id == "なし":
            continue
        rel = f"story/voice/{v_id}.webm"
        tasks.append((rel, PUBLIC_ASSETS_DIR / rel))

    # 7. Sound Effects
    for se_id in sorted(ses):
        rel = f"sound/effects/{se_id}.webm"
        tasks.append((rel, PUBLIC_ASSETS_DIR / rel))

    # 8. BGM tracks (copy from hasu-dub/bgm first if available, else GCS)
    local_bgm_dir = HASU_DUB_DIR / "bgm"
    PUBLIC_BGM_DIR = PUBLIC_ASSETS_DIR / "bgm"
    PUBLIC_BGM_DIR.mkdir(parents=True, exist_ok=True)
    for bgm_id in sorted(bgms):
        dest = PUBLIC_BGM_DIR / f"{bgm_id}.mp3"
        try:
            local_exists = local_bgm_dir.exists() and (local_bgm_dir / f"{bgm_id}.mp3").exists()
        except PermissionError:
            local_exists = False
        if local_exists and not dest.exists():
            local_src = local_bgm_dir / f"{bgm_id}.mp3"
            shutil.copy2(local_src, dest)
            print(f"[BGM] Copied local {local_src.name} -> {dest.relative_to(ROOT_DIR)}")
        elif not dest.exists():
            tasks.append((f"bgm/{bgm_id}.mp3", dest))
        # the re-export from the game's CRI banks with its loop points (scripts/export_bgm.py)
        webm = PUBLIC_BGM_DIR / f"{bgm_id}.webm"
        if not webm.exists():
            tasks.append((f"bgm/{bgm_id}.webm", webm))
            optional.add(webm)

    # Deduplicate tasks by destination path
    unique_tasks: dict[Path, str] = {}
    for rel_path, dest in tasks:
        unique_tasks[dest] = rel_path

    print(f"Queuing {len(unique_tasks)} asset files for local caching (scripts: {', '.join(script_ids)})...")
    downloaded = 0
    cached = 0
    failed: list[tuple[str, str]] = []
    not_published: list[str] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(download_task, rel_path, dest) for dest, rel_path in unique_tasks.items()]
        for fut in concurrent.futures.as_completed(futures):
            rel_display, ok, msg = fut.result()
            if ok:
                if msg == "cached":
                    cached += 1
                else:
                    downloaded += 1
            elif ROOT_DIR / rel_display in optional:
                not_published.append(rel_display)
            else:
                failed.append((rel_display, msg))

    print(f"Done! Downloaded: {downloaded}, Already cached: {cached}, Failed: {len(failed)}")
    if not_published:
        print(f"  ({len(not_published)} optional file(s) not published yet, e.g. {not_published[0]})")
    for rel_display, msg in failed[:15]:
        print(f"  [WARN] {rel_display}: {msg}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("scripts", nargs="*", default=["10300101"], help="Script IDs to cache")
    args = parser.parse_args()
    cache_scripts(args.scripts)
