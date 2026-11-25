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
 * Covers Three.js loads (GLB models, textures) via the default LoadingManager's URL modifier
 * and fetch() of JSON assets (materials, expressions). Audio elements still use local URLs.
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
