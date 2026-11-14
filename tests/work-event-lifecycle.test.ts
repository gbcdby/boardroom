import test from 'node:test';
import assert from 'node:assert/strict';
import { identityEngines, identityFixture, identitySkip } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { initializePolicyConfiguration } from '../src/server/policy/configuration.ts';
import { createOrgMutationService } from '../src/server/org/mutations.ts';
import { createAuditCompensationService } from '../src/server/audit-compensation.ts';
import { createDecisionService } from '../src/server/decisions/service.ts';
import { readDecisionProjectGraph } from '../src/server/decisions/repository.ts';
import { actorForMember } from '../src/server/authz/actors.ts';
import { createMemoryService } from '../src/server/memory/service.ts';
import { DEFAULT_MEMORY_CONFIG } from '../src/server/config.ts';
import { WriteFailedError } from '../src/server/db/errors.ts';
import { onWorkEventCommit } from '../src/server/tasks/events.ts';
import { onResourceChange } from '../src/server/resource-changes.ts';
import type { LiveDecisionView } from '../src/shared/decisions.ts';

const at = '2026-11-14T00:00:00.000Z';
for (const engine of identityEngines) {
  test(`${engine}: WL01–04 member remove/undo/redo preserves originals and never revives old delivery eligibility`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos);
      const org = createOrgMutationService({ repos: f.repos }), compensation = createAuditCompensationService({ repos: f.repos });
      const old = await f.db.query('SELECT * FROM work_events WHERE project_id=? ORDER BY id', [p.project.id]);
      const assignment = old.find(e => e.recipient_member_id === p.worker.id)!;
      const ready = old.find(e => e.recipient_member_id === p.reviewer.id)!;
      const managerNotice = old.find(e => e.recipient_member_id === p.manager.id)!;
      await f.repos.tasks.acknowledgeWorkEvent(p.project.id, p.worker.id, String(assignment.id), at);
      await f.repos.tasks.markWorkEventsDelivered(p.project.id, p.reviewer.id, [String(ready.id)], at);
      await f.repos.tasks.acknowledgeWorkEvent(p.project.id, p.manager.id, String(managerNotice.id), at);
      const original = await f.db.query('SELECT * FROM work_events WHERE project_id=? ORDER BY id', [p.project.id]);
      const originals = async () => (await f.db.query('SELECT * FROM work_events WHERE project_id=? ORDER BY id', [p.project.id])).filter(e => original.some(o => o.id === e.id));
      const removed = await org.removeMember(p.owner, p.project.id, p.worker.id);
      assert.deepEqual(await originals(), original);
      const markers = await f.db.query('SELECT * FROM work_event_delivery_invalidations WHERE project_id=? ORDER BY work_event_id', [p.project.id]);
      assert.deepEqual(markers.map(m => m.work_event_id).sort(), [assignment.id, ready.id].sort());
      assert.ok(markers.every(m => m.cause_audit_id === removed.auditId && Number(m.cause_from_revision) === 1 && Number(m.cause_to_revision) === 2));
      const decision = (await f.db.query('SELECT * FROM decision_records WHERE project_id=?', [p.project.id]))[0]!;
      assert.equal(decision.status, 'cancelled');
      const undo = await compensation.revoke(p.owner, p.project.id, removed.auditId);
      const redo = await compensation.revoke(p.owner, p.project.id, undo.id);
      await compensation.revoke(p.owner, p.project.id, redo.id);
      assert.equal((await f.repos.members.get(p.worker.id))!.membershipRevision, 5);
      assert.deepEqual((await f.db.query('SELECT * FROM work_event_delivery_invalidations WHERE project_id=? ORDER BY work_event_id', [p.project.id]))
        .filter(m => markers.some(old => old.work_event_id === m.work_event_id)), markers);
      assert.deepEqual(await originals(), original);
      const restoredEvents = await f.repos.tasks.listUnackedWorkEvents(p.project.id, p.worker.id);
      assert.ok(restoredEvents.every(e => !original.some(old => old.id === e.id)), '恢复可产生新的分派事实，但不能复活任何旧事件');
      for (const event of restoredEvents) await f.repos.tasks.acknowledgeWorkEvent(p.project.id, p.worker.id, event.id, at);
      assert.deepEqual(await f.repos.tasks.markWorkEventsDelivered(p.project.id, p.reviewer.id, [String(ready.id)], at), []);
      for (const event of [assignment, ready]) await assert.rejects(f.repos.tasks.acknowledgeWorkEvent(p.project.id, String(event.recipient_member_id), String(event.id), at), { reason: 'work_event_delivery_invalidated' });
      assert.equal((await f.repos.tasks.acknowledgeWorkEvent(p.project.id, p.manager.id, String(managerNotice.id), at)).alreadyAcknowledged, true);
      assert.deepEqual((await f.db.query('SELECT * FROM decision_records WHERE project_id=?', [p.project.id]))[0], decision);
      const next = await p.service.create(p.owner, p.project.id, { title: '恢复后的新任务', assigneeMemberId: p.worker.id });
      const group = await f.repos.groups.create({ projectId: p.project.id, name: '恢复后新会话', participantMemberIds: [p.worker.id] });
      const fresh = await p.service.deliverWorkEvents({ actor: actorForMember((await f.repos.members.get(p.worker.id))!),
        connection: { projectId: p.project.id, memberId: p.worker.id, groupId: group.id, membershipRevision: 5 } }, p.project.id);
      assert.deepEqual(fresh.map(e => e.taskId), [next.id]);
      await f.db.readSnapshot(read => readDecisionProjectGraph(read, p.project.id));
    } finally { await f.close(); }
  });

  test(`${engine}: WL05/06 completion history survives while raw Memory cursor advances past invalidated sources and retry stays blocked`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      for (const materializeFirst of [false, true]) {
        const p = await decisionDomainFixture(f.repos), decisions = createDecisionService(f.db);
        const first = (await decisions.list(p.owner, p.project.id)).decisions.find(d => d.recordKind === 'live-review-decision') as LiveDecisionView;
        const applied = await decisions.resolve({ actor: actorForMember(p.manager) }, p.project.id, first.ref.decisionId,
          { decisionRef: first.ref, choiceId: 'approve', reason: '真实完成来源', idempotencyKey: 'done' });
        const group = await f.repos.groups.create({ projectId: p.project.id, name: '记忆资格', participantMemberIds: [p.worker.id] });
        const own = { actor: actorForMember(p.worker), connection: { projectId: p.project.id, memberId: p.worker.id, groupId: group.id, membershipRevision: 1 } };
        const memory = createMemoryService({ repos: f.repos, config: DEFAULT_MEMORY_CONFIG,
          injectionReader: { readOwn: async () => ({ state: 'available', entries: [], errors: [], maxBytes: 8192 }), close: async () => {} }, readVisibleMessages: async () => [] });
        if (materializeFirst) assert.equal((await memory.reconcileTriggers(own)).scheduled, 1);
        const requests = await f.repos.memory.listRequests(p.project.id, p.worker.agentId!);
        assert.equal(requests.length, materializeFirst ? 1 : 0);
        const effect = (await f.db.query("SELECT * FROM work_events WHERE project_id=? AND kind='task.review_decided'", [p.project.id]))[0]!;
        const resolution = await f.db.query('SELECT * FROM decision_resolutions WHERE project_id=?', [p.project.id]);
        const removed = await createOrgMutationService({ repos: f.repos }).removeMember(p.owner, p.project.id, p.worker.id);
        await createAuditCompensationService({ repos: f.repos }).revoke(p.owner, p.project.id, removed.auditId);
        assert.deepEqual((await f.db.query('SELECT * FROM work_events WHERE id=?', [effect.id]))[0], effect);
        assert.deepEqual(await f.db.query('SELECT * FROM decision_resolutions WHERE project_id=?', [p.project.id]), resolution);
        await f.db.readSnapshot(read => readDecisionProjectGraph(read, p.project.id));
        const scope = { kind: 'task_completed' as const, projectId: p.project.id, agentId: p.worker.agentId!, groupId: null };
        const through = await f.repos.memory.scanHighWater(scope); assert.ok(through);
        const page = await f.repos.memory.scanUnmaterializedTaskCompletions(p.project.id, p.worker.agentId!, { after: null, through, limit: 50 });
        assert.deepEqual(page.rows, []); assert.equal(page.scannedCount, 1); assert.deepEqual(page.nextCursor, through);
        if (materializeFirst) await assert.rejects(memory.retrySummary(p.owner, requests[0]!.id, 'restored-retry'), { reason: 'memory_summary_source_changed' });
        const restored = { ...own, actor: actorForMember((await f.repos.members.get(p.worker.id))!), connection: { ...own.connection, membershipRevision: 3 } };
        assert.equal((await memory.reconcileTriggers(restored)).scheduled, 0);
        assert.equal((await f.repos.memory.listRequests(p.project.id, p.worker.agentId!)).length, requests.length);
        assert.equal(applied.current.status, 'resolved');
      }
    } finally { await f.close(); }
  });

  test(`${engine}: WL07 failure after invalidation and cancellation rolls back lifecycle, audit, originals and notifications`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine); let unsubscribe = () => {}, resources = () => {};
    try {
      await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos);
      const tables = ['members','tasks','task_review_rounds','decision_records','decision_changes','decision_change_heads','work_events','work_event_delivery_invalidations','audit_log','member_fact_revisions'];
      const capture = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await f.db.query(`SELECT * FROM ${table}`)).map(row => JSON.stringify(row)).sort()])));
      const before = await capture(), notices: unknown[] = []; unsubscribe = onWorkEventCommit(f.db, events => { notices.push(events); }); resources = onResourceChange(f.db, event => { notices.push(event); });
      const append = f.repos.audit.append; let reached = false;
      f.repos.audit.append = async row => { const result = await append(row); if (row.action === 'member.remove') { reached = true; throw new WriteFailedError('在真实 marker/Decision/成员/audit 写入后失败'); } return result; };
      try { await assert.rejects(createOrgMutationService({ repos: f.repos }).removeMember(p.owner, p.project.id, p.worker.id), { code: 'write_failed' }); }
      finally { f.repos.audit.append = append; }
      assert.equal(reached, true); assert.deepEqual(await capture(), before); assert.deepEqual(notices, []);
    } finally { unsubscribe(); resources(); await f.close(); }
  });
}
