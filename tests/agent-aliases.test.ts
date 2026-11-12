import test from "node:test";
import assert from "node:assert/strict";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createMcpServer } from "../src/server/mcp/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { migrations } from "../src/server/db/migrations/index.ts";

for (const engine of identityEngines) {
  test(`${engine} 稳定 Agent 改名 CAS 保留所有 alias；冲突不合并身份、不产生部分写入`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const a = await f.repos.agents.create({ displayName: "甲", hostType: "claude-code" });
      const b = await f.repos.agents.create({ displayName: "乙", hostType: "claude-code" });
      const renamed = await f.repos.agents.rename(a.id, "甲", "甲的新名字");
      assert.equal(renamed.id, a.id); assert.equal(renamed.displayName, "甲的新名字");
      assert.equal((await f.repos.agents.findByIdentity("甲", "claude-code"))?.id, a.id);
      assert.equal((await f.repos.agents.findByIdentity("甲的新名字", "claude-code"))?.id, a.id);
      await assert.rejects(f.repos.agents.rename(a.id, "甲", "过期编辑"), /agent_name_conflict/);
      assert.equal(await f.repos.agents.findByIdentity("过期编辑", "claude-code"), null);
      const before = await f.db.query("SELECT * FROM agent_legacy_aliases ORDER BY display_name, host_type");
      await assert.rejects(f.repos.agents.rename(b.id, "乙", "甲"), /agent_alias_conflict/);
      assert.deepEqual(await f.db.query("SELECT * FROM agent_legacy_aliases ORDER BY display_name, host_type"), before);
      assert.equal((await f.repos.agents.get(b.id))?.displayName, "乙");
      assert.equal((await f.repos.agents.list()).length, 2);
      const concurrent = await Promise.allSettled([
        f.repos.agents.rename(a.id, "甲的新名字", "唯一新名"), f.repos.agents.rename(b.id, "乙", "唯一新名"),
      ]);
      assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
      assert.ok([a.id, b.id].includes((await f.repos.agents.findByIdentity("唯一新名", "claude-code"))!.id));
    } finally { await f.close(); }
  });
  test(`${engine} 未引用 Agent 删除保留退休 alias；追加 alias 不换身份、不改宿主`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const a = await f.repos.agents.create({ displayName: "待删除", hostType: "other" });
      await f.repos.agents.addAlias(a.id, { displayName: "接入别名", hostType: "codex-cli" });
      assert.equal((await f.repos.agents.get(a.id))?.hostType, "other");
      assert.equal((await f.repos.agents.findByIdentity("接入别名", "codex-cli"))?.id, a.id);
      await f.repos.agents.delete(a.id);
      assert.equal(await f.repos.agents.get(a.id), null);
      const tombstones = await f.db.query("SELECT * FROM agent_legacy_aliases WHERE agent_id = ?", [a.id]);
      assert.equal(tombstones.length, 2); assert.ok(tombstones.every(row => typeof row.retired_at === "string"));
      await assert.rejects(f.repos.agents.findByIdentity("待删除", "other"), /agent_identity_retired/);
      await assert.rejects(f.repos.agents.create({ displayName: "待删除", hostType: "other" }), /agent_alias_conflict/);
      await assert.rejects(f.repos.agents.insertRaw({ ...a, displayName: "换名复活旧 ID" }), /agent_identity_retired/);
      assert.equal((await f.repos.agents.list()).length, 0);
      assert.deepEqual(await f.db.query("SELECT * FROM agent_legacy_aliases WHERE agent_id = ?", [a.id]), tombstones);
    } finally { await f.close(); }
  });

  test(`${engine} 被 Member 引用的 Agent 删除失败，alias 退休标记同事务回滚`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const agent = await f.repos.agents.create({ displayName: "仍被引用", hostType: "other" });
      const project = await f.repos.projects.create({ name: "身份保留" });
      const member = await f.repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: agent.displayName });
      const before = await f.repos.agents.aliases(agent.id);
      await assert.rejects(f.repos.agents.delete(agent.id));
      assert.deepEqual(await f.repos.agents.aliases(agent.id), before);
      assert.equal((await f.repos.agents.findByIdentity(agent.displayName, agent.hostType))?.id, agent.id);
      assert.equal((await f.repos.members.get(member.id))?.agentId, agent.id);
    } finally { await f.close(); }
  });

  test(`${engine} 真实 MCP SDK 旧 alias 重连保留 Agent/Member/历史，并使用新显示名`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine, 13);
    const logger = createLogger({ write() {} });
    const peers: Array<{ close(): Promise<void> }> = [];
    async function peer(key: string) {
      const core = createMcpCore({ db: f.db, logger, memberKey: key });
      const server = createMcpServer({ core, logger });
      const client = new Client({ name: key, version: "test" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
      let closed = false;
      const p = { async call(input: Record<string, unknown>) {
        const response = await client.callTool({ name: "join", arguments: input });
        const content = response.content as Array<{ type: string; text?: string }>;
        return JSON.parse(content.find(part => part.type === "text")!.text!);
      }, async close() { if (!closed) { closed = true; await client.close(); await server.close(); await core.close(); } } };
      peers.push(p); return p;
    }
    try {
      const project = await f.repos.projects.create({ name: "旧客户端项目" });
      const group = await f.repos.groups.create({ projectId: project.id, name: "旧群" });
      const args = { displayName: "原客户端名称", hostType: "claude-code", projectId: project.id, groupId: group.id };
      const old = await peer("original"); const first = await old.call(args);
      assert.equal(first.ok, true);
      const agentId = (await f.repos.members.get(first.memberId))!.agentId!;
      const message = await f.repos.messages.create({ groupId: group.id, senderMemberId: first.memberId, body: "原历史", mentions: [] });
      await old.close();
      await f.db.migrate(migrations);
      await f.repos.agents.rename(agentId, args.displayName, "用户的新名称");
      const next = await peer("legacy-reconnect"); const rejoined = await next.call({ ...args, role: "manager" });
      assert.equal(rejoined.ok, true, JSON.stringify(rejoined));
      assert.equal(rejoined.memberId, first.memberId);
      assert.equal(rejoined.context.identity.displayName, "用户的新名称");
      assert.equal(rejoined.context.identity.role, "member", "旧客户端自报 role 不能改写已有权限");
      assert.equal((await f.repos.agents.get(agentId))!.displayName, "用户的新名称");
      assert.equal((await f.repos.members.get(first.memberId))!.displayName, "用户的新名称");
      assert.equal((await f.repos.messages.get(message.id))!.senderMemberId, first.memberId);
      assert.equal((await f.repos.agents.list()).length, 1);
      assert.equal((await next.call(args)).ok, true, "同一连接以原 alias 重试仍幂等");

      const retired = await f.repos.agents.create({ displayName: "已退休接入", hostType: args.hostType });
      await f.repos.agents.delete(retired.id);
      const retiredPeer = await peer("retired-reconnect");
      const denied = await retiredPeer.call({ ...args, displayName: retired.displayName });
      assert.equal(denied.ok, false);
      assert.equal(denied.error.code, "CONFLICT");
      assert.equal(denied.error.details.reason, "agent_identity_retired");
      assert.equal((await f.repos.agents.list()).length, 1, "旧 alias 被拒绝后不能偷偷注册新身份");
    } finally { for (const p of peers) await p.close(); await f.close(); }
  });
}
