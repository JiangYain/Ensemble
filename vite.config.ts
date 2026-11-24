import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./src/web", import.meta.url));
const shared = fileURLToPath(new URL("./src/shared", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/web", import.meta.url));

// 开发时前端走 Vite，API 与 SSE 代理到本地服务（默认端口见 src/shared/constants.ts）。
const servicePort = process.env["ENSEMBLE_PORT"] ?? "47821";

export default defineConfig({
  root,
  base: "/",
  plugins: [react()],
  resolve: {
    alias: { "@shared": shared },
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2023",
    sourcemap: false,
    cssMinify: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${servicePort}`, changeOrigin: true },
    },
  },
});
