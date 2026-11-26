#!/usr/bin/env python3
"""Export story BGM from the game's CRI banks, with the loop points the game plays them with.

The game plays BGM through CRI ADX2 (`CriAcb BgmAdvMorning0001`, cue `Morning_0001`): an ACB
cue sheet whose HCA wave streams from a separate AWB bank. The HCA header carries the loop
region; the CRI player plays from the start and jumps from loop end back to loop start.
Our old MP3s had no loop data: `<audio loop>` restarted the whole file, intro included, after
a pause (seek latency plus the encoder's leading silence).

For each BGM id this finds its ACB among the extracted banks (scripts/extract_cri_banks.py)
by cue name, pairs it with its AWB (the ACB embeds a copy of the AWB's AFS2 header), decodes
the whole stream with vgmstream (official wasm build, run under node by
scripts/vgmstream_wasm.cjs; native binaries are blocked on this machine), and writes:
  public/assets/bgm/<id>.webm     Opus at 48 kHz, the HCA's rate, so sample positions carry over
  data_cache/bgm_loops.json       {id: {sampleRate, samples, loopStart, loopEnd}} (samples)
build_scenarios.py turns the loop into `audio.bgmLoop` (seconds) for src/engine/bgmLoop.ts.

Usage: uv run scripts/export_bgm.py [bgm_adv_morning_0001 ...]
       (no ids = every BGM the compiled scenarios reference)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BANKS = ROOT / "data-inspect" / "raw-cri"
DEFAULT_VGMSTREAM = ROOT / ".inspect-tmp" / "tools" / "vgmstream-wasm" / "vgmstream-cli.js"
DRIVER = ROOT / "scripts" / "vgmstream_wasm.cjs"
OUT_DIR = ROOT / "public" / "assets" / "bgm"
LOOPS_JSON = ROOT / "data_cache" / "bgm_loops.json"
SCENARIOS = ROOT / "public" / "data" / "scenarios"


def referenced_bgm_ids() -> list[str]:
    ids: set[str] = set()
    for p in SCENARIOS.glob("*.json"):
        for m in re.finditer(r'"bgmId":\s*"([^"]+)"', p.read_text(encoding="utf-8")):
            ids.add(m.group(1))
    return sorted(ids)


def index_banks(banks: Path) -> tuple[list[tuple[Path, bytes]], list[tuple[Path, bytes]]]:
    acbs, awbs = [], []
    for f in banks.rglob("*"):
        if not f.is_file():
            continue
        with open(f, "rb") as fh:
            head = fh.read(4)
        if head == b"@UTF":
            acbs.append((f, f.read_bytes()))
        elif head == b"AFS2":
            with open(f, "rb") as fh:
                awbs.append((f, fh.read(64)))
    return acbs, awbs


def find_acb(acbs: list[tuple[Path, bytes]], bgm_id: str) -> tuple[Path, bytes] | None:
    """The ACB whose string table names the cue sheet `bgm_id` (null-terminated)."""
    needle = b"\0" + bgm_id.encode() + b"\0"
    hits = [(p, d) for p, d in acbs if needle in d]
    return min(hits, key=lambda h: len(h[1])) if hits else None


def find_awb(acb: bytes, awbs: list[tuple[Path, bytes]]) -> Path | None:
    """The AWB whose header the ACB carries (StreamAwbAfs2Header); None if the waves are inside."""
    for m in re.finditer(rb"AFS2", acb):
        header = acb[m.start() : m.start() + 32]
        matches = [p for p, head in awbs if head[: len(header)] == header]
        if len(matches) == 1:
            return matches[0]
    return None


def vgmstream(js: Path, workdir: Path, inputs: list[Path], args: list[str]) -> str:
    cmd = ["node", str(DRIVER), str(js), str(workdir), *map(str, inputs), "--", *args]
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def meta_int(meta: str, key: str) -> int | None:
    m = re.search(rf"^{key}:\s*(\d+)", meta, re.M)
    return int(m.group(1)) if m else None


def export(bgm_id: str, acbs, awbs, js: Path) -> dict | None:
    hit = find_acb(acbs, bgm_id)
    if not hit:
        print(f"[skip] {bgm_id}: no ACB names this cue sheet")
        return None
    acb_path, acb = hit
    awb_path = find_awb(acb, awbs)
    if awb_path is None and len(acb) < 64 * 1024:
        # a streaming cue sheet (the waves are in an AWB), and that AWB isn't among the banks
        print(f"[skip] {bgm_id}: its AWB stream bank isn't in the extracted banks")
        return None
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        inputs = [work / f"{bgm_id}.acb"]
        shutil.copyfile(acb_path, inputs[0])
        if awb_path:
            inputs.append(work / f"{bgm_id}.awb")
            shutil.copyfile(awb_path, inputs[1])
        target = inputs[-1].name  # vgmstream reads a stream bank's cue names from the ACB next to it
        meta = vgmstream(js, work, inputs, ["-m", target])
        rate, samples = meta_int(meta, "sample rate"), meta_int(meta, "stream total samples")
        loop_start, loop_end = meta_int(meta, "loop start"), meta_int(meta, "loop end")
        # -i: the whole stream once, no loop repeats or fade (the player loops it)
        vgmstream(js, work, inputs, ["-i", "-o", f"{bgm_id}.wav", target])
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        out = OUT_DIR / f"{bgm_id}.webm"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(work / f"{bgm_id}.wav"),
             "-c:a", "libopus", "-b:a", "192k", str(out)],
            check=True,
        )
    loop = f"loop {loop_start}..{loop_end}" if loop_start is not None else "no loop"
    print(f"{bgm_id}: {acb_path.name}{' + ' + awb_path.name if awb_path else ''}, "
          f"{samples} samples @ {rate} Hz, {loop} -> {os.path.relpath(out, ROOT)}")
    return {"sampleRate": rate, "samples": samples, "loopStart": loop_start, "loopEnd": loop_end}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--banks", type=Path, default=DEFAULT_BANKS)
    ap.add_argument("--vgmstream", type=Path, default=DEFAULT_VGMSTREAM,
                    help="vgmstream-cli.js from the vgmstream-wasm release")
    args = ap.parse_args()
    ids = args.ids or referenced_bgm_ids()
    acbs, awbs = index_banks(args.banks)
    print(f"{len(acbs)} ACB, {len(awbs)} AWB banks in {args.banks}")
    loops = json.loads(LOOPS_JSON.read_text(encoding="utf-8")) if LOOPS_JSON.exists() else {}
    for bgm_id in ids:
        info = export(bgm_id, acbs, awbs, args.vgmstream)
        if info:
            loops[bgm_id] = info
    LOOPS_JSON.write_text(json.dumps(dict(sorted(loops.items())), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {LOOPS_JSON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
