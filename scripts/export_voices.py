#!/usr/bin/env python3
"""Export story voices and sound effects from the game's CRI banks as Opus WebM for the reader.

Same banks and decoder as scripts/export_bgm.py (extracted by scripts/extract_cri_banks.py,
decoded by vgmstream's wasm build). Two kinds of cue sheet:
  - voices: one per story part, `vo_adv_<scriptId>`, whose waves are named exactly like our files
    (`vo_adv_10300101_0001_m1031_01@kaho`). Every wave of the sheet is decoded in one call and
    written to public/assets/story/voice/<name>.webm (mono Opus, 48 kHz, 48 kbps).
  - sound effects: all `se_adv_*` cues share one large sheet, decoded 50 waves at a time (the wasm
    build keeps everything in memory); the ones asked for go to
    public/assets/sound/effects/<name>.webm (Opus, 64 kbps) and their durations to
    data_cache/se_durations.json, which build_scenarios.py uses to decide what loops.
The SE durations matter: the files the store used to have were cut short (the classroom
ambience was a 0.48 s fragment; the game's is 31.8 s).

Usage:
  uv run scripts/export_voices.py --scripts 10300101 10300102     # their voices and SEs
  uv run scripts/export_voices.py --scripts-file ids.txt [--voices-only | --se-only] [--force]
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_bgm as BGM  # noqa: E402  (bank lookup and the vgmstream driver)

ROOT = Path(__file__).resolve().parent.parent
HASU_DUB_DIR = Path("/Users/michaelting/github/hasu-dub")
VOICE_DIR = ROOT / "public" / "assets" / "story" / "voice"
SE_DIR = ROOT / "public" / "assets" / "sound" / "effects"
SE_DURATIONS = ROOT / "data_cache" / "se_durations.json"
SE_SHEET_PROBE = "se_adv_ambience_bus_0001"  # a cue only the big SE sheet holds
CHUNK = 50


def script_text(script_id: str) -> str:
    return (HASU_DUB_DIR / "story_main_txt" / f"story_main_{script_id}.txt").read_text(encoding="utf-8")


def se_ids(text: str) -> set[str]:
    return set(re.findall(r"^\[SE(?:再生|停止) (se_[a-z0-9_]+)", text, re.M))


def encode(wav: Path, dest: Path, bitrate: str) -> float:
    """WAV -> Opus WebM (written beside the target, then moved); returns the duration."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp.webm")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-c:a", "libopus", "-b:a", bitrate, str(tmp)],
                   check=True)
    shutil.move(tmp, dest)
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(dest)],
                         capture_output=True, text=True, check=True).stdout
    return round(float(out.strip()), 3)


def sheet_index(acbs: list[Path], names: set[str]) -> dict[str, Path]:
    """name -> the smallest ACB whose string table holds it (export_bgm.find_acb's rule), reading
    every bank once instead of once per name."""
    import mmap

    # one regex pass per bank for all names (a find per name re-reads ~6 GB of banks each time)
    pattern = re.compile(b"\0(" + b"|".join(re.escape(n.encode()) for n in sorted(names, key=len, reverse=True)) + b")\0")
    best: dict[str, tuple[Path, int]] = {}
    for p in acbs:
        with open(p, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            for n in {m.group(1).decode() for m in pattern.finditer(mm)}:
                if n not in best or len(mm) < best[n][1]:
                    best[n] = (p, len(mm))
    return {n: p for n, (p, _) in best.items()}


def decode_sheet(acb_path: Path, awbs, js: Path, work: Path, chunked: bool = False) -> list[Path]:
    """Decode every wave of a cue sheet into `work`, one WAV per wave named after its cue."""
    acb = acb_path.read_bytes()
    inputs = [work / "sheet.acb"]
    shutil.copyfile(acb_path, inputs[0])
    awb_path = BGM.find_awb(acb, awbs)
    if awb_path:
        inputs.append(work / "sheet.awb")
        shutil.copyfile(awb_path, inputs[1])
    target = inputs[-1].name
    if chunked:
        n = BGM.meta_int(BGM.vgmstream(js, work, inputs, ["-m", target]), "stream count") or 1
        for s in range(1, n + 1, CHUNK):
            BGM.vgmstream(js, work, inputs, ["-i", "-s", str(s), "-S", str(min(n, s + CHUNK - 1)), "-o", "?n.wav", target])
    else:
        BGM.vgmstream(js, work, inputs, ["-i", "-S", "0", "-o", "?n.wav", target])
    return sorted(work.glob("*.wav"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scripts", nargs="*", default=[])
    ap.add_argument("--scripts-file", type=Path)
    ap.add_argument("--voices-only", action="store_true")
    ap.add_argument("--se-only", action="store_true")
    ap.add_argument("--force", action="store_true", help="re-encode files that already exist")
    ap.add_argument("--banks", type=Path, default=BGM.DEFAULT_BANKS)
    ap.add_argument("--vgmstream", type=Path, default=BGM.DEFAULT_VGMSTREAM)
    args = ap.parse_args()
    scripts = list(args.scripts) + (args.scripts_file.read_text().split() if args.scripts_file else [])
    if not scripts:
        ap.error("give --scripts or --scripts-file")
    acbs, awbs = BGM.index_banks(args.banks)
    print(f"{len(acbs)} ACB, {len(awbs)} AWB banks in {args.banks}")
    sheets = sheet_index(acbs, {f"vo_adv_{s}" for s in scripts} | {SE_SHEET_PROBE})
    failed: list[str] = []

    if not args.se_only:
        for sid in scripts:
            sheet = f"vo_adv_{sid}"
            with tempfile.TemporaryDirectory() as tmp:
                try:
                    if sheet not in sheets:
                        raise LookupError("no ACB names this cue sheet")
                    wavs = decode_sheet(sheets[sheet], awbs, args.vgmstream, Path(tmp))
                except (LookupError, subprocess.CalledProcessError) as e:
                    print(f"[fail] {sheet}: {e}")
                    failed.append(sheet)
                    continue
                # The build looks a clip up by the id the script gives, which for NPC lines leaves
                # off the cue's `@name` (script `…_0046_m9009_01`, cue `…_0046_m9009_01@ryoubo`)
                refs = set(re.findall(r"(vo_adv_\d+_\d+_m\d+_\d+(?:@[A-Za-z0-9_]+)?)", script_text(sid)))
                wrote = 0
                for wav in wavs:
                    name = wav.stem if wav.stem in refs or wav.stem.split("@")[0] not in refs else wav.stem.split("@")[0]
                    dest = VOICE_DIR / f"{name}.webm"
                    if dest.exists() and not args.force:
                        continue
                    encode(wav, dest, "48k")
                    wrote += 1
                print(f"{sheet}: {len(wavs)} waves, {wrote} written")

    if not args.voices_only:
        wanted = set().union(*(se_ids(script_text(s)) for s in scripts))
        todo = {s for s in wanted if args.force or not (SE_DIR / f"{s}.webm").exists()}
        durations = json.loads(SE_DURATIONS.read_text(encoding="utf-8")) if SE_DURATIONS.exists() else {}
        if todo:
            # every SE cue lives in one big sheet: find_acb takes any name in a bank's string table,
            # so a cue only that sheet holds finds it; decode it once
            with tempfile.TemporaryDirectory() as tmp:
                work = Path(tmp)
                wavs = {w.stem: w for w in decode_sheet(sheets[SE_SHEET_PROBE], awbs, args.vgmstream, work, chunked=True)}
                for se in sorted(todo):
                    if se not in wavs:
                        print(f"[skip] {se}: not in the SE sheet")
                        failed.append(se)
                        continue
                    durations[se] = encode(wavs[se], SE_DIR / f"{se}.webm", "64k")
                    print(f"{se}: {durations[se]} s")
            SE_DURATIONS.write_text(json.dumps(durations, indent=2, sort_keys=True), encoding="utf-8")
        print(f"SE: {len(wanted)} referenced, {len(todo)} exported")
    if failed:
        print(f"[WARN] not exported: {' '.join(failed)}")


if __name__ == "__main__":
    main()
