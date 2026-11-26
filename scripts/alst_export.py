#!/usr/bin/env python3
"""Export a Fes×LIVE alst recording as compact motion chunks for the browser viewer.

Reads an archive/alst/<live>/ folder (playlist + *_segmentNNNNN.ts, see alst_decode.py) and writes:

  <out>/index.json            members (character id, name, costume), chunk list, stage centre,
                              duration, time base
  <out>/motion/chunk_NNNN.bin  CHUNK_SECONDS of every member's MotionCommunicator stream

Times are seconds on the archive video's clock (0 = the live's start, the same clock as
archive/hls/<date>/index.m3u8). Each packet carries the sender's own time (seconds since the room
was created); the offset to video time is calibrated as the median of
(packet time - (record wall-clock time - live start)) over the whole recording.

chunk_NNNN.bin, little-endian:
  char[4] "LLM1", u16 version (1), u16 member count, f32 chunk start, f32 chunk end
  per member:
    u16 character id, u16 reserved, u32 frame count n
    f32 time[n]
    f32 body_position[n][3]   Unity world space, meters (Animator.bodyPosition)
    f32 body_rotation[n][4]   Unity quaternion x, y, z, w (Animator.bodyRotation)
    i16 muscles[n][95]        Unity HumanTrait muscle order, value * 1000
    (zero padding to a multiple of 4 bytes)

Standard library only, so it runs with the transfer VM's python3.

Usage:
  alst_export.py <alst dir> <out dir> --live-start 2026-03-30T10:50:00.489Z [--chunk-seconds 60]
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import statistics
import struct
import sys
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import alst_decode as A  # noqa: E402

CHUNK_VERSION = 1


def playlist_segments(folder: Path) -> list[Path]:
    m3u8 = next(folder.glob("*.m3u8"))
    names = [l.strip() for l in m3u8.read_text().splitlines() if l.strip() and not l.startswith("#")]
    return [folder / n for n in names]


def costume_owner(blob: bytes) -> int | None:
    """Costume spawn field 11 carries the owner's character id as a u32 somewhere inside."""
    for i in range(0, len(blob) - 3):
        (v,) = struct.unpack_from("<I", blob, i)
        if v in A.CHARACTERS:
            return v
    return None


def scan_segment(path: Path, live_start_us: int, owners: dict, costumes: dict, offsets: list,
                 timeline_events: list | None = None, receivers: dict | None = None,
                 visibility: dict | None = None, faces: dict | None = None):
    """-> {character id: list of (packet time, pos, quat, muscles bytes)} for one segment.

    costumes: character id -> {costume: first record time (s since live start)}
    timeline_events: (packet time, timeline id) from TimelineReceiver updates
    visibility: character id -> set of (packet time of change, visible) from VisibleCommunicator
      (16-byte updates: u8 visible, 7 bytes padding, f64 time of the change on the packet clock)
    """
    out: dict[int, list] = {}
    receivers = {} if receivers is None else receivers
    for _, rec_ts, payload in A.iter_records(path.read_bytes()):
        for field, wt, v in A.try_message(payload) or []:
            if field != 16 or wt != 2:
                continue
            for kind, iwt, inner in A.try_message(v) or []:
                if iwt != 2:
                    continue
                fields: dict[int, list] = {}
                for f, w, x in A.try_message(inner) or []:
                    fields.setdefault(f, []).append(x)
                tid = fields.get(8, [None])[0]
                if kind == 128:
                    name = A.spawn_name(fields.get(10, [b""])[0])
                    extra = fields.get(11, [b""])[0]
                    if name == "MotionCommunicator":
                        owners[tid] = A.spawn_character(extra)
                    elif name == "TimelineReceiver":
                        receivers[tid] = "timeline"
                    elif name == "VisibleCommunicator":
                        receivers[tid] = ("visible", A.spawn_character(extra))
                    elif name == "LipCommunicator":
                        receivers[tid] = ("lip", A.spawn_character(extra))
                    elif name == "ExpressionCommunicator":
                        receivers[tid] = ("expr", A.spawn_character(extra))
                    elif name.startswith("3d_costume_"):
                        cid = costume_owner(extra)
                        if cid:
                            costumes.setdefault(cid, {}).setdefault(name, (rec_ts - live_start_us) / 1e6)
                elif kind == 129 and isinstance(receivers.get(tid), tuple):
                    what, cid = receivers[tid]
                    for blob in fields.get(10, []):
                        if not cid:
                            continue
                        if what == "visible" and visibility is not None and len(blob) >= 16:
                            visibility.setdefault(cid, set()).add(
                                (round(struct.unpack_from("<d", blob, 8)[0], 3), bool(blob[0])))
                        elif what == "lip" and faces is not None and len(blob) >= 32:
                            # LipSyncData: f32 Mouth_A, I, U, E, O, Close; f64 SendTimeSec
                            *mouth, sent = struct.unpack_from("<6fd", blob, 0)
                            faces["lip"].setdefault(cid, {})[round(sent, 4)] = mouth
                        elif what == "expr" and faces is not None and len(blob) >= 24:
                            # ExpressionData: i32 NextId, i32 LastId, f32 Weight, bool IsSwitchControl, f64 SendTimeSec
                            nxt, last, weight, switch, sent = struct.unpack_from("<iif?3xd", blob, 0)
                            faces["expr"].setdefault(cid, {})[round(sent, 4)] = (nxt, last, weight, switch)
                elif kind == 129 and receivers.get(tid) == "timeline" and timeline_events is not None:
                    for blob in fields.get(10, []):
                        if len(blob) >= 16:
                            tl_id, _, start = struct.unpack_from("<iid", blob, 0)
                            timeline_events.append((start, tl_id))
                elif kind == 129 and owners.get(tid):
                    for blob in fields.get(10, []):
                        if len(blob) != A.MOTION_PACKET_BYTES:
                            continue
                        p = A.decode_motion_packet(blob)
                        offsets.append(p["time"] - (rec_ts - live_start_us) / 1e6)
                        out.setdefault(owners[tid], []).append(
                            (p["time"], p["body_position"], p["body_rotation"], blob[16:206], blob[206:542]))
    return out


def write_chunk(path: Path, start: float, end: float, members: dict[int, list], offset: float) -> int:
    buf = bytearray(b"LLM1")
    buf += struct.pack("<HHff", CHUNK_VERSION, len(members), start, end)
    for cid in sorted(members):
        frames = sorted(members[cid], key=lambda f: f[0])
        n = len(frames)
        buf += struct.pack("<HHI", cid, 0, n)
        buf += array("f", [f[0] - offset for f in frames]).tobytes()
        buf += array("f", [c for f in frames for c in f[1]]).tobytes()
        buf += array("f", [c for f in frames for c in f[2]]).tobytes()
        buf += b"".join(f[3] for f in frames)  # already little-endian int16 x 95
        while len(buf) % 4:
            buf += b"\0"
    path.write_bytes(bytes(buf))
    return len(buf)


def write_sub_chunk(path: Path, members: dict[int, list], offset: float) -> int:
    """Sub-bone chunk, little-endian: "LLS1", u16 version (1), u16 members; per member: u16 character
    id, u16 reserved, u32 n, f32 time[n], i16 position[n][16][3] (Unity local, 0.1 mm),
    i16 rotation[n][26][4] (Unity local quaternion x, y, z, w * 32767), padding to 4 bytes.
    Bone order is the costume's SubBoneReference (avatar JSON "subBones")."""
    buf = bytearray(b"LLS1") + struct.pack("<HH", 1, len(members))
    for cid in sorted(members):
        frames = sorted(members[cid], key=lambda f: f[0])
        buf += struct.pack("<HHI", cid, 0, len(frames))
        buf += array("f", [f[0] - offset for f in frames]).tobytes()
        pos, rot = array("h"), array("h")
        for f in frames:
            sub = f[4]
            for i in range(16):
                for c in A.unpack_position(struct.unpack_from("<Q", sub, 8 * i)[0]):
                    pos.append(max(-32767, min(32767, round(c * 10000))))
            for i in range(26):
                q = A.euler_to_quat(A.unpack_euler(struct.unpack_from("<Q", sub, 128 + 8 * i)[0]))
                rot.extend(max(-32767, min(32767, round(c * 32767))) for c in q)
        buf += pos.tobytes() + rot.tobytes()
        while len(buf) % 4:
            buf += b"\0"
    path.write_bytes(bytes(buf))
    return len(buf)


def write_faces(out_dir: Path, faces: dict, offset: float, chunk_seconds: float) -> None:
    """lip/chunk_NNNN.bin + expressions.json (video time).

    lip chunk, little-endian: "LLL1", u16 version (1), u16 members; per member: u16 character id,
    u16 reserved, u32 n, f32 time[n], u8 mouth[n][6] (A, I, U, E, O, Close, x255), padding to 4.
    expressions.json: {character id: {"t": [...], "next": [...], "last": [...], "w": [...],
    "switch": [...]}} in time order, consecutive duplicates removed.
    """
    (out_dir / "lip").mkdir(parents=True, exist_ok=True)
    by_chunk: dict[int, dict[int, list]] = {}
    for cid, frames in faces["lip"].items():
        for sent, mouth in frames.items():
            t = sent - offset
            by_chunk.setdefault(max(0, int(t // chunk_seconds)), {}).setdefault(cid, []).append((t, mouth))
    total = 0
    for idx, members in sorted(by_chunk.items()):
        buf = bytearray(b"LLL1") + struct.pack("<HH", 1, len(members))
        for cid in sorted(members):
            fr = sorted(members[cid])
            buf += struct.pack("<HHI", cid, 0, len(fr))
            buf += array("f", [f[0] for f in fr]).tobytes()
            buf += bytes(max(0, min(255, round(v * 255))) for f in fr for v in f[1])
            while len(buf) % 4:
                buf += b"\0"
        (out_dir / "lip" / f"chunk_{idx:04d}.bin").write_bytes(bytes(buf))
        total += len(buf)
    expr = {}
    for cid, events in faces["expr"].items():
        cols = {"t": [], "next": [], "last": [], "w": [], "switch": []}
        prev = None
        for sent, (nxt, last, w, switch) in sorted(events.items()):
            key = (nxt, last, round(w, 2), switch)
            if key == prev:
                continue
            prev = key
            cols["t"].append(round(sent - offset, 3))
            cols["next"].append(nxt)
            cols["last"].append(last)
            cols["w"].append(round(w, 3))
            cols["switch"].append(bool(switch))
        expr[str(cid)] = cols
    (out_dir / "expressions.json").write_text(json.dumps(expr, separators=(",", ":")))
    print(f"wrote {len(by_chunk)} lip chunks ({total / 1e6:.1f} MB) and expressions for {len(expr)} members "
          f"({sum(len(v['t']) for v in expr.values())} events)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("alst_dir", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--live-start", required=True, help="ISO time the archive video starts (archive list live_start_time)")
    ap.add_argument("--chunk-seconds", type=float, default=60.0)
    ap.add_argument("--title", default="")
    ap.add_argument("--video", default="", help="video playlist path, recorded in index.json")
    ap.add_argument("--index-only", action="store_true", help="rebuild index.json, keep the existing chunks")
    ap.add_argument("--faces", action="store_true", help="only write lip chunks + expressions.json")
    ap.add_argument("--subbones", action="store_true", help="only write sub-bone chunks (sub/chunk_NNNN.bin)")
    a = ap.parse_args()

    live_start = datetime.datetime.fromisoformat(a.live_start.replace("Z", "+00:00"))
    live_start_us = int(live_start.timestamp() * 1e6)
    segments = playlist_segments(a.alst_dir)
    (a.out_dir / "motion").mkdir(parents=True, exist_ok=True)

    # Pass 1: calibrate the packet clock against video time on a sample of segments.
    owners, costumes, offsets = {}, {}, []
    for seg in segments[:: max(1, len(segments) // 20)]:
        scan_segment(seg, live_start_us, owners, costumes, offsets)
    offset = statistics.median(offsets)
    print(f"{len(segments)} segments; packet time - video time = {offset:.3f}s (from {len(offsets)} packets)")

    # Pass 2: stream every segment into fixed-length chunks.
    chunks, pending, sums, counts = [], {}, {}, 0
    chunk_idx, total_bytes = 0, 0
    bounds = lambda i: (i * a.chunk_seconds, (i + 1) * a.chunk_seconds)  # noqa: E731
    last_t = 0.0

    def flush(idx: int):
        nonlocal total_bytes
        members = {cid: fr for cid, fr in pending.get(idx, {}).items() if fr}
        if not members:
            return
        s, e = bounds(idx)
        name = f"chunk_{idx:04d}.bin"
        if a.subbones:
            (a.out_dir / "sub").mkdir(parents=True, exist_ok=True)
            total_bytes += write_sub_chunk(a.out_dir / "sub" / name, members, offset)
            pending.pop(idx, None)
            return
        total_bytes += write_chunk(a.out_dir / "motion" / name, s, e, members, offset)
        chunks.append({"file": f"motion/{name}", "start": s, "end": e,
                       "frames": {str(c): len(f) for c, f in members.items()}})
        pending.pop(idx, None)

    costumes, timeline_events, receivers, visibility = {}, [], {}, {}
    faces = {"lip": {}, "expr": {}} if a.faces else None
    for i, seg in enumerate(segments):
        per_member = scan_segment(seg, live_start_us, owners, costumes, [], timeline_events, receivers, visibility, faces)
        if a.faces:
            if i % 50 == 0:
                print(f"  segment {i}/{len(segments)} (faces)", flush=True)
            continue
        if a.index_only:
            for cid, frames in per_member.items():
                for fr in frames:
                    last_t = max(last_t, fr[0] - offset)
                    s = sums.setdefault(cid, [0.0, 0.0, 0.0])
                    for k in range(3):
                        s[k] += fr[1][k]
                    counts += 1
            if i % 50 == 0:
                print(f"  segment {i}/{len(segments)} (index only)", flush=True)
            continue
        for cid, frames in per_member.items():
            for fr in frames:
                vt = fr[0] - offset
                last_t = max(last_t, vt)
                idx = max(0, int(vt // a.chunk_seconds))
                pending.setdefault(idx, {}).setdefault(cid, []).append(fr)
                s = sums.setdefault(cid, [0.0, 0.0, 0.0])
                for k in range(3):
                    s[k] += fr[1][k]
                counts += 1
        # a chunk is complete once every buffered frame is past its end (allow one segment of jitter)
        for idx in sorted(pending):
            if (idx + 1) * a.chunk_seconds < last_t - 15:
                flush(idx)
        if i % 50 == 0:
            print(f"  segment {i}/{len(segments)} (video t = {last_t:.0f}s)", flush=True)
    for idx in sorted(pending):
        flush(idx)

    if a.faces:
        write_faces(a.out_dir, faces, offset, a.chunk_seconds)
        return
    if a.subbones:
        print(f"wrote {total_bytes / 1e6:.1f} MB of sub-bone chunks -> {a.out_dir / 'sub'}")
        return

    n_frames = {cid: 0 for cid in sums}
    if a.index_only:  # keep the chunk list of the existing index
        old = json.loads((a.out_dir / "index.json").read_text())
        chunks = old["chunks"]
        n_frames = {m["characterId"]: m["frames"] for m in old["members"]}
    for c in chunks if not a.index_only else []:
        for cid, n in c["frames"].items():
            n_frames[int(cid)] += n

    def changes(events: set) -> list[dict]:
        out, prev = [], None
        for t, vis in sorted(events):
            if vis != prev:
                out.append({"t": round(t - offset, 3), "visible": vis})
                prev = vis
        return out
    centre = [sum(s[k] for s in sums.values()) / max(1, sum(n_frames.values())) for k in range(3)]

    # Setlist: each distinct (timeline id, start) the TimelineReceiver announced, on video time.
    timelines, seen = [], set()
    for start, tl_id in sorted(timeline_events):
        key = (tl_id, round(start, 2))
        if key not in seen:
            seen.add(key)
            timelines.append({"start": round(start - offset, 3), "timeline": f"3d_timeline_{tl_id:010d}"})
    index = {
        "format": "alst-motion-chunks/1",
        "title": a.title,
        "video": a.video,
        "liveStart": a.live_start,
        "packetClockOffset": offset,
        "duration": last_t,
        "chunkSeconds": a.chunk_seconds,
        "fps": 15,
        "stageCentre": centre,
        "members": [{"characterId": cid, "name": A.CHARACTERS.get(cid, str(cid)),
                     "costumes": [{"from": round(max(0.0, t), 3), "costume": c}
                                  for c, t in sorted(costumes.get(cid, {}).items(), key=lambda kv: kv[1])],
                     "visibility": changes(visibility.get(cid, set())),
                     "frames": n_frames.get(cid, 0)} for cid in sorted(sums)],
        "timelines": timelines,
        "chunks": sorted(chunks, key=lambda c: c["start"]),
    }
    (a.out_dir / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))
    print(f"wrote {len(chunks)} chunks ({total_bytes / 1e6:.1f} MB), {len(index['members'])} members, "
          f"duration {last_t:.0f}s -> {a.out_dir}")


if __name__ == "__main__":
    main()
