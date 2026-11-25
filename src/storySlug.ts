/**
 * Human-readable story ids for URLs and data files.
 *
 * Game script ids encode term / episode / part: 10300101 = 103rd term, episode 001, part 01,
 * which becomes the slug "103-ep1-part1". Ids that don't follow that pattern are used as-is.
 * Keep in sync with slug_for_script_id() in scripts/build_scenarios.py.
 */
export function slugForScriptId(scriptId: string): string {
  const m = /^(\d{3})(\d{3})(\d{2})$/.exec(scriptId);
  if (!m) return scriptId;
  return `${m[1]}-ep${Number(m[2])}-part${Number(m[3])}`;
}

export function scriptIdFromSlug(slug: string): string | null {
  const m = /^(\d{3})-ep(\d{1,3})-part(\d{1,2})$/i.exec(slug.trim());
  if (!m) return /^\d{8}$/.test(slug.trim()) ? slug.trim() : null;
  return `${m[1]}${m[2].padStart(3, "0")}${m[3].padStart(2, "0")}`;
}

/** "Ep 1 · Part 2" for a script id (falls back to the id). */
export function episodePartLabel(scriptId: string): string {
  const m = /^(\d{3})(\d{3})(\d{2})$/.exec(scriptId);
  if (!m) return scriptId;
  return `Ep ${Number(m[2])} · Part ${Number(m[3])}`;
}
