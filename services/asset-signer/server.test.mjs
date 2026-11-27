import assert from "node:assert/strict";
import {
  checkRequestOrigin,
  createSignerHandler,
  encodeGcsPath,
  extractAuthAndPathname,
  prepareV4SignInput,
  validateObjectPath,
  verifyDevKey,
} from "./server.mjs";

function invoke(handler, { method = "GET", url = "/", headers = {} } = {}) {
  let statusCode = 200;
  let responseHeaders = {};
  let body = "";
  const req = { method, url, headers };
  const res = {
    writeHead(code, hdrs = {}) {
      statusCode = code;
      responseHeaders = Object.fromEntries(
        Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), String(v)])
      );
    },
    end(chunk = "") {
      body += chunk;
    },
  };
  return handler(req, res).then(() => ({ status: statusCode, headers: responseHeaders, body }));
}

// 1. Path validation & prefix allowlist vs protected prefixes
assert.deepEqual(validateObjectPath("/3d/costume/foo/foo.glb"), {
  ok: true,
  key: "3d/costume/foo/foo.glb",
  protected: false,
});
assert.deepEqual(validateObjectPath("/pjsk/models.json"), {
  ok: true,
  key: "pjsk/models.json",
  protected: true,
});
assert.deepEqual(extractAuthAndPathname("/_k/my-secret/pjsk/3d/model/01ichika/01ichika.glb"), {
  providedKey: "my-secret",
  cleanPathname: "/pjsk/3d/model/01ichika/01ichika.glb",
});
assert.equal(verifyDevKey("abc123", "abc123"), true);
assert.equal(verifyDevKey("abc124", "abc123"), false);
assert.equal(verifyDevKey("", "abc123"), false);
assert.equal(validateObjectPath("/dump/llll-assets-raw.7z").status, 403);
assert.equal(validateObjectPath("/3d/../dump/x").status, 400);
assert.equal(validateObjectPath("/").status, 404);

// 2. Origin / Referer enforcement
assert.equal(checkRequestOrigin({ origin: "https://mting314.github.io" }), true);
assert.equal(
  checkRequestOrigin({ referer: "https://mting314.github.io/hasu-web-reader/?story=103-ep1-part1" }),
  true
);
assert.equal(checkRequestOrigin({ origin: "http://localhost:5173" }), true);
assert.equal(checkRequestOrigin({ origin: "https://evil.example.com" }), false);
assert.equal(checkRequestOrigin({}), false);

// 3. RFC 3986 path encoding & V4 canonical signing input
assert.equal(
  encodeGcsPath("story/voice/vo_adv_10300101_0001_m1031_01@kaho.webm"),
  "story/voice/vo_adv_10300101_0001_m1031_01%40kaho.webm"
);
const v4 = prepareV4SignInput({
  bucket: "hasu-web-reader-assets",
  objectKey: "3d/emotions/emotion_kaho.json",
  method: "GET",
  serviceAccountEmail: "signer@future-name-201021.iam.gserviceaccount.com",
  now: new Date("2026-11-27T04:00:00Z"),
  expiresSec: 3600,
});
assert.equal(v4.resourcePath, "/hasu-web-reader-assets/3d/emotions/emotion_kaho.json");

// 4. Handler coalescing, protected pjsk/ dev-key enforcement, and security rejections
let signCalls = 0;
const handler = createSignerHandler({
  devAccessKey: "super-secret-dev-key",
  signUrl: async ({ bucket, objectKey, method }) => {
    signCalls++;
    await new Promise((r) => setTimeout(r, 10));
    return `https://storage.googleapis.com/${bucket}/${objectKey}?method=${method}&call=${signCalls}`;
  },
});

const [r1, r2] = await Promise.all([
  invoke(handler, {
    url: "/3d/motions/mot_00_00010.glb",
    headers: { origin: "https://mting314.github.io" },
  }),
  invoke(handler, {
    url: "/3d/motions/mot_00_00010.glb",
    headers: { referer: "https://mting314.github.io/hasu-web-reader/" },
  }),
]);
assert.equal(r1.status, 302);
assert.equal(r2.status, 302);
assert.equal(signCalls, 1);

// Protected pjsk/ blocked without key or with wrong key
const pjskNoKey = await invoke(handler, {
  url: "/pjsk/models.json",
  headers: { origin: "https://mting314.github.io" },
});
assert.equal(pjskNoKey.status, 403);

const pjskWrongKey = await invoke(handler, {
  url: "/_k/wrong-key/pjsk/models.json",
  headers: { origin: "https://mting314.github.io" },
});
assert.equal(pjskWrongKey.status, 403);

// Protected pjsk/ allowed with valid /_k/<key>/ and strips /_k/<key> from signed GCS path
const pjskValidKey = await invoke(handler, {
  url: "/_k/super-secret-dev-key/pjsk/models.json",
  headers: { origin: "https://mting314.github.io" },
});
assert.equal(pjskValidKey.status, 302);
assert.equal(
  pjskValidKey.headers["location"],
  "https://storage.googleapis.com/hasu-web-reader-assets/pjsk/models.json?method=GET&call=2"
);

// Disallowed prefix still blocked even with valid dev key
const dumpWithKey = await invoke(handler, {
  url: "/_k/super-secret-dev-key/dump/llll-assets-raw.7z",
  headers: { origin: "https://mting314.github.io" },
});
assert.equal(dumpWithKey.status, 403);

console.log("All asset-signer tests passed.");
