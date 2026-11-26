import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
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
});
