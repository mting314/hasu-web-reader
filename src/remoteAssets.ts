import * as THREE from "three";

/**
 * Optional remote asset hosting (the hasu-web-reader-assets GCS bucket / Cloud Run signer)
 * and subpath-aware URL resolution (e.g. `/hasu-web-reader/` on GitHub Pages).
 *
 * Scenario data refers to assets as `/assets/<path>` (the local public/assets cache). When
 * VITE_ASSET_BASE_URL is set, any such request whose <path> starts with one of the
 * comma-separated VITE_REMOTE_ASSET_PREFIXES (empty = all assets) is served from
 * `${VITE_ASSET_BASE_URL}/<path>` instead. When VITE_ASSET_BASE_URL is unset and Vite's
 * BASE_URL is a subpath (e.g. `/hasu-web-reader/`), `/assets/<path>` is rewritten under
 * `${BASE_URL}assets/<path>`.
 */
const BASE = String(import.meta.env.VITE_ASSET_BASE_URL ?? "").replace(/\/+$/, "");
const APP_BASE = String(import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
const PREFIXES = String(import.meta.env.VITE_REMOTE_ASSET_PREFIXES ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

/** Resolve a file under `public/data/` respecting Vite's `base` subpath. */
export function dataUrl(relPath: string): string {
  return `${APP_BASE}data/${relPath.replace(/^\/+/, "")}`;
}

function extractAssetRelPath(url: string): string | null {
  if (url.startsWith("/assets/")) {
    return url.slice("/assets/".length);
  }
  if (APP_BASE !== "/" && url.startsWith(`${APP_BASE}assets/`)) {
    return url.slice(`${APP_BASE}assets/`.length);
  }
  try {
    const u = new URL(url, window.location.href);
    if (u.origin === window.location.origin) {
      if (u.pathname.startsWith("/assets/")) {
        return u.pathname.slice("/assets/".length) + u.search;
      }
      if (APP_BASE !== "/" && u.pathname.startsWith(`${APP_BASE}assets/`)) {
        return u.pathname.slice(`${APP_BASE}assets/`.length) + u.search;
      }
    }
  } catch {
    // not a URL we handle
  }
  return null;
}

function matchesPrefix(relPath: string): boolean {
  if (PREFIXES.length === 0) return true;
  const withSlash = relPath.endsWith("/") ? relPath : `${relPath}/`;
  return PREFIXES.some((p) => {
    const norm = p.endsWith("/") ? p : `${p}/`;
    return relPath.startsWith(p) || withSlash.startsWith(norm);
  });
}

export function assetUrl(url: string): string {
  const path = extractAssetRelPath(url);
  if (path === null) return url;
  if (BASE && matchesPrefix(path)) {
    return `${BASE}/${path}`;
  }
  if (APP_BASE !== "/" && url.startsWith("/assets/")) {
    return `${APP_BASE}assets/${path}`;
  }
  return url;
}

/**
 * Rewrite every "/assets/..." string inside loaded scenario/catalog data to its resolved URL,
 * so all consumers (audio elements, <img>, prefetch, Three.js) pick up remote or subpath hosting
 * without each call site knowing about it.
 */
export function rewriteAssetUrls<T>(data: T): T {
  if (!BASE && APP_BASE === "/") return data;
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
  if (!BASE && APP_BASE === "/") return;
  THREE.DefaultLoadingManager.setURLModifier(assetUrl);
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(typeof input === "string" ? assetUrl(input) : input, init);
  if (BASE) {
    console.info(
      `[assets] ${PREFIXES.length ? PREFIXES.map((p) => `/assets/${p}*`).join(", ") : "all /assets/*"} -> ${BASE}`
    );
  }
}
