import * as THREE from "three";

/**
 * Optional remote asset hosting (the hasu-web-reader-assets GCS bucket).
 *
 * Scenario data refers to assets as `/assets/<path>` (the local public/assets cache). When
 * VITE_ASSET_BASE_URL is set, any such request whose <path> starts with one of the
 * comma-separated VITE_REMOTE_ASSET_PREFIXES (empty = all assets) is served from
 * `${VITE_ASSET_BASE_URL}/<path>` instead, e.g. in .env.local:
 *
 *   VITE_ASSET_BASE_URL=https://storage.googleapis.com/hasu-web-reader-assets
 *   VITE_REMOTE_ASSET_PREFIXES=3d/
 *
 * Scenario data is rewritten once on load (rewriteAssetUrls), which covers audio, <img> and
 * prefetch; Three.js loads and fetch() calls are also rewritten as a backstop for URLs built
 * in code (e.g. a costume's `_materials.json` derived from its GLB URL).
 */
const BASE = String(import.meta.env.VITE_ASSET_BASE_URL ?? "").replace(/\/+$/, "");
const PREFIXES = String(import.meta.env.VITE_REMOTE_ASSET_PREFIXES ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

export function assetUrl(url: string): string {
  if (!BASE) return url;
  let path: string | null = null;
  if (url.startsWith("/assets/")) {
    path = url.slice("/assets/".length);
  } else {
    try {
      const u = new URL(url, window.location.href);
      if (u.origin === window.location.origin && u.pathname.startsWith("/assets/")) {
        path = u.pathname.slice("/assets/".length) + u.search;
      }
    } catch {
      // not a URL we handle
    }
  }
  if (path === null) return url;
  if (PREFIXES.length > 0 && !PREFIXES.some((p) => path!.startsWith(p))) return url;
  return `${BASE}/${path}`;
}

/**
 * Rewrite every "/assets/..." string inside loaded scenario data to its remote URL, so all
 * consumers (audio elements, <img>, prefetch, Three.js) pick up the bucket without each
 * call site knowing about it. Returns the data unchanged when remote hosting is off.
 */
export function rewriteAssetUrls<T>(data: T): T {
  if (!BASE) return data;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.startsWith("/assets/") ? assetUrl(v) : v;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = walk(v[i]);
      return v;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) o[k] = walk(o[k]);
      return o;
    }
    return v;
  };
  return walk(data) as T;
}

export function installRemoteAssets() {
  if (!BASE) return;
  THREE.DefaultLoadingManager.setURLModifier(assetUrl);
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(typeof input === "string" ? assetUrl(input) : input, init);
  console.info(
    `[assets] ${PREFIXES.length ? PREFIXES.map((p) => `/assets/${p}*`).join(", ") : "all /assets/*"} -> ${BASE}`
  );
}
