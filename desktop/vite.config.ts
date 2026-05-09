import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
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
