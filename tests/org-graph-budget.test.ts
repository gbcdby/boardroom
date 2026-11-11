import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureBudget } from '../src/server/org/capture-budget.ts';
import { createOrgMutationService } from '../src/server/org/mutations.ts';
import { createAuditCompensationService } from '../src/server/audit-compensation.ts';
import { ownerActor } from '../src/server/authz/actors.ts';
import { memoryFixture, pgUnavailable } from './helpers/memory-fixture.ts';

class MeasuredBudget extends CaptureBudget {
  returnedBytes = 0;
  maxRowBytes = 0;
  batches: Array<{ sql: string; rows: number; bytes: number }> = [];
  override after(sql: string, result: unknown, kind: 'query' | 'exec'): void {
    if (kind === 'query' && Array.isArray(result)) {
      const sizes = result.map(row => Buffer.byteLength(JSON.stringify(row)));
      const bytes = sizes.reduce((total, size) => total + size, 0);
      this.returnedBytes += bytes; this.maxRowBytes = Math.max(this.maxRowBytes, ...sizes);
      this.batches.push({ sql, rows: result.length, bytes });
    }
    super.after(sql, result, kind);
  }
}
const access = { actor: ownerActor() };
for (const engine of ['sqlite', 'postgres'] as const) {
  const gate = { skip: engine === 'postgres' ? pgUnavailable : false };
  for (const field of ['node-name', 'occupant-name'] as const) {
    test(`${engine} 岗位补偿有界捕获 ${field}，不先加载百万字符再拒绝`, gate, async t => memoryFixture(async (repos, db) => {
      const p = await repos.projects.create({ name: '损坏大字段' });
      const root = await repos.org.createNode({ projectId: p.id, name: '根', role: 'top_manager' });
      const node = await repos.org.createNode({ projectId: p.id, parentId: root.id, name: '小岗位', role: 'member' });
      const member = await repos.members.create({ projectId: p.id, kind: 'human', displayName: '原占岗人' });
      await repos.org.assignNode(member.id, node.id);
      const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
      const action = field === 'node-name'
        ? await service.updateNode(access, p.id, node.id, { name: '新小岗位' })
        : await service.deleteNode(access, p.id, node.id);
      await db.exec(field === 'node-name' ? 'UPDATE org_nodes SET name = ? WHERE id = ?' : 'UPDATE members SET display_name = ? WHERE id = ?',
        ['长'.repeat(1000000), field === 'node-name' ? node.id : member.id]);
      const budget = new MeasuredBudget();
      let failure: unknown;
      try { await budget.run(() => compensation.revoke(access, p.id, action.auditId)); } catch (error) { failure = error; }
      t.diagnostic(JSON.stringify({ field, maxRowBytes: budget.maxRowBytes, returnedBytes: budget.returnedBytes, rows: budget.stats.rows, sql: budget.stats.sql }));
      assert.ok(budget.maxRowBytes <= 65536, `真实单行返回 ${budget.maxRowBytes} B；累计 ${budget.returnedBytes} B`);
      assert.ok(budget.returnedBytes <= budget.limits.maxReturnedBytes + 65536);
      assert.ok(!budget.batches.some(batch => /SELECT\s+\*\s+FROM\s+(org_nodes|members)\b/i.test(batch.sql)));
      if (field === 'node-name') {
        assert.equal((failure as { code?: string } | undefined)?.code, 'audit_snapshot_too_large');
        assert.equal(budget.stats.changedRows, 0);
        assert.equal((await repos.audit.get(p.id, action.auditId))!.reversedAt, null);
        assert.equal((await repos.audit.list(p.id)).length, 1);
        assert.deepEqual(await db.query('SELECT length(name) AS size, parent_id FROM org_nodes WHERE id = ?', [node.id]),
          [{ size: 1000000, parent_id: root.id }]);
      } else {
        assert.equal(failure, undefined, '成员姓名不是岗位补偿字段，不能阻止合法关系恢复');
        assert.equal((await repos.members.get(member.id))!.nodeId, node.id);
        assert.equal((await repos.members.get(member.id))!.displayName, '长'.repeat(1000000));
        assert.equal((await repos.org.getNode(node.id))!.name, '小岗位');
        assert.ok((await repos.audit.get(p.id, action.auditId))!.reversedAt);
      }
    }, engine));
  }
  test(`${engine} 岗位子边按共享预算分页，40条边完整恢复且不扫描父岗位大名称`, gate, async () => memoryFixture(async (repos, db) => {
    const p = await repos.projects.create({ name: '岗位边分页' });
    const root = await repos.org.createNode({ projectId: p.id, name: '根', role: 'top_manager' });
    const node = await repos.org.createNode({ projectId: p.id, parentId: root.id, name: '团队', role: 'sub_manager' });
    const children = [];
    for (let i = 0; i < 40; i++) children.push(await repos.org.createNode({ projectId: p.id, parentId: node.id, name: `子岗${i}`, role: 'member' }));
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const deleted = await service.deleteNode(access, p.id, node.id);
    await db.exec('UPDATE org_nodes SET name = ? WHERE id = ?', ['长'.repeat(1000000), root.id]);
    const budget = new MeasuredBudget();
    await budget.run(() => compensation.revoke(access, p.id, deleted.auditId));
    assert.ok(budget.batches.every(batch => batch.rows <= 32), `实际单批返回行数 ${budget.batches.map(batch => batch.rows).join(',')}`);
    assert.ok(budget.maxRowBytes <= 65536);
    assert.deepEqual((await repos.org.listNodes(p.id)).filter(n => n.parentId === node.id).map(n => n.id).sort(), children.map(n => n.id).sort());
    assert.equal((await repos.org.getNode(root.id))!.name, '长'.repeat(1000000));
  }, engine));
}
