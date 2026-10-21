import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

/**
 * WebUI 构建配置。
 *
 * 产物固定输出到仓库根 `dist/web`，由 `src/server/static.ts` 直接服务；
 * 开发时可用 `npm run dev:web`（Vite dev server，代理 /api 与 /ws 到后端）。
 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  build: {
    outDir: path.resolve(import.meta.dirname, "../../dist/web"),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/ws": { target: "ws://127.0.0.1:4317", ws: true },
    },
  },
});
