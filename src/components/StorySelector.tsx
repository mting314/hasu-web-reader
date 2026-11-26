import React, { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, ChevronsLeft, ChevronsRight, Lock, Play, X } from "lucide-react";
import { assetUrl } from "../remoteAssets";
import { StoryIndex, StoryIndexSeries } from "../types/storyIndex";
import type { EpisodeSummary } from "../types/scenario";
import { EpisodeTimeline, PartTimeline } from "./EpisodeTimeline";

/**
 * Story selector modelled on the game's 活動記録 (activity record) screen, as laid out in the
 * client dump (ActivityRecordSceneView and its segment views):
 *  - segment tabs: SEGMENT_1 = the main story, SEGMENT_2 = special chapters
 *  - main story: a year carousel (102期 … 105期, with oldest / latest buttons), a carousel of
 *    monthly series cards (year + month, state mark, title, synopsis, part count), and the
 *    selected series' parts as a horizontal timeline (PartTimeline: thumbnail above each node,
 *    PART n below, locked overlay)
 *  - chapters: a list of wide chapter cards, then their parts
 * Data: public/data/story_index.json (scripts/build_story_index.py). A part is readable when the
 * reader's catalog has it; the others are shown locked, the way the game shows parts that aren't
 * released yet. If the index can't be loaded, the catalog's episodes are listed instead.
 */

let indexPromise: Promise<StoryIndex> | null = null;
function loadStoryIndex(): Promise<StoryIndex> {
  if (!indexPromise) {
    indexPromise = fetch("/data/story_index.json").then((r) => {
      if (!r.ok) throw new Error(`story_index.json: HTTP ${r.status}`);
      return r.json() as Promise<StoryIndex>;
    });
    indexPromise.catch(() => {
      indexPromise = null;
    });
  }
  return indexPromise;
}

interface StorySelectorProps {
  open: boolean;
  /** the story being read, focused when the selector opens */
  currentScriptId: string | null;
  onSelect: (scriptId: string) => void;
  onClose: () => void;
  /** e.g. prewarm a readable part's assets on hover */
  onHoverPart?: (scriptId: string) => void;
  /** the reader's compiled episodes: what's readable, and each part's length */
  catalog: EpisodeSummary[];
  formatDuration: (sec: number) => string;
  /** extra links for the top bar (credits, watch order) */
  headerExtras?: React.ReactNode;
}

const readableCount = (s: StoryIndexSeries, readable: Set<string>) =>
  s.parts.filter((p) => readable.has(p.scriptId)).length;

function StateMark({ series, readable }: { series: StoryIndexSeries; readable: Set<string> }) {
  // The game marks each series normal / new / complete; here the state is how much the reader has.
  const n = readableCount(series, readable);
  const all = n === series.parts.length && n > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${
        all
          ? "bg-emerald-400/90 text-emerald-950"
          : n > 0
            ? "bg-[#9db8ff]/90 text-[#0b111c]"
            : "bg-black/55 text-slate-300"
      }`}
      title={`${n} of ${series.parts.length} parts readable`}
    >
      {all ? <Check className="w-3 h-3" /> : n > 0 ? <Play className="w-2.5 h-2.5" /> : <Lock className="w-2.5 h-2.5" />}
      {n > 0 && !all ? `${n}/${series.parts.length}` : all ? "All" : ""}
    </span>
  );
}

export const StorySelector: React.FC<StorySelectorProps> = ({
  open,
  currentScriptId,
  onSelect,
  onClose,
  onHoverPart,
  catalog,
  formatDuration,
  headerExtras,
}) => {
  const byScript = useMemo(() => new Map(catalog.map((ep) => [ep.scriptId, ep])), [catalog]);
  const readable = useMemo(() => new Set(byScript.keys()), [byScript]);
  const [index, setIndex] = useState<StoryIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState(0);
  const [year, setYear] = useState<number | null>(null);
  const [seriesId, setSeriesId] = useState<number | null>(null);
  const cardRefs = useRef(new Map<number, HTMLButtonElement>());

  useEffect(() => {
    if (open && !index) loadStoryIndex().then(setIndex, (e) => setError(String(e)));
  }, [open, index]);

  const currentSeries = useMemo(
    () => index?.series.find((s) => s.parts.some((p) => p.scriptId === currentScriptId)) ?? null,
    [index, currentScriptId]
  );
  const focusSeries = (s: StoryIndexSeries | null | undefined) => {
    if (!s) return;
    setSegment(s.segment);
    setYear(s.fiscalYear);
    setSeriesId(s.id);
  };

  // On open, go to the story being read (like the game's button that jumps to the current season).
  useEffect(() => {
    if (!open || !index) return;
    focusSeries(currentSeries ?? index.series.find((s) => readableCount(s, readable) > 0) ?? index.series[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

  const shown = useMemo(
    () => (index ? index.series.filter((s) => s.segment === segment && (segment !== 0 || s.fiscalYear === year)) : []),
    [index, segment, year]
  );
  const selected = shown.find((s) => s.id === seriesId) ?? shown[0] ?? null;

  useEffect(() => {
    if (open && selected) {
      cardRefs.current.get(selected.id)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, [open, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes; ←/→ move between series. Handled in the capture phase so the reader behind the
  // overlay doesn't also advance its lines.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const i = shown.findIndex((s) => s.id === selected?.id);
        const next = shown[i + (e.key === "ArrowRight" ? 1 : -1)];
        if (next) setSeriesId(next.id);
      } else if (e.key === " ") {
        // keep Space for pressing a focused button; just don't let the reader advance a line
        e.stopImmediatePropagation();
        if (t && /^(BUTTON|A)$/.test(t.tagName)) return;
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, shown, selected, onClose]);

  if (!open) return null;

  const years = index?.years ?? [];
  const yearIdx = years.findIndex((y) => y.fiscalYear === year);
  const selectYear = (fy: number) => {
    setYear(fy);
    setSeriesId(index?.series.find((s) => s.segment === 0 && s.fiscalYear === fy)?.id ?? null);
  };
  const totalParts = index?.series.reduce((n, s) => n + s.parts.length, 0) ?? 0;
  const readableParts = index?.series.reduce((n, s) => n + readableCount(s, readable), 0) ?? 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Activity records"
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-[#0a0f18]/[0.97] backdrop-blur-md"
    >
      {/* top panel */}
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-[#0a0f18]/95 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <BookOpen className="h-5 w-5 text-[#9db8ff]" />
          <div className="leading-tight">
            <div className="text-base font-bold text-white">活動記録</div>
            <div className="text-[10px] uppercase tracking-wider text-slate-400">Activity Records</div>
          </div>
          <div className="ml-1 inline-flex rounded-full border border-slate-700 p-0.5" role="tablist">
            {(index?.segments ?? []).map((seg) => (
              <button
                key={seg.id}
                type="button"
                role="tab"
                aria-selected={segment === seg.id}
                onClick={() => {
                  setSegment(seg.id);
                  const first = index?.series.find((s) => s.segment === seg.id && (seg.id !== 0 || s.fiscalYear === year));
                  setSeriesId(first?.id ?? null);
                }}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                  segment === seg.id ? "bg-[#9db8ff] text-[#0b111c]" : "text-slate-300 hover:text-white"
                }`}
              >
                {seg.label}
              </button>
            ))}
          </div>
          {index && (
            <span className="text-[11px] text-slate-500">
              {readableParts} of {totalParts} parts in the reader
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {headerExtras}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6">
          <div className="mb-3 text-sm text-rose-300">Couldn't load the story list ({error}); showing the episodes in the reader.</div>
          <EpisodeTimeline
            series={[]}
            catalog={catalog}
            activeScriptId={currentScriptId}
            onSelect={(ep) => onSelect(ep.scriptId)}
            onPrewarm={(ep) => onHoverPart?.(ep.scriptId)}
            formatDuration={formatDuration}
          />
        </div>
      )}
      {!index && !error && <div className="p-6 text-sm text-slate-400">Loading…</div>}

      {index && (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-4 sm:px-6">
          {segment === 0 && (
            <>
              {/* year carousel */}
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  aria-label="Oldest year"
                  disabled={yearIdx <= 0}
                  onClick={() => selectYear(years[0].fiscalYear)}
                  className="rounded-full p-1.5 text-slate-400 transition hover:text-white disabled:opacity-30"
                >
                  <ChevronsLeft className="h-4 w-4" />
                </button>
                <div className="flex items-center">
                  {years.map((y, i) => (
                    <React.Fragment key={y.fiscalYear}>
                      {i > 0 && <span aria-hidden="true" className="h-px w-4 sm:w-8 bg-slate-700" />}
                      <button
                        type="button"
                        onClick={() => selectYear(y.fiscalYear)}
                        className={`rounded-full px-3 py-1 text-sm font-bold transition ${
                          y.fiscalYear === year
                            ? "bg-[#9db8ff] text-[#0b111c] shadow-[0_0_12px_rgba(157,184,255,0.35)]"
                            : "border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white"
                        }`}
                      >
                        {y.yearText}
                      </button>
                    </React.Fragment>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label="Latest year"
                  disabled={yearIdx === years.length - 1}
                  onClick={() => selectYear(years[years.length - 1].fiscalYear)}
                  className="rounded-full p-1.5 text-slate-400 transition hover:text-white disabled:opacity-30"
                >
                  <ChevronsRight className="h-4 w-4" />
                </button>
                {currentSeries && (
                  <button
                    type="button"
                    onClick={() => focusSeries(currentSeries)}
                    className="ml-2 rounded-full border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-300 transition hover:border-[#9db8ff] hover:text-white"
                  >
                    Now reading
                  </button>
                )}
              </div>

              {/* monthly series carousel */}
              <div className="-mx-4 flex snap-x snap-mandatory items-end gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
                {shown.map((s) => {
                  const isSel = s.id === selected?.id;
                  return (
                    <button
                      key={s.id}
                      ref={(el) => {
                        if (el) cardRefs.current.set(s.id, el);
                        else cardRefs.current.delete(s.id);
                      }}
                      type="button"
                      onClick={() => setSeriesId(s.id)}
                      aria-pressed={isSel}
                      className={`relative shrink-0 snap-center overflow-hidden rounded-2xl border text-left transition-all duration-300 ${
                        isSel
                          ? "w-40 sm:w-48 border-[#9db8ff] shadow-[0_0_0_2px_rgba(157,184,255,0.3)]"
                          : "w-28 sm:w-36 border-slate-700/70 opacity-70 hover:opacity-100"
                      }`}
                      style={{ aspectRatio: "657 / 1115" }}
                    >
                      {s.card && (
                        <img src={assetUrl(s.card)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                      )}
                      <div className="absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/65 to-transparent p-2">
                        <div className="leading-tight">
                          <div className="text-[10px] font-semibold tracking-wider text-white/80">{s.yearText}</div>
                          <div className="text-sm font-black text-white">{s.monthText}</div>
                        </div>
                        <StateMark series={s} readable={readable} />
                      </div>
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-2 pt-6">
                        <div className={`font-bold leading-snug text-white line-clamp-2 ${isSel ? "text-[13px]" : "text-[11px]"}`}>
                          {s.title}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-300">{s.parts.length} parts</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {segment !== 0 && (
            /* chapter list (the game's second segment): wide chapter cards */
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {shown.map((s) => {
                const isSel = s.id === selected?.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSeriesId(s.id)}
                    aria-pressed={isSel}
                    className={`relative overflow-hidden rounded-2xl border text-left transition ${
                      isSel ? "border-[#9db8ff] shadow-[0_0_0_2px_rgba(157,184,255,0.3)]" : "border-slate-700/70 opacity-80 hover:opacity-100"
                    }`}
                    style={{ aspectRatio: "1000 / 380" }}
                  >
                    {s.card && <img src={assetUrl(s.card)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
                    <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/85 to-transparent p-3 pt-8">
                      <div className="leading-tight">
                        <div className="text-[10px] font-semibold tracking-wider text-white/80">{s.monthText}</div>
                        <div className="text-sm font-bold text-white">{s.title}</div>
                      </div>
                      <StateMark series={s} readable={readable} />
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* selected series: synopsis, then its parts as a timeline */}
          {selected && (
            <section className="flex flex-col gap-4">
              <div>
                <div className="text-xs font-semibold text-[#9db8ff]">
                  {[selected.yearText, selected.monthText].filter(Boolean).join(" · ")}
                </div>
                <h3 className="mt-0.5 text-lg font-bold text-white">
                  {selected.title}
                  {selected.titleEn && <span className="ml-2 text-sm font-semibold text-slate-300">{selected.titleEn}</span>}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{selected.description}</p>
                {selected.descriptionEn && (
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{selected.descriptionEn}</p>
                )}
                <div className="mt-2 text-[11px] text-slate-500">
                  {readableCount(selected, readable)} of {selected.parts.length} parts in the reader
                </div>
              </div>
              <PartTimeline
                series={selected}
                catalogByScript={byScript}
                activeScriptId={currentScriptId}
                onSelect={(ep) => onSelect(ep.scriptId)}
                onPrewarm={(ep) => onHoverPart?.(ep.scriptId)}
                formatDuration={formatDuration}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
};
