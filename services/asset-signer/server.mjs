import { createHash } from "node:crypto";
import http from "node:http";

/**
 * Cloud Run GCS V4 Signed-URL Redirect Service for hasu-web-reader.
 *
 * Validates Origin/Referer and object path prefix, signs a short-lived GCS V4 URL via the
 * keyless IAM Credentials `signBlob` API (cached in memory per instance), and 302-redirects
 * the browser directly to `https://storage.googleapis.com/<bucket>/<path>?X-Goog-...`.
 */

const PORT = Number(process.env.PORT || 8080);
const BUCKET = process.env.BUCKET_NAME || "hasu-web-reader-assets";
const SIGN_EXPIRES_SEC = Number(process.env.SIGN_EXPIRES_SEC || 3600); // 60 min signature
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 2700_000); // 45 min server cache
const BROWSER_MAX_AGE_SEC = Number(process.env.BROWSER_MAX_AGE_SEC || 900); // 15 min browser cache
const MAX_CACHE_ENTRIES = 20_000;

const DEFAULT_PREFIXES = ["3d/", "assets/", "bgm/", "live/", "pjsk/", "sound/", "story/"];
const DEFAULT_HOSTS = ["mting314.github.io", "localhost", "127.0.0.1"];

export function parseCsv(raw, fallback) {
  if (!raw || !raw.trim()) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** RFC 3986 percent-encoding required by GCS V4 canonical request. */
export function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function encodeGcsPath(objectPath) {
  return objectPath.split("/").map(encodeRfc3986).join("/");
}

export function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function formatGoogDate(date) {
  const iso = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return { timestamp: iso, datestamp: iso.slice(0, 8) };
}

/**
 * Validate and normalize the URL pathname into a safe bucket-relative object key.
 * Returns `{ ok: true, key }` or `{ ok: false, status, reason }`.
 */
export function validateObjectPath(pathname, allowedPrefixes = DEFAULT_PREFIXES) {
  if (!pathname || pathname === "/") {
    return { ok: false, status: 404, reason: "empty path" };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, status: 400, reason: "malformed URI encoding" };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return { ok: false, status: 400, reason: "invalid path character" };
  }
  const key = decoded.replace(/^\/+/, "");
  if (!key || key.endsWith("/") || key.includes("//")) {
    return { ok: false, status: 400, reason: "invalid object key" };
  }
  const segments = key.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === "..")) {
    return { ok: false, status: 400, reason: "path traversal rejected" };
  }
  if (!allowedPrefixes.some((prefix) => key.startsWith(prefix))) {
    return { ok: false, status: 403, reason: "prefix not allowed" };
  }
  return { ok: true, key };
}

function extractHostname(headerVal) {
  if (!headerVal || headerVal === "null") return null;
  try {
    return new URL(headerVal).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Enforce that browser requests originate from an allowed host via Origin or Referer.
 */
export function checkRequestOrigin(headers, allowedHosts = DEFAULT_HOSTS) {
  const hostSet = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const origin = headers.origin;
  if (origin) {
    const h = extractHostname(origin);
    return Boolean(h && hostSet.has(h));
  }
  const referer = headers.referer;
  if (referer) {
    const h = extractHostname(referer);
    return Boolean(h && hostSet.has(h));
  }
  return false;
}

/**
 * Build the GCS V4 canonical request, string-to-sign, and unsigned query string.
 */
export function prepareV4SignInput({ bucket, objectKey, method, serviceAccountEmail, now, expiresSec }) {
  const { timestamp, datestamp } = formatGoogDate(now);
  const credentialScope = `${datestamp}/auto/storage/goog4_request`;
  const credential = `${serviceAccountEmail}/${credentialScope}`;
  const resourcePath = `/${encodeRfc3986(bucket)}/${encodeGcsPath(objectKey)}`;

  const queryEntries = [
    ["X-Goog-Algorithm", "GOOG4-RSA-SHA256"],
    ["X-Goog-Credential", credential],
    ["X-Goog-Date", timestamp],
    ["X-Goog-Expires", String(expiresSec)],
    ["X-Goog-SignedHeaders", "host"],
  ];
  const canonicalQuery = queryEntries
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join("&");

  const canonicalRequest = [
    method,
    resourcePath,
    canonicalQuery,
    "host:storage.googleapis.com\n",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "GOOG4-RSA-SHA256",
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  return {
    resourcePath,
    canonicalQuery,
    canonicalRequest,
    stringToSign,
  };
}

/**
 * Default GCP Cloud Run signer using Metadata Server + IAM Credentials `signBlob`.
 */
export function createIamBlobSigner({
  serviceAccountEmail = process.env.SERVICE_ACCOUNT_EMAIL || "",
  fetchImpl = globalThis.fetch,
} = {}) {
  let cachedEmail = serviceAccountEmail;
  let cachedToken = "";
  let tokenExpiresAt = 0;
  let inflightToken = null;

  async function getEmail() {
    if (cachedEmail) return cachedEmail;
    const res = await fetchImpl(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
      { headers: { "Metadata-Flavor": "Google" } }
    );
    if (!res.ok) throw new Error(`metadata email HTTP ${res.status}`);
    cachedEmail = (await res.text()).trim();
    return cachedEmail;
  }

  async function getAccessToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpiresAt) return cachedToken;
    if (!inflightToken) {
      inflightToken = (async () => {
        const res = await fetchImpl(
          "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
          { headers: { "Metadata-Flavor": "Google" } }
        );
        if (!res.ok) throw new Error(`metadata token HTTP ${res.status}`);
        const data = await res.json();
        cachedToken = data.access_token;
        const ttlSec = Math.max(60, Number(data.expires_in || 3600) - 300);
        tokenExpiresAt = Date.now() + ttlSec * 1000;
        return cachedToken;
      })().finally(() => {
        inflightToken = null;
      });
    }
    return inflightToken;
  }

  return async function signUrl({ bucket, objectKey, method, now = new Date(), expiresSec = SIGN_EXPIRES_SEC }) {
    const [email, token] = await Promise.all([getEmail(), getAccessToken()]);
    const { resourcePath, canonicalQuery, stringToSign } = prepareV4SignInput({
      bucket,
      objectKey,
      method,
      serviceAccountEmail: email,
      now,
      expiresSec,
    });
    const iamUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(
      email
    )}:signBlob`;
    const res = await fetchImpl(iamUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payload: Buffer.from(stringToSign, "utf8").toString("base64"),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`iam signBlob HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const { signedBlob } = await res.json();
    const sigHex = Buffer.from(signedBlob, "base64").toString("hex");
    return `https://storage.googleapis.com${resourcePath}?${canonicalQuery}&X-Goog-Signature=${sigHex}`;
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Max-Age": "3600",
};

export function createSignerHandler({
  bucket = BUCKET,
  allowedPrefixes = parseCsv(process.env.ALLOWED_PREFIXES, DEFAULT_PREFIXES),
  allowedHosts = parseCsv(process.env.ALLOWED_HOSTS, DEFAULT_HOSTS),
  signUrl = createIamBlobSigner(),
  cacheTtlMs = CACHE_TTL_MS,
  browserMaxAgeSec = BROWSER_MAX_AGE_SEC,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function getCachedSignedUrl(method, objectKey) {
    const cacheKey = `${method}:${objectKey}`;
    const nowMs = Date.now();
    const hit = cache.get(cacheKey);
    if (hit && nowMs < hit.expiresAt) {
      return hit.url;
    }
    if (hit) cache.delete(cacheKey);

    let pending = inflight.get(cacheKey);
    if (!pending) {
      pending = signUrl({ bucket, objectKey, method })
        .then((url) => {
          if (cache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey !== undefined) cache.delete(oldestKey);
          }
          cache.set(cacheKey, { url, expiresAt: Date.now() + cacheTtlMs });
          return url;
        })
        .finally(() => {
          inflight.delete(cacheKey);
        });
      inflight.set(cacheKey, pending);
    }
    return pending;
  }

  return async function handler(req, res) {
    const rawUrl = req.url || "/";
    const qIdx = rawUrl.indexOf("?");
    const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end('{"ok":true}');
      return;
    }

    if (req.method === "OPTIONS") {
      if (!checkRequestOrigin(req.headers, allowedHosts)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...CORS_HEADERS, Allow: "GET, HEAD, OPTIONS" });
      res.end();
      return;
    }

    if (!checkRequestOrigin(req.headers, allowedHosts)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden: origin not allowed");
      return;
    }

    const validated = validateObjectPath(pathname, allowedPrefixes);
    if (!validated.ok) {
      res.writeHead(validated.status, {
        ...CORS_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end(validated.reason);
      return;
    }

    try {
      const signed = await getCachedSignedUrl(req.method, validated.key);
      res.writeHead(302, {
        ...CORS_HEADERS,
        Location: signed,
        "Cache-Control": `private, max-age=${browserMaxAgeSec}`,
      });
      res.end();
    } catch (err) {
      console.error("[asset-signer] failed to sign:", validated.key, err);
      res.writeHead(502, {
        ...CORS_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Signing unavailable");
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = http.createServer(createSignerHandler());
  server.listen(PORT, () => {
    console.log(`[asset-signer] listening on :${PORT} for gs://${BUCKET}`);
  });
}
