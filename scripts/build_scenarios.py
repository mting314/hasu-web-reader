#!/usr/bin/env python3
"""
ADV Script Compiler & Bilingual Translation Aligner for hasu-web-reader.

Compiles raw Link! Like! Love Live! story scripts (`story_main_<ScriptId>.txt`) into
seekable 3D scene snapshots + intra-turn choreography timelines + aligned multi-source
bilingual translations (`public/data/scenarios/<slug>.json`, e.g. 103-ep1-part1.json, and `public/data/catalog.json`).
"""

from __future__ import annotations

import copy
import html
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_CACHE_DIR = ROOT_DIR / "data_cache"
PUBLIC_DIR = ROOT_DIR / "public"
PUBLIC_ASSETS_DIR = PUBLIC_DIR / "assets"
PUBLIC_DATA_DIR = PUBLIC_DIR / "data"
HASU_DUB_DIR = Path("/Users/michaelting/github/hasu-dub")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jp_lexer  # noqa: E402

JMDICT_RELEASE_URL = (
    "https://github.com/scriptin/jmdict-simplified/releases/download/"
    "3.6.2%2B20261123231529/jmdict-eng-3.6.2%2B20261123231529.json.zip"
)
SE_DURATIONS_CACHE = DATA_CACHE_DIR / "se_durations.json"
# Some exported "ambience" cues are a single sub-second fragment (e.g. one footstep);
# looping those turns into an endless tapping sound, so only real beds loop.
MIN_LOOP_SE_SEC = 3.0


def load_lexer() -> jp_lexer.Lexer | None:
    jm_dir = DATA_CACHE_DIR / "jmdict"
    jm_json = jp_lexer.find_jmdict_json(jm_dir)
    if not jm_json:
        jm_dir.mkdir(parents=True, exist_ok=True)
        zip_path = jm_dir / "jmdict-eng.json.zip"
        try:
            print("Downloading JMdict (scriptin/jmdict-simplified)...")
            req = urllib.request.Request(JMDICT_RELEASE_URL, headers={"User-Agent": "hasu-web-reader/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                zip_path.write_bytes(resp.read())
            shutil.unpack_archive(str(zip_path), str(jm_dir))
        except Exception as e:  # noqa: BLE001
            print(f"[WARN] JMdict unavailable ({e}); Japanese word lookup will be disabled.")
            return None
        jm_json = jp_lexer.find_jmdict_json(jm_dir)
        if not jm_json:
            return None
    dictionary = jp_lexer.Dictionary(jm_json, Path(__file__).resolve().parent / "hasu_terms.json")
    zipf = jp_lexer.load_zipf_table(DATA_CACHE_DIR / "wordfreq_ja.json")
    if not zipf:
        print("[WARN] data_cache/wordfreq_ja.json missing; segmentation falls back to dictionary-only scoring.")
    return jp_lexer.Lexer(dictionary, zipf)


_se_durations: dict[str, float] | None = None


def se_duration_sec(se_id: str) -> float | None:
    """Duration of a cached SE clip (ffprobe, memoised in data_cache/se_durations.json)."""
    global _se_durations
    if _se_durations is None:
        _se_durations = json.loads(SE_DURATIONS_CACHE.read_text(encoding="utf-8")) if SE_DURATIONS_CACHE.exists() else {}
    if se_id in _se_durations:
        return _se_durations[se_id]
    local = PUBLIC_ASSETS_DIR / "sound" / "effects" / f"{se_id}.webm"
    if not local.exists() or not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(local)],
            capture_output=True, text=True, timeout=20, check=True,
        ).stdout.strip()
        dur = round(float(out), 3)
    except Exception:  # noqa: BLE001
        return None
    _se_durations[se_id] = dur
    SE_DURATIONS_CACHE.write_text(json.dumps(_se_durations, indent=2, sort_keys=True), encoding="utf-8")
    return dur


def is_looping_se(se_id: str) -> bool:
    if "ambience" not in se_id:
        return False
    dur = se_duration_sec(se_id)
    return dur is None or dur >= MIN_LOOP_SE_SEC

CHAR_META: dict[str, dict[str, Any]] = {
    "花帆": {"id": 1031, "en": "Kaho", "enLower": "kaho", "color": "#f8b500", "lightColor": "#fff3d1"},
    "さやか": {"id": 1032, "en": "Sayaka", "enLower": "sayaka", "color": "#5383c3", "lightColor": "#dce8f7"},
    "瑠璃乃": {"id": 1033, "en": "Rurino", "enLower": "rurino", "color": "#e7609e", "lightColor": "#fce0ee"},
    "梢": {"id": 1021, "en": "Kozue", "enLower": "kozue", "color": "#68be8d", "lightColor": "#dff3e7"},
    "綴理": {"id": 1022, "en": "Tsuzuri", "enLower": "tsuzuri", "color": "#ba2636", "lightColor": "#f7d9dc"},
    "慈": {"id": 1023, "en": "Megumi", "enLower": "megumi", "color": "#c8c2c6", "lightColor": "#f2f0f1"},
    "吟子": {"id": 1041, "en": "Ginko", "enLower": "ginko", "color": "#a2d7dd", "lightColor": "#e9f6f8"},
    "小鈴": {"id": 1042, "en": "Kosuzu", "enLower": "kosuzu", "color": "#fad764", "lightColor": "#fef6dc"},
    "姫芽": {"id": 1043, "en": "Hime", "enLower": "hime", "color": "#9d8de2", "lightColor": "#ece8fa"},
    "セラス": {"id": 1052, "en": "Ceras", "enLower": "ceras", "color": "#f56565", "lightColor": "#fde2e2"},
    "泉": {"id": 1051, "en": "Izumi", "enLower": "izumi", "color": "#4fd1c5", "lightColor": "#ddf7f5"},
    "沙知": {"id": 1011, "en": "Sachi", "enLower": "sachi", "color": "#8c9eff", "lightColor": "#e8ecff"},
}

SPEAKER_EN_MAP: dict[str, str] = {
    **{k: v["en"] for k, v in CHAR_META.items()},
    "寮母": "Dorm Mother",
    "二人": "Both",
    "一同": "Everyone",
    "生徒A": "Student A",
    "生徒B": "Student B",
    "部員A": "Club Member A",
    "部員B": "Club Member B",
    "NARRATION": "Narration",
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
    if raw_bgm.startswith("Bgm"):
        s = re.sub(r"([a-z])([A-Z])", r"\1_\2", raw_bgm)
        s = re.sub(r"([A-Za-z])(\d+)", r"\1_\2", s)
        return s.lower()
    return raw_bgm.lower()


def parse_vec(s: str, default: list[float]) -> list[float]:
    try:
        parts = [float(x) for x in s.split(",")]
        return parts if len(parts) == len(default) else default
    except Exception:
        return default


def clean_text(raw_text: str) -> str:
    return (
        raw_text.replace("[r]", "\n")
        .replace("[Space]", " ")
        .replace("\\n", "\n")
        .replace("\\s", " ")
        .strip()
    )


def extract_hasuko_html_lines(html_text: str) -> list[dict[str, str]]:
    rows = re.findall(
        r'<div class="chara_[^"]+">(.*?)</div><div class="message_[^"]+">(.*?)</div>',
        html_text,
        re.S,
    )
    out = []
    for chara, msg in rows:
        c = html.unescape(re.sub(r"<[^>]+>", "", chara)).strip()
        m = html.unescape(re.sub(r"<br\s*/?>", "\n", msg)).strip()
        m = re.sub(r"<[^>]+>", "", m).strip()
        out.append({"speaker": c, "text": m})
    return out


def fetch_or_load_hasuko(script_id: str, lang: str = "en") -> list[dict[str, str]]:
    cache_file = DATA_CACHE_DIR / f"hasuko_{lang}_{script_id}.html"
    if not cache_file.exists():
        if lang == "en" and script_id == "10300101" and (HASU_DUB_DIR / "hasu_ko_10300101.html").exists():
            cache_file.write_text((HASU_DUB_DIR / "hasu_ko_10300101.html").read_text(encoding="utf-8"), encoding="utf-8")
        else:
            url = (
                f"https://hasu-ko.vercel.app/en/story/{script_id}"
                if lang == "en"
                else f"https://hasu-ko.vercel.app/story/{script_id}"
            )
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "hasu-web-reader/1.0"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    cache_file.write_text(resp.read().decode("utf-8"), encoding="utf-8")
            except Exception as e:
                print(f"[WARN] Could not fetch {url}: {e}")
                return []
    return extract_hasuko_html_lines(cache_file.read_text(encoding="utf-8"))


def load_ep1_part1_dub_script() -> list[dict[str, str]]:
    p = HASU_DUB_DIR / "ep1-part1-script.txt"
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        parts = [x.strip() for x in line.split("|", 2)]
        if len(parts) == 3:
            out.append({"speaker": parts[1], "text": parts[2]})
    return out


def motion_start(
    script_id: str,
    line_num: int,
    n_turns: int,
    immediate: bool,
    play_type: int = 2,
    breathing: float | None = None,
    normalized_time: float | None = None,
) -> dict[str, Any]:
    """Which command started a character's current motion, and how, carried in every snapshot.

    The player plays a motion's opening only when the motion starts on screen. A snapshot alone
    can't say that (the same motion can be started again, and a jump lands mid-motion), so each
    start is identified by its script line and the turn it falls in (commands before the first
    message belong to turn 0). How it starts comes from the command's arguments, as the game reads
    them (CLAUDE.md, "Story motions"):
      キャラモーション再生 <char> <mot> <playType> [breathing]
      キャラモーション即時再生 <char> <mot> <playType> <normalizedTime>
    playType picks the starting state (0 in, 1 loop, 2 action); breathing is the weight of the
    additive breathing layer (the game uses 0.2 when it's omitted).
    """
    return {
        "motionCmd": f"{script_id}:{line_num}",
        "motionStartTurn": max(n_turns - 1, 0),
        "motionImmediate": immediate,
        "motionPlayType": play_type,
        "motionBreathing": breathing,
        "motionNormalizedTime": normalized_time,
    }


def slug_for_script_id(script_id: str) -> str:
    """Human-readable story id: 10300101 (term 103, episode 001, part 01) -> "103-ep1-part1".

    Keep in sync with slugForScriptId() in src/storySlug.ts.
    """
    m = re.fullmatch(r"(\d{3})(\d{3})(\d{2})", script_id)
    if not m:
        return script_id
    return f"{m.group(1)}-ep{int(m.group(2))}-part{int(m.group(3))}"


# Asset paths referenced by the script but absent from public/assets (reported after the build).
MISSING_ASSETS: dict[str, str] = {}

# What's in our asset store (bucket), from scripts/update_store_manifest.sh, so the compiled JSON
# is the same whether or not public/assets/ is populated locally. Without the manifest, fall back
# to the local cache.
STORE_MANIFEST_PATH = DATA_CACHE_DIR / "asset_store_manifest.txt"
STORE_MANIFEST: set[str] | None = (
    set(STORE_MANIFEST_PATH.read_text(encoding="utf-8").split()) if STORE_MANIFEST_PATH.exists() else None
)


def asset_available(rel_path: str) -> bool:
    local_file = PUBLIC_ASSETS_DIR / rel_path
    return local_file.exists() and local_file.stat().st_size > 0


def asset_in_store(rel_path: str) -> bool:
    """Whether our asset store has the file (the bucket manifest, else the local cache)."""
    if STORE_MANIFEST is not None:
        return rel_path in STORE_MANIFEST
    return asset_available(rel_path)


def asset_url(rel_path: str, script_id: str = "") -> str:
    """App URL for an asset in our own store: public/assets/ locally, mirrored to the
    gs://hasu-web-reader-assets bucket (the app swaps the base URL, see src/remoteAssets.ts).
    Nothing points at third-party hosting; assets missing from the cache are still referenced
    by path but reported, so the gap is visible instead of silently loading from elsewhere."""
    if not asset_available(rel_path):
        MISSING_ASSETS.setdefault(rel_path, script_id)
    return f"/assets/{rel_path}"


def compile_script(
    script_id: str,
    episode_meta: dict[str, Any],
    assets_by_id: dict[str, Any],
    motions_meta_by_id: dict[str, Any],
    bgm_map: dict[str, Any],
    lexer: jp_lexer.Lexer | None = None,
) -> dict[str, Any]:
    txt_path = HASU_DUB_DIR / "story_main_txt" / f"story_main_{script_id}.txt"
    raw_lines = txt_path.read_text(encoding="utf-8").splitlines()

    # Load translations
    en_hasuko = fetch_or_load_hasuko(script_id, "en")
    ko_hasuko = fetch_or_load_hasuko(script_id, "ko")
    en_dub = load_ep1_part1_dub_script() if script_id == "10300101" else []

    # Mutable running state of the 3D ADV stage
    state: dict[str, Any] = {
        "background": {
            "bgId": None,
            "url": None,
            "comment": None,
            "position": [0.0, 0.0, 50.0],
            "scale": [1.0, 1.0],
            "rotation": [0.0, 0.0, 0.0],
        },
        "camera": {
            "position": [0.0, 0.0, -10.0],
            "rotation": [0.0, 0.0, 0.0],
            "fov": 25.0,
            "duration": 0.0,
            "easing": 0,
        },
        "lighting": {
            "rotation": [0.0, 0.0, 0.0],
            "color": [1.0, 1.0, 1.0],
            "postEffect": None,
            "dof": {"enabled": False, "focalLength": 3.1, "focusDistance": 30.0, "aperture": 1.0},
            "sepia": False,
            "monochrome": False,
        },
        "fade": {
            "active": False,
            "color": "#000000",
            "duration": 0.0,
        },
        "audio": {
            "bgmId": None,
            "bgmUrl": None,
            "bgmTitle": None,
            "bgmVolume": 1.0,
            # Looping ambience beds active at this point: [{id, url, volume}]
            "ambience": [],
        },
        "novelMode": False,
        "characters": {},
        "props": {},
    }

    turns: list[dict[str, Any]] = []
    pending_events: list[dict[str, Any]] = []
    clock_sec = 0.0
    turn_elapsed_sec = 0.0

    def event_state(ev: dict[str, Any]) -> dict[str, Any]:
        """The part of the stage an event leaves behind, so the player can apply a mid-line event
        with the same code it uses for a line's starting snapshot. (Every handler updates `state`
        before calling attach_event.)"""
        t = ev["type"]
        if t.startswith("camera_"):
            return {"camera": copy.deepcopy(state["camera"])}
        if t.startswith("bg_"):
            return {"background": copy.deepcopy(state["background"])}
        if t == "fade":
            return {"fade": copy.deepcopy(state["fade"])}
        if t.startswith("bgm_"):
            return {"audio": copy.deepcopy(state["audio"])}
        if t.startswith("prop_"):
            return {"props": copy.deepcopy(state["props"])}
        if t.startswith("light_") or t == "post_effect":
            return {"lighting": copy.deepcopy(state["lighting"])}
        if t in ("char_spawn", "char_move", "char_lookat") and ev.get("character") in state["characters"]:
            return {"characterState": copy.deepcopy(state["characters"][ev["character"]])}
        return {}

    def attach_event(ev: dict[str, Any]) -> None:
        ev["timestampSec"] = round(clock_sec, 3)
        ev["turnOffsetSec"] = round(turn_elapsed_sec, 3)
        ev.update(event_state(ev))
        if turns:
            if turn_elapsed_sec == 0.0:
                # Command occurs on the exact same frame (t=0) as the dialogue line: fold it
                # into the line's starting snapshot. One-shot sounds and mouth flaps carry no
                # state, so they still need to be scheduled (at offset 0) or they would never play.
                turns[-1]["stateBefore"] = copy.deepcopy(state)
                if (ev["type"] == "se_play" and not ev.get("loop")) or ev["type"] == "char_lip":
                    turns[-1]["intraEvents"].append(ev)
            else:
                turns[-1]["intraEvents"].append(ev)
            turns[-1]["stateAfter"] = copy.deepcopy(state)
        else:
            pending_events.append(ev)

    for line_num, raw_line in enumerate(raw_lines, start=1):
        line = raw_line.strip()
        if not line:
            continue
        # Capture location comments like `#背景　市内バス車内（朝）`
        if line.startswith("#"):
            if line.startswith("#背景") and not line.startswith("#["):
                loc = line.lstrip("#").replace("背景", "").strip(" 　\t:：")
                if loc:
                    state["background"]["comment"] = loc
            continue

        m = re.match(r"^\[([^\s\]]+)(?:\s+(.+?))?\](?:\s*#(.*))?$", line)
        if not m:
            continue
        cmd, arg_str, comment = m.groups()
        arg_str = (arg_str or "").strip()
        comment = (comment or "").strip() or None
        args = arg_str.split() if arg_str else []

        # 1. Character Spawn: [キャラ表示 花帆 3d_costume_1001103101 emotion_kaho 0.3,-1.15,-2 0,210,0]
        if cmd == "キャラ表示" and len(args) >= 3:
            char_name = args[0]
            costume_id = args[1]
            emotion_ctrl = args[2]
            pos = parse_vec(args[3], [0.0, -1.0, -2.0]) if len(args) >= 4 else [0.0, -1.0, -2.0]
            rot = parse_vec(args[4], [0.0, 180.0, 0.0]) if len(args) >= 5 else [0.0, 180.0, 0.0]
            cmeta = CHAR_META.get(char_name, {"id": 0, "en": char_name, "enLower": "kaho", "color": "#ffffff", "lightColor": "#ffffff"})
            asset_info = assets_by_id.get(costume_id, {})
            glb_rel = f"3d/{asset_info.get('glbPath', f'costume/{costume_id}/{costume_id}.glb')}"
            tex_dir = asset_info.get("textureDir") or f"costume/{costume_id}/"
            if not tex_dir.endswith("/"):
                tex_dir += "/"
            char_prefix = cmeta["en"][:3].lower()
            eye_tex = None
            for t in asset_info.get("textures") or []:
                if f"{char_prefix}_eye" in t.lower():
                    eye_tex = asset_url(f"3d/{tex_dir}{t}", script_id)
                    break

            state["characters"][char_name] = {
                "name": char_name,
                "nameEn": cmeta["en"],
                "characterId": cmeta["id"],
                "color": cmeta["color"],
                "costumeId": costume_id,
                "glbUrl": asset_url(glb_rel, script_id),
                "eyeHighlightUrl": eye_tex,
                # the character's Tecotec.EmotionData, named by the command (scripts/export_emotions.py)
                "emotionDataUrl": asset_url(f"3d/emotions/{emotion_ctrl}.json", script_id),
                "emotionController": emotion_ctrl,
                "visible": True,
                "position": pos,
                "rotation": rot,
                "emotion": "NORMAL_TUUJO",
                " emotionComment": "通常",
                "motionId": "mot_00_00010",
                "motionUrl": asset_url("3d/motions/mot_00_00010.glb", script_id),
                "motionDescription": "通常立ち",
                **motion_start(script_id, line_num, len(turns), immediate=True, play_type=1),
                "lookAt": {"mode": "angle", "value": 0.0},
                "blush": 0.0,
                "tears": False,
                "attachedProps": [],
            }
            attach_event({"type": "char_spawn", "character": char_name, "costumeId": costume_id, "position": pos, "rotation": rot})
            continue

        if cmd == "キャラ非表示" and args:
            char_name = args[0]
            if char_name in state["characters"]:
                state["characters"][char_name]["visible"] = False
            attach_event({"type": "char_hide", "character": char_name})
            continue

        if cmd == "キャラ描画有効" and args:
            char_name = args[0]
            if char_name in state["characters"]:
                state["characters"][char_name]["visible"] = True
            attach_event({"type": "char_visibility", "character": char_name, "visible": True})
            continue

        if cmd == "キャラ描画無効" and args:
            char_name = args[0]
            if char_name in state["characters"]:
                state["characters"][char_name]["visible"] = False
            attach_event({"type": "char_visibility", "character": char_name, "visible": False})
            continue

        if cmd == "キャラ移動" and len(args) >= 2:
            char_name = args[0]
            pos = parse_vec(args[1], [0.0, -1.0, -2.0])
            dur = float(args[2]) if len(args) >= 3 and re.match(r"^[\d.]+$", args[2]) else 0.0
            if char_name in state["characters"]:
                state["characters"][char_name]["position"] = pos
            attach_event({"type": "char_move", "character": char_name, "position": pos, "duration": dur})
            continue

        if cmd == "キャラ向き変更" and len(args) >= 3:
            char_name = args[0]
            rot = parse_vec(args[2], [0.0, 180.0, 0.0])
            if char_name in state["characters"]:
                state["characters"][char_name]["rotation"] = rot
            attach_event({"type": "char_rotate", "character": char_name, "rotation": rot})
            continue

        if cmd == "キャラ視線変更" and len(args) >= 2:
            char_name = args[0]
            mode = args[1]
            val: float | list[float] | str = 0.0
            dur = 0.0
            if len(args) >= 3:
                if "," in args[2]:
                    val = parse_vec(args[2], [0.0, 0.0, 0.0])
                elif re.match(r"^-?[\d.]+$", args[2]):
                    val = float(args[2])
                else:
                    val = args[2]
            if len(args) >= 4 and re.match(r"^-?[\d.]+$", args[3]):
                dur = float(args[3])
            elif (
                len(args) == 3
                and mode not in ("向き指定", "角度指定", "座標指定", "キャラ指定")
                and isinstance(val, float)
            ):
                dur = val
                val = 0.0
            look_obj: dict[str, Any] = {"mode": mode, "value": val}
            if dur > 0.0:
                look_obj["duration"] = dur
            if char_name in state["characters"]:
                state["characters"][char_name]["lookAt"] = look_obj
            attach_event(
                {
                    "type": "char_lookat",
                    "character": char_name,
                    "mode": mode,
                    "value": val,
                    **({"duration": dur} if dur > 0.0 else {}),
                }
            )
            continue

        if cmd == "キャラ表情変更" and len(args) >= 2:
            char_name, emo_id = args[0], args[1]
            if char_name in state["characters"]:
                state["characters"][char_name]["emotion"] = emo_id
                state["characters"][char_name]["emotionComment"] = comment
            # optional 3rd argument: transition seconds (CharaExpressionCommand rValues[0]; 0 = instant);
            # without it the character's EmotionData.TransitionTime applies
            transition = float(args[2]) if len(args) >= 3 and re.fullmatch(r"\d+(\.\d+)?", args[2]) else None
            if char_name in state["characters"]:
                state["characters"][char_name]["emotionTransitionSec"] = transition
            attach_event({"type": "char_emotion", "character": char_name, "emotion": emo_id, "comment": comment,
                          "transitionSec": transition})
            continue

        # [キャラ口パク開始 <char> <sec>]: mouth flap without a voice (CharaLipCommand -> PlayABLip)
        if cmd == "キャラ口パク開始" and len(args) >= 2:
            dur = float(args[1]) if re.fullmatch(r"\d+(\.\d+)?", args[1]) else 0.0
            interval = float(args[2]) if len(args) >= 3 and re.fullmatch(r"\d+(\.\d+)?", args[2]) else None
            attach_event({"type": "char_lip", "character": args[0], "durationSec": dur, "intervalSec": interval})
            continue

        if cmd in ("キャラモーション再生", "キャラモーション即時再生") and len(args) >= 2:
            char_name, mot_id = args[0], args[1]
            mot_rel = f"3d/motions/{mot_id}.glb"
            # A motion missing from the store leaves the character on its previous valid motion.
            mot_url = asset_url(mot_rel, script_id) if asset_in_store(mot_rel) else None
            if mot_url is None:
                MISSING_ASSETS.setdefault(mot_rel, script_id)
            mot_desc = comment or (motions_meta_by_id.get(mot_id) or {}).get("description") or mot_id
            immediate = cmd == "キャラモーション即時再生"
            play_type = int(args[2]) if len(args) >= 3 and re.fullmatch(r"[0-2]", args[2]) else 2
            extra = float(args[3]) if len(args) >= 4 and re.fullmatch(r"-?\d+(\.\d+)?", args[3]) else None
            start = motion_start(
                script_id, line_num, len(turns), immediate=immediate, play_type=play_type,
                breathing=None if immediate else extra, normalized_time=extra if immediate else None,
            )
            if char_name in state["characters"]:
                state["characters"][char_name]["motionId"] = mot_id
                state["characters"][char_name]["motionDescription"] = mot_desc
                state["characters"][char_name].update(start)
                if mot_url:
                    state["characters"][char_name]["motionUrl"] = mot_url
            attach_event({
                "type": "char_motion",
                "character": char_name,
                "motionId": mot_id,
                "motionUrl": mot_url,
                "description": mot_desc,
                "immediate": start["motionImmediate"],
                "motionCmd": start["motionCmd"],
                "motionPlayType": start["motionPlayType"],
                "motionBreathing": start["motionBreathing"],
                "motionNormalizedTime": start["motionNormalizedTime"],
            })
            continue

        # [顔紅潮操作 <char> [level] [fadeSec]] (FaceFlushingCommand: missing numbers read as 0)
        if cmd == "顔紅潮操作" and len(args) >= 1:
            char_name = args[0]
            num = lambda i: float(args[i]) if len(args) > i and re.match(r"^-?[\d.]+$", args[i]) else 0.0
            blush, fade = num(1), num(2)
            if char_name in state["characters"]:
                state["characters"][char_name]["blush"] = blush
                state["characters"][char_name]["blushFadeSec"] = fade
            attach_event({"type": "char_blush", "character": char_name, "blush": blush, "fadeSec": fade})
            continue

        # 2. 3D Story Props: [3Dオブジェクト表示 ppadv028_buswindow buswindow -2,-1.3,30 20,10,1 0,0,0]
        if cmd == "3Dオブジェクト表示" and len(args) >= 2:
            prop_id = args[0]
            alias = args[1]
            pos = parse_vec(args[2], [0.0, 0.0, 0.0]) if len(args) >= 3 else [0.0, 0.0, 0.0]
            scale = parse_vec(args[3], [1.0, 1.0, 1.0]) if len(args) >= 4 else [1.0, 1.0, 1.0]
            rot = parse_vec(args[4], [0.0, 0.0, 0.0]) if len(args) >= 5 else [0.0, 0.0, 0.0]
            pinfo = assets_by_id.get(prop_id)
            glb_rel = f"3d/{(pinfo or {}).get('glbPath', f'ppadv/{prop_id}/{prop_id}.glb')}"
            if not pinfo or not asset_in_store(glb_rel):
                # No model for this prop in our store (e.g. ppadv006_pamphlet isn't in the catalog):
                # leave it off the stage rather than shipping a reference that can only 404.
                MISSING_ASSETS.setdefault(glb_rel, script_id)
                state["props"].pop(alias, None)  # the slot is emptied, not left with an older prop
                continue
            extra_urls = [asset_url(f"3d/{e}", script_id) for e in (pinfo.get("extraGlbs") or [])]
            tex_dir = pinfo.get("textureDir") or f"ppadv/{prop_id}/"
            if not tex_dir.endswith("/"):
                tex_dir += "/"
            state["props"][alias] = {
                "id": prop_id,
                "alias": alias,
                "glbUrl": asset_url(glb_rel, script_id),
                "extraGlbUrls": extra_urls,
                "textureDir": f"/assets/3d/{tex_dir}",
                "textureMap": pinfo.get("textureMap") or {},
                "visible": True,
                "position": pos,
                "scale": scale,
                "rotation": rot,
            }
            attach_event({"type": "prop_show", "id": prop_id, "alias": alias, "position": pos, "scale": scale, "rotation": rot})
            continue

        if cmd == "3Dオブジェクト非表示" and args:
            alias = args[0]
            if alias in state["props"]:
                state["props"].pop(alias, None)
            attach_event({"type": "prop_hide", "alias": alias})
            continue

        # 3. Background Display & Movement: [背景表示 story_bg_image_049 0.00,2.00,50.00 1.50,1.50]
        if cmd == "背景表示" and args:
            bg_id = args[0]
            pos = parse_vec(args[1], [0.0, 0.0, 50.0]) if len(args) >= 2 else [0.0, 0.0, 50.0]
            scale = parse_vec(args[2], [1.0, 1.0]) if len(args) >= 3 else [1.0, 1.0]
            bg_url = None if bg_id == "story_bg_image_000" else asset_url(f"story/backgrounds/{bg_id}.webp", script_id)
            state["background"]["bgId"] = bg_id
            state["background"]["url"] = bg_url
            state["background"]["position"] = pos
            state["background"]["scale"] = scale
            if comment:
                state["background"]["comment"] = comment
            attach_event({"type": "bg_show", "bgId": bg_id, "url": bg_url, "position": pos, "scale": scale, "comment": comment})
            continue

        if cmd == "背景移動" and args:
            pos = parse_vec(args[0], state["background"]["position"])
            dur = float(args[1]) if len(args) >= 2 and re.match(r"^[\d.]+$", args[1]) else 0.0
            state["background"]["position"] = pos
            attach_event({"type": "bg_move", "position": pos, "duration": dur})
            continue

        if cmd == "背景回転" and args:
            rot = parse_vec(args[0], [0.0, 0.0, 0.0])
            state["background"]["rotation"] = rot
            attach_event({"type": "bg_rotate", "rotation": rot})
            continue

        # 4. Camera Movement & Rotation: [カメラ移動 0.00,4.96,-10.00 12.35 1]
        if cmd == "カメラ移動" and args:
            pos = parse_vec(args[0], state["camera"]["position"])
            dur = float(args[1]) if len(args) >= 2 and re.match(r"^[\d.]+$", args[1]) else 0.0
            ease = int(args[2]) if len(args) >= 3 and re.match(r"^\d+$", args[2]) else 0
            state["camera"]["position"] = pos
            state["camera"]["duration"] = dur
            state["camera"]["easing"] = ease
            attach_event({"type": "camera_move", "position": pos, "duration": dur, "easing": ease})
            continue

        if cmd == "カメラ回転" and args:
            rot = parse_vec(args[0], state["camera"]["rotation"])
            dur = float(args[1]) if len(args) >= 2 and re.match(r"^[\d.]+$", args[1]) else 0.0
            state["camera"]["rotation"] = rot
            attach_event({"type": "camera_rotate", "rotation": rot, "duration": dur})
            continue

        # 5. Lighting & Post Effects
        # [ライト回転 x,y,z] (LightRotateCommand: sets StoryScene.directionalLight.localEulerAngles)
        if cmd == "ライト回転":
            rot = parse_vec(args[0], [0.0, 0.0, 0.0]) if args else [0.0, 0.0, 0.0]
            state["lighting"]["rotation"] = rot
            attach_event({"type": "light_rotate", "rotation": rot})
            continue

        # [ライト光源色変更 r,g,b] (LightColorCommand + StoryDefine.ConvertColor: sets directionalLight.color)
        if cmd == "ライト光源色変更":
            raw_col = parse_vec(args[0], [1.0, 1.0, 1.0]) if args else [1.0, 1.0, 1.0]
            col = [round(c / 255.0, 4) for c in raw_col] if any(c > 1.0 for c in raw_col) else raw_col
            state["lighting"]["color"] = col
            attach_event({"type": "light_color", "color": col})
            continue

        if cmd == "被写界深度開始" and len(args) >= 3:
            state["lighting"]["dof"] = {
                "enabled": True,
                "focalLength": float(args[0]),
                "focusDistance": float(args[1]),
                "aperture": float(args[2]),
            }
            continue

        if cmd == "被写界深度終了":
            state["lighting"]["dof"]["enabled"] = False
            continue

        if cmd == "プリセットポストエフェクト開始" and args:
            state["lighting"]["postEffect"] = args[0]
            attach_event({"type": "post_effect", "preset": args[0]})
            continue

        if cmd == "プリセットポストエフェクト終了":
            state["lighting"]["postEffect"] = None
            continue

        if cmd in ("セピア開始", "セピア終了"):
            state["lighting"]["sepia"] = cmd == "セピア開始"
            continue

        if cmd in ("モノクロ開始", "モノクロ終了"):
            state["lighting"]["monochrome"] = cmd == "モノクロ開始"
            continue

        # 6. Screen Fades
        if cmd in ("暗転_イン", "暗転_アウト", "ブラックアウト_イン", "ブラックアウト_アウト", "円_イン", "円_アウト"):
            is_in = cmd.endswith("_イン")
            dur = float(args[1]) if len(args) > 1 and re.match(r"^[\d.]+$", args[1]) else 0.0
            rgb = (
                [int(args[2]), int(args[3]), int(args[4])]
                if len(args) >= 5 and all(re.match(r"^\d+$", p) for p in args[2:5])
                else [0, 0, 0]
            )
            hex_color = "#ffffff" if rgb == [255, 255, 255] else "#000000"
            state["fade"] = {"active": is_in, "color": hex_color, "duration": dur}
            if "完了待ち" in arg_str:
                clock_sec += dur
            attach_event({"type": "fade", "command": cmd, "active": is_in, "color": hex_color, "duration": dur})
            continue

        # 7. Audio (BGM & SE)
        if cmd in ("BGM再生", "BGMクロスフェード再生") and args:
            bgm_id = normalize_bgm_id(args[0])
            vol = float(args[2]) if len(args) > 2 and re.match(r"^[\d.]+$", args[2]) else 1.0
            fade_sec = float(args[3]) if len(args) > 3 and re.match(r"^[\d.]+$", args[3]) else 0.0
            bgm_info = bgm_map.get(bgm_id) or {}
            bgm_url = asset_url(f"bgm/{bgm_id}.mp3", script_id)
            state["audio"]["bgmId"] = bgm_id
            state["audio"]["bgmUrl"] = bgm_url
            state["audio"]["bgmTitle"] = bgm_info.get("official_title") or bgm_id
            state["audio"]["bgmVolume"] = vol
            attach_event({"type": "bgm_play", "bgmId": bgm_id, "bgmUrl": bgm_url, "volume": vol, "fadeSec": fade_sec})
            continue

        if cmd == "BGM停止":
            fade_sec = float(args[2]) if len(args) > 2 and re.match(r"^[\d.]+$", args[2]) else 0.0
            state["audio"]["bgmId"] = None
            state["audio"]["bgmUrl"] = None
            state["audio"]["bgmTitle"] = None
            attach_event({"type": "bgm_stop", "fadeSec": fade_sec})
            continue

        # [SE再生 <id> <volume> <fadeInSec>] / [SE停止 <id> <fadeOutSec>]
        if cmd == "SE再生" and args:
            se_id = args[0]
            vol = float(args[1]) if len(args) > 1 and re.match(r"^[\d.]+$", args[1]) else 1.0
            fade_sec = float(args[2]) if len(args) > 2 and re.match(r"^[\d.]+$", args[2]) else 0.0
            se_url = asset_url(f"sound/effects/{se_id}.webm", script_id)
            is_loop = is_looping_se(se_id)
            if is_loop:
                state["audio"]["ambience"] = [a for a in state["audio"]["ambience"] if a["id"] != se_id]
                state["audio"]["ambience"].append({"id": se_id, "url": se_url, "volume": vol})
            attach_event({"type": "se_play", "seId": se_id, "seUrl": se_url, "volume": vol, "fadeSec": fade_sec, "loop": is_loop})
            continue

        if cmd == "SE停止" and args:
            se_id = args[0]
            fade_sec = float(args[1]) if len(args) > 1 and re.match(r"^[\d.]+$", args[1]) else 0.0
            state["audio"]["ambience"] = [a for a in state["audio"]["ambience"] if a["id"] != se_id]
            attach_event({"type": "se_stop", "seId": se_id, "fadeSec": fade_sec})
            continue

        # 8. Wait
        if cmd == "待機" and len(args) >= 2 and args[0] == "秒数指定":
            sec = float(args[1])
            clock_sec += sec
            turn_elapsed_sec += sec
            if turns:
                turns[-1]["durationSec"] = round(turns[-1]["durationSec"] + sec, 3)
            attach_event({"type": "wait", "seconds": sec})
            continue

        # 9. Dialogue / Narration Turns
        if cmd in ("メッセージ表示", "ボイス無しメッセージ表示", "ノベルテキスト追加"):
            turn_elapsed_sec = 0.0
            if cmd == "メッセージ表示" and len(args) >= 3:
                speaker_jp = args[0]
                voice_ref = args[1]
                # Preserve internal spaces inside dialogue text
                m_dlg = re.match(r"^(\S+)\s+(\S+)\s+(.+)$", arg_str)
                raw_text = m_dlg.group(3) if m_dlg else " ".join(args[2:])
                turn_type = "dialogue"
            elif cmd == "ボイス無しメッセージ表示" and len(args) >= 2:
                speaker_jp = args[0]
                voice_ref = "なし"
                m_dlg = re.match(r"^(\S+)\s+(.+)$", arg_str)
                raw_text = m_dlg.group(2) if m_dlg else " ".join(args[1:])
                turn_type = "unvoiced_dialogue"
            else:
                speaker_jp = "NARRATION"
                raw_text = args[0] if args else ""
                voice_ref = args[1] if len(args) >= 2 else "なし"
                turn_type = "novel"

            text_jp = clean_text(raw_text)
            idx = len(turns)
            cmeta = CHAR_META.get(speaker_jp)
            speaker_en = SPEAKER_EN_MAP.get(speaker_jp, speaker_jp)
            char_id = cmeta["id"] if cmeta else None
            icon_rel = f"assets/charaicon/charamini_icon_face_sd_{char_id}_01.webp"
            if char_id and asset_in_store(icon_rel):
                icon_url = asset_url(icon_rel, script_id)
            else:
                if char_id:
                    MISSING_ASSETS.setdefault(icon_rel, script_id)
                icon_url = None
            voice_url = None
            if voice_ref and voice_ref != "なし":
                voice_rel = f"story/voice/{voice_ref}.webm"
                if asset_in_store(voice_rel):
                    voice_url = asset_url(voice_rel, script_id)
                else:
                    # Clip not in our store: play the line unvoiced (reading-time pacing)
                    MISSING_ASSETS.setdefault(voice_rel, script_id)

            translations: dict[str, dict[str, str]] = {}
            if idx < len(en_dub):
                translations["en_curated"] = {
                    "speaker": en_dub[idx]["speaker"],
                    "text": en_dub[idx]["text"],
                }
            if idx < len(en_hasuko):
                translations["en_hasuko"] = {
                    "speaker": en_hasuko[idx]["speaker"] or speaker_en,
                    "text": en_hasuko[idx]["text"],
                }
            if idx < len(ko_hasuko):
                translations["ko_hasuko"] = {
                    "speaker": ko_hasuko[idx]["speaker"],
                    "text": ko_hasuko[idx]["text"],
                }

            turn_obj = {
                "index": idx,
                "lineNumber": idx + 1,
                "scriptLineNum": line_num,
                "timestampSec": round(clock_sec, 3),
                "durationSec": 0.0,
                "type": turn_type,
                "speakerJp": "" if speaker_jp == "NARRATION" else speaker_jp,
                "speakerEn": "" if speaker_jp == "NARRATION" else speaker_en,
                "characterId": char_id,
                "characterColor": cmeta["color"] if cmeta else "#94a3b8",
                "characterLightColor": cmeta["lightColor"] if cmeta else "#e2e8f0",
                "iconUrl": icon_url,
                "voiceId": None if voice_ref == "なし" else voice_ref,
                "voiceUrl": voice_url,
                "voiceStartSec": 0.0,
                "voiceEndSec": None,
                "voicePart": 1,
                "voiceTotalParts": 1,
                "textJp": text_jp,
                "tokensJp": lexer.parse(text_jp) if lexer else [{"t": text_jp}],
                "translations": translations,
                "preEvents": pending_events,
                "intraEvents": [],
                "stateBefore": copy.deepcopy(state),
                "stateAfter": copy.deepcopy(state),
            }
            pending_events = []
            turns.append(turn_obj)
            continue

    # Compute sub-clip start/end offsets for consecutive turns sharing the same voiceId
    i = 0
    while i < len(turns):
        vid = turns[i]["voiceId"]
        if not vid:
            i += 1
            continue
        j = i + 1
        while j < len(turns) and turns[j]["voiceId"] == vid:
            j += 1
        total_parts = j - i
        if total_parts > 1:
            offset_sec = 0.0
            for part_idx, k in enumerate(range(i, j), start=1):
                t_k = turns[k]
                t_k["voiceStartSec"] = round(offset_sec, 3)
                t_k["voicePart"] = part_idx
                t_k["voiceTotalParts"] = total_parts
                if part_idx < total_parts and t_k["durationSec"] > 0:
                    t_k["voiceEndSec"] = round(offset_sec + t_k["durationSec"], 3)
                else:
                    t_k["voiceEndSec"] = None
                offset_sec += t_k["durationSec"]
        i = j

    # All current translations come from the fan project "Hasunosora Activity Record
    # Translation" (hasu-ko.vercel.app). The site does not name individual translators, so
    # the project itself is credited. The hasu-dub script is that same English translation
    # (132/138 lines identical in 10300101) with line breaks merged and light edits for dubbing.
    hasuko_en_url = f"https://hasu-ko.vercel.app/en/story/{script_id}"
    hasuko_ko_url = f"https://hasu-ko.vercel.app/story/{script_id}"
    translation_sources = []
    if en_dub:
        translation_sources.append({
            "id": "en_curated",
            "lang": "en",
            "label": "English (Hasu-KO, edited for dub)",
            "attribution": "Hasunosora Activity Record Translation (Hasu-KO)",
            "url": hasuko_en_url,
            "homepage": "https://hasu-ko.vercel.app/en/",
            "note": "Hasu-KO's unofficial English translation with line breaks merged and minor edits for the hasu-dub voice dub.",
        })
    if en_hasuko:
        translation_sources.append({
            "id": "en_hasuko",
            "lang": "en",
            "label": "English (Hasu-KO)",
            "attribution": "Hasunosora Activity Record Translation (Hasu-KO)",
            "url": hasuko_en_url,
            "homepage": "https://hasu-ko.vercel.app/en/",
            "note": "Unofficial English fan translation of the Link! Like! Love Live! activity records.",
        })
    if ko_hasuko:
        translation_sources.append({
            "id": "ko_hasuko",
            "lang": "ko",
            "label": "한국어 (Hasu-KO)",
            "attribution": "하스노소라 활동기록 번역 (Hasu-KO)",
            "url": hasuko_ko_url,
            "homepage": "https://hasu-ko.vercel.app/",
            "note": "Link! Like! 러브라이브! 활동기록 비공식 한국어 번역 (unofficial Korean fan translation).",
        })

    lexicon: dict[str, Any] = {}
    lex_tags: dict[str, str] = {}
    if lexer:
        lexicon, lex_tags = jp_lexer.collect_lexicon(lexer.d, (t["tokensJp"] for t in turns))

    asset_manifest = build_asset_manifest(turns)

    return {
        "scriptId": script_id,
        "episode": episode_meta,
        "totalTurns": len(turns),
        "totalDurationSec": round(clock_sec, 3),
        "translationSources": translation_sources,
        "assetManifest": asset_manifest,
        "turns": turns,
        # Dictionary entries referenced by turns[].tokensJp (JMdict, EDRDG, CC BY-SA 4.0)
        "lexicon": lexicon,
        "lexTags": lex_tags,
    }


def build_asset_manifest(turns: list[dict[str, Any]]) -> dict[str, Any]:
    """Build a deduplicated, firstTurnIndex-ordered manifest of every 3D, 2D, and audio asset in the episode."""
    characters: dict[str, dict[str, Any]] = {}
    backgrounds: dict[str, dict[str, Any]] = {}
    props: dict[str, dict[str, Any]] = {}
    motions: dict[str, dict[str, Any]] = {}
    bgm: dict[str, dict[str, Any]] = {}
    se: dict[str, dict[str, Any]] = {}
    voices: dict[str, dict[str, Any]] = {}

    for turn in turns:
        idx = turn["index"]
        for snap in (turn["stateBefore"], turn["stateAfter"]):
            bg = snap.get("background") or {}
            bg_url = bg.get("url")
            if bg_url and bg_url not in backgrounds:
                backgrounds[bg_url] = {
                    "bgId": bg.get("bgId"),
                    "url": bg_url,
                    "firstTurnIndex": idx,
                }

            aud = snap.get("audio") or {}
            bgm_url = aud.get("bgmUrl")
            if bgm_url and bgm_url not in bgm:
                bgm[bgm_url] = {
                    "id": aud.get("bgmId"),
                    "url": bgm_url,
                    "firstTurnIndex": idx,
                }
            for amb in aud.get("ambience") or []:
                amb_url = amb.get("url")
                if amb_url and amb_url not in se:
                    se[amb_url] = {
                        "id": amb.get("id"),
                        "url": amb_url,
                        "firstTurnIndex": idx,
                    }

            for c in (snap.get("characters") or {}).values():
                cid = c.get("costumeId")
                glb_url = c.get("glbUrl")
                if cid and glb_url and cid not in characters:
                    characters[cid] = {
                        "name": c.get("name"),
                        "nameEn": c.get("nameEn"),
                        "costumeId": cid,
                        "glbUrl": glb_url,
                        "materialsUrl": re.sub(r"\.glb$", "_materials.json", glb_url),
                        "emotionDataUrl": c.get("emotionDataUrl"),
                        "eyeHighlightUrl": c.get("eyeHighlightUrl"),
                        "firstTurnIndex": idx,
                    }
                m_url = c.get("motionUrl")
                if m_url and m_url not in motions:
                    motions[m_url] = {
                        "id": c.get("motionId"),
                        "url": m_url,
                        "firstTurnIndex": idx,
                    }

            for p in (snap.get("props") or {}).values():
                pid = p.get("id")
                p_glb = p.get("glbUrl")
                if pid and p_glb and pid not in props:
                    glb_urls = [p_glb, *(p.get("extraGlbUrls") or [])]
                    tex_dir = p.get("textureDir") or ""
                    tex_urls = sorted({
                        f"{tex_dir}{tex_file}"
                        for entry in (p.get("textureMap") or {}).values()
                        for tex_file in (entry or {}).values()
                        if tex_file
                    })
                    props[pid] = {
                        "id": pid,
                        "glbUrls": glb_urls,
                        "textureUrls": tex_urls,
                        "firstTurnIndex": idx,
                    }

        for ev in (turn.get("preEvents") or []) + (turn.get("intraEvents") or []):
            m_url = ev.get("motionUrl")
            if m_url and m_url not in motions:
                motions[m_url] = {
                    "id": ev.get("motionId"),
                    "url": m_url,
                    "firstTurnIndex": idx,
                }
            se_url = ev.get("seUrl")
            if se_url and se_url not in se:
                se[se_url] = {
                    "id": ev.get("seId"),
                    "url": se_url,
                    "firstTurnIndex": idx,
                }

        v_url = turn.get("voiceUrl")
        if v_url and v_url not in voices:
            voices[v_url] = {
                "id": turn.get("voiceId"),
                "url": v_url,
                "firstTurnIndex": idx,
            }

    char_list = list(characters.values())
    bg_list = list(backgrounds.values())
    prop_list = list(props.values())
    motion_list = list(motions.values())
    bgm_list = list(bgm.values())
    se_list = list(se.values())
    voice_list = list(voices.values())

    return {
        "characters": char_list,
        "backgrounds": bg_list,
        "props": prop_list,
        "motions": motion_list,
        "audio": {
            "bgm": bgm_list,
            "se": se_list,
            "voices": voice_list,
        },
        "counts": {
            "characters": len(char_list),
            "backgrounds": len(bg_list),
            "props": len(prop_list),
            "motions": len(motion_list),
            "bgm": len(bgm_list),
            "se": len(se_list),
            "voices": len(voice_list),
            "total": (
                len(char_list)
                + len(bg_list)
                + len(prop_list)
                + len(motion_list)
                + len(bgm_list)
                + len(se_list)
                + len(voice_list)
            ),
        },
    }


def main() -> None:
    PUBLIC_DATA_DIR.mkdir(parents=True, exist_ok=True)
    scenarios_dir = PUBLIC_DATA_DIR / "scenarios"
    scenarios_dir.mkdir(parents=True, exist_ok=True)

    model_ctx = json.loads((DATA_CACHE_DIR / "model_viewer_context.json").read_text(encoding="utf-8"))
    assets_by_id = {a["id"]: a for a in model_ctx["data"]["assets"]}

    motions_meta_path = PUBLIC_ASSETS_DIR / "3d/metadata/motions.json"
    if not motions_meta_path.exists():
        motions_meta_path = DATA_CACHE_DIR / "motions_meta.json"
    motions_list = json.loads(motions_meta_path.read_text(encoding="utf-8")) if motions_meta_path.exists() else []
    if isinstance(motions_list, dict):
        motions_list = (motions_list.get("data") or {}).get("motions") or motions_list.get("motions") or []
    motions_meta_by_id = {m["id"]: m for m in motions_list if isinstance(m, dict) and "id" in m}

    bgm_map_path = HASU_DUB_DIR / "bgm_map.json"
    bgm_map_raw = json.loads(bgm_map_path.read_text(encoding="utf-8")) if bgm_map_path.exists() else {}
    bgm_map = bgm_map_raw.get("ep1_part1_required", {})

    sample_episodes = [
        {
            "scriptId": "10300101",
            "seriesId": "103001",
            "term": "103rd Term (2023)",
            "month": "April",
            "seriesTitleJp": "第1話『花咲きたい！』",
            "seriesTitleEn": "Episode 1: \"I Want to Bloom!\"",
            "partTitleJp": "PART 1",
            "partTitleEn": "PART 1 — Arrival in Kanazawa & Bus Ride",
            "descriptionJp": "花咲く高校生活を夢見る花帆。入学した蓮ノ空女学院は思い描いていた環境とはほど遠かったが、スクールアイドルクラブの梢と出会い……。",
            "descriptionEn": "Dreaming of a blooming high school life, Kaho boards the bus from Kanazawa Station alongside fellow first-year Sayaka Murano—only to discover Hasunosora is deep in the mountains.",
        },
        {
            "scriptId": "10300102",
            "seriesId": "103001",
            "term": "103rd Term (2023)",
            "month": "April",
            "seriesTitleJp": "第1話『花咲きたい！』",
            "seriesTitleEn": "Episode 1: \"I Want to Bloom!\"",
            "partTitleJp": "PART 2",
            "partTitleEn": "PART 2 — Fateful Encounter with Kozue",
            "descriptionJp": "厳格な寮の規則に絶望し脱獄を企てる花帆は、夜の学院で舞い踊る乙宗梢と出会う。",
            "descriptionEn": "Despairing over the strict dorm rules, Kaho attempts a 'jailbreak' and encounters Kozue Otomune practicing as a school idol.",
        },
    ]

    lexer = load_lexer()

    catalog_entries = []
    for ep in sample_episodes:
        sid = ep["scriptId"]
        slug = slug_for_script_id(sid)
        ep = {"slug": slug, **ep}
        print(f"Compiling scenario {slug} ({sid}: {ep['seriesTitleEn']} - {ep['partTitleEn']})...")
        compiled = compile_script(sid, ep, assets_by_id, motions_meta_by_id, bgm_map, lexer)
        compiled = {"slug": slug, **compiled}
        out_path = scenarios_dir / f"{slug}.json"
        out_path.write_text(json.dumps(compiled, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        legacy_path = scenarios_dir / f"{sid}.json"  # files used to be named by script id
        if legacy_path != out_path and legacy_path.exists():
            legacy_path.unlink()
        print(
            f"  -> Wrote {out_path.relative_to(ROOT_DIR)} "
            f"({compiled['totalTurns']} turns, {len(compiled['translationSources'])} translation sources, "
            f"{compiled['assetManifest']['counts']['total']} unique assets, "
            f"{len(compiled['lexicon'])} dictionary entries)"
        )
        catalog_entries.append({
            **ep,
            "totalTurns": compiled["totalTurns"],
            "totalDurationSec": compiled["totalDurationSec"],
            "translationSources": compiled["translationSources"],
            "assetCounts": compiled["assetManifest"]["counts"],
            "castCharacters": compiled["assetManifest"]["characters"],
            "initialBackgroundUrl": (
                compiled["assetManifest"]["backgrounds"][0]["url"]
                if compiled["assetManifest"]["backgrounds"]
                else None
            ),
        })

    catalog_path = PUBLIC_DATA_DIR / "catalog.json"
    catalog_path.write_text(json.dumps({"episodes": catalog_entries}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote catalog to {catalog_path.relative_to(ROOT_DIR)}")

    if MISSING_ASSETS:
        print(
            f"\n[WARN] {len(MISSING_ASSETS)} referenced asset(s) are not in public/assets "
            "(missing voice clips play unvoiced, missing props are left off the stage):"
        )
        for rel, sid in sorted(MISSING_ASSETS.items()):
            print(f"  {sid}  {rel}")


if __name__ == "__main__":
    main()
