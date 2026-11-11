import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const stdioEntry = path.join(root, "src/server/mcp/stdio.ts");

function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("AGENT_STUDIO_") || name === "BOARDROOM_HOME" || name === "NODE_OPTIONS") delete env[name];
  return { ...env, ...extra };
}

test("S4-AC01: stdio 显式缺失配置在 connect/migrate/建目录前失败", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-entry-"));
  try {
    const trace = path.join(dir, "trace.mjs");
    await writeFile(trace, `import { writeSync } from 'node:fs';
import { SqliteDriver } from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/db/drivers/sqlite.ts")).href)};
for (const method of ['connect', 'migrate']) {
  const original = SqliteDriver.prototype[method];
  SqliteDriver.prototype[method] = function(...args) { writeSync(3, method + '\\n'); return original.apply(this, args); };
}`);
    const before = await readdir(dir);
    const result = spawnSync(process.execPath, ["--import", trace, stdioEntry], {
      cwd: dir, env: cleanEnv({ BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: path.join(dir, "missing.json") }),
      input: "", encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    assert.equal(result.error, undefined);
    assert.deepEqual({ code: result.status, stdout: result.stdout, calls: result.output[3], files: await readdir(dir) },
      { code: 1, stdout: "", calls: "", files: before });
    assert.match(result.stderr, /config_invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
