import { useEffect, useMemo, useState } from "react";
import type { PjskModelEntry } from "../engine/castSwap/castSwap";
import { loadPjskCatalog, setCastState, useCastState } from "../castSwapStore";
import type { ScenarioData } from "../types/scenario";

/** Settings section for the PJSK cast swap: pick a Project Sekai stand-in per character. */
export function CastPanel({ scenario }: { scenario: ScenarioData | null }) {
  const { cast, heightMode } = useCastState();
  const [models, setModels] = useState<PjskModelEntry[]>([]);
  useEffect(() => {
    loadPjskCatalog().then(setModels);
  }, []);

  // Every character that appears in this episode, in order of first appearance
  const characters = useMemo(() => {
    const seen = new Map<number, string>();
    for (const turn of scenario?.turns ?? []) {
      for (const c of Object.values(turn.stateBefore.characters)) {
        if (!seen.has(c.characterId)) seen.set(c.characterId, c.nameEn || c.name);
      }
    }
    return [...seen.entries()];
  }, [scenario]);

  if (!models.length || !characters.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-slate-400">Project Sekai cast:</span>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {characters.map(([id, name]) => (
          <label key={id} className="inline-flex items-center gap-2">
            <span>{name}</span>
            <select
              aria-label={`Stand-in for ${name}`}
              value={cast[String(id)] ?? ""}
              onChange={(e) =>
                setCastState((s) => {
                  const next = { ...s.cast };
                  if (e.target.value) next[String(id)] = e.target.value;
                  else delete next[String(id)];
                  return { ...s, cast: next };
                })
              }
              className="rounded-lg border border-slate-700/80 bg-[#111b2a] px-2.5 py-1.5 text-slate-100 font-medium"
            >
              <option value="">Original</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="inline-flex items-center gap-2 cursor-pointer" title="Off: the stand-in takes the replaced character's size">
          <input
            type="checkbox"
            checked={heightMode === "pjsk"}
            onChange={(e) => setCastState((s) => ({ ...s, heightMode: e.target.checked ? "pjsk" : "replaced" }))}
            className="accent-[#58a6ff] h-4 w-4 rounded"
          />
          <span>Use Project Sekai heights</span>
        </label>
      </div>
    </div>
  );
}
