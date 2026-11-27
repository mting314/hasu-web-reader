import { useSyncExternalStore } from "react";
import type { CastHeightMode, PjskModelEntry } from "./engine/castSwap/castSwap";
import { assetUrl, hasDevKey, rewriteAssetUrls } from "./remoteAssets";

/**
 * The user's PJSK cast (which Project Sekai model stands in for which Hasu character), kept in
 * localStorage. See src/engine/castSwap/castSwap.ts.
 */
export interface CastState {
  /** Hasu character id (1031 Kaho, …) -> PJSK model id; missing = the original character */
  cast: Record<string, string>;
  heightMode: CastHeightMode;
}

const KEY = "hasu-reader.pjskCast";
const listeners = new Set<() => void>();
let state: CastState = load();

/** `?cast=1031:01ichika,1032:11akito&castHeight=pjsk` sets the cast (and is saved), for shareable links. */
function fromUrl(): CastState | null {
  const params = new URLSearchParams(window.location.search);
  const spec = params.get("cast");
  if (spec === null) return null;
  const cast: Record<string, string> = {};
  for (const pair of spec.split(",")) {
    const [id, model] = pair.split(":");
    if (id && model) cast[id] = model;
  }
  return { cast, heightMode: params.get("castHeight") === "pjsk" ? "pjsk" : "replaced" };
}

function load(): CastState {
  const linked = fromUrl();
  if (linked) {
    try {
      localStorage.setItem(KEY, JSON.stringify(linked));
    } catch {
      // storage disabled: the link still applies for this visit
    }
    return linked;
  }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object" && raw.cast && typeof raw.cast === "object") {
      return { cast: raw.cast, heightMode: raw.heightMode === "pjsk" ? "pjsk" : "replaced" };
    }
  } catch {
    // unreadable entry: start empty
  }
  return { cast: {}, heightMode: "replaced" };
}

export function getCastState(): CastState {
  return state;
}

export function setCastState(update: (s: CastState) => CastState) {
  state = update(state);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage full or disabled: keep the in-memory state
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCastState(): CastState {
  return useSyncExternalStore(subscribe, getCastState);
}

let catalog: Promise<PjskModelEntry[]> | null = null;

/** The exported PJSK models (`/assets/pjsk/models.json`, written by scripts/export_pjsk_model.py). */
export function loadPjskCatalog(): Promise<PjskModelEntry[]> {
  if (!hasDevKey()) return Promise.resolve([]);
  catalog ??= fetch(assetUrl("/assets/pjsk/models.json"))
    .then((r) => (r.ok ? r.json() : []))
    .then((entries: PjskModelEntry[]) => rewriteAssetUrls(entries))
    .catch(() => []);
  return catalog;
}
