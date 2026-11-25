import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import type { JpToken, JpTokenMatch, LexEntry, LexSense } from "../types/scenario";

/** Friendly labels for the most common JMdict part-of-speech codes (others show the code). */
const POS_LABELS: Record<string, string> = {
  n: "noun",
  "n-suf": "noun suffix",
  "n-pref": "noun prefix",
  pn: "pronoun",
  "adj-i": "i-adjective",
  "adj-ix": "i-adjective (いい)",
  "adj-na": "na-adjective",
  "adj-no": "no-adjective",
  "adj-pn": "pre-noun adjectival",
  "adj-t": "taru-adjective",
  "adj-f": "prenominal",
  adv: "adverb",
  "adv-to": "adverb (と)",
  prt: "particle",
  conj: "conjunction",
  int: "interjection",
  exp: "expression",
  cop: "copula",
  "aux-v": "auxiliary verb",
  "aux-adj": "auxiliary adjective",
  aux: "auxiliary",
  suf: "suffix",
  pref: "prefix",
  ctr: "counter",
  num: "numeric",
  v1: "ichidan verb",
  "v1-s": "ichidan verb",
  vk: "kuru verb",
  vs: "suru verb",
  "vs-i": "suru verb",
  "vs-s": "suru verb",
  vz: "zuru verb",
  vi: "intransitive",
  vt: "transitive",
  char: "character",
  place: "place",
  org: "organization",
  unit: "unit",
};
const MISC_SHOWN = new Set(["uk", "col", "hon", "hum", "pol", "sl", "fam", "fem", "male", "arch", "abbr", "on-mim", "vulg", "derog", "joc", "id", "yoji"]);

function posLabel(code: string): string {
  if (POS_LABELS[code]) return POS_LABELS[code];
  if (code.startsWith("v5")) return "godan verb";
  return code;
}

interface Headword {
  word: string;
  reading: string | null;
  /** other spellings worth showing (kanji for kana matches) */
  alt: string[];
  senses: LexSense[];
}

/** Work out what to display for one dictionary candidate, Yomitan style. */
function buildHeadword(entry: LexEntry, match: JpTokenMatch): Headword {
  const isUk = entry.s.some((s) => s.x?.includes("uk"));
  const kanji = entry.k ?? [];
  const readingsFor = (k: string) => entry.r.filter((r) => !entry.ra?.[r] || entry.ra[r].includes(k));
  let word: string;
  let reading: string | null;
  let alt: string[] = [];
  if (kanji.includes(match.f)) {
    word = match.f;
    reading = readingsFor(match.f)[0] ?? entry.r[0] ?? null;
  } else {
    const kanjiForReading = kanji.filter((k) => !entry.ra?.[match.f] || entry.ra[match.f].includes(k));
    if (kanjiForReading.length && !isUk && !entry.n) {
      word = kanjiForReading[0];
      reading = match.f;
    } else {
      word = match.f;
      reading = null;
      alt = kanjiForReading.slice(0, 2);
    }
  }
  const kanjiKey = kanji.includes(word) ? word : null;
  const readingKey = reading ?? (entry.r.includes(word) ? word : null);
  const senses = entry.s.filter(
    (s) =>
      (!s.ak || !kanjiKey || s.ak.includes(kanjiKey)) &&
      (!s.ar || !readingKey || s.ar.includes(readingKey))
  );
  return { word, reading, alt, senses: senses.length ? senses : entry.s };
}

interface LookupPopoverProps {
  token: JpToken;
  anchorEl: HTMLElement;
  lexicon: Record<string, LexEntry>;
  tags: Record<string, string>;
  page: number;
  setPage: (p: number) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

const LookupPopover: React.FC<LookupPopoverProps> = ({
  token,
  anchorEl,
  lexicon,
  tags,
  page,
  setPage,
  onPointerEnter,
  onPointerLeave,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; arrowX: number; below: boolean } | null>(null);
  const matches = (token.m ?? []).filter((m) => lexicon[m.e]);
  const idx = Math.min(page, Math.max(0, matches.length - 1));
  const match = matches[idx];
  const entry = match ? lexicon[match.e] : null;
  const hw = entry && match ? buildHeadword(entry, match) : null;

  // Place above the word (flip below near the top edge) and follow it if the layout
  // shifts, e.g. while the translation next to it is still typing out.
  useLayoutEffect(() => {
    let raf = 0;
    let last = "";
    const place = () => {
      const el = ref.current;
      if (el && anchorEl.isConnected) {
        const anchor = anchorEl.getBoundingClientRect();
        const { width, height } = el.getBoundingClientRect();
        const key = `${anchor.left},${anchor.top},${anchor.width},${width},${height},${window.innerWidth}`;
        if (key !== last) {
          last = key;
          const margin = 8;
          const gap = 10;
          let top = anchor.top - height - gap;
          let below = false;
          if (top < margin) {
            top = anchor.bottom + gap;
            below = true;
          }
          const centerX = anchor.left + anchor.width / 2;
          const left = Math.min(Math.max(margin, centerX - width / 2), window.innerWidth - width - margin);
          setPos({ left, top, arrowX: Math.min(Math.max(14, centerX - left), width - 14), below });
        }
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [anchorEl, idx, token]);

  if (!entry || !match || !hw) return null;

  const pos0 = hw.senses[0]?.p ?? [];
  const reasons = match.r ? [...match.r].reverse() : [];
  const searchTerm = encodeURIComponent(hw.word);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Dictionary: ${hw.word}`}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onClick={stop}
      onPointerDown={stop}
      style={{
        position: "fixed",
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: "min(22rem, calc(100vw - 16px))",
        zIndex: 1000,
        visibility: pos ? "visible" : "hidden",
      }}
      className="rounded-xl border border-slate-600/80 bg-slate-950/[0.97] px-3.5 py-3 text-left text-slate-100 shadow-2xl shadow-black/60 backdrop-blur-md font-jp"
    >
      {/* arrow */}
      {pos && (
        <span
          aria-hidden
          className={`absolute h-2.5 w-2.5 rotate-45 border-slate-600/80 bg-slate-950 ${
            pos.below ? "-top-[6px] border-l border-t" : "-bottom-[6px] border-r border-b"
          }`}
          style={{ left: pos.arrowX - 5 }}
        />
      )}

      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-xl font-bold leading-tight text-white">{hw.word}</span>
        {hw.reading && <span className="text-sm text-amber-200/90">{hw.reading}</span>}
        {hw.alt.length > 0 && (
          <span className="text-xs text-slate-400">({hw.alt.join("・")})</span>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {entry.n && (
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
            Hasunosora
          </span>
        )}
        {pos0.map((p) => (
          <span
            key={p}
            title={tags[p] || p}
            className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300"
          >
            {posLabel(p)}
          </span>
        ))}
        {entry.c && !entry.n && (
          <span
            title="Common word (JMdict priority)"
            className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300"
          >
            common
          </span>
        )}
      </div>

      {reasons.length > 0 && (
        <div className="mt-1.5 text-[11px] text-sky-300/90">
          <span className="text-slate-400">{token.t} ← </span>
          {reasons.join(" › ")}
        </div>
      )}

      <ol className="mt-2 space-y-1 text-[13px] leading-snug text-slate-200 max-h-48 overflow-y-auto pr-1">
        {hw.senses.slice(0, 6).map((s, i) => {
          const prevPos = i > 0 ? hw.senses[i - 1].p.join(",") : pos0.join(",");
          const misc = (s.x ?? []).filter((x) => MISC_SHOWN.has(x));
          return (
            <li key={i} className="flex gap-1.5">
              {hw.senses.length > 1 && <span className="text-slate-500 shrink-0">{i + 1}.</span>}
              <span>
                {s.p.join(",") !== prevPos && s.p.length > 0 && (
                  <span className="mr-1 text-[10px] uppercase text-violet-300/80">
                    [{s.p.map(posLabel).join(", ")}]
                  </span>
                )}
                {s.g.join("; ")}
                {misc.map((x) => (
                  <span key={x} title={tags[x] || x} className="ml-1 text-[10px] text-slate-400">
                    {x}
                  </span>
                ))}
                {s.i && s.i.length > 0 && <span className="ml-1 text-[11px] text-slate-500">({s.i.join("; ")})</span>}
              </span>
            </li>
          );
        })}
        {hw.senses.length > 6 && (
          <li className="text-[11px] text-slate-500">+{hw.senses.length - 6} more on Jisho</li>
        )}
      </ol>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-800 pt-2">
        <div className="flex items-center gap-1 text-[11px] text-slate-400">
          {matches.length > 1 ? (
            <>
              <button
                type="button"
                aria-label="Previous entry"
                onClick={() => setPage((idx - 1 + matches.length) % matches.length)}
                className="rounded p-0.5 hover:bg-slate-800 hover:text-white"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="tabular-nums">
                {idx + 1} / {matches.length}
              </span>
              <button
                type="button"
                aria-label="Next entry"
                onClick={() => setPage((idx + 1) % matches.length)}
                className="rounded p-0.5 hover:bg-slate-800 hover:text-white"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <a
              href="https://www.edrdg.org/edrdg/licence.html"
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-slate-500 hover:text-slate-300"
              title="Dictionary data: JMdict (EDRDG), CC BY-SA 4.0"
            >
              JMdict
            </a>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <a
            href={`https://jisho.org/search/${searchTerm}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] text-slate-200 hover:bg-slate-700"
          >
            Jisho <ExternalLink className="h-3 w-3" />
          </a>
          <a
            href={`https://ejje.weblio.jp/content/${searchTerm}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] text-slate-200 hover:bg-slate-700"
          >
            Weblio <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
};

interface JapaneseLookupTextProps {
  tokens: JpToken[] | undefined;
  text: string;
  lexicon: Record<string, LexEntry>;
  tags: Record<string, string>;
  className?: string;
  /** ms before a hover opens the popover (longer in dense lists) */
  hoverDelayMs?: number;
  /** clicking a word pins its popover (and doesn't bubble, e.g. to "advance line") */
  clickToPin?: boolean;
}

/**
 * Japanese text split into dictionary words (see scripts/jp_lexer.py). Hovering a word
 * opens a floating dictionary popover above it, rendered in a portal so it overlays
 * everything instead of resizing the subtitle box.
 */
export const JapaneseLookupText: React.FC<JapaneseLookupTextProps> = ({
  tokens,
  text,
  lexicon,
  tags,
  className = "",
  hoverDelayMs = 60,
  clickToPin = true,
}) => {
  const [active, setActive] = useState<{ idx: number; anchorEl: HTMLElement } | null>(null);
  const [pinned, setPinned] = useState(false);
  const [page, setPage] = useState(0);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const segs = useMemo<JpToken[]>(() => (tokens && tokens.length ? tokens : [{ t: text }]), [tokens, text]);

  const clearTimers = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };

  const close = useCallback(() => {
    clearTimers();
    setActive(null);
    setPinned(false);
  }, []);

  // New line -> drop any open popover
  useEffect(() => close, [segs, close]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: PointerEvent) => {
      if (!pinned) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-jp-token]")) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [active, pinned, close]);

  const open = (idx: number, el: HTMLElement) => {
    clearTimers();
    setPage(0);
    setActive({ idx, anchorEl: el });
  };

  const scheduleClose = () => {
    if (pinned) return;
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    openTimer.current = null;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setActive(null), 180);
  };

  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const portalTarget = typeof document !== "undefined" ? (document.fullscreenElement as HTMLElement | null) ?? document.body : null;
  const activeToken = active ? segs[active.idx] : null;

  return (
    <div className={className} role="group" aria-label="Japanese text with word lookup">
      <p className="leading-relaxed whitespace-pre-wrap">
        {segs.map((tok, idx) => {
          if (!tok.m || tok.m.length === 0) return <span key={idx}>{tok.t}</span>;
          const isActive = active?.idx === idx;
          return (
            <span
              key={idx}
              data-jp-token
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                cancelClose();
                if (active && !pinned) {
                  open(idx, el); // already showing a word: switch immediately
                  return;
                }
                if (pinned) return;
                if (openTimer.current !== null) window.clearTimeout(openTimer.current);
                openTimer.current = window.setTimeout(() => open(idx, el), hoverDelayMs);
              }}
              onMouseLeave={scheduleClose}
              onClick={(e) => {
                if (!clickToPin) return;
                e.stopPropagation();
                if (pinned && isActive) {
                  close();
                } else {
                  open(idx, e.currentTarget);
                  setPinned(true);
                }
              }}
              className={`rounded-[4px] transition-colors duration-100 ${clickToPin ? "cursor-pointer" : "cursor-help"} ${
                isActive ? "bg-amber-300/25 text-amber-100" : "hover:bg-amber-300/15 hover:text-amber-50"
              }`}
            >
              {tok.t}
            </span>
          );
        })}
      </p>
      {active && activeToken && portalTarget &&
        createPortal(
          <LookupPopover
            token={activeToken}
            anchorEl={active.anchorEl}
            lexicon={lexicon}
            tags={tags}
            page={page}
            setPage={setPage}
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
          />,
          portalTarget
        )}
    </div>
  );
};
