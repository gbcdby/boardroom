import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { cpSync, existsSync, mkdirSync } from "node:fs";

/**
 * 构建后把 br-collab v2 原型的 10 张 PNG 拷进产物，供 /prototype 对照台并排显示。
 * 源图在 docs/prototypes（git 跟踪），dist 是构建产物、每次 build 会清空，所以随构建拷贝。
 */
function copyPrototypeImages(): Plugin {
  return {
    name: "copy-prototype-images",
    closeBundle() {
      const src = path.resolve(import.meta.dirname, "../../docs/prototypes/br-collab-20261112-v2");
      const out = path.resolve(import.meta.dirname, "../../dist/web/prototypes");
      if (!existsSync(src)) return;
      mkdirSync(out, { recursive: true });
      for (const theme of ["light", "dark"]) {
        const from = path.join(src, theme);
        if (existsSync(from)) cpSync(from, path.join(out, theme), { recursive: true });
      }
    },
  };
}

/**
 * WebUI 构建配置。
 *
 * 产物固定输出到仓库根 `dist/web`，由 `src/server/static.ts` 直接服务；
 * 开发时可用 `npm run dev:web`（Vite dev server，代理 /api 与 /ws 到后端）。
 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue(), copyPrototypeImages()],
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
