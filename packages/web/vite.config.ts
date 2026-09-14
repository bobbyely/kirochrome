import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    // The server's Origin allowlist trusts exactly this port in dev mode. Vite's
    // default is to drift to 5174 when 5173 is busy, which silently puts the
    // page on an origin the API rejects — every request 403s and the console
    // still says 5173. Failing to start is the honest outcome.
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4711",
      // ws: true is required — without it the upgrade is not forwarded and the
      // app silently never connects.
      "/ws": { target: "ws://127.0.0.1:4711", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
