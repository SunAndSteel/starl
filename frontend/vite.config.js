import { defineConfig } from "vite";

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const devHost = process.env.FRONTEND_HOST || "127.0.0.1";
const devPort = parsePort(process.env.FRONTEND_PORT, 4173);

export default defineConfig({
  server: {
    host: devHost,
    port: devPort,
    strictPort: false,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8000",
        ws: true,
      },
      "/api": {
        target: "http://127.0.0.1:8000",
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
