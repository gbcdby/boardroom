import test from "node:test";
import assert from "node:assert/strict";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createLogger } from "../src/server/logger.ts";
import { memoryFixture, pgUnavailable } from "./helpers/memory-fixture.ts";
import type { DbTransaction } from "../src/server/db/driver.ts";

for (const engine of ["sqlite", "postgres"] as const) {
  const gate = { skip: engine === "postgres" ? pgUnavailable : false };
  test(`${engine} S5-AUDIT-13：真实 MCP 心跳先锁项目再锁成员`, gate, async () => memoryFixture(async (repos, db) => {
    const project = await repos.projects.create({ name: "MCP 共同变更边界" });
    const group = await repos.groups.create({ projectId: project.id, name: "协作" });
    const core = createMcpCore({ db, logger: createLogger({ write() {} }) });
    const exec = db.exec.bind(db); const locks: string[] = [];
    try {
      await core.join("agent", { projectId: project.id, groupId: group.id, displayName: "执行者", hostType: "other" });
      db.exec = async (sql, params) => {
        if (/^UPDATE (projects|members) SET updated_at = updated_at/.test(sql)) locks.push(sql.split(" ")[1]!);
        return exec(sql, params);
      };
      await core.heartbeat("agent");
      assert.deepEqual(locks.slice(0, 2), ["projects", "members"]);
    } finally { db.exec = exec; await core.close(); }
  }, engine));

  test(`${engine} S5-AUDIT-09：移除阻止普通重入，恢复只接受新绑定，旧关闭不影响新会话`, gate, async () => memoryFixture(async (repos, db) => {
    const project = await repos.projects.create({ name: "身份代际" });
    const group = await repos.groups.create({ projectId: project.id, name: "协作" });
    const logger = createLogger({ write() {} });
    const old = createMcpCore({ db, logger, memberKey: "old" });
    const fresh = createMcpCore({ db, logger, memberKey: "fresh" });
    const params = { projectId: project.id, groupId: group.id, displayName: "同一全局身份", hostType: "other" };
    try {
      const joined = await old.join("agent", params);
      const original = (await repos.members.get(joined.memberId))!;
      const originalSession = (await repos.mcpSessions.listByProject(project.id))[0]!;
      const plan = { projectIds: [project.id], discover: async () => ({ memberIds: [original.id], groupIds: [group.id], runtimeIds: [] }) };
      const at = new Date().toISOString();
      const removed = await repos.mutations.run(plan, async () => repos.members.applyLifecycleCas(project.id, original.id, original.membershipRevision,
        { displayName: original.displayName, status: "disabled", role: "normal", nodeId: null, removedAt: at }, at));
      await assert.rejects(old.heartbeat("agent"), error => (error as { code?: string }).code === "FORBIDDEN");
      await assert.rejects(fresh.join("removed", params), error => (error as { details?: { reason?: string } }).details?.reason === "member_removed");
      await old.disconnect();
      assert.deepEqual(await repos.mcpSessions.get(originalSession.id), originalSession,
        "移除后的旧连接不得以退出清理为由改写会话事实");
      const restored = await repos.mutations.run(plan, async () => repos.members.applyLifecycleCas(project.id, original.id, removed.membershipRevision,
        { displayName: original.displayName, status: "active", role: "normal", nodeId: null, removedAt: null }, at));
      assert.ok(restored.membershipRevision > original.membershipRevision);
      const stale = (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === "membership_changed";
      await assert.rejects(old.heartbeat("agent"), stale);
      await assert.rejects(old.join("agent", params), stale);
      const rejoined = await fresh.join("current", params);
      assert.equal(rejoined.memberId, original.id);
      const freshStatus = await repos.statuses.get(project.id, original.id);
      const freshSessions = await repos.mcpSessions.listByProject(project.id);
      await old.close();
      await old.disconnect();
      assert.deepEqual(await repos.statuses.get(project.id, original.id), freshStatus,
        "旧代际退出清理不能覆盖恢复后新连接的运行状态");
      assert.deepEqual(await repos.mcpSessions.listByProject(project.id), freshSessions);
      assert.equal((await fresh.heartbeat("current")).ok, true);
      assert.equal((await repos.mcpSessions.listByProject(project.id)).filter(s => s.memberId === original.id && s.state === "connected").length, 1);
    } finally { await old.close(); await fresh.close(); }
  }, engine));

  test(`${engine} S5-AUDIT-13：消息投递写入前锁定全部真实接收成员`, gate, async () => memoryFixture(async (repos, db) => {
    const project = await repos.projects.create({ name: "完整投递计划" });
    const group = await repos.groups.create({ projectId: project.id, name: "协作" });
    const logger = createLogger({ write() {} });
    const sender = createMcpCore({ db, logger, memberKey: "sender" }), recipient = createMcpCore({ db, logger, memberKey: "recipient" });
    const transaction = db.transaction.bind(db);
    let writes = 0;
    try {
      const a = await sender.join("agent", { projectId: project.id, groupId: group.id, displayName: "发送者", hostType: "other" });
      const b = await recipient.join("agent", { projectId: project.id, groupId: group.id, displayName: "接收者", hostType: "other" });
      db.transaction = <T>(body: (tx: DbTransaction) => Promise<T>): Promise<T> => transaction(tx => body({
        ...tx, exec: async (sql, params) => {
          if (/INSERT INTO message_deliveries/.test(sql)) {
            const scope = repos.mutations.current(); assert.ok(scope);
            scope.assertCovers([project.id], [a.memberId, b.memberId]); writes++;
          }
          return tx.exec(sql, params);
        },
      }));
      const sent = await sender.sendMessage("agent", { text: "完整范围", mentions: [b.memberId] });
      assert.ok(writes >= 2);
      assert.equal((await repos.deliveries.get(sent.messageId, b.memberId))?.status, "pending");
    } finally { db.transaction = transaction; await sender.close(); await recipient.close(); }
  }, engine));
}
