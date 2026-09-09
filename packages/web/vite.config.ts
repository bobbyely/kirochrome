import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:4711",
      // ws: true is required — without it the upgrade is not forwarded and the
      // app silently never connects.
      "/ws": { target: "ws://127.0.0.1:4711", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
