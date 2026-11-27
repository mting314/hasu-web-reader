import * as THREE from "three";

/**
 * Optional remote asset hosting (the hasu-web-reader-assets GCS bucket / Cloud Run signer)
 * and subpath-aware URL resolution (e.g. `/hasu-web-reader/pjsk/` on GitHub Pages).
 *
 * Protected prefixes (`pjsk/`) require a private dev key saved once per browser via
 * `#devKey=<secret>` (or `?devKey=<secret>`, immediately stripped from the URL bar and stored
 * in `localStorage["hasu-reader.devKey"]`; `#devKey=clear` removes it).
 */
const BASE = String(import.meta.env.VITE_ASSET_BASE_URL ?? "").replace(/\/+$/, "");
const APP_BASE = String(import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
const PREFIXES = String(import.meta.env.VITE_REMOTE_ASSET_PREFIXES ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const PROTECTED_PREFIXES = ["pjsk/"];
const DEV_KEY_STORAGE = "hasu-reader.devKey";

function consumeDevKeyFromUrl(reloadOnChange = false): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const raw = hashParams.get("devKey") ?? url.searchParams.get("devKey");
    if (raw === null) return;
    if (raw === "" || raw === "clear" || raw === "off") {
      localStorage.removeItem(DEV_KEY_STORAGE);
    } else {
      localStorage.setItem(DEV_KEY_STORAGE, raw.trim());
    }
    url.searchParams.delete("devKey");
    if (hashParams.has("devKey")) {
      hashParams.delete("devKey");
      const nextHash = hashParams.toString();
      url.hash = nextHash ? `#${nextHash}` : "";
    }
    window.history.replaceState(null, "", url.toString());
    if (reloadOnChange) window.location.reload();
  } catch {
    // ignore storage / URL errors
  }
}

consumeDevKeyFromUrl(false);
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => consumeDevKeyFromUrl(true));
}

function getDevKey(): string {
  try {
    const fromEnv = String(import.meta.env.VITE_DEV_ACCESS_KEY ?? "").trim();
    if (fromEnv) return fromEnv;
    return (localStorage.getItem(DEV_KEY_STORAGE) ?? "").trim();
  } catch {
    return "";
  }
}

/** True when protected dev-only asset prefixes (`pjsk/`) can be loaded in this session. */
export function hasDevKey(): boolean {
  return !BASE || Boolean(getDevKey());
}

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

function matchesPrefixList(relPath: string, list: string[]): boolean {
  const withSlash = relPath.endsWith("/") ? relPath : `${relPath}/`;
  return list.some((p) => {
    const norm = p.endsWith("/") ? p : `${p}/`;
    return relPath.startsWith(p) || withSlash.startsWith(norm);
  });
}

function matchesPrefix(relPath: string): boolean {
  if (PREFIXES.length === 0) return true;
  return matchesPrefixList(relPath, PREFIXES);
}

export function assetUrl(url: string): string {
  const path = extractAssetRelPath(url);
  if (path === null) return url;
  if (BASE && matchesPrefix(path)) {
    if (matchesPrefixList(path, PROTECTED_PREFIXES)) {
      const dk = getDevKey();
      return dk ? `${BASE}/_k/${encodeURIComponent(dk)}/${path}` : `${BASE}/${path}`;
    }
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
  consumeDevKeyFromUrl(false);
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
