import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { appendAuditEntry } from "../src/server/audit.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { createAuditCompensationService } from "../src/server/audit-compensation.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
const access = { actor: ownerActor() };
async function withDb(engine: "sqlite" | "postgres", body: (repos: RepositorySet, db: DbDriver) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-org-v2-"));
  const schema = `org_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(engine === "sqlite" ? { dataDir: dir } : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try { await db.connect(); await db.migrate(migrations); await body(createRepositories(db), db); }
  finally {
    await db.close();
    if (engine === "postgres") { const admin = new Client({ connectionString: pgUrl }); await admin.connect(); try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); } }
    await rm(dir, { recursive: true, force: true });
  }
}
for (const engine of ["sqlite", "postgres"] as const) {
  const skip = engine === "postgres" && !pgUrl ? "未配置真实 PostgreSQL；交 CI 执行" : false;
  test(`${engine} R-P5-C-REQ-001：岗位图绑定占岗成员代际，移除后重新加入或恢复不能继承旧岗位`, { skip }, async () => withDb(engine, async repos => {
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    for (const mode of ['readd', 'undo-remove'] as const) {
      const p = await repos.projects.create({ name: `岗位代际 ${mode}` });
      const agent = await repos.agents.create({ displayName: `代际 Agent ${mode}`, hostType: 'other' });
      const added = await service.addMember(access, { projectId: p.id, kind: 'agent', agentId: agent.id, displayName: '原周期' });
      const root = await service.createNode(access, { projectId: p.id, name: '根', role: 'top_manager' });
      const node = await service.createNode(access, { projectId: p.id, parentId: root.node.id, name: '旧岗位', role: 'member' });
      await service.assignNode(access, p.id, added.member.id, node.node.id);
      const deleted = await service.deleteNode(access, p.id, node.node.id);
      const removed = await service.removeMember(access, p.id, added.member.id);
      if (mode === 'readd') await service.addMember(access, { projectId: p.id, kind: 'agent', agentId: agent.id, displayName: '新周期' });
      else await compensation.revoke(access, p.id, removed.auditId);
      const current = (await repos.members.get(added.member.id))!;
      assert.equal(current.membershipRevision, 3); assert.equal(current.nodeId, null);
      const auditCount = (await repos.audit.list(p.id)).length;
      await assert.rejects(compensation.revoke(access, p.id, deleted.auditId), { code: 'compensation_conflict' });
      assert.deepEqual(await repos.members.get(added.member.id), current);
      assert.equal(await repos.org.getNode(node.node.id), null);
      assert.equal((await repos.audit.list(p.id)).length, auditCount);
      const original = (await repos.audit.get(p.id, deleted.auditId))!;
      assert.equal(original.reversedAt, null);
      assert.equal(JSON.parse(original.before!).assignments[0].membershipRevision, 1);
      assert.equal(JSON.parse(original.after!).assignments[0].membershipRevision, 1);
    }
  }));
  test(`${engine} 旧岗位图占岗缺代际时明确拒绝，不猜当前代际或默认1`, { skip }, async () => withDb(engine, async (repos, db) => {
    const p = await repos.projects.create({ name: '缺代际旧v2' });
    const m = await repos.members.create({ projectId: p.id, kind: 'human', displayName: '旧占岗者' });
    const node = await repos.org.createNode({ projectId: p.id, name: '根岗位', role: 'top_manager' });
    await repos.org.assignNode(m.id, node.id);
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const deleted = await service.deleteNode(access, p.id, node.id);
    const row = (await repos.audit.get(p.id, deleted.auditId))!;
    const before = JSON.parse(row.before!), after = JSON.parse(row.after!);
    for (const snapshot of [before, after]) for (const assignment of snapshot.assignments) delete assignment.membershipRevision;
    await db.exec('UPDATE audit_log SET before = ?, after = ? WHERE id = ?', [JSON.stringify(before), JSON.stringify(after), row.id]);
    await assert.rejects(compensation.revoke(access, p.id, row.id), { code: 'legacy_incomplete_snapshot' });
    assert.equal(await repos.org.getNode(node.id), null);
    assert.equal((await repos.members.get(m.id))!.nodeId, null);
    assert.equal((await repos.members.get(m.id))!.role, 'normal');
    assert.equal((await repos.audit.get(p.id, row.id))!.reversedAt, null);
    assert.equal((await repos.audit.list(p.id)).length, 1);
  }));
  test(`${engine} 合法大快照按列有界读取，三次撤销不重复读取整行历史`, { skip }, async () => withDb(engine, async (repos, db) => {
    const p = await repos.projects.create({ name: "大快照边界" });
    const originalName = "\\".repeat(14000), updatedName = "\"".repeat(14000);
    const node = await repos.org.createNode({ projectId: p.id, name: originalName, role: "top_manager" });
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const updated = await service.updateNode(access, p.id, node.id, { name: updatedName });
    const rootRow = (await repos.audit.get(p.id, updated.auditId))!;
    assert.ok(Buffer.byteLength(rootRow.before!) < 32768 && Buffer.byteLength(rootRow.after!) < 32768);
    assert.ok(Buffer.byteLength(JSON.stringify(rootRow)) > 65536, "合法字段组合确实超过单返回行预算");
    let previous = updated.auditId;
    const statements: string[] = [];
    const query = repos.context.query, one = repos.context.one;
    repos.context.query = async (sql, params) => { statements.push(sql); return query(sql, params); };
    repos.context.one = async (sql, params) => { statements.push(sql); return one(sql, params); };
    try {
      for (let i = 0; i < 3; i++) {
        const result = await compensation.revoke(access, p.id, previous);
        assert.equal((await repos.org.getNode(node.id))!.name, i % 2 === 0 ? originalName : updatedName);
        previous = result.id;
      }
    } finally { repos.context.query = query; repos.context.one = one; }
    assert.ok(!statements.some(sql => /SELECT\s+\*\s+FROM\s+audit_log/i.test(sql)), "补偿链不读取整行快照历史");
    const last = (await repos.audit.get(p.id, previous))!;
    await db.exec("UPDATE audit_log SET before = ? WHERE id = ?", [JSON.stringify({ invalid: "长".repeat(1000000) }), previous]);
    await assert.rejects(() => compensation.revoke(access, p.id, previous), { code: "audit_snapshot_too_large" });
    assert.equal((await repos.org.getNode(node.id))!.name, originalName);
    assert.equal((await repos.audit.get(p.id, previous))!.reversedAt, last.reversedAt);
  }));
  test(`${engine} 删除岗位保留完整关系，连续五次补偿只复原边与占岗`, { skip }, async () => withDb(engine, async (repos) => {
    const p = await repos.projects.create({ name: "组织补偿" });
    const root = await repos.org.createNode({ projectId: p.id, name: "根", role: "top_manager" });
    const node = await repos.org.createNode({ projectId: p.id, parentId: root.id, name: "团队", role: "sub_manager" });
    const child = await repos.org.createNode({ projectId: p.id, parentId: node.id, name: "开发", role: "member" });
    const m = await repos.members.create({ projectId: p.id, kind: "human", displayName: "成员" });
    await repos.org.assignNode(m.id, node.id);
    const service = createOrgMutationService({ repos }); const compensation = createAuditCompensationService({ repos });
    const removed = await service.deleteNode(access, p.id, node.id);
    assert.equal(await repos.org.getNode(node.id), null);
    assert.equal((await repos.org.getNode(child.id))!.parentId, root.id);
    assert.equal((await repos.members.get(m.id))!.nodeId, null);
    await repos.org.updateNode(child.id, { name: "独立修改的名称" });
    await repos.members.update(m.id, { displayName: "独立姓名" });
    let previous = (await repos.audit.get(p.id, removed.auditId))!;
    const before = JSON.parse(previous.before!);
    assert.equal(before.schema, "org-graph/v2"); assert.deepEqual(before.directChildIds, [child.id]);
    for (let i = 0; i < 5; i++) {
      const next = await compensation.revoke(access, p.id, previous.id);
      const meta = JSON.parse(next.detail!).reversal;
      assert.equal(meta.undoesAuditId, previous.id); assert.equal(meta.rootAuditId, removed.auditId);
      assert.equal((await repos.audit.get(p.id, previous.id))!.reversedByAuditId, next.id);
      const exists = i % 2 === 0;
      assert.equal(Boolean(await repos.org.getNode(node.id)), exists);
      assert.equal((await repos.org.getNode(child.id))!.parentId, exists ? node.id : root.id);
      assert.equal((await repos.members.get(m.id))!.nodeId, exists ? node.id : null);
      assert.equal((await repos.org.getNode(child.id))!.name, "独立修改的名称");
      assert.equal((await repos.members.get(m.id))!.displayName, "独立姓名");
      previous = next;
    }
    await assert.rejects(() => compensation.revoke(access, p.id, removed.auditId), { code: "compensation_conflict" });
    assert.equal((await repos.audit.list(p.id)).length, 6);
  }));
  test(`${engine} 补偿冲突、审计失败与旧不完整删除均零提交`, { skip }, async () => withDb(engine, async (repos, db) => {
    const p = await repos.projects.create({ name: "失败回滚" });
    const root = await repos.org.createNode({ projectId: p.id, name: "根", role: "top_manager" });
    const child = await repos.org.createNode({ projectId: p.id, parentId: root.id, name: "孩子", role: "member" });
    const service = createOrgMutationService({ repos }); const compensation = createAuditCompensationService({ repos });
    const changed = await service.updateNode(access, p.id, child.id, { name: "新名" });
    const originalAppend = repos.audit.append;
    repos.audit.append = async () => { throw new Error("injected audit failure"); };
    await assert.rejects(() => service.updateNode(access, p.id, child.id, { name: '失败不得提交' }), { code: 'write_failed' });
    await assert.rejects(() => compensation.revoke(access, p.id, changed.auditId), /injected audit failure/);
    await assert.rejects(() => service.deleteNode(access, p.id, child.id), /injected audit failure/);
    repos.audit.append = originalAppend;
    assert.equal((await repos.org.getNode(child.id))!.name, "新名");
    assert.equal((await repos.audit.get(p.id, changed.auditId))!.reversedAt, null);
    const undo = await compensation.revoke(access, p.id, changed.auditId);
    await repos.org.updateNode(child.id, { name: "独立后改" });
    await assert.rejects(() => compensation.revoke(access, p.id, undo.id), { code: "compensation_conflict" });
    const legacy = await appendAuditEntry(repos.audit, { projectId: p.id, actor: { kind: "human", name: "人" }, action: "org.node_delete", targetKind: "node", targetId: child.id, targetName: child.name, before: child, after: null });
    await assert.rejects(() => compensation.revoke(access, p.id, legacy.id), { code: "legacy_incomplete_snapshot" });
    assert.equal((await repos.audit.get(p.id, legacy.id))!.reversedAt, null);
    assert.equal((await db.query("SELECT id FROM audit_log WHERE reversed_at IS NOT NULL")).length, 1);
    await assert.rejects(() => service.updateNode({ actor: { ...ownerActor(p.id), role: 'member' } }, p.id, child.id, { name: '越权' }), error => error instanceof Error && error.name === 'ForbiddenError');
  }));
  test(`${engine} 根叶删除降级 legacy manager，UTF-8 快照上限在写前拒绝`, { skip }, async () => withDb(engine, async (repos) => {
    const p = await repos.projects.create({ name: "根删除" });
    const root = await repos.org.createNode({ projectId: p.id, name: "根", role: "top_manager" });
    const m = await repos.members.create({ projectId: p.id, kind: "human", displayName: "负责人" });
    await repos.org.assignNode(m.id, root.id);
    const service = createOrgMutationService({ repos }); const compensation = createAuditCompensationService({ repos });
    const row = await service.deleteNode(access, p.id, root.id);
    assert.equal((await repos.members.get(m.id))!.role, "normal");
    await compensation.revoke(access, p.id, row.auditId);
    assert.equal((await repos.members.get(m.id))!.role, "manager");
    const count = (await repos.audit.list(p.id)).length;
    await assert.rejects(() => service.updateNode(access, p.id, root.id, { name: "长".repeat(12000) }), { code: "audit_snapshot_too_large" });
    assert.equal((await repos.org.getNode(root.id))!.name, "根");
    assert.equal((await repos.audit.list(p.id)).length, count);
  }));
  test(`${engine} 删除重做拒绝新增下级或新占岗，改名旧快照仍可安全适配`, { skip }, async () => withDb(engine, async (repos) => {
    const p = await repos.projects.create({ name: "集合冲突" });
    const root = await repos.org.createNode({ projectId: p.id, name: "根", role: "top_manager" });
    const node = await repos.org.createNode({ projectId: p.id, parentId: root.id, name: "团队", role: "member" });
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const removed = await service.deleteNode(access, p.id, node.id);
    const undo = await compensation.revoke(access, p.id, removed.auditId);
    const newChild = await repos.org.createNode({ projectId: p.id, parentId: node.id, name: "后来下级", role: "member" });
    await assert.rejects(() => compensation.revoke(access, p.id, undo.id), { code: "compensation_conflict" });
    await repos.org.deleteNode(newChild.id);
    const m = await repos.members.create({ projectId: p.id, kind: "human", displayName: "后来占岗" });
    await repos.org.assignNode(m.id, node.id);
    await assert.rejects(() => compensation.revoke(access, p.id, undo.id), { code: "compensation_conflict" });
    assert.equal((await repos.members.get(m.id))!.nodeId, node.id);
    const before = (await repos.org.getNode(node.id))!, after = await repos.org.updateNode(node.id, { name: "新名" });
    const legacy = await appendAuditEntry(repos.audit, { projectId: p.id, actor: { kind: "human", name: "人" }, action: "org.node_update", targetKind: "node", targetId: node.id, targetName: node.name, before, after });
    let current = legacy;
    for (let i = 0; i < 5; i++) { current = await compensation.revoke(access, p.id, current.id); assert.equal((await repos.org.getNode(node.id))!.name, i % 2 === 0 ? "团队" : "新名"); }
    assert.equal((await repos.members.get(m.id))!.nodeId, node.id);
  }));
  test(`${engine} 占岗捕获被降级的旧 manager，状态补偿保留成员其他字段`, { skip }, async () => withDb(engine, async (repos) => {
    const p = await repos.projects.create({ name: "角色投影" });
    const old = await repos.members.create({ projectId: p.id, kind: "human", displayName: "旧负责人", role: "manager" });
    const next = await repos.members.create({ projectId: p.id, kind: "human", displayName: "新负责人" });
    const root = await repos.org.createNode({ projectId: p.id, name: "根", role: "top_manager" });
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const assigned = await service.assignNode(access, p.id, next.id, root.id);
    assert.equal((await repos.members.get(old.id))!.role, "normal");
    const undo = await compensation.revoke(access, p.id, assigned.auditId);
    assert.equal((await repos.members.get(old.id))!.role, "manager");
    assert.equal((await repos.members.get(next.id))!.nodeId, null);
    await compensation.revoke(access, p.id, undo.id);
    const paused = await service.setMemberStatus(access, p.id, next.id, "disabled");
    await repos.members.update(next.id, { displayName: "另改姓名" });
    await compensation.revoke(access, p.id, paused.auditId);
    assert.equal((await repos.members.get(next.id))!.status, "active");
    assert.equal((await repos.members.get(next.id))!.displayName, "另改姓名");
    assert.equal((await repos.members.get(next.id))!.nodeId, root.id);
  }));
}
