#!/usr/bin/env python3
"""Copy the Fes×LIVE / With×MEETS stream archive from the community MEGA dump into GCS.

Two steps:

  plan      (anywhere) Turn a MEGA folder listing (from mega_list.py --json) into plan.json:
            one entry per HLS stream folder with the exact size of every file in it.
  transfer  (on the transfer VM) For each stream in plan.json not yet in done.txt: download
            the master playlist with MEGAcmd, keep only the highest-bandwidth video rendition
            and its audio, verify every file's size against the plan, upload to
            gs://<bucket>/archive/... with the game server's layout, then delete the local copy.

The master playlist is rewritten to list only the kept renditions (the original is kept next to
it as index.full.m3u8), so players never pick a rendition that wasn't copied. Re-running
`transfer` resumes: finished streams are listed in done.txt and failures are retried.

MEGAcmd must already be logged in to the shared folder (`mega-login <folder link>`), whose root
is the dump's `Assets/` folder. Standard library only (the VM's python3 is enough).

Usage:
  archive_transfer.py plan mega_nodes.json plan.json
  archive_transfer.py transfer plan.json --bucket gs://hasu-web-reader-assets --stage ~/stage
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = "Assets"
SKIP_SUFFIXES = (".7z", ".tar")
SKIP_NAMES = {".DS_Store"}
CACHE_CONTROL = "private, max-age=86400"
CONTENT_TYPES = {
    ".m3u8": "application/vnd.apple.mpegurl",
    ".m4s": "video/iso.segment",
    ".mp4": "video/mp4",
}


# ---------------------------------------------------------------- plan

def build_plan(nodes_path: Path, out_path: Path) -> None:
    nodes = {n["h"]: n for n in json.loads(nodes_path.read_text())}

    def path_of(n):
        parts = []
        while n:
            parts.append(n["name"])
            n = nodes.get(n["p"])
        return "/".join(reversed(parts))

    files = {}
    for n in nodes.values():
        if n["t"] != 0:
            continue
        p = path_of(n)
        if not p.startswith(f"{ROOT}/archive/hls/"):
            continue
        name = p.rsplit("/", 1)[1]
        if name in SKIP_NAMES or name.endswith(SKIP_SUFFIXES):
            continue
        files[p[len(ROOT) + 1:]] = n["s"]

    streams, loose = {}, []
    stream_dirs = {p.rsplit("/", 1)[0] for p in files if p.endswith("/index.m3u8")}
    for p, size in sorted(files.items()):
        d, name = p.rsplit("/", 1)
        if d in stream_dirs:
            streams.setdefault(d, {})[name] = size
        else:
            loose.append({"path": p, "size": size})

    plan = {
        "streams": [{"dir": d, "files": fs} for d, fs in sorted(streams.items())],
        "loose_files": loose,
    }
    out_path.write_text(json.dumps(plan, indent=1, ensure_ascii=False))
    total = sum(sum(s["files"].values()) for s in plan["streams"])
    print(f"{len(plan['streams'])} streams ({total / 1e9:.1f} GB with every rendition), "
          f"{len(loose)} loose files -> {out_path}")


# ---------------------------------------------------------------- playlists

ATTR_RE = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)')


def attrs(line: str) -> dict[str, str]:
    return {k: v.strip('"') for k, v in ATTR_RE.findall(line.split(":", 1)[1])}


def trim_master(text: str) -> tuple[str, list[str]]:
    """Keep the highest-bandwidth variant and its audio. Returns (new text, playlists kept)."""
    lines = text.splitlines()
    variants = []  # (bandwidth, inf line, uri)
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            uri = next(l for l in lines[i + 1:] if l and not l.startswith("#"))
            variants.append((int(attrs(line).get("BANDWIDTH", 0)), line, uri))
    if not variants:
        return text, []  # not a master playlist
    _, inf, uri = max(variants, key=lambda v: v[0])
    group = attrs(inf).get("AUDIO")
    media = [l for l in lines if l.startswith("#EXT-X-MEDIA") and attrs(l).get("GROUP-ID") == group]
    if len(media) > 1:  # several tracks in the group: keep the default one
        media = [next((l for l in media if attrs(l).get("DEFAULT") == "YES"), media[0])]
    header = [l for l in lines if l.startswith("#EXT") and not l.startswith(("#EXT-X-STREAM-INF", "#EXT-X-MEDIA"))]
    out = header + media + [inf, uri]
    kept = [uri] + [attrs(l)["URI"] for l in media if "URI" in attrs(l)]
    return "\n".join(out) + "\n", kept


def media_files(text: str) -> list[str]:
    """Files a media playlist points at (init map + segments), in order, without duplicates."""
    seen = []
    for line in text.splitlines():
        if line.startswith("#EXT-X-MAP"):
            uri = attrs(line).get("URI")
        elif line and not line.startswith("#"):
            uri = line.strip()
        else:
            continue
        if uri and uri not in seen:
            seen.append(uri)
    return seen


# ---------------------------------------------------------------- transfer

def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def mega_get(remote: str, local_dir: Path, expect: int, retries: int = 6) -> Path:
    local_dir.mkdir(parents=True, exist_ok=True)
    dest = local_dir / remote.rsplit("/", 1)[1]
    for attempt in range(retries):
        if dest.exists() and dest.stat().st_size == expect:
            return dest
        dest.unlink(missing_ok=True)
        r = run(["mega-get", remote, str(local_dir) + "/"])
        if dest.exists() and dest.stat().st_size == expect:
            return dest
        wait = min(60 * 2 ** attempt, 1800)
        msg = (r.stdout + r.stderr).strip().splitlines()[-1:] or ["?"]
        log(f"  mega-get {remote} failed (attempt {attempt + 1}): {msg[0][:200]}; waiting {wait}s")
        time.sleep(wait)
    raise RuntimeError(f"could not download {remote} with the expected size {expect}")


def upload(local: Path, gcs_url: str) -> None:
    cmd = ["gcloud", "storage", "cp", str(local), gcs_url, f"--cache-control={CACHE_CONTROL}", "--quiet"]
    ctype = CONTENT_TYPES.get(local.suffix)
    if ctype:
        cmd.append(f"--content-type={ctype}")
    r = run(cmd)
    if r.returncode != 0:
        raise RuntimeError(f"upload failed for {local}: {r.stderr.strip()[-300:]}")


def remote_sizes(gcs_dir: str) -> dict[str, int]:
    r = run(["gcloud", "storage", "ls", "-l", gcs_dir + "/"])
    sizes = {}
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[-1].startswith("gs://") and parts[0].isdigit():
            sizes[parts[-1].rsplit("/", 1)[1]] = int(parts[0])
    return sizes


LOG_FILE: Path | None = None


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    if LOG_FILE:
        with LOG_FILE.open("a") as f:
            f.write(line + "\n")


def transfer_stream(stream: dict, bucket: str, stage: Path) -> int:
    d, plan_files = stream["dir"], stream["files"]
    local = stage / d
    gcs_dir = f"{bucket}/{d}"
    t0 = time.time()

    master_path = mega_get(f"/{d}/index.m3u8", local, plan_files["index.m3u8"])
    master = master_path.read_text()
    trimmed, kept_playlists = trim_master(master)

    if kept_playlists:
        wanted = list(kept_playlists)
        for pl in kept_playlists:
            p = mega_get(f"/{d}/{pl}", local, plan_files[pl])
            wanted += media_files(p.read_text())
    else:  # plain media playlist or something unexpected: copy the whole folder
        wanted = [n for n in plan_files if n != "index.m3u8"]

    missing = [n for n in wanted if n not in plan_files]
    if missing:
        raise RuntimeError(f"{d}: playlists reference files not in the dump: {missing[:5]}")
    for name in dict.fromkeys(wanted):
        mega_get(f"/{d}/{name}", local, plan_files[name])

    if kept_playlists:
        (local / "index.full.m3u8").write_text(master)
        master_path.write_text(trimmed)

    expected = {n: plan_files[n] for n in dict.fromkeys(wanted)}
    expected["index.m3u8"] = master_path.stat().st_size
    if kept_playlists:
        expected["index.full.m3u8"] = plan_files["index.m3u8"]
    for name in expected:
        upload(local / name, f"{gcs_dir}/{name}")

    got = remote_sizes(gcs_dir)
    bad = {n: (s, got.get(n)) for n, s in expected.items() if got.get(n) != s}
    if bad:
        raise RuntimeError(f"{d}: size mismatch after upload: {bad}")

    nbytes = sum(expected.values())
    shutil.rmtree(local)
    dt = time.time() - t0
    log(f"done {d}: {len(expected)} files, {nbytes / 1e9:.2f} GB in {dt:.0f}s "
        f"({nbytes / 1e6 / max(dt, 1):.0f} MB/s)")
    return nbytes


def transfer(plan_path: Path, bucket: str, stage: Path, only: list[str], passes: int) -> None:
    global LOG_FILE
    stage.mkdir(parents=True, exist_ok=True)
    LOG_FILE = stage / "transfer.log"
    done_file = stage / "done.txt"
    plan = json.loads(plan_path.read_text())
    streams = [s for s in plan["streams"] if not only or s["dir"] in only]

    for p in range(passes):
        done = set(done_file.read_text().split()) if done_file.exists() else set()
        todo = [s for s in streams if s["dir"] not in done]
        if not todo:
            break
        log(f"pass {p + 1}: {len(todo)} streams to go")
        failed = 0
        for i, s in enumerate(todo, 1):
            log(f"[{i}/{len(todo)}] {s['dir']}")
            try:
                transfer_stream(s, bucket, stage)
            except Exception as e:  # noqa: BLE001  (log and move on; retried next pass)
                failed += 1
                log(f"FAILED {s['dir']}: {e}")
                continue
            with done_file.open("a") as f:
                f.write(s["dir"] + "\n")
        if not failed:
            break
    done = set(done_file.read_text().split()) if done_file.exists() else set()
    left = [s["dir"] for s in streams if s["dir"] not in done]
    log(f"finished: {len(streams) - len(left)}/{len(streams)} streams copied" + (f"; still missing: {left}" if left else ""))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("nodes", type=Path)
    p.add_argument("out", type=Path)
    t = sub.add_parser("transfer")
    t.add_argument("plan", type=Path)
    t.add_argument("--bucket", required=True)
    t.add_argument("--stage", type=Path, default=Path.home() / "stage")
    t.add_argument("--only", nargs="*", default=[], help="stream dirs to copy (default: all)")
    t.add_argument("--passes", type=int, default=3, help="retry rounds for failed streams")
    a = ap.parse_args()
    if a.cmd == "plan":
        build_plan(a.nodes, a.out)
    else:
        transfer(a.plan, a.bucket.rstrip("/"), a.stage.expanduser(), a.only, a.passes)


if __name__ == "__main__":
    sys.exit(main())
