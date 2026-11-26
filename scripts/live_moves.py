#!/usr/bin/env python3
"""Find spins, turns and travelling steps in a Fes×LIVE recording, for the choreo viewer's cues.

Reads <live dir>/index.json and motion/chunk_NNNN.bin (alst_export.py) and writes
<live dir>/moves.json. Only the root (Animator.bodyPosition / bodyRotation) is used:

  spin  the body's heading turns one way by >= SPIN_DEG within a short burst
  turn  a sustained facing change of TURN_DEG..SPIN_DEG: the heading holds before and after
  walk  the root travels >= WALK_M (net) in one go

Method. Per member, the track is cut into pieces at data gaps and wherever she leaves the stage
(VisibleCommunicator), and each piece is resampled to a uniform 15 fps grid.
- Heading = the body's forward axis projected on the floor, unwrapped, Gaussian-smoothed
  (YAW_SIGMA). It is cut into one-way runs with a zigzag filter (a run ends once the heading
  goes back by more than REVERSAL_DEG), and runs are split again at pauses (|rate| below
  RATE_MIN deg/s for longer than PAUSE_S), so a spin is measured from where the rotation starts
  to where it stops.
- Position = the root on the floor, smoothed harder (POS_SIGMA) to remove the hip sway of the
  steps and the 15 fps jitter. Moving = speed above WALK_SPEED (grown out to WALK_SPEED_LOW);
  moving stretches less than MERGE_GAP_S apart that keep their direction are merged.

Spaces. Unity: the stage faces the audience along +z, and a performer facing the audience has
her right hand on +x (left-handed axes), so
  downstage = +z (towards the audience), upstage = -z,
  stage right = +x (the performer's right = the audience's / front camera's screen left),
  stage left = -x (the performer's left = the audience's screen right).
Headings ("facing") are degrees in the same frame: 0 = facing the audience, 90 = facing stage
right, -90 = facing stage left, ±180 = back to the audience. A positive heading change is
clockwise seen from above, which is a turn to the performer's right whichever way she faces.
Positions written out ("from"/"to"/"at") are the viewer's three.js stage space, [x, z] in
metres, formation offset included (LiveStage: hips = toGltfT(root + offset), i.e. x = -unity x).

moves.json:
  {"format": "live-moves/1", "params": {...}, "members": {"<cid>": [event, ...]}}
  event: id, kind ("spin" | "turn" | "walk"), start, end (video seconds), song (timeline label
  or null), facingFrom, facingTo (deg), at = [x, z] where it starts, and
    spin/turn: degrees (signed, + = clockwise from above), clockwise (bool), side ("right"|"left")
    walk:      from, to ([x, z]), distance (m, net), heading (deg, stage frame, 0 = downstage),
               direction ("downstage" | "upstage" | "stage left" | "stage right" or a diagonal
               such as "downstage left"), relFacing ("forwards" | "backwards" | "sideways")

Usage:
  live_moves.py <live dir> [--out moves.json] [--check cid:t0:t1 ...]
"""
from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path

import numpy as np

FPS = 15.0
GAP_S = 0.5            # a hole in the data longer than this cuts the track
YAW_SIGMA = 0.07       # s, heading smoothing (about one frame)
POS_SIGMA = 0.2        # s, position smoothing (hip sway of a step is ~2 Hz)
REVERSAL_DEG = 35.0    # a one-way run ends once the heading goes back this far
RATE_MIN = 70.0        # deg/s: slower than this counts as not turning
PAUSE_S = 0.25         # ...for this long splits a run
SPIN_DEG = 270.0       # minimum rotation of a spin
SPIN_MAX_S = 3.0       # ...within this long
TURN_DEG = 80.0        # minimum sustained facing change of a turn
TURN_MAX_S = 1.5
HOLD_S = 0.8           # a turn's heading must hold this long before and after
HOLD_DEG = 20.0        # ...within this spread
WALK_SPEED = 0.35      # m/s, moving
WALK_SPEED_LOW = 0.12  # m/s, a move's edges
MERGE_GAP_S = 0.5      # moving stretches closer than this merge if they keep direction
MERGE_DEG = 60.0
WALK_M = 0.8           # minimum net travel of a walk
WALK_MIN_SPEED = 0.25  # m/s, net travel / duration (drifting doesn't count)


def read_tracks(live: Path, index: dict) -> dict[int, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """-> {cid: (time[n], pos[n, 3], quat[n, 4])}, Unity space, sorted, duplicates dropped."""
    parts: dict[int, list] = {}
    for c in index["chunks"]:
        buf = (live / c["file"]).read_bytes()
        if buf[:4] != b"LLM1":
            raise SystemExit(f"{c['file']}: not a motion chunk")
        o = 16
        for _ in range(struct.unpack_from("<H", buf, 6)[0]):
            cid, _, n = struct.unpack_from("<HHI", buf, o)
            o += 8
            t = np.frombuffer(buf, "<f4", n, o).astype(float)
            o += 4 * n
            p = np.frombuffer(buf, "<f4", 3 * n, o).reshape(n, 3).astype(float)
            o += 12 * n
            q = np.frombuffer(buf, "<f4", 4 * n, o).reshape(n, 4).astype(float)
            o += 16 * n + 2 * 95 * n
            o = (o + 3) & ~3
            parts.setdefault(cid, []).append((t, p, q))
    out = {}
    for cid, ps in parts.items():
        t = np.concatenate([x[0] for x in ps])
        p = np.concatenate([x[1] for x in ps])
        q = np.concatenate([x[2] for x in ps])
        order = np.argsort(t, kind="stable")
        t, p, q = t[order], p[order], q[order]
        keep = np.concatenate([[True], np.diff(t) > 1e-4])  # chunks/segments overlap by a frame
        out[cid] = (t[keep], p[keep], q[keep])
    return out


def on_stage_spans(visibility: list[dict], end: float) -> list[tuple[float, float]]:
    """On-stage intervals, by the viewer's rule (LiveStage.visibleAt): visible until the first
    event, then whatever the latest event at or before t says."""
    spans, since = [], 0.0
    for e in sorted(visibility, key=lambda e: e["t"]):
        if e["visible"] and since is None:
            since = e["t"]
        elif not e["visible"] and since is not None:
            if e["t"] > since:
                spans.append((since, e["t"]))
            since = None
    if since is not None and end > since:
        spans.append((since, end))
    return spans


def gauss(x: np.ndarray, sigma_frames: float) -> np.ndarray:
    """Gaussian smoothing along axis 0 with edge padding."""
    r = max(1, int(3 * sigma_frames))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_frames) ** 2)
    k /= k.sum()
    pad = np.pad(x, [(r, r)] + [(0, 0)] * (x.ndim - 1), mode="edge")
    if x.ndim == 1:
        return np.convolve(pad, k, mode="valid")
    return np.stack([np.convolve(pad[:, j], k, mode="valid") for j in range(x.shape[1])], axis=1)


def heading(q: np.ndarray) -> np.ndarray:
    """Unwrapped heading (deg) of the body's forward axis on the floor, 0 = +z, + = towards +x."""
    x, y, z, w = q.T
    fx, fz = 2 * (x * z + w * y), 1 - 2 * (x * x + y * y)
    ok = np.hypot(fx, fz) > 0.2  # bent far forward/back: the projection is unreliable
    ang = np.arctan2(fx, fz)
    if not ok.all() and ok.any():
        i = np.arange(len(ang))
        ang = np.interp(i, i[ok], np.unwrap(ang[ok]))
    return np.degrees(np.unwrap(ang))


def wrap(d: float) -> float:
    return (d + 180.0) % 360.0 - 180.0


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[(i0, i1)] inclusive index ranges where mask is true."""
    m = np.concatenate([[False], mask, [False]]).astype(int)
    d = np.diff(m)
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0] - 1))


def zigzag(y: np.ndarray, rev: float) -> list[int]:
    """Indices of the alternating extremes of y, ignoring reversals smaller than rev."""
    piv, ext, d = [0], 0, 0
    for i in range(1, len(y)):
        if d >= 0 and y[i] > y[ext] or d <= 0 and y[i] < y[ext]:
            ext = i
            if d == 0 and abs(y[i] - y[0]) >= rev:
                d = 1 if y[i] > y[0] else -1
        elif abs(y[i] - y[ext]) >= rev:
            if d == 0:
                d = 1 if y[ext] > y[0] else -1
            piv.append(ext)
            d, ext = -d, i
    piv.append(ext)
    if piv[-1] != len(y) - 1:
        piv.append(len(y) - 1)
    return sorted(set(piv))


def rotations(t: np.ndarray, yaw: np.ndarray) -> list[dict]:
    """One-way heading changes, split at pauses: [{i0, i1, deg}]."""
    rate = np.gradient(yaw, t)
    pause = max(1, int(round(PAUSE_S * FPS)))
    out = []
    piv = zigzag(yaw, REVERSAL_DEG)
    for a, b in zip(piv, piv[1:]):
        sign = 1 if yaw[b] >= yaw[a] else -1
        fast = sign * rate[a:b + 1] > RATE_MIN
        # bridge short slow patches inside the run, then keep each moving stretch
        idx = runs(fast)
        merged: list[list[int]] = []
        for i0, i1 in idx:
            if merged and i0 - merged[-1][1] - 1 < pause:
                merged[-1][1] = i1
            else:
                merged.append([i0, i1])
        for i0, i1 in merged:
            i0, i1 = a + i0, a + i1
            out.append({"i0": i0, "i1": i1, "deg": float(yaw[i1] - yaw[i0])})
    return out


def steady(yaw: np.ndarray, i0: int, i1: int) -> bool:
    seg = yaw[max(0, i0):max(0, i1)]
    return len(seg) >= 2 and float(seg.max() - seg.min()) <= HOLD_DEG


def direction(dx: float, dz: float) -> tuple[float, str]:
    """Stage-frame heading of a displacement (Unity dx, dz) and its name."""
    ang = math.degrees(math.atan2(dx, dz))  # 0 = downstage, 90 = stage right
    names = ["downstage", "downstage right", "stage right", "upstage right",
             "upstage", "upstage left", "stage left", "downstage left"]
    return ang, names[int(((ang + 22.5) % 360) // 45)]


def stage_xz(xz: np.ndarray, off: dict | None, centre: list[float]) -> list[float]:
    """Unity root (x, z) -> viewer (three.js) floor position [x, z], as LiveStage draws it."""
    if off:
        ux, uz = xz[0] + off["dx"], xz[1] + off["dz"]
    else:
        ux, uz = xz[0] - centre[0], xz[1] - centre[2]
    return [round(-float(ux), 3), round(float(uz), 3)]


def offset_at(offsets: list[dict], t: float) -> dict | None:
    o = None
    for e in offsets:
        if t >= e["from"] - 0.5:
            o = e
    return o or (offsets[0] if offsets else None)


def song_at(songs: list[tuple[float, float, str]], t: float) -> str | None:
    return next((label for a, b, label in songs if a <= t < b), None)


def detect(t: np.ndarray, p: np.ndarray, q: np.ndarray) -> list[dict]:
    """Moves in one contiguous on-stage piece (uniform FPS grid). Positions stay in Unity space."""
    yaw = gauss(heading(q), YAW_SIGMA * FPS)
    xz = gauss(p[:, [0, 2]], POS_SIGMA * FPS)
    hold = int(round(HOLD_S * FPS))
    ev: list[dict] = []

    for r in rotations(t, yaw):
        i0, i1, deg = r["i0"], r["i1"], r["deg"]
        dur = t[i1] - t[i0]
        kind = None
        if abs(deg) >= SPIN_DEG and dur <= SPIN_MAX_S:
            kind = "spin"
        elif TURN_DEG <= abs(deg) < SPIN_DEG and dur <= TURN_MAX_S \
                and steady(yaw, i0 - hold, i0 + 1) and steady(yaw, i1, i1 + hold + 1):
            kind = "turn"
        if kind:
            ev.append({"kind": kind, "i0": i0, "i1": i1, "deg": deg, "yaw0": yaw[i0], "yaw1": yaw[i1], "p0": xz[i0]})

    speed = np.hypot(*np.gradient(xz, t, axis=0).T)
    moving: list[list[int]] = []
    for c0, c1 in runs(speed > WALK_SPEED):
        while c0 > 0 and speed[c0 - 1] > WALK_SPEED_LOW:
            c0 -= 1
        while c1 < len(t) - 1 and speed[c1 + 1] > WALK_SPEED_LOW:
            c1 += 1
        if moving and c0 <= moving[-1][1]:
            moving[-1][1] = max(moving[-1][1], c1)
            continue
        if moving:
            a0, a1 = moving[-1]
            d_prev, d_new = xz[a1] - xz[a0], xz[c1] - xz[c0]
            cosang = np.dot(d_prev, d_new) / (np.linalg.norm(d_prev) * np.linalg.norm(d_new) + 1e-9)
            if t[c0] - t[a1] < MERGE_GAP_S and cosang > math.cos(math.radians(MERGE_DEG)):
                moving[-1][1] = c1
                continue
        moving.append([c0, c1])
    for i0, i1 in moving:
        d = xz[i1] - xz[i0]
        dist = float(np.hypot(*d))
        if dist >= WALK_M and dist / max(t[i1] - t[i0], 1e-3) >= WALK_MIN_SPEED:
            ev.append({"kind": "walk", "i0": i0, "i1": i1, "d": d, "p0": xz[i0], "p1": xz[i1],
                       "yaw0": yaw[i0], "yaw1": yaw[i1], "yawMid": float(np.mean(yaw[i0:i1 + 1]))})
    return ev


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("live_dir", type=Path)
    ap.add_argument("--out", type=Path, help="default: <live dir>/moves.json")
    ap.add_argument("--check", nargs="*", default=[], metavar="CID:T0:T1",
                    help="print the heading/position trace of a member over a time range")
    a = ap.parse_args()

    index = json.loads((a.live_dir / "index.json").read_text())
    tracks = read_tracks(a.live_dir, index)
    duration = float(index["duration"])
    tl = index["timelines"]
    songs = [(max(0.0, x["start"]), tl[i + 1]["start"] if i + 1 < len(tl) else duration,
              x.get("label") or x["timeline"]) for i, x in enumerate(tl) if x.get("kind") == "song"]
    titles = {x.get("label"): x.get("titleEn") or x.get("label") for x in tl}
    centre = index.get("stageCentre", [0, 0, 0])

    result: dict[str, list] = {}
    for m in index["members"]:
        cid = m["characterId"]
        if cid not in tracks:
            continue
        t_all, p_all, q_all = tracks[cid]
        events: list[dict] = []
        for s0, s1 in on_stage_spans(m.get("visibility") or [], duration):
            sel = (t_all >= s0) & (t_all <= s1)
            if sel.sum() < FPS:
                continue
            t, p, q = t_all[sel], p_all[sel], q_all[sel]
            # contiguous pieces, resampled to a uniform grid (slerp is overkill at 15 fps: lerp + renormalise)
            cuts = np.where(np.diff(t) > GAP_S)[0]
            for k0, k1 in zip(np.r_[0, cuts + 1], np.r_[cuts, len(t) - 1]):
                if t[k1] - t[k0] < 2.0:
                    continue
                g = np.arange(t[k0], t[k1], 1.0 / FPS)
                pg = np.stack([np.interp(g, t[k0:k1 + 1], p[k0:k1 + 1, j]) for j in range(3)], axis=1)
                qq = q[k0:k1 + 1].copy()
                # keep consecutive quaternions in the same hemisphere so the lerp doesn't pass through 0
                flips = np.cumsum(np.r_[False, np.sum(qq[1:] * qq[:-1], axis=1) < 0]) % 2
                qq[flips == 1] *= -1
                qg = np.stack([np.interp(g, t[k0:k1 + 1], qq[:, j]) for j in range(4)], axis=1)
                qg /= np.linalg.norm(qg, axis=1, keepdims=True)
                for e in detect(g, pg, qg):
                    t0, t1 = float(g[e["i0"]]), float(g[e["i1"]])
                    off = offset_at(m.get("offsets") or [], t0)
                    out = {
                        "kind": e["kind"], "start": round(t0, 3), "end": round(t1, 3), "song": song_at(songs, t0),
                        "facingFrom": round(wrap(float(e["yaw0"])), 1), "facingTo": round(wrap(float(e["yaw1"])), 1),
                        "at": stage_xz(e["p0"], off, centre),
                    }
                    if e["kind"] == "walk":
                        heading_deg, name = direction(float(e["d"][0]), float(e["d"][1]))
                        rel = abs(wrap(heading_deg - e["yawMid"]))
                        out.update({
                            "from": out["at"], "to": stage_xz(e["p1"], off, centre),
                            "distance": round(float(np.hypot(*e["d"])), 2), "heading": round(heading_deg, 1),
                            "direction": name,
                            "relFacing": "forwards" if rel <= 50 else "backwards" if rel >= 130 else "sideways",
                        })
                    else:
                        out.update({"degrees": round(e["deg"]), "clockwise": bool(e["deg"] > 0),
                                    "side": "right" if e["deg"] > 0 else "left"})
                    events.append(out)
        events.sort(key=lambda e: (e["start"], e["kind"]))
        for i, e in enumerate(events):
            e["id"] = f"{cid}-{i}"
        result[str(cid)] = events

    params = {k: v for k, v in globals().items() if k.isupper() and isinstance(v, float)}
    out_path = a.out or a.live_dir / "moves.json"
    out_path.write_text(json.dumps({"format": "live-moves/1", "params": params, "members": result},
                                   ensure_ascii=False, separators=(",", ":")))

    names = {m["characterId"]: m["name"] for m in index["members"]}
    print(f"{'song':28s} {'member':8s} spin turn walk")
    totals = {"spin": 0, "turn": 0, "walk": 0}
    for label in [None] + [s[2] for s in songs]:
        for cid, events in result.items():
            ev = [e for e in events if e["song"] == label]
            if not ev:
                continue
            c = {k: sum(e["kind"] == k for e in ev) for k in totals}
            for k in totals:
                totals[k] += c[k]
            print(f"{(titles.get(label) or label or '(talk / MC)')[:28]:28s} {names[int(cid)]:8s} "
                  f"{c['spin']:4d} {c['turn']:4d} {c['walk']:4d}")
    print(f"total: {totals}; wrote {out_path}")

    for spec in a.check:
        cid_s, t0_s, t1_s = spec.split(":")
        cid, t0, t1 = int(cid_s), float(t0_s), float(t1_s)
        t, p, q = tracks[cid]
        sel = (t >= t0) & (t <= t1)
        yaw = heading(q[sel])
        print(f"\n{names[cid]} {t0}–{t1}: time, heading (unwrapped), unity x, z")
        for i in range(0, int(sel.sum()), 3):
            print(f"  {t[sel][i]:9.2f} {yaw[i]:8.1f} {p[sel][i, 0]:8.2f} {p[sel][i, 2]:6.2f}")
        for e in result[str(cid)]:
            if e["end"] >= t0 and e["start"] <= t1:
                print("  event", {k: v for k, v in e.items() if k != "song"})


if __name__ == "__main__":
    main()
