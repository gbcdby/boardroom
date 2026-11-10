#!/usr/bin/env node
/** #88/#89：真实 Web 浏览器验收的独立 SQLite 服务；stdin 关闭即清理。 */
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/server/logger.ts";
import { startServer } from "../src/server/server.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createHostLauncher } from "../src/server/runtime/hosts/launcher.ts";

const root = await mkdtemp(path.join(tmpdir(), "boardroom-managed-web-"));
const workdir = path.join(root, "workdir");
const dataDir = path.join(root, "data");
const missingExecutable = path.join(root, "missing-cli", "claude");
const webRoot = process.env.AGENT_STUDIO_WEBUI_TEST_ROOT
  ? path.resolve(process.env.AGENT_STUDIO_WEBUI_TEST_ROOT)
  : path.resolve(import.meta.dirname, "../dist/web");
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
  // 使用真实生产 launcher 与缺失的受信安装位置，验收拒绝启动；不依赖支持表是否为空。
  try { await access(missingExecutable); throw new Error("browser_fixture_cli_must_be_absent"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  await access(path.join(webRoot, "index.html"));
  await mkdir(workdir);
  server = await startServer({
    config: { port: 0, dbDriver: "sqlite", dataDir,
      heartbeat: { intervalMs: 1_000, timeoutMs: 10_000 }, configFile: null },
    logger: createLogger({ write: () => {} }),
    webRoot,
    runtimeLauncher: createHostLauncher({ stateRoot: path.join(dataDir, "managed"),
      protectedPaths: [path.resolve(import.meta.dirname, ".."), dataDir],
      installations: [{ backend: "claude-code", executable: missingExecutable }] }),
  });
  const repos = createRepositories(server.database);
  const project = await repos.projects.create({ name: "浏览器验收项目" });
  const group = await repos.groups.create({ projectId: project.id, name: "研发验收群" });
  process.stdout.write(`${JSON.stringify({ url: server.url, workdir, projectId: project.id,
    groupId: group.id, hostScenario: "missing-configured-cli" })}\n`);
} catch (error) {
  process.stderr.write(`managed_web_fixture_failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  await close(1);
}
