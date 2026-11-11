import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { registerMemoryRuntime, getMemoryRuntime, closeMemoryRuntime, scheduleMemoryReconciliation } from "../src/server/memory/runtime.ts";
import type { DbDriver } from "../src/server/db/driver.ts";
import { setImmediate as tick } from "node:timers/promises";

test("自动补偿串行并合并同绑定待办，关闭等待真实在途结束且不启动剩余任务", async () => {
  const db = {} as DbDriver;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  scheduleMemoryReconciliation(db, "first", async () => { seen.push("first"); entered(); await gate; });
  await started;
  scheduleMemoryReconciliation(db, "next", async () => { seen.push("superseded"); });
  scheduleMemoryReconciliation(db, "next", async () => { seen.push("next"); });
  await tick();
  assert.deepEqual(seen, ["first"]);
  let closed = false;
  const closing = closeMemoryRuntime(db).then(() => { closed = true; });
  await tick();
  assert.equal(closed, false, "不能把超时返回或关队列冒充在途任务结束");
  release(); await closing;
  assert.deepEqual(seen, ["first"]);
  assert.equal(closed, true);
});

test("DbDriver 共用真实只读 reader，拒绝重复装配，关闭后不再暴露私有记忆", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-runtime-"));
  const db = createDbDriver({ dataDir: dir });
  try {
    await db.connect(); await db.migrate(migrations);
    const repos = createRepositories(db);
    const project = await repos.projects.create({ name: "注入资源" });
    const agent = await repos.agents.create({ displayName: "自己", hostType: "other" });
    const member = await repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName: agent.displayName });
    await repos.memory.insertHead({ id: "global-head", key: { scope: "global", projectId: null, agentId: agent.id },
      version: 1, markdown: "仅属于这个 Agent", byteLength: Buffer.byteLength("仅属于这个 Agent"), source: "agent",
      updatedAt: new Date().toISOString(), updatedBy: { kind: "agent", actorId: member.id, agentId: agent.id, displayName: agent.displayName } });
    registerMemoryRuntime(db, { database: { kind: "sqlite", sqlitePath: path.join(dir, "agent-studio.db") } });
    const first = getMemoryRuntime(db), second = getMemoryRuntime(db);
    assert.equal(first.reader, second.reader);
    assert.throws(() => registerMemoryRuntime(db, { database: { kind: "sqlite", sqlitePath: "/different-untrusted-path" } }), /already_configured/);
    const input = { memberId: member.id, projectId: project.id, bindingGeneration: "trusted-binding" };
    const result = await second.reader.readOwn(input);
    assert.equal(result.state, "available", JSON.stringify(result.errors));
    assert.equal(result.entries[0]?.markdown, "仅属于这个 Agent");
    await closeMemoryRuntime(db);
    assert.equal((await first.reader.readOwn(input)).state, "unavailable");
    assert.deepEqual((await getMemoryRuntime(db).reader.readOwn(input)).entries, []);
    await closeMemoryRuntime(db);
  } finally { await closeMemoryRuntime(db); await db.close(); await rm(dir, { recursive: true, force: true }); }
});
