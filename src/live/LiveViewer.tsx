import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bone, BookmarkPlus, Crosshair, Eye, EyeOff, FlipHorizontal2, Pause, Play, Repeat, StepBack, StepForward, Video, Volume2,
  VolumeX, X,
} from "lucide-react";
import { ChunkStore, type LiveIndex } from "./motion";
import { LiveStage, MEMBER_COLORS, type CameraPreset } from "./LiveStage";
import { PlaybackClock } from "./clock";

/**
 * Fes×LIVE 3D choreo viewer: the decoded live motion of every member on a free-camera stage,
 * with the live's audio as the clock. Slow-mo, frame stepping, A/B loops, mirroring, solo/hide
 * and follow-cam for studying the choreography.
 *
 * Data (see scripts/alst_export.py, export_live_avatar.py, export_live_costume.py):
 *   /assets/live/<live>/index.json, motion/chunk_NNNN.bin, audio.m4a
 *   /assets/live/costume/<id>/<id>.glb, <id>_avatar.json
 * URL: live.html?live=fes-20260330&song=aishii_2603  (or &t=<seconds>)
 */

const ASSET_BASE = "/assets/live";
const RATES = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const CAMERAS: CameraPreset[] = ["front", "back", "left", "right", "top"];
const FRAME = 1 / 30;
const LOOP_GAPS = [0, 1, 2, 3, 5];

/** A saved practice loop. */
type Segment = { id: string; name: string; a: number; b: number };

type Settings = {
  rate: number; mirror: boolean; offsetMs: number; hidden: number[]; skeleton: boolean;
  volume: number; muted: boolean;
  /** Opacity of everyone but the followed member. */
  othersOpacity: number;
  plain: boolean;
  /** Fan cam stays in front of the member rather than on the audience side. */
  fanFacing: boolean;
  /** Seconds of pause before each loop repeat. */
  loopGap: number;
  segments: Segment[];
  /** Split view: front (the interactive camera) and its exact back view side by side. */
  split: boolean;
};
const DEFAULTS: Settings = {
  rate: 1, mirror: false, offsetMs: 0, hidden: [], skeleton: false, volume: 1, muted: false,
  othersOpacity: 1, plain: false, fanFacing: false, loopGap: 0, segments: [],
  split: false,
};

function fmt(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return "--:--.-";
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.max(0, t) - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export default function LiveViewer() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const liveId = params.get("live") ?? "fes-20260330";
  const storageKey = `live-viewer:${liveId}`;

  const containerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const clockRef = useRef<PlaybackClock | null>(null);
  const [silent, setSilent] = useState<string | null>(null);
  const stageRef = useRef<LiveStage | null>(null);
  const storeRef = useRef<ChunkStore | null>(null);

  const [index, setIndex] = useState<LiveIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [models, setModels] = useState({ loaded: 0, total: 0, missing: 0 });
  const [onStage, setOnStage] = useState<Set<number>>(new Set());
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [follow, setFollow] = useState<number | null>(null);
  const [fanCam, setFanCam] = useState(false);
  const [camera, setCameraState] = useState<CameraPreset>("front");
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(storageKey) ?? "{}") };
    } catch {
      return DEFAULTS;
    }
  });
  const { rate, mirror, offsetMs, hidden, skeleton, volume, muted, othersOpacity, plain, fanFacing, loopGap, segments } = settings;
  const { split } = settings;
  /** Wall-clock time (performance.now) when a paused loop repeat resumes, during a loop gap. */
  const resumeAtRef = useRef<number | null>(null);
  const [gapLeft, setGapLeft] = useState<number | null>(null);
  const update = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), []);
  useEffect(() => localStorage.setItem(storageKey, JSON.stringify(settings)), [storageKey, settings]);

  const base = `${ASSET_BASE}/${liveId}`;
  const duration = index?.duration ?? 0;

  const songs = useMemo(() => {
    if (!index) return [];
    const tl = index.timelines as (LiveIndex["timelines"][number] & {
      label?: string; kind?: string; titleEn?: string; titleJa?: string;
    })[];
    const pretty = (s: string) => s.replace(/_\d{4}$/, "").replace(/^\w/, (c) => c.toUpperCase());
    return tl
      .map((t, i) => ({ ...t, end: tl[i + 1]?.start ?? index.duration }))
      .filter((t) => t.kind === "song")
      .map((t) => ({
        label: t.titleEn ?? pretty(t.label ?? t.timeline),
        sub: t.titleJa && t.titleJa !== t.titleEn ? t.titleJa : "",
        start: Math.max(0, t.start),
        end: t.end,
      }));
  }, [index]);

  // load the live index
  useEffect(() => {
    fetch(`${base}/index.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
        return r.json();
      })
      .then((ix: LiveIndex) => setIndex(ix))
      .catch((e) => setError(String(e)));
  }, [base]);

  // build the stage
  useEffect(() => {
    if (!index || !containerRef.current) return;
    const store = new ChunkStore(base, index);
    storeRef.current = store;
    const stage = new LiveStage(containerRef.current, store, index, ASSET_BASE, base);
    stageRef.current = stage;
    (window as unknown as { __liveStage?: LiveStage }).__liveStage = stage; // for debugging in devtools
    stage.preload();
    const onResize = () => stage.resize();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    const song = params.get("song");
    const startT = Number(params.get("t") ?? NaN);
    const tl = (index.timelines as { start: number; label?: string }[]).find((x) => x.label?.startsWith(song ?? "aishii"));
    const t0 = Number.isFinite(startT) ? startT : Math.max(0, tl?.start ?? 0);
    if (audioRef.current && !clockRef.current) clockRef.current = new PlaybackClock(audioRef.current);
    if (clockRef.current) clockRef.current.time = t0;
    setTime(t0);
    store.prefetch(t0);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      stage.dispose();
      stageRef.current = null;
    };
  }, [index, base, params]);

  // render loop: the playback clock (audio when it plays, else silent) drives everything
  useEffect(() => {
    let raf = 0;
    let lastUi = 0;
    const tick = (now: number) => {
      const clock = clockRef.current;
      const stage = stageRef.current;
      if (clock && stage) {
        clock.sync();
        if (loopOn && loopA !== null && loopB !== null && loopB > loopA && clock.time >= loopB) {
          clock.time = loopA;
          if (loopGap > 0) {
            clock.pause();
            resumeAtRef.current = now + loopGap * 1000;
          }
        }
        if (resumeAtRef.current !== null && now >= resumeAtRef.current) {
          resumeAtRef.current = null;
          clock.play();
        }
        const t = clock.time + offsetMs / 1000;
        stage.update(t);
        if (now - lastUi > 50) {
          lastUi = now;
          setTime(clock.time);
          setPlaying(!clock.paused || resumeAtRef.current !== null);
          setGapLeft(resumeAtRef.current === null ? null : Math.ceil((resumeAtRef.current - now) / 1000));
          setSilent(clock.silentReason);
          setBuffering(!storeRef.current?.isReady(t));
          setModels(stage.loadedModels());
          const staged = stage.onStageMembers();
          setOnStage((prev) => (prev.size === staged.size && [...staged].every((c) => prev.has(c)) ? prev : staged));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loopOn, loopA, loopB, offsetMs, loopGap]);

  useEffect(() => {
    if (clockRef.current) clockRef.current.rate = rate;
  }, [rate, index]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = volume;
    a.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !index) return;
    for (const m of index.members) stage.setVisible(m.characterId, !hidden.includes(m.characterId));
    stage.showSkeleton = skeleton;
    stage.othersOpacity = othersOpacity;
    stage.plain = plain;
    stage.fanCamFacing = fanFacing;
  }, [hidden, skeleton, othersOpacity, plain, fanFacing, index]);

  // Mirror flips only the main (front) view, through its projection, so split halves never swap.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.split = split;
    stage.mirror = mirror;
  }, [split, mirror, index]);

  const seek = useCallback(
    (t: number) => {
      const clock = clockRef.current;
      if (!clock) return;
      resumeAtRef.current = null; // moving the playhead cancels a pending loop repeat
      clock.time = Math.min(Math.max(0, t), duration || t);
      setTime(clock.time);
    },
    [duration],
  );

  const togglePlay = useCallback(() => {
    const clock = clockRef.current;
    if (!clock) return;
    if (resumeAtRef.current !== null) {
      // pausing during a loop gap: cancel the pending repeat
      resumeAtRef.current = null;
      setPlaying(false);
      setGapLeft(null);
      return;
    }
    if (clock.paused) {
      if (loopOn && loopA !== null && loopB !== null && (clock.time >= loopB || clock.time < loopA)) clock.time = loopA;
      clock.play();
    } else clock.pause();
    setPlaying(!clock.paused);
  }, [loopOn, loopA, loopB]);

  const step = useCallback(
    (dir: 1 | -1) => {
      clockRef.current?.pause();
      seek((clockRef.current?.time ?? 0) + dir * FRAME);
    },
    [seek],
  );

  const setCamera = useCallback((p: CameraPreset) => {
    setCameraState(p);
    stageRef.current?.setCamera(p);
  }, []);

  const setFollowMember = useCallback((cid: number | null) => {
    setFollow(cid);
    setFanCam(false);
    const stage = stageRef.current;
    if (stage) {
      stage.follow = cid;
      stage.fanCamActive = false;
      stage.setCamera(camera);
    }
  }, [camera]);

  /** Fan cam: tight shot of one member from the audience side, tracking her. */
  const startFanCam = useCallback((cid: number | null) => {
    setFollow(cid);
    setFanCam(cid !== null);
    stageRef.current?.fanCam(cid);
  }, []);

  const toggleHidden = (cid: number) =>
    update({ hidden: hidden.includes(cid) ? hidden.filter((h) => h !== cid) : [...hidden, cid] });
  const solo = (cid: number) => {
    const all = index?.members.map((m) => m.characterId) ?? [];
    const isSolo = hidden.length === all.length - 1 && !hidden.includes(cid);
    update({ hidden: isSolo ? [] : all.filter((c) => c !== cid) });
  };

  const setPoint = (which: "A" | "B") => {
    const t = clockRef.current?.time ?? 0;
    if (which === "A") {
      setLoopA(t);
      if (loopB !== null && loopB <= t) setLoopB(null);
    } else {
      setLoopB(t);
      if (loopA !== null && loopA >= t) setLoopA(null);
    }
  };
  useEffect(() => {
    if (loopA !== null && loopB !== null && loopB > loopA) setLoopOn(true);
  }, [loopA, loopB]);

  const loopSong = (s: { start: number; end: number }) => {
    setLoopA(s.start);
    setLoopB(s.end);
    setLoopOn(true);
    seek(s.start);
  };

  /** Save the current A/B loop, named after its song and the times within the song. */
  const saveSegment = () => {
    if (loopA === null || loopB === null || loopB <= loopA) return;
    const song = songs.find((s) => loopA >= s.start && loopA < s.end);
    const rel = (t: number) => fmt(t - (song?.start ?? 0)).replace(/\.\d$/, "");
    const name = `${song?.label ?? "Live"} ${rel(loopA)}–${rel(loopB)}`;
    update({ segments: [...segments, { id: `${Date.now()}`, name, a: loopA, b: loopB }] });
  };
  const playSegment = (s: Segment) => loopSong({ start: s.a, end: s.b });
  const renameSegment = (id: string, name: string) =>
    update({ segments: segments.map((s) => (s.id === id ? { ...s, name } : s)) });
  const deleteSegment = (id: string) => update({ segments: segments.filter((s) => s.id !== id) });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const now = clockRef.current?.time ?? 0;
      const k = e.key.toLowerCase();
      let handled = true;
      if (k === " ") togglePlay();
      else if (k === ",") step(-1);
      else if (k === ".") step(1);
      else if (k === "arrowleft") seek(now - (e.shiftKey ? 5 : 1));
      else if (k === "arrowright") seek(now + (e.shiftKey ? 5 : 1));
      else if (k === "[" || k === "]") {
        const i = RATES.findIndex((r) => r >= rate - 1e-6);
        const j = Math.min(Math.max((i < 0 ? RATES.length - 1 : i) + (k === "]" ? 1 : -1), 0), RATES.length - 1);
        update({ rate: RATES[j] });
      } else if (k === "a") setPoint("A");
      else if (k === "b") setPoint("B");
      else if (k === "l") setLoopOn((v) => !v);
      else if (k === "c") {
        setLoopA(null);
        setLoopB(null);
        setLoopOn(false);
      } else if (k === "s") saveSegment();
      else if (k === "p") update({ plain: !plain });
      else if (k === "m") update({ mirror: !mirror });
      else if (k === "d") update({ split: !split });
      else if (k === "k") update({ skeleton: !skeleton });
      else if (/^[1-5]$/.test(k)) setCamera(CAMERAS[Number(k) - 1]);
      else if (k === "f") setFollowMember(null);
      else if (k === "v" && follow !== null) startFanCam(fanCam ? null : follow);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pct = (t: number) => `${duration ? (Math.max(0, t) / duration) * 100 : 0}%`;
  const scrubRef = useRef<HTMLDivElement>(null);
  const scrubTo = (x: number) => {
    const el = scrubRef.current;
    if (!el || !duration) return;
    const r = el.getBoundingClientRect();
    seek(((x - r.left) / r.width) * duration);
  };
  const currentSong = songs.find((s) => time >= s.start && time < s.end);

  if (error) {
    return <div className="p-6 text-red-300">Couldn't load the live: {error}</div>;
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-2 text-sm">
        <span className="font-semibold text-amber-300">Fes×LIVE Choreo Viewer</span>
        <span className="truncate text-slate-400">{index?.title ?? "Loading…"}</span>
        {currentSong && (
          <span className="rounded bg-amber-500/15 px-2 py-0.5 text-amber-200">
            ♪ {currentSong.label}
            {currentSong.sub && <span className="ml-1.5 font-jp text-amber-200/70">{currentSong.sub}</span>}
          </span>
        )}
        <span className="ml-auto text-xs text-slate-500">
          models {models.loaded}/{models.total}
          {models.missing > 0 && ` (${models.missing} shown as skeletons)`}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-black">
          <div ref={containerRef} className="absolute inset-0" />
          {split && (
            <>
              <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-slate-700/80" />
              <span className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/70 px-1.5 py-0.5 text-xs text-slate-200">
                Front{mirror && <span className="text-sky-300"> (mirrored)</span>}
              </span>
              <span className="pointer-events-none absolute bottom-3 left-[calc(50%+0.75rem)] rounded bg-black/70 px-1.5 py-0.5 text-xs text-slate-200">
                Back
              </span>
            </>
          )}
          <div className="pointer-events-none absolute left-3 top-3 flex gap-1.5 text-xs">
            {rate !== 1 && <span className="rounded bg-black/70 px-1.5 py-0.5 text-amber-300">{rate}×</span>}
            {mirror && <span className="rounded bg-black/70 px-1.5 py-0.5 text-sky-300">Mirrored</span>}
            {loopOn && <span className="rounded bg-black/70 px-1.5 py-0.5 text-emerald-300">Loop</span>}
            {gapLeft !== null && <span className="rounded bg-black/70 px-1.5 py-0.5 text-emerald-300">Again in {gapLeft}…</span>}
            {follow !== null && (
              <span className="rounded bg-black/70 px-1.5 py-0.5" style={{ color: MEMBER_COLORS[follow] }}>
                {fanCam ? "Fan cam" : "Following"} {index?.members.find((m) => m.characterId === follow)?.name}
              </span>
            )}
            {buffering && <span className="rounded bg-black/70 px-1.5 py-0.5 text-slate-300">Loading motion…</span>}
            {silent && playing && (
              <span className="rounded bg-black/70 px-1.5 py-0.5 text-rose-300" title={silent}>
                No audio (playing silently)
              </span>
            )}
          </div>
          <div className="absolute right-3 top-3 flex gap-1 text-xs">
            {CAMERAS.map((c, i) => (
              <button
                key={c}
                onClick={() => setCamera(c)}
                className={`rounded px-2 py-0.5 capitalize ${camera === c ? "bg-amber-500 text-black" : "bg-black/60 text-slate-200 hover:bg-black/80"}`}
                title={`Camera: ${c} (${i + 1})`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <aside className="flex w-72 flex-col overflow-y-auto border-l border-slate-800 text-sm">
          <section className="border-b border-slate-800 px-3 py-2">
            <div className="mb-1 font-medium text-slate-300">Members</div>
            {index?.members.map((m) => {
              const off = hidden.includes(m.characterId);
              const away = !onStage.has(m.characterId);
              return (
                <div key={m.characterId} className="flex items-center gap-2 py-0.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: MEMBER_COLORS[m.characterId], opacity: away ? 0.35 : 1 }} />
                  <span className={`flex-1 ${off || away ? "text-slate-600" : "text-slate-200"}`}>
                    {m.name}
                    {away && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-slate-600">off stage</span>}
                  </span>
                  <button onClick={() => toggleHidden(m.characterId)} className="text-slate-400 hover:text-white" title="Show/hide">
                    {off ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  <button onClick={() => solo(m.characterId)} className="rounded px-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white" title="Solo">
                    S
                  </button>
                  <button
                    onClick={() => setFollowMember(follow === m.characterId ? null : m.characterId)}
                    className={follow === m.characterId ? "text-amber-300" : "text-slate-400 hover:text-white"}
                    title="Follow with the camera"
                  >
                    <Crosshair size={14} />
                  </button>
                  <button
                    onClick={() => startFanCam(fanCam && follow === m.characterId ? null : m.characterId)}
                    className={fanCam && follow === m.characterId ? "text-rose-300" : "text-slate-400 hover:text-white"}
                    title="Fan cam: close-up that tracks this member (V)"
                  >
                    <Video size={14} />
                  </button>
                </div>
              );
            })}
          </section>
          <section className="space-y-1.5 border-b border-slate-800 px-3 py-2 text-xs text-slate-300">
            <div className="text-sm font-medium text-slate-300">View</div>
            <label className="flex items-center gap-2" title="Fade everyone except the member you follow (crosshair or fan cam)">
              <span className="w-24 shrink-0">Others' opacity</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={othersOpacity}
                onChange={(e) => update({ othersOpacity: Number(e.target.value) })}
                className="min-w-0 flex-1 accent-amber-500"
              />
              <span className="w-8 text-right font-mono text-slate-400">{Math.round(othersOpacity * 100)}%</span>
            </label>
            {othersOpacity < 1 && follow === null && (
              <div className="text-[11px] text-slate-500">Follow a member to fade the others.</div>
            )}
            <label className="flex items-center gap-2" title="Draw each member in one flat colour, without costume detail (P)">
              <input type="checkbox" checked={plain} onChange={(e) => update({ plain: e.target.checked })} className="accent-amber-500" />
              Plain colours (no costume detail)
            </label>
            <label className="flex items-center gap-2" title="The fan cam swings round to stay in front of her, instead of watching from the audience side">
              <input type="checkbox" checked={fanFacing} onChange={(e) => update({ fanFacing: e.target.checked })} className="accent-amber-500" />
              Fan cam stays in front of her
            </label>
            <label className="flex items-center gap-2" title="Front and back side by side: the right half always shows the left half's camera from behind (D)">
              <input type="checkbox" checked={split} onChange={(e) => update({ split: e.target.checked })} className="accent-amber-500" />
              Split view: front and back (D)
            </label>
          </section>
          <section className="border-b border-slate-800 px-3 py-2">
            <div className="mb-1 font-medium text-slate-300">Setlist</div>
            {songs.map((s) => (
              <div key={s.start} className={`flex items-center gap-2 py-0.5 ${currentSong?.start === s.start ? "text-amber-200" : "text-slate-300"}`}>
                <button onClick={() => seek(s.start)} className="w-12 shrink-0 text-left font-mono text-xs text-slate-500 hover:text-white">
                  {fmt(s.start).replace(/\.\d$/, "")}
                </button>
                <button onClick={() => seek(s.start)} className="min-w-0 flex-1 text-left leading-tight hover:text-white" title={s.sub || s.label}>
                  <span className="block truncate">{s.label}</span>
                  {s.sub && <span className="block truncate font-jp text-xs text-slate-500">{s.sub}</span>}
                </button>
                <button onClick={() => loopSong(s)} className="text-slate-500 hover:text-emerald-300" title="Loop this song">
                  <Repeat size={13} />
                </button>
              </div>
            ))}
          </section>
          <section className="border-b border-slate-800 px-3 py-2 text-xs">
            <div className="mb-1 text-sm font-medium text-slate-300">Practice loops</div>
            {segments.length === 0 && (
              <div className="text-slate-500">Set A and B, then press Save (S) to keep a loop here.</div>
            )}
            {segments.map((s) => (
              <div key={s.id} className="flex items-center gap-1.5 py-0.5">
                <button onClick={() => playSegment(s)} className="text-slate-400 hover:text-emerald-300" title="Loop this segment">
                  <Repeat size={13} />
                </button>
                <input
                  value={s.name}
                  onChange={(e) => renameSegment(s.id, e.target.value)}
                  className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-slate-200 hover:bg-slate-900 focus:bg-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-700"
                  title={`${fmt(s.a)} – ${fmt(s.b)}`}
                />
                <button onClick={() => deleteSegment(s.id)} className="text-slate-600 hover:text-rose-300" title="Delete">
                  <X size={13} />
                </button>
              </div>
            ))}
            <label className="mt-1.5 flex items-center gap-2 text-slate-400">
              Pause between repeats
              <select
                value={loopGap}
                onChange={(e) => update({ loopGap: Number(e.target.value) })}
                className="rounded bg-slate-900 px-1 py-0.5 text-slate-200 ring-1 ring-slate-700"
              >
                {LOOP_GAPS.map((g) => (
                  <option key={g} value={g}>{g === 0 ? "none" : `${g} s`}</option>
                ))}
              </select>
            </label>
          </section>
          <section className="px-3 py-2 text-xs leading-5 text-slate-500">
            <div><kbd>Space</kbd> play · <kbd>,</kbd>/<kbd>.</kbd> frame · <kbd>←</kbd>/<kbd>→</kbd> ±1s</div>
            <div><kbd>[</kbd>/<kbd>]</kbd> speed · <kbd>A</kbd>/<kbd>B</kbd>/<kbd>L</kbd>/<kbd>C</kbd> loop · <kbd>S</kbd> save loop</div>
            <div><kbd>M</kbd> mirror · <kbd>K</kbd> skeleton · <kbd>P</kbd> plain · <kbd>1</kbd>–<kbd>5</kbd> cameras · <kbd>F</kbd> unfollow · <kbd>V</kbd> fan cam · <kbd>D</kbd> split</div>
            <div>Drag to orbit, right-drag to pan, wheel to zoom.</div>
            <label className="mt-2 flex items-center gap-2">
              Audio sync
              <input
                type="number"
                step={10}
                value={offsetMs}
                onChange={(e) => update({ offsetMs: Number(e.target.value) || 0 })}
                className="w-20 rounded bg-slate-900 px-1 py-0.5 text-slate-200 ring-1 ring-slate-700"
              />
              ms
            </label>
          </section>
        </aside>
      </div>

      <footer className="border-t border-slate-800 px-4 py-2">
        <div
          ref={scrubRef}
          className="relative h-7 cursor-pointer"
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            scrubTo(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) scrubTo(e.clientX);
          }}
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-slate-800" />
          {songs.map((s) => (
            <div
              key={s.start}
              title={s.label}
              className="absolute top-1/2 h-2 -translate-y-1/2 rounded bg-amber-500/35"
              style={{ left: pct(s.start), width: `calc(${pct(s.end)} - ${pct(s.start)})` }}
            />
          ))}
          {loopA !== null && loopB !== null && (
            <div
              className={`absolute top-1/2 h-3 -translate-y-1/2 rounded ${loopOn ? "bg-emerald-500/50" : "bg-emerald-500/20"}`}
              style={{ left: pct(loopA), width: `calc(${pct(loopB)} - ${pct(loopA)})` }}
            />
          )}
          <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: pct(time) }} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
          <button onClick={() => step(-1)} className="text-slate-300 hover:text-white" aria-label="Previous frame">
            <StepBack size={18} />
          </button>
          <button onClick={togglePlay} className="text-white" aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={22} /> : <Play size={22} />}
          </button>
          <button onClick={() => step(1)} className="text-slate-300 hover:text-white" aria-label="Next frame">
            <StepForward size={18} />
          </button>
          <span className="font-mono text-xs text-slate-400">
            {fmt(time)} / {fmt(duration)}
          </span>
          <div className="flex items-center gap-1">
            {RATES.map((r) => (
              <button
                key={r}
                onClick={() => update({ rate: r })}
                className={`rounded px-1.5 py-0.5 text-xs ${Math.abs(rate - r) < 1e-6 ? "bg-amber-500 text-black" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
              >
                {r}×
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-xs">
            <button onClick={() => setPoint("A")} className="rounded bg-slate-800 px-1.5 py-0.5 hover:bg-slate-700">A {fmt(loopA)}</button>
            <button onClick={() => setPoint("B")} className="rounded bg-slate-800 px-1.5 py-0.5 hover:bg-slate-700">B {fmt(loopB)}</button>
            <button
              onClick={() => setLoopOn((v) => !v)}
              disabled={loopA === null || loopB === null}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 disabled:opacity-40 ${loopOn ? "bg-emerald-600 text-white" : "bg-slate-800 hover:bg-slate-700"}`}
            >
              <Repeat size={12} /> Loop
            </button>
            <button
              onClick={saveSegment}
              disabled={loopA === null || loopB === null}
              className="flex items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5 hover:bg-slate-700 disabled:opacity-40"
              title="Save this loop to Practice loops (S)"
            >
              <BookmarkPlus size={12} /> Save
            </button>
          </div>
          <button
            onClick={() => update({ mirror: !mirror })}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${mirror ? "bg-sky-600 text-white" : "bg-slate-800 hover:bg-slate-700"}`}
          >
            <FlipHorizontal2 size={12} /> Mirror
          </button>
          <button
            onClick={() => update({ skeleton: !skeleton })}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${skeleton ? "bg-violet-600 text-white" : "bg-slate-800 hover:bg-slate-700"}`}
          >
            <Bone size={12} /> Skeleton
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => update({ muted: !muted })} className="text-slate-300 hover:text-white" aria-label={muted ? "Unmute" : "Mute"}>
              {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => update({ volume: Number(e.target.value), muted: false })}
              className="w-24 accent-amber-500"
              aria-label="Volume"
            />
          </div>
        </div>
      </footer>

      <audio
        ref={audioRef}
        src={`${base}/audio.m4a`}
        preload="auto"
      />
    </div>
  );
}
