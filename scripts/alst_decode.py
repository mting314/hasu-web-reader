#!/usr/bin/env python3
"""Decode Fes×LIVE "alst" (Alstromeria) live-motion recordings.

An archive folder (archive/alst/<live>/) holds a playlist of ~10 s `*_segmentNNNNN.ts` files.
Despite the extension they aren't MPEG-TS. Each is a stream of records:

    u16 BE  length of the record that follows
    u8      record kind (always 1 so far)
    u64 BE  timestamp, microseconds since the Unix epoch
    ...     payload: a protobuf message (no schema available; decoded generically here)

Records arrive at ~60 Hz; each is one network frame of the live's state.

Usage:
  alst_decode.py stats <segment.ts>...            record/field statistics
  alst_decode.py dump <segment.ts> [--records N]  print decoded records as indented trees
"""
from __future__ import annotations

import argparse
import collections
import struct
import sys
from pathlib import Path


def iter_records(data: bytes):
    i = 0
    while i + 2 <= len(data):
        (length,) = struct.unpack_from(">H", data, i)
        rec = data[i + 2 : i + 2 + length]
        if len(rec) < length:
            raise ValueError(f"truncated record at byte {i}")
        yield rec[0], struct.unpack_from(">Q", rec, 1)[0], rec[9:]
        i += 2 + length
    if i != len(data):
        raise ValueError(f"{len(data) - i} trailing bytes")


# ---------------------------------------------------------------- generic protobuf

def read_varint(b: bytes, i: int) -> tuple[int, int]:
    shift = result = 0
    while True:
        if i >= len(b):
            raise ValueError("varint past end")
        byte = b[i]
        i += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, i
        shift += 7
        if shift > 70:
            raise ValueError("varint too long")


def parse_message(b: bytes) -> list[tuple[int, int, object]]:
    """Parse protobuf wire format into [(field, wiretype, value)]. Raises if it doesn't fit."""
    out, i = [], 0
    while i < len(b):
        key, i = read_varint(b, i)
        field, wt = key >> 3, key & 7
        if field == 0:
            raise ValueError("field 0")
        if wt == 0:
            v, i = read_varint(b, i)
        elif wt == 1:
            if i + 8 > len(b):
                raise ValueError("fixed64 past end")
            v = b[i : i + 8]
            i += 8
        elif wt == 2:
            n, i = read_varint(b, i)
            if i + n > len(b):
                raise ValueError("bytes past end")
            v = b[i : i + n]
            i += n
        elif wt == 5:
            if i + 4 > len(b):
                raise ValueError("fixed32 past end")
            v = b[i : i + 4]
            i += 4
        else:
            raise ValueError(f"wire type {wt}")
        out.append((field, wt, v))
    return out


def try_message(b: bytes):
    if not b:
        return None
    try:
        return parse_message(b)
    except ValueError:
        return None


def printable(b: bytes) -> bool:
    return len(b) > 0 and all(32 <= c < 127 for c in b)


def describe(field_list, depth: int = 0, max_bytes: int = 48, lines=None):
    lines = [] if lines is None else lines
    pad = "  " * depth
    for field, wt, v in field_list:
        if wt == 0:
            lines.append(f"{pad}{field}: {v}")
        elif wt == 5:
            lines.append(f"{pad}{field}: f32 {struct.unpack('<f', v)[0]:.6g}  (u32 {struct.unpack('<I', v)[0]})")
        elif wt == 1:
            lines.append(f"{pad}{field}: f64 {struct.unpack('<d', v)[0]:.6g}  (u64 {struct.unpack('<Q', v)[0]})")
        else:
            if printable(v):
                lines.append(f"{pad}{field}: \"{v.decode()}\"")
                continue
            sub = try_message(v)
            if sub is not None and len(v) > 1:
                lines.append(f"{pad}{field}: {{  # {len(v)} B")
                describe(sub, depth + 1, max_bytes, lines)
                lines.append(f"{pad}}}")
            else:
                lines.append(f"{pad}{field}: bytes[{len(v)}] {v[:max_bytes].hex()}{'…' if len(v) > max_bytes else ''}")
    return lines


# ---------------------------------------------------------------- commands

def shape(field_list, prefix="", out=None, depth=0):
    """Collect (path -> count, total bytes) for every field, recursing into sub-messages."""
    out = collections.defaultdict(lambda: [0, 0]) if out is None else out
    for field, wt, v in field_list:
        path = f"{prefix}.{field}" if prefix else str(field)
        size = len(v) if isinstance(v, bytes) else 0
        out[path][0] += 1
        out[path][1] += size
        if wt == 2 and depth < 6 and not printable(v):
            sub = try_message(v)
            if sub is not None and len(v) > 1:
                shape(sub, path, out, depth + 1)
    return out


def cmd_stats(paths: list[Path]) -> None:
    agg = collections.defaultdict(lambda: [0, 0])
    nrec = 0
    for p in paths:
        for _, _, payload in iter_records(p.read_bytes()):
            nrec += 1
            msg = try_message(payload)
            if msg is None:
                agg["<unparsed>"][0] += 1
                continue
            for k, (c, s) in shape(msg).items():
                agg[k][0] += c
                agg[k][1] += s
    print(f"{nrec} records")
    print(f"{'path':40s} {'count':>9s} {'per rec':>8s} {'bytes':>11s}")
    for k, (c, s) in sorted(agg.items(), key=lambda kv: [int(x) if x.isdigit() else 0 for x in kv[0].split(".")]):
        if c >= nrec * 0.01 or k.count(".") <= 1:
            print(f"{k:40s} {c:9d} {c / nrec:8.2f} {s:11d}")


def cmd_dump(path: Path, n: int, skip: int) -> None:
    for idx, (kind, ts, payload) in enumerate(iter_records(path.read_bytes())):
        if idx < skip:
            continue
        if idx >= skip + n:
            break
        print(f"=== record {idx} kind={kind} ts={ts} payload={len(payload)} B")
        msg = try_message(payload)
        print("\n".join(describe(msg)) if msg is not None else payload[:64].hex())


def iter_messages(paths: list[Path]):
    """Yield (ts_us, oneof_field, fields dict-of-lists) for every field-16 message."""
    for p in paths:
        for _, ts, payload in iter_records(p.read_bytes()):
            for field, wt, v in try_message(payload) or []:
                if field != 16 or wt != 2:
                    continue
                for inner_field, iwt, inner in try_message(v) or []:
                    sub = try_message(inner) if iwt == 2 else None
                    fields = collections.defaultdict(list)
                    for f, w, x in sub or []:
                        fields[f].append(x)
                    yield ts, inner_field, fields, inner


def cmd_targets(paths: list[Path]) -> None:
    """Per target id (field 8): message counts, blob sizes, and any strings seen with it."""
    stats = collections.defaultdict(lambda: {"n": 0, "sizes": collections.Counter(), "kinds": collections.Counter()})
    strings = collections.defaultdict(set)
    for ts, kind, fields, raw in iter_messages(paths):
        tid = fields.get(8, [None])[0]
        st = stats[tid]
        st["n"] += 1
        st["kinds"][kind] += 1
        for blob in fields.get(10, []):
            st["sizes"][len(blob)] += 1
        for s in collect_strings(raw):
            if not s.startswith("default-"):
                strings[tid].add(s)
    for tid, st in sorted(stats.items(), key=lambda kv: -kv[1]["n"]):
        sizes = ", ".join(f"{s}B×{c}" for s, c in st["sizes"].most_common(3))
        names = "; ".join(sorted(strings[tid]))[:150]
        print(f"{str(tid):>12s} n={st['n']:6d} kinds={dict(st['kinds'])} sizes=[{sizes}] {names}")


# Character ids as in the game's master data (Characters.yaml). Note 1051 is Izumi and 1052 Ceras.
CHARACTERS = {1011: "Sachi", 1021: "Kozue", 1022: "Tsuzuri", 1023: "Megumi", 1031: "Kaho",
              1032: "Sayaka", 1033: "Rurino", 1041: "Ginko", 1042: "Kosuzu", 1043: "Hime",
              1051: "Izumi", 1052: "Ceras", 1054: "Maika", 1055: "Aoi"}


def spawn_name(blob: bytes) -> str:
    """Spawn (kind 128) field 10: i32 marker, i32 length, UTF-8 name."""
    if len(blob) >= 8:
        (n,) = struct.unpack_from("<i", blob, 4)
        if 0 < n <= len(blob) - 8:
            return blob[8 : 8 + n].decode("utf-8", "replace")
    return blob.hex()


def spawn_character(blob: bytes) -> int | None:
    """Spawn field 11 carries the owning character id (u32 LE), usually near the end."""
    for i in range(len(blob) - 4, -1, -1):
        (cid,) = struct.unpack_from("<I", blob, i)
        if cid in CHARACTERS:
            return cid
    return None


def cmd_objects(paths: list[Path]) -> None:
    """List spawned objects: id, name, character, update count and blob sizes."""
    spawns, updates = {}, collections.defaultdict(collections.Counter)
    t_first = t_last = None
    for ts, kind, fields, raw in iter_messages(paths):
        t_first = ts if t_first is None else min(t_first, ts)
        t_last = ts if t_last is None else max(t_last, ts)
        tid = fields.get(8, [None])[0]
        if kind == 128:
            spawns[tid] = (spawn_name(fields.get(10, [b""])[0]), spawn_character(fields.get(11, [b""])[0]),
                           fields.get(11, [b""])[0].hex())
        elif kind == 129:
            for blob in fields.get(10, []):
                updates[tid][len(blob)] += 1
    span = (t_last - t_first) / 1e6 if t_first else 1
    rows = []
    for tid, (name, cid, extra) in spawns.items():
        n = sum(updates[tid].values())
        sizes = ",".join(f"{s}" for s, _ in updates[tid].most_common(2))
        rows.append((name, CHARACTERS.get(cid, "-"), tid, n / span, sizes, extra))
    for name, who, tid, hz, sizes, extra in sorted(rows):
        print(f"{name[:48]:48s} {who:8s} {tid:>11d} {hz:6.1f} Hz  [{sizes}]  {extra[:40]}")
    print(f"{len(spawns)} spawned objects over {span:.1f}s")


# ---------------------------------------------------------------- MotionCommunicator packets
#
# Layout from the game's code (Inspix.CharacterMotion.MotionPacket / Inspix.MotionPacketAndTime):
#   0..7      body position: packed long, x/y/z with (22, 20, 22) bits, x in the HIGHEST bits
#             (bits 42..63), y in 22..41, z in 0..21; each stored as value + 2^(bits-1),
#             unit 1/1000 m (MotionDataPacking.Position3Unit)
#   8..15     body rotation: packed long, three 20-bit unsigned Euler angles, x in bits 40..59,
#             y in 20..39, z in 0..19, unit 1/2000 degree (RotationUnit); top 4 bits unused
#             (PackingLong shifts each value in after the previous one, so the first ends up on top.
#             Checked against the archive video: at a lineup the members share z and face +z.)
#   16..205   95 humanoid muscles, int16 / 1000 (FloatUnit), Unity's HumanTrait muscle order
#   206..333  16 sub-bone positions (packed longs, same scheme as the body position; unverified)
#   334..541  26 sub-bone rotations (packed longs; layout not verified yet)
#   542..549  time, double seconds
# The body position/rotation are Animator.bodyPosition/bodyRotation in world space (meters).

MOTION_PACKET_BYTES = 550
POSITION_BITS = (22, 20, 22)
ROTATION_BITS = 20


def unpack_position(v: int) -> tuple[float, float, float]:
    """-> (x, y, z) meters. Fields are read from the lowest bits up, i.e. z, y, x."""
    out, shift = [], 0
    for n in reversed(POSITION_BITS):
        out.append((((v >> shift) & ((1 << n) - 1)) - (1 << (n - 1))) / 1000.0)
        shift += n
    z, y, x = out
    return (x, y, z)


def unpack_euler(v: int) -> tuple[float, float, float]:
    """-> (x, y, z) degrees; z is in the lowest 20 bits, x in bits 40..59."""
    mask = (1 << ROTATION_BITS) - 1
    z, y, x = (((v >> (ROTATION_BITS * i)) & mask) / 2000.0 for i in range(3))
    return (x, y, z)


def euler_to_quat(deg) -> tuple[float, float, float, float]:
    """Unity's Quaternion.Euler(x, y, z): rotate z, then x, then y (q = qy * qx * qz), as (x, y, z, w)."""
    import math

    x, y, z = (math.radians(d) / 2 for d in deg)
    qx = (math.sin(x), 0.0, 0.0, math.cos(x))
    qy = (0.0, math.sin(y), 0.0, math.cos(y))
    qz = (0.0, 0.0, math.sin(z), math.cos(z))

    def mul(a, b):
        ax, ay, az, aw = a
        bx, by, bz, bw = b
        return (aw * bx + ax * bw + ay * bz - az * by,
                aw * by - ax * bz + ay * bw + az * bx,
                aw * bz + ax * by - ay * bx + az * bw,
                aw * bw - ax * bx - ay * by - az * bz)

    return mul(mul(qy, qx), qz)


def decode_motion_packet(blob: bytes) -> dict:
    if len(blob) != MOTION_PACKET_BYTES:
        raise ValueError(f"motion packet is {len(blob)} bytes, expected {MOTION_PACKET_BYTES}")
    pos_raw, rot_raw = struct.unpack_from("<QQ", blob, 0)
    euler = unpack_euler(rot_raw)
    return {
        "time": struct.unpack_from("<d", blob, 542)[0],
        "body_position": unpack_position(pos_raw),
        "body_euler": euler,
        "body_rotation": euler_to_quat(euler),
        "muscles": [m / 1000.0 for m in struct.unpack_from("<95h", blob, 16)],
    }


def motion_streams(paths: list[Path]) -> dict[int, list[dict]]:
    """character id -> decoded MotionCommunicator packets, in order."""
    owner, out = {}, collections.defaultdict(list)
    for ts, kind, fields, raw in iter_messages(paths):
        tid = fields.get(8, [None])[0]
        if kind == 128 and spawn_name(fields.get(10, [b""])[0]) == "MotionCommunicator":
            owner[tid] = spawn_character(fields.get(11, [b""])[0])
        elif kind == 129 and tid in owner:
            for blob in fields.get(10, []):
                if len(blob) == MOTION_PACKET_BYTES:
                    out[owner[tid]].append(decode_motion_packet(blob))
    return dict(out)


def collect_strings(b: bytes, depth: int = 0) -> list[str]:
    out = []
    for f, wt, v in try_message(b) or []:
        if wt == 2:
            if printable(v) and len(v) >= 3:
                out.append(v.decode())
            elif depth < 6:
                out += collect_strings(v, depth + 1)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stats")
    s.add_argument("segments", nargs="+", type=Path)
    t = sub.add_parser("targets")
    t.add_argument("segments", nargs="+", type=Path)
    o = sub.add_parser("objects")
    o.add_argument("segments", nargs="+", type=Path)
    d = sub.add_parser("dump")
    d.add_argument("segment", type=Path)
    d.add_argument("--records", type=int, default=2)
    d.add_argument("--skip", type=int, default=0)
    a = ap.parse_args()
    if a.cmd == "stats":
        cmd_stats(a.segments)
    elif a.cmd == "targets":
        cmd_targets(a.segments)
    elif a.cmd == "objects":
        cmd_objects(a.segments)
    else:
        cmd_dump(a.segment, a.records, a.skip)


if __name__ == "__main__":
    sys.exit(main())
