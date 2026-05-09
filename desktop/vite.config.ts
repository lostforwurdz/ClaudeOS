import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  // Packaged Electron loads the renderer via `file://`, so `<script src="/assets/...">`
  // resolves to filesystem root and 404s. Use relative paths so both dev (served
  // from /) and production (file:// or relative) load correctly. Discovered while
  // wiring up the E2E suite (kobramaz-ajr.5).
  base: "./",
  build: {
    outDir: "out/renderer",
    emptyOutDir: true,
  },
  server: {
    // Bind explicitly to 127.0.0.1 (not Vite's default `localhost` which can
    // resolve to ::1 first). The api-server listens only on 127.0.0.1, and
    // Chromium's network stack treats `localhost` vs `127.0.0.1` as separate
    // origins for some checks — keeping both on 127.0.0.1 avoids it.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
