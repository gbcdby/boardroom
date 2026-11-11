import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDbDriver } from "../src/server/db/driver.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { migrations } from "../src/server/db/migrations/index.ts";

test("真实 stdio 启动共用记忆 reader；stdin EOF 等待资源退出且不创建 session-end 请求", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-stdio-"));
  const db = createDbDriver({ dataDir: dir });
  await db.connect(); await db.migrate(migrations);
  const repos = createRepositories(db);
  const project = await repos.projects.create({ name: "stdio 生命周期" });
  const group = await repos.groups.create({ projectId: project.id, name: "协议群" });
  const child = spawn(process.execPath, [path.resolve("src/server/mcp/stdio.ts")], {
    cwd: dir, env: { PATH: process.env["PATH"], AGENT_STUDIO_DATA_DIR: dir, AGENT_STUDIO_DB_DRIVER: "sqlite", AGENT_STUDIO_LOG_LEVEL: "warn" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  let text = "", stderr = "", nextId = 0;
  const responses = new Map<number, (value: any) => void>();
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.stdout.on("data", chunk => {
    text += chunk.toString();
    let at: number;
    while ((at = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, at); text = text.slice(at + 1);
      const message = JSON.parse(line);
      if (message.id !== undefined) { responses.get(message.id)?.(message); responses.delete(message.id); }
    }
  });
  async function call(method: string, params: unknown): Promise<any> {
    const id = ++nextId;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { responses.delete(id); reject(new Error(`stdio ${method} response timed out: ${stderr}`)); }, 5000);
      responses.set(id, value => { clearTimeout(timer); resolve(value); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  try {
    const init = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-lifecycle-fixture", version: "1" } });
    assert.ok(init.result, JSON.stringify(init));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const result = await call("tools/call", { name: "join", arguments: { displayName: "stdio本人", hostType: "other", projectId: project.id, groupId: group.id } });
    const joined = result.result.structuredContent;
    assert.equal(joined.ok, true, JSON.stringify(result));
    assert.equal(joined.context.memory.state, "available");
    child.stdin.end();
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 4000);
    const [code, signal] = await exit;
    clearTimeout(watchdog);
    assert.equal(code, 0, `stdio 未正常关闭: ${signal}; ${stderr}`);
    assert.equal(signal, null);
    assert.equal((await repos.mcpSessions.listByProject(project.id))[0]?.state, "disconnected");
    assert.deepEqual(await repos.memory.listRequests(project.id, joined.agentId), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; }
    await db.close(); await rm(dir, { recursive: true, force: true });
  }
});
