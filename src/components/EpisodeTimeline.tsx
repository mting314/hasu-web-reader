import React from "react";
import { Lock } from "lucide-react";
import { assetUrl } from "../remoteAssets";
import type { StoryIndexSeries } from "../types/storyIndex";
import type { EpisodeSummary } from "../types/scenario";

/**
 * The episode picker, laid out like the game's 活動記録 screen turned sideways: per monthly episode a
 * header over its card art, then a horizontal timeline with one node per part, the part's thumbnail
 * above the node and "PART n" below. Parts that aren't compiled into the reader yet are shown locked.
 * Data: public/data/story_index.json (scripts/build_story_index.py, from the game's AdvSeries /
 * AdvDatas tables and image_record_monthly_* art).
 */
export const EpisodeTimeline: React.FC<{
  series: StoryIndexSeries[];
  catalog: EpisodeSummary[];
  activeScriptId: string | null;
  onSelect: (ep: EpisodeSummary) => void;
  onPrewarm: (ep: EpisodeSummary) => void;
  formatDuration: (sec: number) => string;
}> = ({ series, catalog, activeScriptId, onSelect, onPrewarm, formatDuration }) => {
  const byScript = new Map(catalog.map((ep) => [ep.scriptId, ep]));
  // monthly episodes that have at least one readable part, in the game's order
  const indexed = series.filter((s) => s.parts.some((p) => byScript.has(p.scriptId)));
  // catalog episodes the index doesn't cover (or every episode, if it failed to load) still get a
  // timeline, built from the catalog (no art)
  const covered = new Set(indexed.flatMap((s) => s.parts.map((p) => p.scriptId)));
  const fallback = new Map<string, StoryIndexSeries>();
  for (const ep of catalog) {
    if (covered.has(ep.scriptId)) continue;
    let s = fallback.get(ep.seriesId);
    if (!s) {
      s = {
        id: Number(ep.seriesId), segment: 0, fiscalYear: 0, yearText: ep.term, monthText: ep.month,
        title: ep.seriesTitleJp, description: ep.descriptionJp, titleEn: ep.seriesTitleEn,
        descriptionEn: ep.descriptionEn, card: null, cardShape: "wide", parts: [],
      };
      fallback.set(ep.seriesId, s);
    }
    s.parts.push({ scriptId: ep.scriptId, slug: ep.slug ?? ep.scriptId, label: ep.partTitleJp, number: "", thumbnail: null,
      available: true, titleEn: ep.partTitleEn });
  }
  const shown = [...indexed, ...fallback.values()];

  return (
    <div className="flex flex-col gap-4">
      {shown.map((s) => {
        const firstEp = s.parts.map((p) => byScript.get(p.scriptId)).find(Boolean);
        return (
          <section key={s.id} className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70">
            {/* header over the series card art, faded like the app */}
            <div className="relative px-4 pt-3 pb-2">
              {s.card && (
                <img
                  src={assetUrl(s.card)}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  className="pointer-events-none absolute inset-0 h-full w-full object-cover object-[50%_20%] opacity-25"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-r from-slate-950/95 via-slate-950/70 to-slate-950/30" />
              <div className="relative flex items-baseline gap-3">
                <div className="shrink-0 text-[#9db8ff] leading-tight">
                  <div className="text-[11px] font-semibold">{s.yearText}</div>
                  <div className="text-base font-bold">{s.monthText}</div>
                </div>
                <div className="min-w-0">
                  {/* English title and synopsis from Hasu-KO where it has them (scripts/hasuko_series_en.py) */}
                  <div className="text-sm font-bold text-white">
                    {s.title}
                    {(s.titleEn ?? firstEp?.seriesTitleEn) && (
                      <span className="ml-2 font-semibold text-slate-300">{s.titleEn ?? firstEp?.seriesTitleEn}</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-400 line-clamp-2" lang={s.descriptionEn ? "en" : "ja"}>
                    {s.descriptionEn ?? s.description}
                  </div>
                </div>
              </div>
            </div>

            {/* horizontal timeline: thumbnail above each node, PART n below */}
            <div className="relative overflow-x-auto px-4 pb-3">
              <div className="flex gap-3">
                {s.parts.map((p) => {
                  const ep = byScript.get(p.scriptId);
                  const selected = p.scriptId === activeScriptId;
                  const num = p.label.replace(/^PART\s*/i, "");
                  const isPartN = /^PART\s*\d+$/i.test(p.label);
                  return (
                    <button
                      key={p.scriptId}
                      type="button"
                      disabled={!ep}
                      onClick={() => ep && onSelect(ep)}
                      onMouseEnter={() => ep && onPrewarm(ep)}
                      onFocus={() => ep && onPrewarm(ep)}
                      title={ep ? ep.partTitleEn : `${p.label}: not in the reader yet`}
                      className="group relative flex min-w-[9.5rem] flex-1 basis-0 flex-col items-center text-center disabled:cursor-not-allowed"
                    >
                      <div
                        className={`relative aspect-[828/238] w-full overflow-hidden rounded-xl border transition ${
                          selected
                            ? "border-[#9db8ff] shadow-[0_0_18px_rgba(124,159,245,0.45)]"
                            : ep
                              ? "border-slate-700 group-hover:border-[#7c9ff5]/80"
                              : "border-slate-800"
                        }`}
                      >
                        {!p.thumbnail && <span className="absolute inset-0 bg-slate-900" />}
                        {p.thumbnail && (
                          <img
                            src={assetUrl(p.thumbnail)}
                            alt=""
                            loading="lazy"
                            className={`h-full w-full object-cover transition ${ep ? "group-hover:scale-[1.03]" : "opacity-35 grayscale"}`}
                          />
                        )}
                        {!ep && (
                          <span className="absolute inset-0 flex items-center justify-center text-slate-400">
                            <Lock className="h-4 w-4" />
                          </span>
                        )}
                      </div>
                      {/* node on the line; each column draws its stretch of the line (bridging the gap) */}
                      <span aria-hidden="true" className="relative mt-1.5 flex w-full justify-center">
                        <span className="absolute -left-1.5 -right-1.5 top-1/2 h-0.5 -translate-y-1/2 bg-[#7c9ff5]/50" />
                      <span
                        className={`relative z-10 h-[15px] w-[15px] rounded-full border-2 ${
                          selected
                            ? "border-[#9db8ff] bg-[#9db8ff]"
                            : ep
                              ? "border-[#7c9ff5] bg-slate-950 group-hover:bg-[#7c9ff5]/40"
                              : "border-slate-600 bg-slate-950"
                        }`}
                      />
                      </span>
                      <span className={`mt-1 font-bold ${ep ? "text-[#9db8ff]" : "text-slate-500"}`}>
                        {isPartN ? (
                          <>
                            <span className="text-[10px] tracking-wider">PART</span>
                            <span className="ml-0.5 text-lg leading-none">{num}</span>
                          </>
                        ) : (
                          <span className="text-xs">{p.label}</span>
                        )}
                      </span>
                      {ep && <span className="mt-0.5 text-[11px] text-slate-400">{formatDuration(ep.totalDurationSec)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
};
