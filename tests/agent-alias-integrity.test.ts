import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createMcpServer } from "../src/server/mcp/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { createLegacyConfigInspector } from "../src/server/identity/legacy-config-inspection.ts";
import { RepositoryError } from "../src/server/db/errors.ts";
import { BUSINESS_TABLES } from "../src/server/db/migrate-data.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";

const scenarios = ["duplicate-history", "current-key-mismatch", "target-current-alias-corrupt"] as const;
const ambiguous = (error: unknown) => error instanceof RepositoryError && error.code === "migration_identity_ambiguous";

for (const engine of identityEngines) test(`${engine} R-134-REQ-001 已绑定会话再次 join 遇 alias 损坏仍明确返回歧义`, { skip: identitySkip(engine) }, async () => {
  const f = await identityFixture(engine), logger = createLogger({ write() {} });
  const core = createMcpCore({ db: f.db, repos: f.repos, logger, memberKey: "req001-repeat" });
  const server = createMcpServer({ core, logger });
  const client = new Client({ name: "req001-repeat", version: "test" });
  try {
    const a = await f.repos.agents.create({ displayName: "已加入身份", hostType: "claude-code" });
    const b = await f.repos.agents.create({ displayName: "另一身份", hostType: "claude-code" });
    const project = await f.repos.projects.create({ name: "重复接入" });
    const group = await f.repos.groups.create({ projectId: project.id, name: "重复接入群" });
    const args = { displayName: a.displayName, hostType: a.hostType, projectId: project.id, groupId: group.id };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    const join = async () => {
      const response = await client.callTool({ name: "join", arguments: args });
      const content = response.content as Array<{ type: string; text?: string }>;
      return JSON.parse(content.find(part => part.type === "text")!.text!);
    };
    assert.equal((await join()).ok, true);
    await f.db.exec("UPDATE agent_legacy_aliases SET agent_id = ? WHERE display_name = ? AND host_type = ?", [b.id, a.displayName, a.hostType]);
    const capture = () => Promise.all(BUSINESS_TABLES.map(table => f.db.query(`SELECT * FROM ${table.name} ORDER BY ${table.keyColumns.join(", ")}`)));
    const before = await capture();
    const denied = await join();
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "CONFLICT");
    assert.equal(denied.error.details.reason, "migration_identity_ambiguous");
    assert.deepEqual(await capture(), before);
  } finally { await client.close(); await server.close(); await core.close(); await f.close(); }
});

for (const engine of identityEngines) for (const scenario of scenarios) {
  test(`${engine} R-134-REQ-001 ${scenario}：真实旧 MCP/身份解析拒绝歧义，预检保留引用且全表不变`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    const logger = createLogger({ write() {} });
    const core = createMcpCore({ db: f.db, repos: f.repos, logger, memberKey: `req001-${scenario}` });
    const server = createMcpServer({ core, logger });
    const client = new Client({ name: `req001-${scenario}`, version: "test" });
    try {
      const a = await f.repos.agents.create({ displayName: "原甲", hostType: "claude-code" });
      const b = await f.repos.agents.create({ displayName: "原乙", hostType: "claude-code" });
      const unrelated = await f.repos.agents.create({ displayName: "无关完好身份", hostType: "claude-code" });
      await f.repos.agents.rename(a.id, "原甲", "现甲");
      await f.repos.agents.rename(b.id, "原乙", "现乙");
      const project = await f.repos.projects.create({ name: "坏导入不能合并身份" });
      const group = await f.repos.groups.create({ projectId: project.id, name: "旧接入" });
      const ma = await f.repos.members.create({ projectId: project.id, agentId: a.id, kind: "agent", displayName: "现甲" });
      const mb = await f.repos.members.create({ projectId: project.id, agentId: b.id, kind: "agent", displayName: "现乙" });
      if (scenario === "duplicate-history") {
        // 坏导入可能丢失约束；两个现名 alias 均正确，只有历史键发生重复。
        await f.db.exec("CREATE TABLE imported_aliases AS SELECT * FROM agent_legacy_aliases");
        await f.db.exec("DROP TABLE agent_legacy_aliases");
        await f.db.exec("ALTER TABLE imported_aliases RENAME TO agent_legacy_aliases");
        await f.db.exec("INSERT INTO agent_legacy_aliases (display_name, host_type, agent_id, created_at, retired_at) VALUES (?, ?, ?, ?, NULL)",
          ["原甲", a.hostType, b.id, a.createdAt]);
      } else {
        // 不改 DDL：当前乙 alias 指向仍存活的甲。历史乙 alias 仍正确指向乙。
        await f.db.exec("UPDATE agent_legacy_aliases SET agent_id = ? WHERE display_name = ? AND host_type = ?", [a.id, "现乙", b.hostType]);
      }
      const displayName = scenario === "duplicate-history" ? "原甲" : scenario === "current-key-mismatch" ? "现乙" : "原乙";
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
      const capture = () => Promise.all(BUSINESS_TABLES.map(table => f.db.query(`SELECT * FROM ${table.name} ORDER BY ${table.keyColumns.join(", ")}${table.name === "agent_legacy_aliases" ? ", agent_id" : ""}`)));
      const before = await capture();
      // 接入先于预检，不能依赖用户先执行一次 preflight 才安全。
      const response = await client.callTool({ name: "join", arguments: { displayName, hostType: a.hostType, projectId: project.id, groupId: group.id } });
      const content = response.content as Array<{ type: string; text?: string }>;
      const joined = JSON.parse(content.find(part => part.type === "text")!.text!);
      assert.equal(joined.ok, false, JSON.stringify(joined));
      assert.equal(joined.error.code, "CONFLICT");
      assert.equal(joined.error.details.reason, "migration_identity_ambiguous");
      await assert.rejects(f.repos.agents.findByIdentity(displayName, a.hostType), ambiguous);
      await assert.rejects(f.repos.agents.findByIdentity("现甲", a.hostType), ambiguous, "不能从另一条完好 current alias 绕过目标已有损坏关系");
      assert.equal((await f.repos.agents.findByIdentity(unrelated.displayName, unrelated.hostType))?.id, unrelated.id, "局部损坏不构造全局身份停用开关");
      const report = await createLegacyConfigInspector({ db: f.db, repos: f.repos }).preflight();
      assert.equal(report.code, "migration_identity_ambiguous");
      if (scenario === "duplicate-history") {
        assert.ok(report.issues.some(issue => issue.reason === "legacy_alias_duplicate" && issue.refs["displayName"] === "原甲"
          && Array.isArray(issue.refs["agentIds"]) && issue.refs["agentIds"].includes(a.id) && issue.refs["agentIds"].includes(b.id)));
      } else assert.ok(report.issues.some(issue => issue.reason === "legacy_alias_conflict"
        && issue.refs["agentId"] === b.id && issue.refs["aliasAgentId"] === a.id));
      await assert.rejects(f.repos.agents.rename(b.id, "现乙", "不应被改名"), ambiguous);
      await assert.rejects(f.repos.agents.addAlias(b.id, { displayName: "不应被追加", hostType: a.hostType }), ambiguous);
      assert.equal((await f.repos.members.get(ma.id))?.agentId, a.id);
      assert.equal((await f.repos.members.get(mb.id))?.agentId, b.id);
      assert.deepEqual(await capture(), before, "失败接入、改名、alias 新增和只读预检不产生任何业务写入");
    } finally { await client.close(); await server.close(); await core.close(); await f.close(); }
  });
}

for (const engine of identityEngines) test(`${engine} R-134-REQ-001 重复历史 alias 的预检不被 Map 覆盖`, { skip: identitySkip(engine) }, async () => {
  const f = await identityFixture(engine);
  try {
    const a = await f.repos.agents.create({ displayName: "历史名", hostType: "claude-code" });
    const b = await f.repos.agents.create({ displayName: "其他名", hostType: "claude-code" });
    await f.repos.agents.rename(a.id, "历史名", "甲现名");
    await f.repos.agents.rename(b.id, "其他名", "乙现名");
    await f.db.exec("CREATE TABLE imported_aliases AS SELECT * FROM agent_legacy_aliases");
    await f.db.exec("DROP TABLE agent_legacy_aliases");
    await f.db.exec("ALTER TABLE imported_aliases RENAME TO agent_legacy_aliases");
    await f.db.exec("INSERT INTO agent_legacy_aliases SELECT display_name, host_type, ?, created_at, retired_at FROM agent_legacy_aliases WHERE display_name = ?", [b.id, "历史名"]);
    const before = await f.db.query("SELECT * FROM agent_legacy_aliases ORDER BY display_name, host_type, agent_id");
    const report = await createLegacyConfigInspector({ db: f.db, repos: f.repos }).preflight();
    assert.equal(report.code, "migration_identity_ambiguous");
    assert.ok(report.profiles.every(profile => profile.mode === "ambiguous"));
    const duplicate = report.issues.find(issue => issue.reason === "legacy_alias_duplicate")!;
    assert.deepEqual(duplicate.refs["agentIds"], [a.id, b.id].sort());
    assert.deepEqual(await f.db.query("SELECT * FROM agent_legacy_aliases ORDER BY display_name, host_type, agent_id"), before);
  } finally { await f.close(); }
});
