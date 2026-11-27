import assert from "node:assert/strict";
import {
  checkRequestOrigin,
  createSignerHandler,
  encodeGcsPath,
  prepareV4SignInput,
  validateObjectPath,
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

// 1. Path validation & prefix allowlist
assert.deepEqual(validateObjectPath("/3d/costume/foo/foo.glb"), {
  ok: true,
  key: "3d/costume/foo/foo.glb",
});
assert.deepEqual(
  validateObjectPath("/story/voice/vo_adv_10300101_0001_m1031_01%40kaho.webm"),
  {
    ok: true,
    key: "story/voice/vo_adv_10300101_0001_m1031_01@kaho.webm",
  }
);
assert.equal(validateObjectPath("/dump/llll-assets-raw.7z").status, 403);
assert.equal(validateObjectPath("/tools/foo").status, 403);
assert.equal(validateObjectPath("/3d/../dump/x").status, 400);
assert.equal(validateObjectPath("/3d//motions/a.glb").status, 400);
assert.equal(validateObjectPath("/").status, 404);

// 2. Origin / Referer enforcement
assert.equal(checkRequestOrigin({ origin: "https://mting314.github.io" }), true);
assert.equal(
  checkRequestOrigin({ referer: "https://mting314.github.io/hasu-web-reader/?story=103-ep1-part1" }),
  true
);
assert.equal(checkRequestOrigin({ origin: "http://localhost:5173" }), true);
assert.equal(checkRequestOrigin({ origin: "https://evil.example.com" }), false);
assert.equal(
  checkRequestOrigin({
    origin: "https://evil.example.com",
    referer: "https://mting314.github.io/hasu-web-reader/",
  }),
  false
);
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
assert.match(v4.canonicalQuery, /^X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=/);
assert.match(
  v4.stringToSign,
  /^GOOG4-RSA-SHA256\n20261127T040000Z\n20261127\/auto\/storage\/goog4_request\n[0-9a-f]{64}$/
);

// 4. Handler coalescing, method separation, CORS headers, and security rejections
let signCalls = 0;
const handler = createSignerHandler({
  signUrl: async ({ bucket, objectKey, method }) => {
    signCalls++;
    await new Promise((r) => setTimeout(r, 15));
    return `https://storage.googleapis.com/${bucket}/${objectKey}?method=${method}&call=${signCalls}`;
  },
});

const health = await invoke(handler, { url: "/healthz" });
assert.equal(health.status, 200);

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
assert.equal(r1.headers["access-control-allow-origin"], "*");
assert.equal(
  r1.headers["location"],
  "https://storage.googleapis.com/hasu-web-reader-assets/3d/motions/mot_00_00010.glb?method=GET&call=1"
);

const headRes = await invoke(handler, {
  method: "HEAD",
  url: "/3d/motions/mot_00_00010.glb",
  headers: { origin: "https://mting314.github.io" },
});
assert.equal(headRes.status, 302);
assert.equal(signCalls, 2);

const badOrigin = await invoke(handler, {
  url: "/3d/motions/mot_00_00010.glb",
  headers: { origin: "https://attacker.invalid" },
});
assert.equal(badOrigin.status, 403);

const dumpReq = await invoke(handler, {
  url: "/dump/llll-assets-raw.7z",
  headers: { origin: "https://mting314.github.io" },
});
assert.equal(dumpReq.status, 403);

console.log("All asset-signer tests passed.");
