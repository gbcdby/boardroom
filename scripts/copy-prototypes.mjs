#!/usr/bin/env node
/** 将 br-collab v2 原型的 10 张 PNG 拷入 dist/web/prototypes，供 /prototype split view 并排对照。
 *  dist 是构建产物、被 git 忽略；npm run build:web 会清空它，所以每次构建后需重跑本脚本。
 *  用法：node scripts/copy-prototypes.mjs */
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = path.join(root, "docs/prototypes/br-collab-20261112-v2");
const dst = path.join(root, "dist/web/prototypes");
for (const theme of ["light", "dark"]) {
  mkdirSync(path.join(dst, theme), { recursive: true });
  cpSync(path.join(src, theme), path.join(dst, theme), { recursive: true });
}
console.log(`原型图已拷入 ${dst}（light/dark 各 5 张）`);
