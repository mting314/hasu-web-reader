import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  FlipHorizontal2,
  Link as LinkIcon,
  Pause,
  Play,
  Repeat,
  StepBack,
  StepForward,
  Trash2,
  Upload,
} from "lucide-react";

/**
 * Choreo study player: a plain video player with slow-mo, frame stepping, A/B looping,
 * mirroring, zoom/pan and bookmarks, for learning Fes×LIVE choreography from the archive streams.
 *
 * Sources: drag-and-drop or pick a local video file, or open `study.html?src=<url>`.
 * Per-video settings (loop points, bookmarks, speed, mirror) persist in localStorage.
 */

const RATES = [0.1, 0.25, 0.5, 0.75, 1];
const STORAGE_PREFIX = "choreo-study:";
const RESET_VIEW = { zoom: 1, x: 0, y: 0 };

type Marker = { t: number; label: string };

type Saved = {
  loopA: number | null;
  loopB: number | null;
  loopOn: boolean;
  rate: number;
  mirror: boolean;
  fps: number;
  bookmarks: Marker[];
};

const DEFAULTS: Saved = {
  loopA: null,
  loopB: null,
  loopOn: false,
  rate: 1,
  mirror: false,
  fps: 60,
  bookmarks: [],
};

function loadSaved(key: string): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function fmt(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return "--:--.--";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

export default function StudyPlayer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);

  const [src, setSrc] = useState<string | null>(null);
  const [srcKey, setSrcKey] = useState<string | null>(null);
  const [srcLabel, setSrcLabel] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [preservesPitch, setPreservesPitch] = useState(true);
  const [saved, setSaved] = useState<Saved>(DEFAULTS);
  const [view, setView] = useState(RESET_VIEW);
  const { zoom } = view;
  const [dragOver, setDragOver] = useState(false);

  const { loopA, loopB, loopOn, rate, mirror, fps, bookmarks } = saved;
  const update = useCallback((patch: Partial<Saved>) => setSaved((s) => ({ ...s, ...patch })), []);

  const openSource = useCallback((url: string, key: string, label: string) => {
    setError(null);
    setSrc((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return url;
    });
    setSrcKey(key);
    setSrcLabel(label);
    setSaved(loadSaved(key));
    setView(RESET_VIEW);
    setTime(0);
  }, []);

  const openFile = useCallback(
    (file: File) => openSource(URL.createObjectURL(file), `file:${file.name}:${file.size}`, file.name),
    [openSource]
  );

  const openUrl = useCallback(
    (url: string) => {
      const trimmed = url.trim();
      if (!trimmed) return;
      openSource(trimmed, `url:${trimmed}`, trimmed.split("/").pop() || trimmed);
      const params = new URLSearchParams(window.location.search);
      params.set("src", trimmed);
      window.history.replaceState(null, "", `?${params}`);
    },
    [openSource]
  );

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("src");
    if (initial) {
      setUrlDraft(initial);
      openUrl(initial);
    }
  }, [openUrl]);

  useEffect(() => {
    if (srcKey) localStorage.setItem(STORAGE_PREFIX + srcKey, JSON.stringify(saved));
  }, [srcKey, saved]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = rate;
    v.preservesPitch = preservesPitch;
  }, [rate, preservesPitch, src]);

  // Per-frame clock: keeps the time readout smooth and enforces the A/B loop more tightly
  // than `timeupdate` (which only fires a few times a second).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        if (loopOn && loopA !== null && loopB !== null && loopB > loopA && v.currentTime >= loopB) {
          v.currentTime = loopA;
        }
        setTime(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, loopOn, loopA, loopB]);

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = Math.min(Math.max(t, 0), duration || v.duration || 0);
      setTime(v.currentTime);
    },
    [duration]
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || !src) return;
    if (v.paused) {
      if (loopOn && loopA !== null && loopB !== null && (v.currentTime >= loopB || v.currentTime < loopA)) {
        v.currentTime = loopA;
      }
      void v.play();
    } else {
      v.pause();
    }
  }, [src, loopOn, loopA, loopB]);

  const stepFrame = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      seek(v.currentTime + dir / fps);
    },
    [fps, seek]
  );

  const stepRate = useCallback(
    (dir: 1 | -1) => {
      const idx = RATES.findIndex((r) => r >= rate - 1e-6);
      const next = RATES[Math.min(Math.max((idx === -1 ? RATES.length - 1 : idx) + dir, 0), RATES.length - 1)];
      update({ rate: next });
    },
    [rate, update]
  );

  const setPoint = useCallback(
    (which: "A" | "B") => {
      const t = videoRef.current?.currentTime ?? 0;
      if (which === "A") update({ loopA: t, loopB: loopB !== null && loopB <= t ? null : loopB, loopOn: loopB !== null && loopB > t });
      else update({ loopB: t, loopA: loopA !== null && loopA >= t ? null : loopA, loopOn: loopA !== null && loopA < t });
    },
    [loopA, loopB, update]
  );

  const addBookmark = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    const next = [...bookmarks, { t, label: `#${bookmarks.length + 1}` }].sort((a, b) => a.t - b.t);
    update({ bookmarks: next });
  }, [bookmarks, update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const v = videoRef.current;
      const key = e.key.toLowerCase();
      let handled = true;
      if (key === " ") togglePlay();
      else if (key === ",") stepFrame(-1);
      else if (key === ".") stepFrame(1);
      else if (key === "arrowleft") seek((v?.currentTime ?? 0) - (e.shiftKey ? 5 : 1));
      else if (key === "arrowright") seek((v?.currentTime ?? 0) + (e.shiftKey ? 5 : 1));
      else if (key === "[") stepRate(-1);
      else if (key === "]") stepRate(1);
      else if (key === "a") setPoint("A");
      else if (key === "b") setPoint("B");
      else if (key === "l") update({ loopOn: !loopOn });
      else if (key === "c") update({ loopA: null, loopB: null, loopOn: false });
      else if (key === "m") update({ mirror: !mirror });
      else if (key === "k") addBookmark();
      else if (key === "0") setView(RESET_VIEW);
      else if (/^[1-9]$/.test(key) && bookmarks[Number(key) - 1]) seek(bookmarks[Number(key) - 1].t);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, stepFrame, seek, stepRate, setPoint, addBookmark, update, loopOn, mirror, bookmarks]);

  // Zoom toward the cursor with the wheel; drag to pan; double-click to reset.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      setView((v) => {
        const z = Math.min(Math.max(v.zoom * Math.exp(-e.deltaY * 0.0015), 1), 8);
        if (z === 1) return RESET_VIEW;
        return { zoom: z, x: cx - ((cx - v.x) * z) / v.zoom, y: cy - ((cy - v.y) * z) / v.zoom };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [src]);

  const dragRef = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const onStagePointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, px: view.x, py: view.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved && zoom > 1) setView((v) => ({ ...v, x: d.px + dx, y: d.py + dy }));
  };
  const onStagePointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved) togglePlay();
  };

  const scrubTo = (clientX: number) => {
    const el = scrubRef.current;
    if (!el || !duration) return;
    const rect = el.getBoundingClientRect();
    seek(((clientX - rect.left) / rect.width) * duration);
  };

  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;

  return (
    <div
      className="flex h-screen flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) openFile(file);
      }}
    >
      <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-2 text-sm">
        <span className="font-semibold text-amber-300">Choreo Study</span>
        <span className="truncate text-slate-400">{srcLabel || "No video loaded"}</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md bg-slate-800 px-2.5 py-1 hover:bg-slate-700">
            <Upload size={14} /> Open file
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) openFile(file);
                e.target.value = "";
              }}
            />
          </label>
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              openUrl(urlDraft);
            }}
          >
            <LinkIcon size={14} className="text-slate-500" />
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="Video URL"
              className="w-64 rounded-md bg-slate-900 px-2 py-1 text-slate-200 outline-none ring-1 ring-slate-700 focus:ring-amber-500/60"
            />
          </form>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          ref={stageRef}
          className={`relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black ${
            zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
          }`}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onDoubleClick={() => setView(RESET_VIEW)}
        >
          {src ? (
            <div
              className="h-full w-full"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})` }}
            >
              <video
                ref={videoRef}
                src={src}
                className="h-full w-full object-contain"
                style={{ transform: mirror ? "scaleX(-1)" : undefined }}
                playsInline
                onPlay={() => setPlaying(true)}
                onPause={() => {
                  setPlaying(false);
                  setTime(videoRef.current?.currentTime ?? 0);
                }}
                onSeeked={() => setTime(videoRef.current?.currentTime ?? 0)}
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration);
                  e.currentTarget.playbackRate = rate;
                }}
                onError={() =>
                  setError(
                    src.includes(".m3u8")
                      ? "This browser can't play HLS (.m3u8) directly yet. Try Safari, or a downloaded MP4."
                      : "Couldn't load this video."
                  )
                }
              />
            </div>
          ) : (
            <div className="text-center text-slate-500">
              <Upload className="mx-auto mb-3" size={32} />
              <p>Drop a video here, open a file, or paste a URL.</p>
            </div>
          )}
          {error && (
            <div className="absolute inset-x-0 top-4 mx-auto w-fit rounded-md bg-red-950/90 px-3 py-1.5 text-sm text-red-200">
              {error}
            </div>
          )}
          {dragOver && (
            <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-amber-400/70 bg-amber-400/5" />
          )}
          <div className="pointer-events-none absolute left-3 top-3 flex gap-1.5 text-xs">
            {rate !== 1 && <span className="rounded bg-black/70 px-1.5 py-0.5 text-amber-300">{rate}×</span>}
            {mirror && <span className="rounded bg-black/70 px-1.5 py-0.5 text-sky-300">Mirrored</span>}
            {zoom > 1 && <span className="rounded bg-black/70 px-1.5 py-0.5 text-slate-300">{zoom.toFixed(1)}× zoom</span>}
            {loopOn && <span className="rounded bg-black/70 px-1.5 py-0.5 text-emerald-300">Loop</span>}
          </div>
        </div>

        <aside className="flex w-64 flex-col border-l border-slate-800 text-sm">
          <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
            <span className="font-medium text-slate-300">Bookmarks</span>
            <button
              onClick={addBookmark}
              disabled={!src}
              className="flex items-center gap-1 rounded bg-slate-800 px-2 py-0.5 text-xs hover:bg-slate-700 disabled:opacity-40"
            >
              <Bookmark size={12} /> Add (K)
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {bookmarks.map((b, i) => (
              <li key={`${b.t}-${i}`} className="group flex items-center gap-2 px-3 py-1 hover:bg-slate-900">
                <button onClick={() => seek(b.t)} className="w-16 shrink-0 text-left font-mono text-xs text-amber-300">
                  {i < 9 ? <span className="mr-1 text-slate-500">{i + 1}</span> : null}
                  {fmt(b.t)}
                </button>
                <input
                  value={b.label}
                  onChange={(e) =>
                    update({ bookmarks: bookmarks.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })
                  }
                  className="min-w-0 flex-1 bg-transparent text-slate-200 outline-none focus:text-white"
                />
                <button
                  onClick={() => update({ bookmarks: bookmarks.filter((_, j) => j !== i) })}
                  className="text-slate-600 opacity-0 hover:text-red-400 group-hover:opacity-100"
                  aria-label="Delete bookmark"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
            {bookmarks.length === 0 && (
              <li className="px-3 py-2 text-xs text-slate-500">Mark sections (verse, chorus, formation changes) to jump back with 1–9.</li>
            )}
          </ul>
          <div className="border-t border-slate-800 px-3 py-2 text-xs leading-5 text-slate-500">
            <div><kbd>Space</kbd> play · <kbd>,</kbd>/<kbd>.</kbd> frame step</div>
            <div><kbd>←</kbd>/<kbd>→</kbd> ±1s (Shift ±5s) · <kbd>[</kbd>/<kbd>]</kbd> speed</div>
            <div><kbd>A</kbd>/<kbd>B</kbd> loop points · <kbd>L</kbd> loop · <kbd>C</kbd> clear</div>
            <div><kbd>M</kbd> mirror · wheel zoom · <kbd>0</kbd> reset</div>
          </div>
        </aside>
      </div>

      <footer className="border-t border-slate-800 px-4 py-2">
        <div
          ref={scrubRef}
          className="relative h-6 cursor-pointer"
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            scrubTo(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) scrubTo(e.clientX);
          }}
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-slate-800" />
          {loopA !== null && loopB !== null && (
            <div
              className={`absolute top-1/2 h-2 -translate-y-1/2 rounded ${loopOn ? "bg-emerald-500/50" : "bg-emerald-500/20"}`}
              style={{ left: pct(loopA), width: `calc(${pct(loopB)} - ${pct(loopA)})` }}
            />
          )}
          {[loopA, loopB].map((t, i) =>
            t === null ? null : (
              <div key={i} className="absolute top-0 h-full w-px bg-emerald-400" style={{ left: pct(t) }} />
            )
          )}
          {bookmarks.map((b, i) => (
            <div
              key={`${b.t}-${i}`}
              title={b.label}
              className="absolute top-0 h-2 w-0.5 -translate-x-1/2 bg-amber-400"
              style={{ left: pct(b.t) }}
            />
          ))}
          <div
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
            style={{ left: pct(time) }}
          />
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
          <button onClick={() => stepFrame(-1)} className="text-slate-300 hover:text-white" aria-label="Previous frame">
            <StepBack size={18} />
          </button>
          <button onClick={togglePlay} className="text-white" aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={22} /> : <Play size={22} />}
          </button>
          <button onClick={() => stepFrame(1)} className="text-slate-300 hover:text-white" aria-label="Next frame">
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
                className={`rounded px-1.5 py-0.5 text-xs ${
                  Math.abs(rate - r) < 1e-6 ? "bg-amber-500 text-black" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {r}×
              </button>
            ))}
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={rate}
              onChange={(e) => update({ rate: Number(e.target.value) })}
              className="ml-1 w-24 accent-amber-500"
              aria-label="Playback speed"
            />
          </div>

          <div className="flex items-center gap-1 text-xs">
            <button onClick={() => setPoint("A")} className="rounded bg-slate-800 px-1.5 py-0.5 hover:bg-slate-700">
              A {fmt(loopA)}
            </button>
            <button onClick={() => setPoint("B")} className="rounded bg-slate-800 px-1.5 py-0.5 hover:bg-slate-700">
              B {fmt(loopB)}
            </button>
            <button
              onClick={() => update({ loopOn: !loopOn })}
              disabled={loopA === null || loopB === null}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 disabled:opacity-40 ${
                loopOn ? "bg-emerald-600 text-white" : "bg-slate-800 hover:bg-slate-700"
              }`}
            >
              <Repeat size={12} /> Loop
            </button>
          </div>

          <button
            onClick={() => update({ mirror: !mirror })}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
              mirror ? "bg-sky-600 text-white" : "bg-slate-800 hover:bg-slate-700"
            }`}
          >
            <FlipHorizontal2 size={12} /> Mirror
          </button>

          <label className="ml-auto flex items-center gap-1 text-xs text-slate-400">
            <input type="checkbox" checked={preservesPitch} onChange={(e) => setPreservesPitch(e.target.checked)} />
            Keep pitch
          </label>
          <label className="flex items-center gap-1 text-xs text-slate-400">
            Frame step
            <select
              value={fps}
              onChange={(e) => update({ fps: Number(e.target.value) })}
              className="rounded bg-slate-900 px-1 py-0.5 text-slate-200 ring-1 ring-slate-700"
            >
              {[24, 30, 60].map((f) => (
                <option key={f} value={f}>
                  1/{f}s
                </option>
              ))}
            </select>
          </label>
        </div>
      </footer>
    </div>
  );
}
