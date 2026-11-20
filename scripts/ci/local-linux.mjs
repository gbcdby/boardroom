#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
if (!args.length) {
  console.error("用法: npm run ci:local:linux -- tests/foo.test.ts [--test-name-pattern=...]");
  process.exit(2);
}
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const options = args.filter(arg => arg.startsWith("--")).map(quote);
const files = args.filter(arg => !arg.startsWith("--")).map(quote);
const inner = `cp -a /src/. /workspace && npm ci >/dev/null && node scripts/build-maintenance-platform.mjs --source-files && node --test --test-reporter=spec ${options.join(" ")} ${files.join(" ")}`;
const result = spawnSync("docker", ["run", "--rm", "--shm-size=1g", "-v", `${root}:/src:ro`, "-w", "/workspace",
  "node:24.22.3-bookworm", "bash", "-lc", inner], { cwd: root, stdio: "inherit" });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
