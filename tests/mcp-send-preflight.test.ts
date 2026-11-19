import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createLogger } from "../src/server/logger.ts";
import type { DbDriver } from "../src/server/db/driver.ts";
import type { RepositorySet } from "../src/server/db/repositories.ts";
import type { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { onMessageCommit } from "../src/server/runtime/dispatch-events.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { memoryFixture, pgUnavailable } from "./helpers/memory-fixture.ts";

type Fault = "none" | "heartbeat-read" | "heartbeat-write" | "preflight-commit" | "message-commit";
/** Observe the native connection, not transaction-wrapper calls. SQL fault cases
 * execute a real invalid statement; commit failpoints perform real rollback. */
function physicalSql(db: DbDriver, fault: Fault = "none") {
  const events: string[] = []; let injected = false, messageWrite = false;
  const failure = new Error("injected physical commit failure");
  const prepare = (source: string) => {
    const sql = source.trim().replace(/\s+/g, " "); events.push(sql);
    if (/^INSERT INTO messages\b/i.test(sql)) messageWrite = true;
    if (!injected && ((fault === "heartbeat-read" && /^SELECT \* FROM mcp_sessions WHERE id =/i.test(sql))
      || (fault === "heartbeat-write" && /^UPDATE mcp_sessions SET last_heartbeat_at/i.test(sql)))) {
      injected = true; events.push("INJECT: SELECT boardroom_missing_heartbeat_function()");
      return { sql: "SELECT boardroom_missing_heartbeat_function()", commitFailure: false };
    }
    if (!injected && /^COMMIT\b/i.test(sql) && ((fault === "preflight-commit" && !messageWrite)
      || (fault === "message-commit" && messageWrite))) {
      injected = true; events.push("INJECT: ROLLBACK"); return { sql: "ROLLBACK", commitFailure: true };
    }
    return { sql: source, commitFailure: false };
  };
  let restore: () => void;
  if (db.kind === "sqlite") {
    const handle = (db as SqliteDriver).handle, nativePrepare = handle.prepare, nativeExec = handle.exec;
    handle.prepare = ((sql: string) => Reflect.apply(nativePrepare, handle, [prepare(sql).sql])) as typeof handle.prepare;
    handle.exec = (sql: string) => {
      const action = prepare(sql), result = Reflect.apply(nativeExec, handle, [action.sql]);
      if (action.commitFailure) throw failure; return result;
    };
    restore = () => { handle.prepare = nativePrepare; handle.exec = nativeExec; };
  } else {
    const nativeQuery = Client.prototype.query;
    Client.prototype.query = (function(this: Client, ...args: unknown[]) {
      const first = args[0], source = typeof first === "string" ? first
        : first !== null && typeof first === "object" && "text" in first ? String(first.text) : "";
      const action = prepare(source);
      if (action.sql !== source) {
        const result = Reflect.apply(nativeQuery, this, [action.sql]);
        if (action.commitFailure) return Promise.resolve(result).then(() => { throw failure; });
        return result;
      }
      return Reflect.apply(nativeQuery, this, args);
    }) as typeof Client.prototype.query;
    restore = () => { Client.prototype.query = nativeQuery; };
  }
  return { events, restore, injected: () => injected };
}

type Sender = { repos: RepositorySet; db: DbDriver; core: ReturnType<typeof createMcpCore>; memberId: string;
  projectId: string; groupId: string; advance: () => void; logs: string[] };
async function senderFixture(engine: "sqlite" | "postgres", run: (sender: Sender) => Promise<void>) {
  return memoryFixture(async (repos, db) => {
    const project = await repos.projects.create({ name: "发送前短事务" });
    const group = await repos.groups.create({ projectId: project.id, name: "群" });
    let clock = Date.parse("2026-11-19T10:00:00.000Z"); const logs: string[] = [];
    const core = createMcpCore({ db, repos, now: () => new Date(clock), logger: createLogger({ write(line) { logs.push(line); } }) });
    try {
      const joined = await core.join("sender", { projectId: project.id, groupId: group.id, displayName: "发送者", hostType: "other" });
      clock += 1000;
      await run({ repos, db, core, memberId: joined.memberId, projectId: project.id, groupId: group.id, advance: () => { clock += 1000; }, logs });
    } finally { await core.close(); }
  }, engine);
}

for (const engine of ["sqlite", "postgres"] as const) {
  const gate = { skip: engine === "postgres" ? pgUnavailable : false };
  test(`${engine} send 首次授权与心跳只有一次物理提交，真实消息提交后才通知`, gate, async () => senderFixture(engine, async f => {
    const observed = physicalSql(f.db); const notifications: string[] = [];
    const unsubscribe = onMessageCommit(f.db, async id => {
      assert.equal(f.db.currentTransactionContext(), undefined);
      assert.ok(await f.repos.messages.get(id!)); notifications.push(id!);
    });
    try {
      const sent = await f.core.sendMessage("sender", { text: "同一短预检事务", clientMessageId: "preflight-idempotence" });
      const insert = observed.events.findIndex(sql => /^INSERT INTO messages\b/i.test(sql)); assert.ok(insert > 0);
      const prefix = observed.events.slice(0, insert);
      const heartbeat = prefix.findIndex(sql => /^UPDATE mcp_sessions SET last_heartbeat_at/i.test(sql));
      assert.ok(heartbeat >= 0);
      const preflightEnd = prefix.findIndex((sql, index) => index > heartbeat && /^COMMIT\b/i.test(sql));
      assert.ok(preflightEnd > heartbeat);
      // PG 的后续 guard 只读查询各自提交；此处只量首授权到心跳提交的边界。
      assert.equal(prefix.slice(0, preflightEnd + 1).filter(sql => /^COMMIT\b/i.test(sql)).length, 1,
        "no independent empty authorization commit before the heartbeat commit");
      assert.ok(prefix.some(sql => /^SAVEPOINT\b/i.test(sql)));
      assert.deepEqual(notifications, [sent.messageId]);
      const repeated = await f.core.sendMessage("sender", { text: "同一短预检事务", clientMessageId: "preflight-idempotence" });
      assert.equal(repeated.duplicate, true); assert.equal(repeated.messageId, sent.messageId);
      assert.deepEqual(notifications, [sent.messageId]);
      assert.equal((await f.db.query("SELECT id FROM messages")).length, 1);
    } finally { observed.restore(); unsubscribe(); }
  }));

  for (const fault of ["heartbeat-read", "heartbeat-write"] as const) {
    test(`${engine} send ${fault} 的真实SQL错误回滚保存点后仍可发送`, gate, async () => senderFixture(engine, async f => {
      const session = (await f.repos.mcpSessions.listByProject(f.projectId))[0]!;
      const observed = physicalSql(f.db, fault); const notifications: string[] = [];
      const unsubscribe = onMessageCommit(f.db, id => { assert.equal(f.db.currentTransactionContext(), undefined); notifications.push(id!); });
      try {
        const sent = await f.core.sendMessage("sender", { text: "心跳失败仍发送" });
        assert.equal(observed.injected(), true);
        assert.ok(observed.events.some(sql => /^ROLLBACK TO SAVEPOINT\b/i.test(sql)), "whole heartbeat is isolated by the real driver");
        assert.ok(await f.repos.messages.get(sent.messageId)); assert.deepEqual(notifications, [sent.messageId]);
        assert.equal((await f.repos.mcpSessions.get(session.id))!.lastHeartbeatAt, session.lastHeartbeatAt);
        assert.ok(f.logs.some(line => line.includes("mcp_session_heartbeat_failed")));
      } finally { observed.restore(); unsubscribe(); }
    }));
  }

  for (const fault of ["preflight-commit", "message-commit"] as const) {
    test(`${engine} send ${fault} 失败保持硬错误且不提交消息或通知`, gate, async () => senderFixture(engine, async f => {
      const observed = physicalSql(f.db, fault); const notifications: string[] = [];
      const unsubscribe = onMessageCommit(f.db, id => { notifications.push(id!); });
      try {
        await assert.rejects(f.core.sendMessage("sender", { text: "提交失败" }));
        assert.equal(observed.injected(), true);
        assert.deepEqual(await f.db.query("SELECT id FROM messages"), []);
        assert.deepEqual(await f.db.query("SELECT id FROM message_deliveries"), []);
        assert.deepEqual(notifications, []);
        if (fault === "preflight-commit") assert.equal(observed.events.some(sql => /^INSERT INTO messages\b/i.test(sql)), false);
      } finally { observed.restore(); unsubscribe(); }
    }));
  }

  test(`${engine} send 硬成员代际拒绝在参数与心跳之前，正常参数错误保留心跳顺序`, gate, async () => senderFixture(engine, async f => {
    const session = (await f.repos.mcpSessions.listByProject(f.projectId))[0]!;
    await assert.rejects(f.core.sendMessage("sender", { text: "" }), error => (error as { code?: string }).code === "INVALID_ARGUMENT");
    assert.notEqual((await f.repos.mcpSessions.get(session.id))!.lastHeartbeatAt, session.lastHeartbeatAt);
    const member = (await f.repos.members.get(f.memberId))!;
    await f.repos.mutations.run({ projectIds: [f.projectId], discover: async () => ({ memberIds: [member.id], groupIds: [f.groupId], runtimeIds: [] }) },
      () => f.repos.members.applyLifecycleCas(f.projectId, member.id, member.membershipRevision,
        { displayName: member.displayName, status: "disabled", role: "normal", nodeId: null, removedAt: "2026-11-19T10:00:02.000Z" }, "2026-11-19T10:00:02.000Z"));
    const observed = physicalSql(f.db);
    try {
      await assert.rejects(f.core.sendMessage("sender", { text: "" }), error => (error as { code?: string }).code === "FORBIDDEN");
      assert.equal(observed.events.some(sql => /^UPDATE mcp_sessions SET last_heartbeat_at/i.test(sql)), false);
      assert.deepEqual(await f.db.query("SELECT id FROM messages"), []);
    } finally { observed.restore(); }
  }));

  test(`${engine} send 的真实托管运行fence拒绝不被心跳best-effort吞掉`, gate, async () => memoryFixture(async (repos, db) => {
    const project = await repos.projects.create({ name: "发送fence" }), group = await repos.groups.create({ projectId: project.id, name: "群" });
    const runtime = createRuntimeRepository(db, { repos });
    const created = await runtime.create({ name: "托管发送者", backend: "claude-code", defaults: { workdir: process.cwd() }, bindings: [{ projectId: project.id, groupId: group.id }] });
    const view = created.bindings[0]!; await runtime.intent(view.binding.id, "start");
    const fence = await runtime.claim(view.binding.id, "send-preflight-owner");
    const identity = { displayName: view.runtime.name, hostType: view.runtime.backend, projectId: project.id, groupId: group.id, memberId: view.binding.memberId };
    const core = createMcpCore({ db, repos, logger: createLogger({ write() {} }), managed: { identity,
      run: (operation, body, discover) => runtime.withFence(fence, body, { requireRunningIntent: operation === "write" || operation === "consume" }, discover),
      beforeWait: async () => true, onDelivery: async () => {} } });
    try {
      await core.join("managed", identity); await runtime.intent(view.binding.id, "stop");
      const observed = physicalSql(db);
      try {
        await assert.rejects(core.sendMessage("managed", { text: "禁止越过停止fence" }), error => (error as { code?: string }).code === "CONFLICT");
        assert.equal(observed.events.some(sql => /^UPDATE mcp_sessions SET last_heartbeat_at/i.test(sql)), false);
        assert.deepEqual(await db.query("SELECT id FROM messages"), []);
      } finally { observed.restore(); }
    } finally { await core.close(); }
  }, engine));
}
