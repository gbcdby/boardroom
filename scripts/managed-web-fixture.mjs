#!/usr/bin/env node
/** #88/#89：真实 Web 浏览器验收的独立 SQLite 服务；stdin 关闭即清理。 */
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/server/logger.ts";
import { startServer } from "../src/server/server.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { VERIFIED_HOST_PROFILES } from "../src/server/runtime/hosts/types.ts";

const root = await mkdtemp(path.join(tmpdir(), "boardroom-managed-web-"));
const workdir = path.join(root, "workdir");
const webRoot = path.resolve(import.meta.dirname, "../dist/web");
let server;
let closing;

function close(code = 0) {
  closing ??= (async () => {
    try { await server?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  })().then(() => process.exit(code), () => process.exit(1));
  return closing;
}

process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
process.stdin.resume();
process.stdin.on("end", () => { void close(); });

try {
  // 此用例验收未验证宿主的真实产品表现；禁止注入 fake launcher 或冒充真实 CLI 成功。
  if (VERIFIED_HOST_PROFILES.length !== 0) throw new Error("browser_fixture_requires_unverified_production_profiles");
  await access(path.join(webRoot, "index.html"));
  await mkdir(workdir);
  server = await startServer({
    config: { port: 0, dbDriver: "sqlite", dataDir: path.join(root, "data"),
      heartbeat: { intervalMs: 1_000, timeoutMs: 10_000 }, configFile: null },
    logger: createLogger({ write: () => {} }),
    webRoot,
  });
  const repos = createRepositories(server.database);
  const project = await repos.projects.create({ name: "浏览器验收项目" });
  const group = await repos.groups.create({ projectId: project.id, name: "研发验收群" });
  process.stdout.write(`${JSON.stringify({ url: server.url, workdir, projectId: project.id,
    groupId: group.id, verifiedHostProfiles: VERIFIED_HOST_PROFILES.length })}\n`);
} catch (error) {
  process.stderr.write(`managed_web_fixture_failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  await close(1);
}
