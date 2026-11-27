import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ command, mode }) => {
  const fileEnv = loadEnv(mode, ROOT, "");
  const basePath = process.env.VITE_BASE_PATH || fileEnv.VITE_BASE_PATH || "/";
  const assetBaseUrl = process.env.VITE_ASSET_BASE_URL ?? fileEnv.VITE_ASSET_BASE_URL ?? "";
  const remotePrefixes =
    process.env.VITE_REMOTE_ASSET_PREFIXES ?? fileEnv.VITE_REMOTE_ASSET_PREFIXES ?? "";

  const remoteAllAssets =
    command === "build" && Boolean(assetBaseUrl.trim()) && !remotePrefixes.trim();

  let outDirAbs = resolve(ROOT, "dist");

  return {
    base: basePath,
    // When all /assets/* come from VITE_ASSET_BASE_URL, skip copying the multi-GB local
    // public/assets/ cache into dist/ and copy only public/data/.
    publicDir: remoteAllAssets ? false : "public",
    plugins: [
      react(),
      remoteAllAssets && {
        name: "copy-public-data-only",
        configResolved(cfg) {
          outDirAbs = resolve(cfg.root, cfg.build.outDir);
        },
        closeBundle() {
          const srcData = resolve(ROOT, "public/data");
          if (existsSync(srcData)) {
            cpSync(srcData, resolve(outDirAbs, "data"), { recursive: true });
          }
        },
      },
    ],
    build: {
      assetsDir: "static",
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          study: fileURLToPath(new URL("./study.html", import.meta.url)),
          live: fileURLToPath(new URL("./live.html", import.meta.url)),
        },
      },
    },
    server: {
      port: 5173,
      host: true,
      watch: {
        ignored: ["**/.inspect-tmp/**", "**/data-inspect/**", "**/data_cache/**"],
      },
    },
  };
});
