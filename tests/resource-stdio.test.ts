import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createResourceReconciliation, type ResourceBrowser } from "../src/web/src/composables/useResourceReconciliation.ts";
import { acceptsTaskDetail, readTaskDetail, type TaskDetailResource } from "../src/web/src/api/task-resources.ts";

async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeout) throw new Error(`等待对账超过 ${timeout}ms`);
    await delay(20);
  }
}

test("真实独立 stdio 同库写入由15秒条件读取兑现；掉包/真实WS重连与可见性边界恢复不消费 WorkEvent", { timeout: 35000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-resource-stdio-")), dataDir = path.join(directory, "data");
  const server = await startServer({ config: { port: 0, dataDir, configFile: null, heartbeat: { intervalMs: 1000, timeoutMs: 10000 } }, logger: createLogger({ write: () => {} }) });
  const client = new Client({ name: "resource-stdio-contract", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(import.meta.dirname, "../src/server/mcp/stdio.ts")], cwd: directory, stderr: "pipe",
    env: { ...(process.env["PATH"] ? { PATH: process.env["PATH"] } : {}), AGENT_STUDIO_DATA_DIR: dataDir, AGENT_STUDIO_DB_DRIVER: "sqlite", BOARDROOM_HOME: path.join(directory, "home"), AGENT_STUDIO_LOG_LEVEL: "error" } });
  let resource: ReturnType<typeof createResourceReconciliation<TaskDetailResource, { projectId: string; key: string; taskId: string }>> | undefined;
  let visible = true, onVisibility = () => {}, drop = false, polls = 0, requests = 0;
  const sockets: WebSocket[] = [], frames: Record<string, unknown>[] = [];
  const browser: ResourceBrowser = {
    isVisible: () => visible, onVisibility(listener) { onVisibility = listener; return () => { onVisibility = () => {}; }; },
    interval(callback, ms) { assert.equal(ms, 15000); polls++; const timer = setInterval(callback, ms); return () => { polls--; clearInterval(timer); }; },
    timeout(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    connect(handlers) {
      const socket = new WebSocket(server.wsUrl); sockets.push(socket);
      socket.addEventListener("open", handlers.open);
      socket.addEventListener("message", event => { const raw = String(event.data), frame = JSON.parse(raw); frames.push(frame); if (!drop || frame.type !== "resource.changed") handlers.message(raw); });
      socket.addEventListener("close", handlers.close); socket.addEventListener("error", handlers.error);
      return { send: data => socket.send(data), close: () => socket.close() };
    },
  };
  try {
    const repos = createRepositories(server.database), project = await repos.projects.create({ name: "跨进程对账" });
    const group = await repos.groups.create({ projectId: project.id, name: "同库独立进程" });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    async function call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result));
      const content = JSON.parse((result.content as Array<{ type: string; text: string }>).find(item => item.type === "text")!.text);
      assert.equal(content.ok, true, JSON.stringify(content)); return content;
    }
    const joined = await call("join", { displayName: "独立stdio统筹", hostType: "other", projectId: project.id, groupId: group.id, role: "manager" });
    const collection = `/api/projects/${project.id}/tasks`;
    const create = await fetch(server.url + collection, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "初始快照", assigneeMemberId: joined.memberId, reviewerMemberId: null }) });
    assert.equal(create.status, 201); const task = (await create.json() as any).task;
    resource = createResourceReconciliation({ browser, accepts: acceptsTaskDetail,
      fetch: (url, init) => { requests++; return fetch(server.url + String(url), init); },
      read: (scope: { projectId: string; key: string; taskId: string }, reader) => readTaskDetail(reader, scope.projectId, scope.taskId),
    });
    await resource.setScope({ projectId: project.id, taskId: task.id, key: `${project.id}:${task.id}:1` });
    await until(() => resource!.connection.value === "connected" && !resource!.loading.value);
    assert.equal(resource.value.value!.detail.task.title, "初始快照");
    const hintCount = frames.filter(frame => frame.type === "resource.changed").length;
    const writtenAt = performance.now();
    const updated = await call("update_task", { taskId: task.id, expectedRevision: 1, title: "独立stdio已提交" });
    assert.equal(updated.task.revision, 2);
    assert.equal(frames.filter(frame => frame.type === "resource.changed").length, hintCount, "独立进程不共享 HTTP driver listener");
    await until(() => resource!.value.value?.detail.task.title === "独立stdio已提交", 20000);
    t.diagnostic(`独立 stdio 提交至真实15秒兜底读取完成：${Math.round(performance.now() - writtenAt)}ms；未借用跨进程 WS`);
    assert.equal(frames.filter(frame => frame.type === "resource.changed").length, hintCount);

    drop = true;
    async function update(revision: number, title: string) {
      const response = await fetch(server.url + `${collection}/${task.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: revision, title }) });
      assert.equal(response.status, 200); return (await response.json() as any).task;
    }
    await update(2, "被丢弃提示的更新");
    await until(() => frames.filter(frame => frame.type === "resource.changed").length > hintCount);
    assert.equal(resource.value.value!.detail.task.revision, 2);
    const lastRead = resource.lastSuccessAt.value;
    sockets.at(-1)!.close(); await until(() => resource!.connection.value === "disconnected");
    assert.equal(resource.lastSuccessAt.value, lastRead); assert.equal(resource.value.value!.detail.task.revision, 2);
    drop = false;
    await until(() => resource!.connection.value === "connected" && resource!.value.value!.detail.task.revision === 3, 5000);

    visible = false; onVisibility(); assert.equal(polls, 0);
    const beforeHidden = requests;
    const beforeHint = frames.filter(frame => frame.type === "resource.changed").length;
    await update(3, "隐藏期间的新版本");
    await until(() => frames.filter(frame => frame.type === "resource.changed").length > beforeHint);
    assert.equal(requests, beforeHidden); assert.equal(resource.value.value!.detail.task.revision, 3);
    visible = true; onVisibility(); assert.equal(polls, 1);
    await until(() => resource!.value.value!.detail.task.revision === 4);
    const receipts = await repos.context.query<{ acked_at: string | null }>("SELECT acked_at FROM work_events WHERE task_id = ?", [task.id]);
    assert.equal(receipts.length, 1); assert.equal(receipts[0]!.acked_at, null);
  } finally {
    resource?.dispose(); await client.close(); await transport.close(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});
