#!/usr/bin/env python3
"""Idol Story (idol.st) English transcript loader, credit parser, and turn aligner.

Idol Story's Link! Like! Love Live! story wiki pages are hosted from the public GitHub wiki
repository `MagiCircles/IdolStoryWiki.wiki` and cover the entire 103rd Term (Episodes 1-18,
125 parts). Each part is cached in `data_cache/idolst_en_<scriptId>.md`.
"""

from __future__ import annotations

import difflib
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

IDOLST_HOMEPAGE = "https://idol.st/wiki/Link!%20Like!:%20Story/"
IDOLST_WIKI_URL_BASE = "https://idol.st/wiki/"
IDOLST_RAW_WIKI_BASE = "https://raw.githubusercontent.com/wiki/MagiCircles/IdolStoryWiki/"

# Map Japanese speaker names (including NPCs that aren't in CHAR_META) to canonical English
# names used on Idol Story so speaker-sequence alignment matches cleanly.
JP_SPEAKER_TO_EN: dict[str, str] = {
    "花帆": "Kaho",
    "さやか": "Sayaka",
    "瑠璃乃": "Rurino",
    "梢": "Kozue",
    "綴理": "Tsuzuri",
    "慈": "Megumi",
    "沙知": "Sachi",
    "吟子": "Ginko",
    "小鈴": "Kosuzu",
    "姫芽": "Hime",
    "セラス": "Ceras",
    "泉": "Izumi",
    "寮母": "Dorm Mother",
    "えな": "Ena",
    "びわこ": "Biwako",
    "しいな": "Shiina",
    "れいかさん": "Reika-san",
    "つかさ": "Tsukasa",
    "みのり": "Minori",
    "ふたば": "Futaba",
    "花帆母": "Kaho's Mother",
    "花帆の母": "Kaho's Mother",
    "校内放送": "PA Announcement (Sachi)",
    "二人": "Both",
    "一同": "Everyone",
}

# Non-dialogue headings that appear on Idol Story pages (e.g. stream chat overlays)
# and do not correspond to game dialogue turns.
NON_DIALOGUE_SPEAKERS = {"comment", "comments"}

_story_index_cache: dict[Path, dict[str, tuple[str, str]]] = {}


def _load_part_map(story_index_path: Path) -> dict[str, tuple[str, str]]:
    """Map 103rd-term scriptId -> (wiki_filename, idolst_wiki_url) using story_index.json."""
    if story_index_path in _story_index_cache:
        return _story_index_cache[story_index_path]
    mapping: dict[str, tuple[str, str]] = {}
    if story_index_path.exists():
        data = json.loads(story_index_path.read_text(encoding="utf-8"))
        for series in data.get("series") or []:
            sid = int(series["id"])
            if not (103001 <= sid <= 103018):
                continue
            ep = sid - 103000
            for part in series.get("parts") or []:
                num = str(part.get("number") or "")
                part_label = {
                    "幕間": "Intermission",
                    "ED": "Epilogue",
                    "ED1": "Epilogue 1",
                    "ED2": "Epilogue 2",
                }.get(num, f"Part {num}")
                page_title = f"Link! Like!: Episode {ep} ~ {part_label}"
                wiki_filename = f"{page_title.replace(' ', '-')}.md"
                wiki_url = IDOLST_WIKI_URL_BASE + urllib.parse.quote(page_title, safe="!~:")
                mapping[part["scriptId"]] = (wiki_filename, wiki_url)
    _story_index_cache[story_index_path] = mapping
    return mapping


def wiki_page_info(script_id: str, story_index_path: Path) -> tuple[str, str] | None:
    """Return `(wiki_filename, idolst_wiki_url)` if Idol Story covers this scriptId."""
    return _load_part_map(story_index_path).get(script_id)


def parse_credits(md_text: str) -> list[dict[str, Any]]:
    """Extract structured translator/proofreader/staff credits from an Idol Story wiki page."""
    credits: list[dict[str, Any]] = []
    credit_line = None
    for line in md_text.splitlines():
        s = line.strip()
        if s.startswith("#####") and re.search(r"Translation|Translator|Proofread", s, re.I):
            credit_line = s
            break
    if not credit_line:
        return credits

    cleaned = re.sub(r"^#+\s*", "", credit_line)
    cleaned = re.sub(r"</?div\b[^>]*>", "", cleaned).strip()
    for seg in cleaned.split("|"):
        seg = seg.strip()
        if ":" not in seg:
            continue
        role, rest = seg.split(":", 1)
        role = role.strip()
        rest = rest.strip()
        people: list[dict[str, str]] = []
        for m in re.finditer(r"\[([^\]]+)\]\((https?://[^)]+)\)", rest):
            people.append({"name": m.group(1).strip(), "url": m.group(2).strip()})
        if not people and rest:
            for name in re.split(r"\s*(?:&|,|\band\b)\s*", rest):
                if name.strip():
                    people.append({"name": name.strip()})
        if role and people:
            credits.append({"role": role, "people": people})
    return credits


def format_attribution(credits: list[dict[str, Any]]) -> str:
    """Credit line naming every contributor listed on the Idol Story page (roles go in `credits`)."""
    # one entry per person (keyed by profile URL), so someone with two roles is named once
    people_by_key: dict[str, str] = {}
    for entry in credits:
        for p in entry["people"]:
            people_by_key.setdefault(p.get("url") or p["name"], p["name"])
    return f"Idol Story ({', '.join(people_by_key.values())})" if people_by_key else "Idol Story"


def _clean_dialogue_text(s: str) -> str:
    """Strip inline markdown/HTML markup from an Idol Story dialogue line into plain text."""
    s = re.sub(r"^<br\s*/?>\s*", "", s)
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"</?(?:i|em|b|strong|span|p)\b[^>]*>", "", s)
    # Unwrap **bold**
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    # Unwrap _italic_ or *italic* when delimiting a span
    s = re.sub(r"(?<!\w)_([^_]+?)_(?!\w)", r"\1", s)
    s = re.sub(r"(?<!\*)\*([^*]+?)\*(?!\*)", r"\1", s)
    # Remove trailing spaces before newlines
    return "\n".join(line.strip() for line in s.splitlines()).strip()


def parse_idolst_markdown(md_text: str) -> list[dict[str, str]]:
    """Parse an Idol Story Link! Like! transcript markdown file into speaker/text rows."""
    # Rejoin <img ...> tags that wrapped across a newline before closing `>`
    text = re.sub(r"(<img\b[^>]*?)\r?\n\s*", r"\1 ", md_text)
    lines = text.splitlines()

    # Locate start of dialogue (after YouTube banner's `***`, or after `#####` credits `***`)
    start_idx = 0
    for i, line in enumerate(lines):
        if "Click the video" in line:
            for j in range(i + 1, len(lines)):
                if lines[j].strip() == "***":
                    start_idx = j + 1
                    break
            break
    if start_idx == 0:
        for i, line in enumerate(lines):
            if line.strip().startswith("#####"):
                for j in range(i + 1, len(lines)):
                    if lines[j].strip() == "***":
                        start_idx = j + 1
                        break
                break

    # Locate footer navigation links (`## <div align="center">[...Go to/Back to...`)
    end_idx = len(lines)
    for i in range(len(lines) - 1, start_idx - 1, -1):
        s = lines[i].strip()
        if re.search(r"##\s*<div[^>]*>\[.*?(?:Go to|Back to)", s):
            end_idx = i
        elif s == "***" and end_idx < len(lines) and i == end_idx - 1:
            end_idx = i
            break
        elif s and end_idx < len(lines):
            break

    body = lines[start_idx:end_idx]
    rows: list[dict[str, str]] = []
    cur_speaker = ""
    skip_non_dialogue = False

    bold_speaker_re = re.compile(r"^(?:(?:<img\b[^>]*>|&|\s)*)\*\*(.+?):\*\*\s*(.*)$")
    plain_speaker_re = re.compile(r"^([A-Z][A-Za-z0-9 ’'&.,()-]{1,40}):\s*$")
    bare_link_re = re.compile(r"^\[\]\(https?://[^)]+\)$")

    for raw in body:
        s = raw.strip()
        if s == "***":
            cur_speaker = ""
            skip_non_dialogue = False
            continue
        if not s or s in ("<br/>", "<br>", "<br />"):
            continue
        if bare_link_re.match(s):
            continue
        if "Translator's Note" in s or "Translator’s Note" in s:
            continue

        m = bold_speaker_re.match(s)
        if m:
            cur_speaker = m.group(1).strip()
            skip_non_dialogue = cur_speaker.lower() in NON_DIALOGUE_SPEAKERS
            rest = _clean_dialogue_text(m.group(2).strip())
            if rest and not skip_non_dialogue:
                rows.append({"speaker": cur_speaker, "text": rest})
            continue

        m2 = plain_speaker_re.match(s)
        if m2:
            cur_speaker = m2.group(1).strip()
            skip_non_dialogue = cur_speaker.lower() in NON_DIALOGUE_SPEAKERS
            continue

        if skip_non_dialogue:
            continue

        cleaned = _clean_dialogue_text(s)
        if cleaned:
            rows.append({"speaker": cur_speaker, "text": cleaned})

    return rows


def fetch_or_load_idolst(
    script_id: str,
    cache_dir: Path,
    story_index_path: Path,
) -> dict[str, Any] | None:
    """Load (or fetch and cache) Idol Story's English transcript and credits for `script_id`."""
    info = wiki_page_info(script_id, story_index_path)
    if not info:
        return None
    wiki_filename, wiki_url = info
    cache_file = cache_dir / f"idolst_en_{script_id}.md"
    if not cache_file.exists():
        raw_url = IDOLST_RAW_WIKI_BASE + urllib.parse.quote(wiki_filename, safe="!~:-.")
        try:
            req = urllib.request.Request(raw_url, headers={"User-Agent": "hasu-web-reader/1.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                cache_file.write_text(resp.read().decode("utf-8"), encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            print(f"[WARN] Could not fetch Idol Story wiki {raw_url}: {e}")
            return None

    md_text = cache_file.read_text(encoding="utf-8")
    credits = parse_credits(md_text)
    rows = parse_idolst_markdown(md_text)
    if not rows:
        return None
    return {
        "url": wiki_url,
        "homepage": IDOLST_HOMEPAGE,
        "credits": credits,
        "attribution": format_attribution(credits),
        "note": "Unofficial English fan translation of the Link! Like! Love Live! activity records.",
        "rows": rows,
    }


def _norm_speaker(speaker: str) -> str:
    s = speaker.replace("’", "'").strip()
    if not s:
        return ""
    if s in JP_SPEAKER_TO_EN:
        return JP_SPEAKER_TO_EN[s]
    # Strip parenthetical tags like "Megumi (Stream)" -> "Megumi"
    base = re.sub(r"\s*\([^)]*\)\s*$", "", s).strip()
    if base in JP_SPEAKER_TO_EN:
        return JP_SPEAKER_TO_EN[base]
    if any(sep in s for sep in ("＆", "&", "、", ",", " and ")):
        parts = re.split(r"\s*(?:＆|&|、|,|\band\b)\s*", s)
        mapped = sorted(JP_SPEAKER_TO_EN.get(p.strip(), p.strip()) for p in parts if p.strip())
        return " & ".join(mapped)
    return base or s


def _norm_for_sim(s: str) -> str:
    s = s.lower().replace("’", "'").replace("“", '"').replace("”", '"').replace("…", "...")
    return re.sub(r"\s+", " ", s).strip()


def _split_sentences(text: str) -> list[str]:
    """Split an English dialogue line into sentence/clause chunks at terminal punctuation."""
    # Protect common honorific/title abbreviations from splitting
    protected = re.sub(r"\b(Mr|Ms|Mrs|Dr|St|vs|etc)\.", r"\1<DOT>", text)
    # Split after sentence-ending punctuation (optionally followed by closing quote/paren) + space
    parts = re.split(r"(?<=[.!?…])(?:[”\"'’)\]]*)(?=\s+)", protected)
    out = [p.replace("<DOT>", ".").strip() for p in parts if p.strip()]
    return out or [text]


def _dp_partition(
    turns_slice: list[dict[str, Any]],
    units: list[tuple[str, int]],
) -> list[str]:
    """Partition `len(units) >= len(turns_slice)` ordered text units into `len(turns_slice)`
    non-empty contiguous chunks matching the turns as closely as possible.

    Each element of `units` is `(text, source_row_idx)` so chunks from the same original row
    join with `" "` while chunks from different rows join with `"\\n"`.
    """
    n = len(turns_slice)
    m = len(units)

    def join_units(lo: int, hi: int) -> str:
        out = units[lo][0]
        prev_row = units[lo][1]
        for k in range(lo + 1, hi):
            txt, ridx = units[k]
            sep = " " if ridx == prev_row else "\n"
            out += sep + txt
            prev_row = ridx
        return out

    has_ref = all(bool((t.get("translations") or {}).get("en_hasuko", {}).get("text")) for t in turns_slice)
    ref_norms = [
        _norm_for_sim((t.get("translations") or {}).get("en_hasuko", {}).get("text", ""))
        for t in turns_slice
    ]
    jp_lens = [max(len(re.sub(r"\s+", "", t["textJp"])), 1) for t in turns_slice]
    total_jp = sum(jp_lens)
    total_en = max(sum(len(u[0]) for u in units), 1)

    def chunk_cost(turn_i: int, lo: int, hi: int) -> float:
        cand = join_units(lo, hi)
        cost = 0.0
        if has_ref:
            sim = difflib.SequenceMatcher(None, ref_norms[turn_i], _norm_for_sim(cand), autojunk=False).ratio()
            cost += 1.0 - sim
        else:
            en_share = len(cand) / total_en
            jp_share = jp_lens[turn_i] / total_jp
            cost += 4.0 * (en_share - jp_share) ** 2
            # Prefer matching the JP turn's own line-break count when merging Idol Story lines
            jp_lines = turns_slice[turn_i]["textJp"].count("\n") + 1
            en_rows = len({units[k][1] for k in range(lo, hi)})
            cost += 0.02 * abs(en_rows - jp_lines)
        # Mildly discourage splitting a single Idol Story line across turn boundaries unless needed
        if lo > 0 and units[lo][1] == units[lo - 1][1]:
            cost += 0.01
        return cost

    INF = 1e18
    dp = [[INF] * (m + 1) for _ in range(n + 1)]
    back = [[-1] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0.0

    for i in range(1, n + 1):
        # Leave at least 1 unit for each remaining turn
        min_j = i
        max_j = m - (n - i)
        for j in range(min_j, max_j + 1):
            for prev_j in range(i - 1, j):
                c = dp[i - 1][prev_j] + chunk_cost(i - 1, prev_j, j)
                if c < dp[i][j]:
                    dp[i][j] = c
                    back[i][j] = prev_j

    bounds: list[tuple[int, int]] = []
    cur = m
    for i in range(n, 0, -1):
        prev = back[i][cur]
        bounds.append((prev, cur))
        cur = prev
    bounds.reverse()
    return [join_units(lo, hi) for lo, hi in bounds]


def align_idolst_turns(
    turns: list[dict[str, Any]],
    rows: list[dict[str, str]],
) -> dict[int, dict[str, str]]:
    """Align Idol Story transcript rows to game dialogue turns.

    Uses speaker-sequence alignment (`SequenceMatcher`), expanding adjacent same-speaker runs
    around gaps so multi-line turns (1-to-N) and merged turns (N-to-1) are repartitioned cleanly
    without shifting subsequent lines.
    """
    ours_sp = [_norm_speaker(t.get("speakerEn") or t.get("speakerJp") or "") for t in turns]
    theirs_sp = [_norm_speaker(r.get("speaker") or "") for r in rows]

    opcodes = [
        list(op)
        for op in difflib.SequenceMatcher(None, ours_sp, theirs_sp, autojunk=False).get_opcodes()
    ]

    # Expand same-speaker gaps into neighboring `equal` blocks of that same speaker so a
    # 2-to-1 merge or 1-to-2 split inside a speaker run is solved as one unit.
    merged: list[list[Any]] = []
    for op in opcodes:
        tag, i1, i2, j1, j2 = op
        if tag == "equal":
            merged.append(op)
            continue

        gap_speakers = {s for s in ours_sp[i1:i2] + theirs_sp[j1:j2] if s}
        if len(gap_speakers) == 1:
            sp = next(iter(gap_speakers))
            # Pull matching tail from the preceding equal block
            if merged and merged[-1][0] == "equal":
                prev = merged[-1]
                while prev[2] > prev[1] and ours_sp[prev[2] - 1] == sp and theirs_sp[prev[4] - 1] == sp:
                    prev[2] -= 1
                    prev[4] -= 1
                    i1 -= 1
                    j1 -= 1
                if prev[1] == prev[2]:
                    merged.pop()
            # If the previous block is already a non-equal block for the same speaker, coalesce
            if merged and merged[-1][0] != "equal":
                prev_sp = {s for s in ours_sp[merged[-1][1]:merged[-1][2]] + theirs_sp[merged[-1][3]:merged[-1][4]] if s}
                if prev_sp == {sp}:
                    merged[-1][2] = i2
                    merged[-1][4] = j2
                    continue
            merged.append(["run", i1, i2, j1, j2])
        else:
            merged.append(op)

    # Also pull matching head from any following `equal` block into a preceding `run` block
    final_ops: list[list[Any]] = []
    idx = 0
    while idx < len(merged):
        op = merged[idx]
        if op[0] == "run" and idx + 1 < len(merged) and merged[idx + 1][0] == "equal":
            _, i1, i2, j1, j2 = op
            gap_speakers = {s for s in ours_sp[i1:i2] + theirs_sp[j1:j2] if s}
            if len(gap_speakers) == 1:
                sp = next(iter(gap_speakers))
                nxt = merged[idx + 1]
                while nxt[1] < nxt[2] and ours_sp[nxt[1]] == sp and theirs_sp[nxt[3]] == sp:
                    nxt[1] += 1
                    nxt[3] += 1
                    i2 += 1
                    j2 += 1
                op = ["run", i1, i2, j1, j2]
                if nxt[1] == nxt[2]:
                    merged.pop(idx + 1)
                    # Check if the new next block is also a `run` of the same speaker
                    if idx + 1 < len(merged) and merged[idx + 1][0] == "run":
                        n2 = merged[idx + 1]
                        n2_sp = {s for s in ours_sp[n2[1]:n2[2]] + theirs_sp[n2[3]:n2[4]] if s}
                        if n2_sp == {sp}:
                            op[2] = n2[2]
                            op[4] = n2[4]
                            merged.pop(idx + 1)
                            continue
        final_ops.append(op)
        idx += 1

    aligned: dict[int, dict[str, str]] = {}
    for tag, i1, i2, j1, j2 in final_ops:
        n_ours = i2 - i1
        n_theirs = j2 - j1
        if tag == "equal" or (n_ours == n_theirs and n_ours > 0):
            for k in range(n_ours):
                r = rows[j1 + k]
                aligned[i1 + k] = {"speaker": r["speaker"] or turns[i1 + k]["speakerEn"], "text": r["text"]}
        elif tag == "run" and n_ours > 0 and n_theirs > 0:
            speaker_display = rows[j1]["speaker"] or turns[i1]["speakerEn"]
            if n_ours < n_theirs:
                units = [(rows[j]["text"], j) for j in range(j1, j2)]
                chunks = _dp_partition(turns[i1:i2], units)
                for k, txt in enumerate(chunks):
                    aligned[i1 + k] = {"speaker": speaker_display, "text": txt}
            else:
                # n_ours > n_theirs: split merged Idol Story line(s) at sentence boundaries
                units = []
                for j in range(j1, j2):
                    for seg in _split_sentences(rows[j]["text"]):
                        units.append((seg, j))
                if len(units) >= n_ours:
                    chunks = _dp_partition(turns[i1:i2], units)
                    for k, txt in enumerate(chunks):
                        aligned[i1 + k] = {"speaker": speaker_display, "text": txt}
        # Otherwise (unmatched extra lines from a different speaker like Tsuzuri humming): skip cleanly.

    return aligned
