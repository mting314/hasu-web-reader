#!/usr/bin/env python3
"""
Yomitan-style Japanese word segmentation + dictionary lookup (build-time).

Mirrors how Yomitan's built-in "scanning parser" splits a sentence:

  1. Starting at the current character, take the next N characters (scan length 16).
  2. For every prefix length (longest first), generate text variants
     (hiragana <-> katakana, collapsed emphatic っ/ー, 〜 -> ー) and run each variant
     through a rule-based deinflector (食べました -> 食べる, すっごく -> すごい, ...).
  3. Look every candidate up in JMdict (+ a small series-specific term list). A
     deinflected candidate only counts if the dictionary entry's part of speech
     satisfies the deinflection rule (e.g. "-ta" on an ichidan verb).
  4. The longest prefix that produced at least one entry becomes a token; if nothing
     matched, the character is emitted as an ungrouped (non-lookup) segment.

Dictionary data: JMdict (EDRDG, CC BY-SA 4.0) via scriptin/jmdict-simplified.
"""

from __future__ import annotations

import json
import pickle
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

SCAN_LENGTH = 16
MAX_ENTRIES_PER_TOKEN = 8
INDEX_CACHE_VERSION = 4

# ---------------------------------------------------------------------------
# Character helpers
# ---------------------------------------------------------------------------

HIRA_START, HIRA_END = 0x3041, 0x3096
KATA_START, KATA_END = 0x30A1, 0x30F6
EMPHATIC = {"っ", "ッ", "ー"}
SMALL_VOWELS = str.maketrans("ぁぃぅぇぉゎ", "あいうえおわ")
ELONGATION_ONLY = re.compile(r"^[ー〜～っッ]+$")
WORD_BREAKS = set(" 　\t\n\r、。，．,.!！?？「」『』（）()[]［］【】〈〉《》…‥・:：;；\"'“”‘’/／")


def is_kana(ch: str) -> bool:
    cp = ord(ch)
    return HIRA_START <= cp <= 0x309F or KATA_START - 1 <= cp <= 0x30FF


def is_kanji(ch: str) -> bool:
    cp = ord(ch)
    return (0x4E00 <= cp <= 0x9FFF) or (0x3400 <= cp <= 0x4DBF) or (0xF900 <= cp <= 0xFAFF) or ch in "々〆ヶ"


def is_japanese(ch: str) -> bool:
    cp = ord(ch)
    return (
        is_kana(ch)
        or is_kanji(ch)
        or 0xFF66 <= cp <= 0xFF9F  # half-width katakana
        or ch in "ー〜～"
    )


def has_kanji(s: str) -> bool:
    return any(is_kanji(c) for c in s)


def kata_to_hira(s: str) -> str:
    out = []
    for ch in s:
        cp = ord(ch)
        if KATA_START <= cp <= KATA_END:
            out.append(chr(cp - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def hira_to_kata(s: str) -> str:
    out = []
    for ch in s:
        cp = ord(ch)
        if HIRA_START <= cp <= HIRA_END:
            out.append(chr(cp + 0x60))
        else:
            out.append(ch)
    return "".join(out)


def collapse_emphatic(text: str, full: bool) -> str:
    """Port of the idea behind Yomitan's collapseEmphaticSequences.

    Leading/trailing emphatic characters are kept; runs inside the word are collapsed
    to one (partial) or removed entirely (full).
    """
    left = 0
    while left < len(text) and text[left] in EMPHATIC:
        left += 1
    right = len(text) - 1
    while right >= 0 and text[right] in EMPHATIC:
        right -= 1
    if left > right:
        return text
    middle = []
    prev_emphatic = None
    for ch in text[left : right + 1]:
        if ch in EMPHATIC:
            if prev_emphatic != ch:
                prev_emphatic = ch
                if not full:
                    middle.append(ch)
        else:
            prev_emphatic = None
            middle.append(ch)
    return text[:left] + "".join(middle) + text[right + 1 :]


def text_variants(s: str, phrase_end: bool = True) -> list[tuple[str, int]]:
    """Return (variant, preprocessing-steps) pairs, original first.

    `phrase_end` says whether `s` runs up to punctuation/end of line; trailing emphasis
    (違いますっ！) is only stripped there, so 親って is not read as 親っ + て.
    """
    seen: dict[str, int] = {}

    def add(v: str, steps: int) -> None:
        if v and (v not in seen or seen[v] > steps):
            seen[v] = steps

    base_forms = [(s, 0)]
    wave = s.replace("〜", "ー").replace("～", "ー")
    if wave != s:
        base_forms.append((wave, 1))
    nfkc = unicodedata.normalize("NFKC", s)
    if nfkc != s:
        base_forms.append((nfkc, 1))
    # Small hiragana vowels are emphatic in casual writing: わぁ -> わあ, えぇ -> ええ
    big = s.translate(SMALL_VOWELS)
    if big != s:
        base_forms.append((big, 1))
    # Trailing emphasis: 違いますっ -> 違います, すごーい〜 -> すごーい
    stripped = s.rstrip("っッー〜～ぁぃぅぇぉ")  # 部活かぁ -> 部活か, それなのにぃ -> それなのに
    if phrase_end and stripped and stripped != s:
        base_forms.append((stripped, 1))
    expanded: list[tuple[str, int]] = []
    for form, steps in base_forms:
        expanded.append((form, steps))
        partial = collapse_emphatic(form, False)
        if partial != form:
            expanded.append((partial, steps + 1))
        full = collapse_emphatic(form, True)
        if full != form and full != partial:
            expanded.append((full, steps + 1))
    for form, steps in expanded:
        add(form, steps)
        # katakana -> hiragana only (ヤバい -> やばい). The reverse direction makes plain hiragana
        # runs match katakana loanwords (ちゃんすっごく -> チャンス), which is never what a reader wants.
        h = kata_to_hira(form)
        if h != form:
            add(h, steps + 1)
    return sorted(seen.items(), key=lambda kv: kv[1])


# ---------------------------------------------------------------------------
# Deinflection rules
# ---------------------------------------------------------------------------

V1, V5, VK, VS, VZ, ADJ_I, COP = "v1", "v5", "vk", "vs", "vz", "adj-i", "cop"
TE, MASU, STEM, ADJ_STEM = "te", "masu", "stem", "adj-stem"
VERBS = frozenset({V1, V5, VK, VS, VZ})


@dataclass(frozen=True)
class Rule:
    kana_in: str
    kana_out: str
    rules_in: frozenset
    rules_out: frozenset
    reason: str | None
    require_cond: bool = False  # never applies to the raw (undeinflected) surface
    stem_guard: bool = False  # ichidan empty-suffix stem: previous char must fit
    intermediate: bool = False  # result must be deinflected further before it can match


GODAN = [
    # dict, a-row, i-row, e-row, o-row, te, ta
    ("う", "わ", "い", "え", "お", "って", "った"),
    ("く", "か", "き", "け", "こ", "いて", "いた"),
    ("ぐ", "が", "ぎ", "げ", "ご", "いで", "いだ"),
    ("す", "さ", "し", "せ", "そ", "して", "した"),
    ("つ", "た", "ち", "て", "と", "って", "った"),
    ("ぬ", "な", "に", "ね", "の", "んで", "んだ"),
    ("ぶ", "ば", "び", "べ", "ぼ", "んで", "んだ"),
    ("む", "ま", "み", "め", "も", "んで", "んだ"),
    ("る", "ら", "り", "れ", "ろ", "って", "った"),
]
ICHIDAN_STEM_KANA = set("いきぎしじちぢにひびぴみりえけげせぜてでねへべぺめれ")


def _build_rules() -> list[Rule]:
    rules: list[Rule] = []

    def r(kin: str, kout: str, rin: Iterable[str], rout: Iterable[str], reason: str | None, **kw: Any) -> None:
        rules.append(Rule(kin, kout, frozenset(rin), frozenset(rout), reason, **kw))

    # --- negative (behaves like an i-adjective afterwards) ---
    for d, a, *_ in GODAN:
        r(a + "ない", d, [ADJ_I], [V5], "negative")
    r("ない", "る", [ADJ_I], [V1], "negative")
    r("しない", "する", [ADJ_I], [VS], "negative")
    r("こない", "くる", [ADJ_I], [VK], "negative")
    r("来ない", "来る", [ADJ_I], [VK], "negative")
    r("じない", "ずる", [ADJ_I], [VZ], "negative")
    r("くない", "い", [ADJ_I], [ADJ_I], "negative")
    r("なきゃ", "ない", [], [ADJ_I], "-nakya (must)")
    r("なくちゃ", "ない", [], [ADJ_I], "-nakucha (must)")
    r("なけりゃ", "ない", [], [ADJ_I], "-nakerya (must)")
    # 食べないで -> 食べない -> 食べる; the adjective ない itself has no "ないで" form
    r("ないで", "ない", [], [ADJ_I], "negative -te", intermediate=True)

    # --- classical / colloquial negatives (terminal) ---
    for suffix, reason in (("ん", "negative (colloquial)"), ("ず", "-zu (without)"), ("ぬ", "-nu (negative)"), ("ねえ", "negative (slang)"), ("ねぇ", "negative (slang)")):
        for d, a, *_ in GODAN:
            r(a + suffix, d, [], [V5], reason)
        r(suffix, "る", [], [V1], reason)
        r("せ" + suffix if suffix != "ねえ" and suffix != "ねぇ" else "し" + suffix, "する", [], [VS], reason)
        r("こ" + suffix, "くる", [], [VK], reason)
        r("来" + suffix, "来る", [], [VK], reason)

    # --- polite -masu (via the continuative stem) ---
    r("ます", "", [MASU], [STEM], "polite")
    r("ません", "ます", [], [MASU], "negative")
    r("ました", "ます", [], [MASU], "past")
    r("ませんでした", "ます", [], [MASU], "negative past")
    r("ましょう", "ます", [], [MASU], "volitional")
    r("まして", "ます", [], [MASU], "-te")
    r("ましたら", "ます", [], [MASU], "conditional")
    r("ませ", "ます", [], [MASU], "imperative")
    r("たい", "", [ADJ_I], [STEM], "-tai (want)")
    r("なさい", "", [], [STEM], "polite imperative")
    r("ながら", "", [], [STEM], "-nagara (while)")
    r("そう", "", [], [STEM, ADJ_STEM], "-sou (looks like)")
    r("すぎる", "", [V1], [STEM, ADJ_STEM], "-sugiru (too much)")
    r("過ぎる", "", [V1], [STEM, ADJ_STEM], "-sugiru (too much)")
    r("さそう", "い", [], [ADJ_I], "-sou (looks like)")  # よさそう / なさそう

    # continuative stem -> dictionary form (no extra reason; also covers bare 連用形)
    for d, _a, i, *_ in GODAN:
        r(i, d, [STEM], [V5], None)
    r("", "る", [STEM], [V1], None, stem_guard=True)
    r("し", "する", [STEM], [VS], None)
    r("き", "くる", [STEM], [VK], None)
    r("来", "来る", [STEM], [VK], None)
    r("じ", "ずる", [STEM], [VZ], None)
    r("", "い", [ADJ_STEM], [ADJ_I], None, require_cond=True)

    # --- te-form ---
    for d, _a, _i, _e, _o, te, _ta in GODAN:
        r(te, d, [TE], [V5], "-te")
    r("て", "る", [TE], [V1], "-te")
    r("して", "する", [TE], [VS], "-te")
    r("きて", "くる", [TE], [VK], "-te")
    r("来て", "来る", [TE], [VK], "-te")
    r("じて", "ずる", [TE], [VZ], "-te")
    r("くて", "い", [TE], [ADJ_I], "-te")
    r("行って", "行く", [TE], [V5], "-te")
    r("いって", "いく", [TE], [V5], "-te")
    # te-form + auxiliary (the auxiliary decides the outer word class)
    for te_tail in ("て", "で"):
        r(te_tail + "いる", te_tail, [V1], [TE], "-te iru (progressive)")
        r(te_tail + "る", te_tail, [V1], [TE], "-te iru (progressive)")
        r(te_tail + "おく", te_tail, [V5], [TE], "-te oku (in advance)")
        r(te_tail + "しまう", te_tail, [V5], [TE], "-te shimau (completely)")
        r(te_tail + "ある", te_tail, [V5], [TE], "-te aru (has been done)")
    r("とく", "て", [V5], [TE], "-te oku (in advance)")
    r("どく", "で", [V5], [TE], "-te oku (in advance)")
    r("ちゃう", "て", [V5], [TE], "-chau (completely)")
    r("じゃう", "で", [V5], [TE], "-chau (completely)")
    r("ちまう", "て", [V5], [TE], "-chimau (completely)")
    r("じまう", "で", [V5], [TE], "-chimau (completely)")
    r("ちゃ", "て", [], [TE], "-te wa (contracted)")
    r("じゃ", "で", [], [TE], "-te wa (contracted)")

    # --- past / -tara / -tari (terminal) ---
    for ta_suffix, reason in (("", "past"), ("ら", "-tara (if/when)"), ("り", "-tari (and so on)")):
        for d, _a, _i, _e, _o, _te, ta in GODAN:
            r(ta + ta_suffix, d, [], [V5], reason)
        r("た" + ta_suffix, "る", [], [V1], reason)
        r("した" + ta_suffix, "する", [], [VS], reason)
        r("きた" + ta_suffix, "くる", [], [VK], reason)
        r("来た" + ta_suffix, "来る", [], [VK], reason)
        r("じた" + ta_suffix, "ずる", [], [VZ], reason)
        r("かった" + ta_suffix, "い", [], [ADJ_I], reason)
        r("行った" + ta_suffix, "行く", [], [V5], reason)
        r("いった" + ta_suffix, "いく", [], [V5], reason)
        r("だった" + ta_suffix, "だ", [], [COP], reason)
        r("でした" + ta_suffix, "です", [], [COP], reason)

    # --- -ba conditional ---
    for d, _a, _i, e, *_ in GODAN:
        r(e + "ば", d, [], [V5], "-ba (if)")
    r("れば", "る", [], [V1, VK, VS, VZ], "-ba (if)")
    r("ければ", "い", [], [ADJ_I], "-ba (if)")

    # --- volitional ---
    for d, _a, _i, _e, o, *_ in GODAN:
        r(o + "う", d, [], [V5], "volitional")
    r("よう", "る", [], [V1], "volitional")
    r("しよう", "する", [], [VS], "volitional")
    r("こよう", "くる", [], [VK], "volitional")
    r("来よう", "来る", [], [VK], "volitional")
    r("かろう", "い", [], [ADJ_I], "volitional")

    # --- imperative ---
    for d, _a, _i, e, *_ in GODAN:
        r(e, d, [], [V5], "imperative")
    r("ろ", "る", [], [V1], "imperative")
    r("しろ", "する", [], [VS], "imperative")
    r("せよ", "する", [], [VS], "imperative")
    r("こい", "くる", [], [VK], "imperative")
    r("来い", "来る", [], [VK], "imperative")
    r("な", "", [], [V1, V5, VK, VS, VZ], "negative imperative", require_cond=False)

    # --- potential / passive / causative (all become ichidan verbs) ---
    for d, a, _i, e, *_ in GODAN:
        r(e + "る", d, [V1], [V5], "potential")
        r(a + "れる", d, [V1], [V5], "passive")
        r(a + "せる", d, [V1], [V5], "causative")
        r(a + "す", d, [V5], [V5], "causative (short)")
    r("られる", "る", [V1], [V1], "potential / passive")
    r("れる", "る", [V1], [V1], "potential (ra-less)")
    r("させる", "る", [V1], [V1], "causative")
    r("される", "する", [V1], [VS], "passive")
    r("させる", "する", [V1], [VS], "causative")
    r("こられる", "くる", [V1], [VK], "potential / passive")
    r("来られる", "来る", [V1], [VK], "potential / passive")
    r("こさせる", "くる", [V1], [VK], "causative")
    r("来させる", "来る", [V1], [VK], "causative")

    # --- i-adjective odds and ends ---
    r("く", "い", [], [ADJ_I], "adverb")
    r("さ", "い", [], [ADJ_I], "noun (-sa)")
    return rules


RULES = _build_rules()
RULES_BY_LAST: dict[str, list[Rule]] = {}
EMPTY_SUFFIX_RULES: list[Rule] = []
for _rule in RULES:
    if _rule.kana_in:
        RULES_BY_LAST.setdefault(_rule.kana_in[-1], []).append(_rule)
    else:
        EMPTY_SUFFIX_RULES.append(_rule)


@dataclass
class Deinflection:
    text: str
    conds: frozenset | None  # None = raw surface (no part-of-speech constraint)
    reasons: tuple[str, ...]
    bare_stem: bool = False  # produced by reading the raw surface as a bare masu stem
    lookup: bool = True  # False for intermediate states that must be deinflected further


_deinflect_cache: dict[str, list[Deinflection]] = {}


def deinflect(source: str) -> list[Deinflection]:
    cached = _deinflect_cache.get(source)
    if cached is not None:
        return cached
    results = [Deinflection(source, None, ())]
    seen = {(source, None)}
    queue = [results[0]]
    while queue:
        cur = queue.pop(0)
        if len(cur.reasons) >= 7:
            continue
        candidates = list(RULES_BY_LAST.get(cur.text[-1], [])) if cur.text else []
        candidates += EMPTY_SUFFIX_RULES
        for rule in candidates:
            if rule.kana_in and not cur.text.endswith(rule.kana_in):
                continue
            if cur.conds is None:
                if rule.require_cond:
                    continue
            else:
                if not rule.rules_in or not (rule.rules_in & cur.conds):
                    continue
                if cur.bare_stem and TE in rule.rules_out:
                    continue  # X -> Xる (stem) -> Xて (te-iru) would just re-read the surface
            stem = cur.text[: len(cur.text) - len(rule.kana_in)] if rule.kana_in else cur.text
            if not stem and not rule.kana_out:
                continue
            if rule.stem_guard and (not stem or not (stem[-1] in ICHIDAN_STEM_KANA or is_kanji(stem[-1]))):
                continue
            new_text = stem + rule.kana_out
            if not new_text or new_text == cur.text and rule.rules_out == cur.conds:
                continue
            key = (new_text, rule.rules_out)
            if key in seen:
                continue
            seen.add(key)
            reasons = cur.reasons
            reason = rule.reason
            bare_stem = reason is None and cur.conds is None and STEM in rule.rules_in
            if bare_stem:
                reason = "masu stem"  # bare continuative form, e.g. 食べに行く -> 食べ
            if reason and not (reason == "-te" and cur.conds is not None and TE in cur.conds and cur.reasons):
                reasons = cur.reasons + (reason,)
            nxt = Deinflection(new_text, rule.rules_out, reasons, bare_stem or cur.bare_stem, not rule.intermediate)
            results.append(nxt)
            queue.append(nxt)
    _deinflect_cache[source] = results
    return results


# ---------------------------------------------------------------------------
# Dictionary
# ---------------------------------------------------------------------------

POS_CLASS = {
    "v1": V1, "v1-s": V1,
    "v5u": V5, "v5k": V5, "v5g": V5, "v5s": V5, "v5t": V5, "v5n": V5, "v5b": V5, "v5m": V5, "v5r": V5,
    "v5k-s": V5, "v5r-i": V5, "v5u-s": V5, "v5aru": V5, "v5uru": V5,
    "vk": VK, "vs-i": VS, "vs-s": VS, "vz": VZ,
    "adj-i": ADJ_I, "adj-ix": ADJ_I,
    "cop": COP,
}
RARE_FORM_TAGS = {"rK", "rk", "sK", "sk", "oK", "ok", "iK", "ik", "ateji", "io"}
SEARCH_ONLY_TAGS = {"sK", "sk"}


@dataclass
class Entry:
    id: str
    kanji: list[dict]
    kana: list[dict]
    senses: list[dict]
    custom: bool = False
    classes: frozenset = field(default_factory=frozenset)
    common: bool = False
    uk: bool = False

    def form_info(self, form: str) -> tuple[bool, bool, bool, bool]:
        """(is_kanji_form, form_common, form_rare, form_search_only)"""
        for k in self.kanji:
            if k["text"] == form:
                tags = set(k.get("tags") or [])
                return True, bool(k.get("common")), bool(tags & RARE_FORM_TAGS), bool(tags & SEARCH_ONLY_TAGS)
        for k in self.kana:
            if k["text"] == form:
                tags = set(k.get("tags") or [])
                return False, bool(k.get("common")), bool(tags & RARE_FORM_TAGS), bool(tags & SEARCH_ONLY_TAGS)
        return False, False, True, False


def _finalize_entry(e: Entry) -> Entry:
    classes = set()
    uk = False
    for s in e.senses:
        for p in s.get("partOfSpeech") or []:
            c = POS_CLASS.get(p)
            if c:
                classes.add(c)
        if "uk" in (s.get("misc") or []):
            uk = True
    e.classes = frozenset(classes)
    e.common = any(k.get("common") for k in e.kanji) or any(k.get("common") for k in e.kana)
    e.uk = uk
    return e


class Dictionary:
    def __init__(self, jmdict_json: Path, custom_terms: Path | None = None, cache_dir: Path | None = None):
        self.entries: dict[str, Entry] = {}
        self.index: dict[str, list[str]] = {}
        self.tags: dict[str, str] = {}
        self._load_jmdict(jmdict_json, cache_dir)
        if custom_terms and custom_terms.exists():
            self._load_custom(custom_terms)

    def _load_jmdict(self, path: Path, cache_dir: Path | None) -> None:
        cache_file = (cache_dir or path.parent) / f"{path.stem}.index.v{INDEX_CACHE_VERSION}.pickle"
        if cache_file.exists() and cache_file.stat().st_mtime >= path.stat().st_mtime:
            with cache_file.open("rb") as f:
                data = pickle.load(f)
            # Plain tuples only (no class references) so the cache works no matter which
            # script imported this module.
            for eid, kanji, kana, senses in data["entries"]:
                self.entries[eid] = _finalize_entry(Entry(eid, kanji, kana, senses))
            self.index, self.tags = data["index"], data["tags"]
            return
        raw = json.loads(path.read_text(encoding="utf-8"))
        self.tags = raw.get("tags", {})
        for w in raw["words"]:
            senses = []
            for s in w.get("sense", []):
                glosses = [g["text"] for g in s.get("gloss", []) if g.get("lang", "eng") == "eng"]
                if not glosses:
                    continue
                senses.append({
                    "partOfSpeech": s.get("partOfSpeech") or [],
                    "misc": s.get("misc") or [],
                    "field": s.get("field") or [],
                    "dialect": s.get("dialect") or [],
                    "info": s.get("info") or [],
                    "appliesToKanji": s.get("appliesToKanji") or ["*"],
                    "appliesToKana": s.get("appliesToKana") or ["*"],
                    "gloss": glosses,
                })
            if not senses:
                continue
            e = _finalize_entry(Entry(
                id=str(w["id"]),
                kanji=[{"text": k["text"], "common": k.get("common", False), "tags": k.get("tags") or []} for k in w.get("kanji", [])],
                kana=[{"text": k["text"], "common": k.get("common", False), "tags": k.get("tags") or [], "appliesToKanji": k.get("appliesToKanji") or ["*"]} for k in w.get("kana", [])],
                senses=senses,
            ))
            self.entries[e.id] = e
            for form in [k["text"] for k in e.kanji] + [k["text"] for k in e.kana]:
                self.index.setdefault(form, []).append(e.id)
        with cache_file.open("wb") as f:
            pickle.dump(
                {
                    "entries": [(e.id, e.kanji, e.kana, e.senses) for e in self.entries.values()],
                    "index": self.index,
                    "tags": self.tags,
                },
                f,
                protocol=pickle.HIGHEST_PROTOCOL,
            )

    def _load_custom(self, path: Path) -> None:
        data = json.loads(path.read_text(encoding="utf-8"))
        self.tags.update(data.get("tags", {}))
        for i, t in enumerate(data.get("terms", [])):
            eid = f"x{i}"
            e = _finalize_entry(Entry(
                id=eid,
                kanji=[{"text": k, "common": True, "tags": []} for k in t.get("kanji", [])],
                kana=[{"text": k, "common": True, "tags": [], "appliesToKanji": ["*"]} for k in t.get("kana", [])],
                senses=[{
                    "partOfSpeech": t.get("pos", ["n"]),
                    "misc": t.get("misc", []),
                    "field": [],
                    "dialect": [],
                    "info": [t["info"]] if t.get("info") else [],
                    "appliesToKanji": ["*"],
                    "appliesToKana": ["*"],
                    "gloss": t["gloss"],
                }],
                custom=True,
            ))
            self.entries[eid] = e
            # Names written in kanji are only indexed by their kanji spelling so that ordinary
            # kana words (e.g. めぐみ "blessing") are not mistaken for a character name.
            indexed = list(t.get("kanji", []))
            if not indexed or t.get("indexKana"):
                indexed += t.get("kana", [])
            for form in indexed:
                self.index.setdefault(form, []).append(eid)

    def lookup(self, form: str) -> list[Entry]:
        return [self.entries[i] for i in self.index.get(form, ())]


# ---------------------------------------------------------------------------
# Scanning parser
# ---------------------------------------------------------------------------

@dataclass
class Match:
    entry: Entry
    form: str  # the dictionary form that matched (kanji or kana headword)
    reasons: tuple[str, ...]
    variant_steps: int
    score: tuple = ()


FUNCTION_POS = {"prt", "cop", "aux", "aux-v", "aux-adj", "conj", "int", "suf", "pref", "exp", "pn"}
PARTICLE_POS = {"prt", "cop", "aux", "aux-v", "aux-adj", "conj"}
SINGLE_KANA_WORD_POS = {"prt", "cop", "aux", "aux-v", "aux-adj", "conj", "int"}


def _entry_pos(e: Entry) -> set[str]:
    return {p for s in e.senses for p in s.get("partOfSpeech") or []}


def _is_function_word(e: Entry) -> bool:
    return bool(_entry_pos(e) & FUNCTION_POS)


def _normal_kanji_forms(e: Entry) -> list[str]:
    """Kanji spellings that are not tagged rare/outdated/irregular/search-only (の's 乃・之 are)."""
    return [k["text"] for k in e.kanji if not (set(k.get("tags") or []) & RARE_FORM_TAGS)]


def _is_kanji_normal(e: Entry) -> bool:
    """Normally written with kanji: has a regular kanji spelling and isn't "usually kana"."""
    return not e.uk and not e.custom and bool(_normal_kanji_forms(e))


UNKNOWN_JP_CHAR_COST = 3.0
UNKNOWN_OTHER_CHAR_COST = 0.05
DEFAULT_ZIPF_FUNCTION_WORD = 3.0  # rare particle compounds (がね); frequent ones are listed below
# Frequent spoken particle/copula compounds that wordfreq lacks because MeCab splits them.
PARTICLE_COMPOUND_ZIPF = {
    "かな": 6.5, "かなぁ": 5.0, "よね": 6.2, "だよね": 5.0, "ですか": 6.0, "ですね": 5.8, "ですよ": 5.5,
    "ですよね": 5.0, "んだ": 6.0, "んです": 6.0, "んですか": 5.5, "のに": 6.0, "じゃん": 5.5,
    "でしょ": 5.5, "かしら": 4.5, "っけ": 4.5, "にて": 4.5, "ってば": 4.0, "なの": 5.5,
}
DEFAULT_ZIPF_CONTENT_WORD = 2.5
CUSTOM_TERM_ZIPF = 5.0


def load_zipf_table(path: Path | None) -> dict[str, float]:
    if not path or not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8")).get("zipf", {})


class Lexer:
    """Yomitan-style dictionary/deinflection matching with a lowest-cost segmentation.

    Yomitan's scanning parser is purely greedy (always the longest match at the cursor),
    which mis-splits common phrases like は|この|学校 as はこ(箱)|の|学校. Here every
    dictionary match at every position is a candidate edge and the cheapest path through
    the sentence wins. A word's cost falls with its corpus frequency (wordfreq Zipf score
    of the *spelling* that matched, so kana spellings of kanji words are naturally
    unlikely); among equally cheap paths the longest leftmost word wins, which is
    Yomitan's own rule.
    """

    def __init__(self, dictionary: Dictionary, zipf: dict[str, float] | None = None):
        self.d = dictionary
        self.zipf = zipf or {}
        self._find_cache: dict[tuple[str, bool], dict[int, list[Match]]] = {}

    # -- scoring -------------------------------------------------------------
    def word_zipf(self, m: Match) -> float:
        """Corpus frequency of the spelling that matched (wordfreq Zipf scale, 0-8)."""
        if m.entry.custom:
            return CUSTOM_TERM_ZIPF
        z = self.zipf.get(m.form)
        if z is not None:
            if not has_kanji(m.form) and _is_kanji_normal(m.entry):
                # The kana string may be dominated by a homograph (そう the adverb vs 沿う);
                # a kanji word's kana spelling can't be much more common than the kanji one.
                kanji_z = max((self.zipf.get(k, 0.0) for k in _normal_kanji_forms(m.entry)), default=0.0)
                z = min(z, kanji_z + 0.5)
            return z
        # Not in wordfreq. Its MeCab-based counts split particle chains, so frequent spoken
        # compounds (かな, んです) need explicit values; a kana spelling of a kanji word
        # (そうなん -> 遭難) is genuinely rare.
        if m.form in PARTICLE_COMPOUND_ZIPF:
            return PARTICLE_COMPOUND_ZIPF[m.form]
        if _entry_pos(m.entry) & PARTICLE_POS:
            return DEFAULT_ZIPF_FUNCTION_WORD
        if not has_kanji(m.form) and _is_kanji_normal(m.entry):
            return 2.0
        return 4.0 if m.entry.common else DEFAULT_ZIPF_CONTENT_WORD

    def rank(self, m: Match, surface: str) -> tuple:
        is_kanji_form, form_common, form_rare, form_search_only = m.entry.form_info(m.form)
        if has_kanji(surface):
            script_fit = 0 if is_kanji_form else 1
        elif not m.entry.kanji:
            script_fit = 0  # kana-only words (particles like よ/か/に/の)
        elif m.entry.uk:
            script_fit = 1  # "usually written in kana" words
        elif form_common:
            script_fit = 2
        else:
            script_fit = 3
        try:
            id_num = int(m.entry.id)
        except ValueError:
            id_num = 0
        return (
            0 if m.entry.custom else 1,
            m.variant_steps,  # exact spelling before emphatic/kana-normalised spellings
            # Frequency, with each deinflection step worth 1.5 Zipf: exact matches still come first
            # unless a conjugated reading is far more common (しよう -> する before 仕様,
            # but あれ the pronoun before ある's imperative).
            -round(self.word_zipf(m) - 1.5 * len(m.reasons), 1),
            0 if m.entry.common else 1,
            script_fit,
            0 if form_common else 1,
            1 if (form_rare or form_search_only) else 0,
            id_num,
        )

    def token_cost(self, surface: str, matches: list[Match], clause_start: bool) -> float:
        """Plausibility cost of reading `surface` as one word (lower = more likely).

        Roughly 1 + (7.5 - Zipf)/4: a very frequent particle costs ~1, a rare word ~2.3,
        so splitting a word into several frequent particles is not free.
        """
        best = matches[0]
        zipf = max(self.word_zipf(m) for m in matches if m.variant_steps == best.variant_steps)
        cost = 1.0 + 0.25 * (7.5 - min(7.5, max(1.0, zipf)))
        cost += 0.1 * min(4, len(best.reasons))  # equal splits favour plain words over conjugations
        if best.variant_steps:
            cost += 0.35
            if any(is_kana(c) and ord(c) < KATA_START - 1 for c in surface) and any(ord(c) >= KATA_START - 1 and is_kana(c) for c in surface):
                cost += 1.0  # hiragana+katakana glued together (の+バス -> 伸ばす) is two words
        if not has_kanji(surface) and _is_kanji_normal(best.entry):
            cost += 0.25  # kana spelling of a word normally written in kanji (はこ -> 箱)
            if best.reasons:
                cost += 0.25  # ...and conjugated on top of that (かなって -> 叶う, はもう -> 食む)
        if not (best.entry.common or best.entry.custom):
            cost += 0.4  # JMdict marks the everyday vocabulary as common
        if not clause_start and _entry_pos(best.entry) == {"conj"}:
            cost += 1.0  # conjunctions start clauses: いいよって is いい|よ|って, not いい|よって
        if _entry_pos(best.entry) & {"prt", "cop", "aux", "aux-v"}:
            cost *= 0.8  # particles/copula glue words together; chains like よ|って are normal
        if len(surface) == 1:
            pos = _entry_pos(best.entry)
            if is_kana(surface):
                if best.reasons:
                    cost += 1.5  # a lone kana explained only by deinflection (れ -> れる) is rarely right
                elif not pos & SINGLE_KANA_WORD_POS:
                    cost += 0.5  # lone kana suffixes/nouns (ら -> 等) are usually part of something else
                elif clause_start and "prt" in pos and "int" not in pos:
                    cost += 0.8  # particles don't start clauses (しおれちゃう is not し|おれちゃう)
            elif is_kanji(surface):
                cost += 0.2
        return cost


    def find_all(self, text: str, window_ends_phrase: bool = True) -> dict[int, list[Match]]:
        """Return {source_length: all ranked matches} for every prefix of `text` with a match."""
        cache_key = (text, window_ends_phrase)
        cached = self._find_cache.get(cache_key)
        if cached is not None:
            return cached
        by_length: dict[int, list[Match]] = {}
        for length in range(len(text), 0, -1):
            source = text[:length]
            if ELONGATION_ONLY.match(source):
                continue  # a bare 〜/ー/っ run is emphasis, not a word
            found: dict[str, Match] = {}
            for variant, steps in text_variants(source, phrase_end=length == len(text) and window_ends_phrase):
                for di in deinflect(variant):
                    if not di.lookup:
                        continue
                    for entry in self.d.lookup(di.text):
                        if di.conds is not None and not (entry.classes & di.conds):
                            continue
                        if di.reasons and di.text.endswith("いい") and "adj-ix" in _entry_pos(entry):
                            continue  # 良い conjugates from よい (よく, よかった); いく is not a form of いい
                        m = Match(entry, di.text, di.reasons, steps)
                        m.score = self.rank(m, source)
                        prev = found.get(entry.id)
                        if prev is None or m.score < prev.score:
                            found[entry.id] = m
            if found:
                by_length[length] = sorted(found.values(), key=lambda mm: mm.score)
        self._find_cache[cache_key] = by_length
        return by_length

    def parse(self, text: str) -> list[dict[str, Any]]:
        n = len(text)
        # Candidate edges: (end, cost, matches-or-None) for every start position.
        edges: list[list[tuple[int, float, list[Match] | None]]] = [[] for _ in range(n)]
        for i, ch in enumerate(text):
            plain_cost = UNKNOWN_JP_CHAR_COST if (is_japanese(ch) and ch not in WORD_BREAKS) else UNKNOWN_OTHER_CHAR_COST
            edges[i].append((i + 1, plain_cost, None))
            if ch in WORD_BREAKS:
                continue
            end = i
            while end < n and end - i < SCAN_LENGTH and text[end] not in WORD_BREAKS:
                end += 1
            window_ends_phrase = end >= n or text[end] in WORD_BREAKS
            clause_start = i == 0 or text[i - 1] in WORD_BREAKS
            for length, matches in self.find_all(text[i:end], window_ends_phrase).items():
                if not matches or (length == 1 and not is_japanese(ch)):
                    continue
                edges[i].append((i + length, self.token_cost(text[i : i + length], matches, clause_start), matches))

        # Cheapest cost to finish the sentence from each position (backward pass).
        best_from = [0.0] * (n + 1)
        for i in range(n - 1, -1, -1):
            best_from[i] = min(c + best_from[j] for j, c, _ in edges[i])

        # Walk forward; among optimal choices take the longest word (Yomitan's leftmost-longest rule).
        segments: list[tuple[int, int, list[Match] | None]] = []
        i = 0
        while i < n:
            optimal = [(j, m) for j, c, m in edges[i] if c + best_from[j] <= best_from[i] + 1e-9]
            j, matches = max(optimal, key=lambda e: (e[0], e[1] is not None))
            segments.append((i, j, matches))
            i = j

        tokens: list[dict[str, Any]] = []
        for i, j, matches in segments:
            surface = text[i:j]
            if matches:
                tokens.append({
                    "t": surface,
                    "m": [
                        {"e": m.entry.id, "f": m.form, **({"r": list(m.reasons)} if m.reasons else {})}
                        for m in matches[:MAX_ENTRIES_PER_TOKEN]
                    ],
                })
            elif tokens and "m" not in tokens[-1]:
                tokens[-1]["t"] += surface
            else:
                tokens.append({"t": surface})
        return tokens


# ---------------------------------------------------------------------------
# Compact lexicon export for the web client
# ---------------------------------------------------------------------------

def export_entry(e: Entry) -> dict[str, Any]:
    out: dict[str, Any] = {}
    kanji = [k for k in e.kanji if not (set(k.get("tags") or []) & SEARCH_ONLY_TAGS)]
    kana = [k for k in e.kana if not (set(k.get("tags") or []) & SEARCH_ONLY_TAGS)]
    if kanji:
        out["k"] = [k["text"] for k in kanji]
        kt = {k["text"]: k["tags"] for k in kanji if k.get("tags")}
        if kt:
            out["kt"] = kt
    out["r"] = [k["text"] for k in kana]
    ra = {k["text"]: k["appliesToKanji"] for k in kana if k.get("appliesToKanji") not in (None, ["*"])}
    if ra:
        out["ra"] = ra
    rt = {k["text"]: k["tags"] for k in kana if k.get("tags")}
    if rt:
        out["rt"] = rt
    senses = []
    for s in e.senses:
        so: dict[str, Any] = {"p": s["partOfSpeech"], "g": s["gloss"]}
        if s.get("misc"):
            so["x"] = s["misc"]
        if s.get("field"):
            so["fl"] = s["field"]
        if s.get("dialect"):
            so["dl"] = s["dialect"]
        if s.get("info"):
            so["i"] = s["info"]
        if s.get("appliesToKanji") not in (None, ["*"]):
            so["ak"] = s["appliesToKanji"]
        if s.get("appliesToKana") not in (None, ["*"]):
            so["ar"] = s["appliesToKana"]
        senses.append(so)
    out["s"] = senses
    if e.common:
        out["c"] = 1
    if e.custom:
        out["n"] = 1
    return out


def collect_lexicon(dictionary: Dictionary, token_lists: Iterable[list[dict[str, Any]]]) -> tuple[dict[str, Any], dict[str, str]]:
    used: dict[str, Any] = {}
    used_tags: set[str] = set()
    for tokens in token_lists:
        for tok in tokens:
            for m in tok.get("m", []):
                eid = m["e"]
                if eid in used:
                    continue
                exported = export_entry(dictionary.entries[eid])
                used[eid] = exported
                for s in exported["s"]:
                    used_tags.update(s.get("p", []))
                    used_tags.update(s.get("x", []))
                    used_tags.update(s.get("fl", []))
                    used_tags.update(s.get("dl", []))
                for tags in list(exported.get("kt", {}).values()) + list(exported.get("rt", {}).values()):
                    used_tags.update(tags)
    tag_map = {t: dictionary.tags[t] for t in sorted(used_tags) if t in dictionary.tags}
    return used, tag_map


def find_jmdict_json(jmdict_dir: Path) -> Path | None:
    candidates = sorted(jmdict_dir.glob("jmdict-eng-*.json"))
    candidates = [c for c in candidates if "common" not in c.name and "examples" not in c.name]
    return candidates[-1] if candidates else None


if __name__ == "__main__":
    import sys

    root = Path(__file__).resolve().parent.parent
    jm = find_jmdict_json(root / "data_cache" / "jmdict")
    if not jm:
        sys.exit("JMdict JSON not found under data_cache/jmdict/")
    lex = Lexer(Dictionary(jm, root / "scripts" / "hasu_terms.json"), load_zipf_table(root / "data_cache" / "wordfreq_ja.json"))
    for line in sys.argv[1:] or ["大丈夫だよ、さやかちゃんすっごくかわいいから、\nすぐにお友達たくさんできるよ。"]:
        toks = lex.parse(line)
        print(" | ".join(t["t"] + (f"[{lex.d.entries[t['m'][0]['e']].kanji[0]['text'] if lex.d.entries[t['m'][0]['e']].kanji else t['m'][0]['f']}{'<' + ','.join(t['m'][0].get('r', [])) if t['m'][0].get('r') else ''}]" if t.get("m") else "") for t in toks))
