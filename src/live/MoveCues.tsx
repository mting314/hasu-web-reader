import { memo, useEffect, useState } from "react";
import { MEMBER_COLORS, type LiveStage } from "./LiveStage";
import { activeMoves, describeMove, loadMoves, screenAngle, type MoveEvent, type MovesFile } from "./moves";

/**
 * Spin / walk markers in the choreo viewer's UI: ticks on the timeline scrubber and the early
 * cue over the stage (see moves.ts for the data and the floor arrows).
 */

/** moves.json for the live; null until loaded or when there is none. */
export function useMoves(liveBase: string): MovesFile | null {
  const [moves, setMoves] = useState<MovesFile | null>(null);
  useEffect(() => {
    let alive = true;
    setMoves(null);
    loadMoves(liveBase).then((m) => alive && setMoves(m));
    return () => {
      alive = false;
    };
  }, [liveBase]);
  return moves;
}

const KIND_LABEL = { spin: "Spin", turn: "Turn", walk: "Walk" } as const;

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
}

/**
 * Markers on the scrubber for some members' moves: spins as dots above the bar, turns as short
 * ticks above it, walks as bars under it spanning the walk. Coloured by member. Clicks fall
 * through to the scrubber.
 */
export const MoveTicks = memo(function MoveTicks({
  moves, members, names, duration,
}: {
  moves: MovesFile;
  members: number[];
  names: Record<number, string>;
  duration: number;
}) {
  if (!duration) return null;
  const pct = (t: number) => `${(Math.max(0, t) / duration) * 100}%`;
  return (
    <>
      {members.flatMap((cid) =>
        (moves.members[String(cid)] ?? []).map((e) => {
          const color = MEMBER_COLORS[cid] ?? "#ffffff";
          const what = e.kind === "walk"
            ? `${e.direction} ${e.distance} m`
            : `${e.side} ${Math.abs(e.degrees ?? 0)}°`;
          const title = `${names[cid] ?? cid}: ${KIND_LABEL[e.kind]} ${what} (${fmt(e.start)})`;
          if (e.kind === "walk") {
            return (
              <div
                key={e.id}
                title={title}
                className="absolute bottom-0.5 h-1 rounded-sm"
                style={{ left: pct(e.start), width: `max(2px, calc(${pct(e.end)} - ${pct(e.start)}))`, background: color, opacity: 0.8 }}
              />
            );
          }
          return (
            <div
              key={e.id}
              title={title}
              className={`absolute -translate-x-1/2 ${e.kind === "spin" ? "top-0 h-1.5 w-1.5 rounded-full" : "top-0.5 h-1.5 w-0.5"}`}
              style={{ left: pct(e.start), background: color, opacity: e.kind === "spin" ? 1 : 0.7 }}
            />
          );
        }),
      )}
    </>
  );
},
// the viewer re-renders ~20×/s with fresh arrays; only redraw when the member list really changes
(a, b) => a.moves === b.moves && a.duration === b.duration && a.members.join() === b.members.join()
  && Object.keys(a.names).length === Object.keys(b.names).length);

const ARROWS = ["→", "↗", "↑", "↖", "←", "↙", "↓", "↘"];

/**
 * The early cue for one member: shown LEAD seconds before each move with a countdown, and kept
 * up until the move ends, so a dancer can read it before she has to look away.
 */
export function MoveCue({
  events, cid, name, time, lead, mirror, stage,
}: {
  events: MoveEvent[] | undefined;
  cid: number;
  name: string;
  time: number;
  lead: number;
  mirror: boolean;
  stage: LiveStage | null;
}) {
  const cues = activeMoves(events, time, lead);
  if (!cues.length) return null;
  const color = MEMBER_COLORS[cid] ?? "#ffffff";
  return (
    <div className="pointer-events-none absolute left-1/2 top-12 flex -translate-x-1/2 flex-col items-center gap-1.5">
      {cues.map((e) => {
        const c = describeMove(e, time, lead, mirror);
        let glyph = c.glyph;
        if (e.kind === "walk" && e.from && e.to && stage) {
          // the arrow points the way she'll travel on screen, from the current camera (and mirror)
          const a = screenAngle(stage, e.from, e.to, mirror);
          if (a !== null) glyph = ARROWS[Math.round((((a * 180) / Math.PI + 360) % 360) / 45) % 8];
        }
        const now = c.until <= 0;
        return (
          <div
            key={e.id}
            className="min-w-64 rounded-lg border-2 bg-black/75 px-4 py-2 text-center shadow-lg"
            style={{ borderColor: color }}
          >
            <div className="flex items-center justify-center gap-2 text-lg font-semibold text-white">
              <span className="text-2xl leading-none" style={{ color }}>{glyph}</span>
              <span>
                {c.title}
                {now ? <span className="ml-2 text-amber-300">now!</span> : <span className="ml-2 text-slate-300">in {Math.ceil(c.until)}…</span>}
              </span>
            </div>
            <div className="text-xs text-slate-300">
              <span style={{ color }}>{name}</span>
              {c.detail && <> · {c.detail}</>}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded bg-slate-700">
              <div className="h-full" style={{ width: `${Math.round(c.progress * 100)}%`, background: now ? "#fbbf24" : color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
