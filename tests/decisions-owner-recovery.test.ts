import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from 'pg';
import { identityEngines, identityFixture, identitySkip } from './helpers/identity-fixture.ts';
import { identityPgUrl } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { createDecisionService, type DecisionService } from '../src/server/decisions/service.ts';
import { initializePolicyConfiguration, createPolicyConfiguration } from '../src/server/policy/configuration.ts';
import { actorForMember } from '../src/server/authz/actors.ts';
import { createOrgMutationService } from '../src/server/org/mutations.ts';
import { DB_REVIEW_HANDLER } from '../src/server/decisions/effect.ts';
import { onWorkEventCommit } from '../src/server/tasks/events.ts';
import { onResourceChange } from '../src/server/resource-changes.ts';
import { DECISION_TABLE_NAMES } from '../src/server/decisions/tables.ts';
import type { LiveDecisionView } from '../src/shared/decisions.ts';
import type { DbDriver } from '../src/server/db/driver.ts';

type Domain = Awaited<ReturnType<typeof decisionDomainFixture>>;
const at = '2026-11-15T01:00:00.000Z';

async function current(service: DecisionService, p: Domain): Promise<LiveDecisionView> {
  const decision = (await service.list(p.owner, p.project.id)).decisions.find(d => d.recordKind === 'live-review-decision' && d.isCurrent);
  assert.ok(decision && decision.recordKind === 'live-review-decision');
  return decision;
}

async function requests(db: DbDriver, p: Domain) {
  return db.query("SELECT * FROM work_events WHERE project_id=? AND kind='decision.requested' ORDER BY id", [p.project.id]);
}
async function capture(db: DbDriver) {
  const tables = [...DECISION_TABLE_NAMES, 'tasks', 'task_review_rounds', 'task_history', 'work_events', 'audit_log', 'member_fact_revisions', 'work_event_delivery_invalidations'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await db.query(`SELECT * FROM ${table}`)).map(row => JSON.stringify(row)).sort()])));
}
async function assertNoEffect(db: DbDriver, p: Domain) {
  for (const table of ['decision_user_events', 'decision_local_initiations', 'decision_resolutions', 'decision_executions'])
    assert.deepEqual(await db.query(`SELECT * FROM ${table} WHERE project_id=?`, [p.project.id]), []);
}

for (const engine of identityEngines) {
  test(`${engine}: S1-T5-R01 refresh restores one durable request after the same owner's old notice was ACKed`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db, { now: () => new Date(at) });
      const first = await current(service, p), access = { actor: actorForMember(p.manager) };
      const original = (await f.repos.tasks.listUnackedWorkEvents(p.project.id, p.manager.id))
        .filter(event => event.kind === 'decision.requested' && event.payload.decisionId === first.ref.decisionId);
      assert.equal(original.length, 1);
      await f.repos.tasks.markWorkEventsDelivered(p.project.id, p.manager.id, [original[0]!.id], at);
      await f.repos.tasks.acknowledgeWorkEvent(p.project.id, p.manager.id, original[0]!.id, at);
      const acknowledged = await f.db.query('SELECT * FROM work_events WHERE id=?', [original[0]!.id]);
      const task = await f.repos.tasks.get(p.project.id, p.task.id), round = await f.repos.tasks.getRound(p.project.id, p.task.id, p.round.id);

      const refreshed = await service.refresh(access, p.project.id, first.ref.decisionId,
        { decisionRef: first.ref, idempotencyKey: 'refresh-after-ack' });
      const notifications = (await f.repos.tasks.listUnackedWorkEvents(p.project.id, p.manager.id))
        .filter(event => event.kind === 'decision.requested' && event.payload.decisionId === first.ref.decisionId);
      assert.equal(notifications.length, 1, 'the committed new Decision revision must have one recoverable request');
      assert.equal(refreshed.state, 'refreshed');
      assert.equal(refreshed.current.status, 'pending');
      assert.equal(refreshed.decisionRef.revision, first.ref.revision + 1);
      assert.equal(refreshed.current.assigneeMemberId, p.manager.id);
      assert.deepEqual(notifications[0], {
        id: notifications[0]!.id, projectId: p.project.id, taskId: p.task.id, recipientMemberId: p.manager.id,
        kind: 'decision.requested', eventKey: `decision:${first.ref.decisionId}:${first.ref.revision + 1}:${p.manager.id}:requested`,
        payload: { taskId: p.task.id, decisionId: first.ref.decisionId, decisionRevision: first.ref.revision + 1 },
        deliveryState: 'pending', attempts: 0, createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null,
      });
      assert.deepEqual(await f.db.query('SELECT * FROM work_events WHERE id=?', [original[0]!.id]), acknowledged);
      assert.deepEqual(await f.repos.tasks.get(p.project.id, p.task.id), task);
      assert.deepEqual(await f.repos.tasks.getRound(p.project.id, p.task.id, p.round.id), round);
      for (const table of ['decision_user_events', 'decision_local_initiations', 'decision_resolutions', 'decision_executions']) {
        assert.deepEqual(await f.db.query(`SELECT * FROM ${table} WHERE project_id=?`, [p.project.id]), []);
      }
    } finally { await f.close(); }
  });

  for (const sameId of [false, true]) test(`${engine}: S1-T5-R0${sameId ? 3 : 2} real owner removal and ${sameId ? 'same-ID rejoin' : 'replacement'} preserves invalidated history`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), first = await current(service, p);
      const old = await requests(f.db, p), org = createOrgMutationService({ repos: f.repos });
      await org.removeMember(p.owner, p.project.id, p.manager.id);
      const agent = sameId ? (await f.repos.agents.get(p.manager.agentId!))! : await f.repos.agents.create({ displayName: `replacement-${p.project.id}`, hostType: 'other' });
      const replacement = (await org.addMember(p.owner, { projectId: p.project.id, agentId: agent.id, kind: 'agent', displayName: '新当前负责人', role: 'manager' })).member;
      assert.equal(replacement.id === p.manager.id, sameId);
      if (sameId) assert.equal(replacement.membershipRevision, 3);
      const markers = await f.db.query('SELECT * FROM work_event_delivery_invalidations WHERE project_id=? ORDER BY work_event_id', [p.project.id]);
      assert.ok(markers.some(marker => marker.work_event_id === old[0]!.id));
      const stillPending = await current(service, p);
      assert.deepEqual(stillPending.ref, first.ref, 'removing only the owner does not invalidate this Task candidate');
      const result = await service.refresh(p.owner, p.project.id, first.ref.decisionId, { decisionRef: first.ref, idempotencyKey: 'restore-owner' });
      assert.equal(result.current.assigneeMemberId, replacement.id);
      const fresh = (await f.repos.tasks.listUnackedWorkEvents(p.project.id, replacement.id)).filter(e => e.kind === 'decision.requested');
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0]!.payload.decisionRevision, result.decisionRef.revision);
      assert.equal(fresh[0]!.recipientMemberId, replacement.id);
      assert.deepEqual((await requests(f.db, p)).filter(e => old.some(o => o.id === e.id)), old);
      assert.deepEqual(await f.db.query('SELECT * FROM work_event_delivery_invalidations WHERE project_id=? ORDER BY work_event_id', [p.project.id]), markers);
      await assert.rejects(f.repos.tasks.acknowledgeWorkEvent(p.project.id, p.manager.id, String(old[0]!.id), at),
        sameId ? { reason: 'work_event_delivery_invalidated' } : { name: 'InvalidReferenceError' });
      await assertNoEffect(f.db, p);
    } finally { await f.close(); }
  });

  test(`${engine}: S1-T5-R04 human, deny, missing owner and unavailable handler never enqueue an Agent request`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      for (const outcome of ['human', 'deny', 'missing-owner', 'unavailable-handler'] as const) {
        const p = await decisionDomainFixture(f.repos), policy = createPolicyConfiguration({ repos: f.repos });
        const service = createDecisionService(f.db, outcome === 'unavailable-handler' ? { handler: { ...DB_REVIEW_HANDLER, available: false } } : {});
        const first = await current(service, p), before = await requests(f.db, p);
        if (outcome === 'human' || outcome === 'deny') {
          const old = await policy.getGlobal(p.owner);
          await policy.updateGlobal(p.owner, { expectedRevision: old.ref.revision,
            rules: old.document.rules.map(rule => rule.ruleId === 'default.review.decide' ? { ...rule, outcome, requiresFreshHuman: outcome === 'human' } : rule) });
        } else {
          const old = await policy.getGlobal(p.owner);
          await policy.updateGlobal(p.owner, { expectedRevision: old.ref.revision,
            rules: old.document.rules.map(rule => rule.ruleId === 'default.review.decide' ? { ...rule, outcome: 'owner', requiresFreshHuman: false } : rule) });
          if (outcome === 'missing-owner') await createOrgMutationService({ repos: f.repos }).setMemberStatus(p.owner, p.project.id, p.manager.id, 'disabled');
        }
        const result = await service.refresh(p.owner, p.project.id, first.ref.decisionId, { decisionRef: first.ref, idempotencyKey: `blocked-${outcome}` });
        assert.equal(result.state, 'refreshed'); assert.equal(result.current.status, 'pending');
        if (outcome === 'human') assert.equal(result.requiredAuthority, 'human');
        if (outcome === 'missing-owner') assert.equal(result.blockedReason, 'assignee_unavailable');
        if (outcome === 'deny' || outcome === 'unavailable-handler') assert.equal(result.requiredAuthority, null);
        assert.deepEqual(await requests(f.db, p), before);
        await assertNoEffect(f.db, p);
      }
    } finally { await f.close(); }
  });

  for (const entry of ['resolve', 'legacy'] as const) for (const outcome of ['auto', 'human'] as const)
  test(`${engine}: S1-T5-R05 ${entry} policy refresh to ${outcome} preserves authority without resolving`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), first = await current(service, p);
      const policy = createPolicyConfiguration({ repos: f.repos }), old = await policy.getGlobal(p.owner), access = { actor: actorForMember(p.manager) };
      await policy.updateGlobal(p.owner, { expectedRevision: old.ref.revision,
        rules: old.document.rules.map(rule => rule.ruleId === 'default.review.decide' ? { ...rule, outcome, requiresFreshHuman: outcome === 'human' } : rule) });
      const result = entry === 'resolve'
        ? await service.resolve(access, p.project.id, first.ref.decisionId, { decisionRef: first.ref, choiceId: 'approve', reason: '旧版本明确选择', idempotencyKey: 'implicit-refresh' })
        : await p.service.decideReview(access, p.project.id, p.task.id, p.round.id,
          { expectedTaskRevision: p.task.revision, expectedRoundRevision: p.round.revision, verdict: 'pass', reason: '旧入口选择', override: true });
      assert.equal(result.state, 'refreshed'); assert.equal(result.receipt.httpStatus, 409);
      assert.equal(result.requiredAuthority, outcome);
      assert.equal(result.current.assigneeMemberId, outcome === 'auto' ? p.reviewer.id : null);
      const fresh = (await f.repos.tasks.listUnackedWorkEvents(p.project.id, p.reviewer.id)).filter(e => e.kind === 'decision.requested');
      assert.equal(fresh.length, outcome === 'auto' ? 1 : 0);
      if (outcome === 'auto') assert.equal(fresh[0]!.payload.decisionRevision, result.decisionRef.revision);
      else assert.equal((await requests(f.db, p)).length, 1, 'human refresh cannot create an Agent notification');
      assert.equal((await f.repos.tasks.get(p.project.id, p.task.id))!.state, 'review');
      await assertNoEffect(f.db, p);
    } finally { await f.close(); }
  });

  test(`${engine}: S1-T5-R06 immutable refresh replay and stale refs cannot add notifications`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), first = await current(service, p), access = { actor: actorForMember(p.manager) };
      const input = { decisionRef: first.ref, idempotencyKey: 'original' };
      const result = await service.refresh(access, p.project.id, first.ref.decisionId, input), initial = await capture(f.db);
      const replay = await service.refresh(access, p.project.id, first.ref.decisionId, input);
      assert.equal(replay.replay, 'same-key'); assert.deepEqual(replay.receipt, result.receipt); assert.deepEqual(await capture(f.db), initial);
      await assert.rejects(service.refresh(access, p.project.id, first.ref.decisionId, { ...input, decisionRef: result.decisionRef }), { reason: 'idempotency_conflict' });
      await assert.rejects(service.refresh(access, p.project.id, first.ref.decisionId, { ...input, idempotencyKey: 'stale' }), { reason: 'decision_revision_conflict' });
      assert.deepEqual(await capture(f.db), initial);
      const newer = await service.refresh(access, p.project.id, first.ref.decisionId, { decisionRef: result.decisionRef, idempotencyKey: 'newer' });
      const higher = await capture(f.db);
      assert.deepEqual((await service.refresh(access, p.project.id, first.ref.decisionId, input)).receipt, result.receipt);
      assert.deepEqual(await capture(f.db), higher);
      await service.resolve(access, p.project.id, first.ref.decisionId, { decisionRef: newer.decisionRef, choiceId: 'reject', reason: '真正终结', idempotencyKey: 'terminal' });
      const terminal = await capture(f.db);
      assert.deepEqual((await service.refresh(access, p.project.id, first.ref.decisionId, input)).receipt, result.receipt, 'valid original replay survives a later terminal decision');
      await assert.rejects(service.refresh(access, p.project.id, first.ref.decisionId, { decisionRef: newer.decisionRef, idempotencyKey: 'new-terminal-refresh' }), { reason: 'decision_terminal' });
      assert.deepEqual(await capture(f.db), terminal);
      await f.repos.members.setStatus(p.manager.id, 'disabled');
      const revoked = await capture(f.db);
      await assert.rejects(service.refresh(access, p.project.id, first.ref.decisionId, input), { name: 'ForbiddenError' });
      await assert.rejects(service.refresh(access, p.project.id, first.ref.decisionId, { ...input, idempotencyKey: 'revoked-new' }), { name: 'ForbiddenError' });
      assert.deepEqual(await capture(f.db), revoked);
    } finally { await f.close(); }
  });

  for (const sameKey of [false, true]) test(`${engine}: S1-T5-R07 concurrent ${sameKey ? 'same' : 'different'} keys commit one revision and request`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), first = await current(service, p), access = { actor: actorForMember(p.manager) };
      const results = await Promise.allSettled([0, 1].map(i => service.refresh(access, p.project.id, first.ref.decisionId,
        { decisionRef: first.ref, idempotencyKey: sameKey ? 'same-key' : `key-${i}` })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, sameKey ? 2 : 1);
      if (sameKey) {
        const [a, b] = results; assert.ok(a && b && a.status === 'fulfilled' && b.status === 'fulfilled');
        assert.deepEqual(a.value.receipt, b.value.receipt);
      } else {
        const loser = results.find(r => r.status === 'rejected')!; assert.equal(loser.status, 'rejected');
        assert.equal(loser.reason.reason, 'decision_revision_conflict');
      }
      assert.equal((await current(service, p)).ref.revision, first.ref.revision + 1);
      assert.equal((await requests(f.db, p)).length, 2);
      assert.equal((await f.db.query('SELECT * FROM decision_command_receipts')).length, 1);
      await assertNoEffect(f.db, p);
    } finally { await f.close(); }
  });

  test(`${engine}: S1-T5-R08 event and later receipt failures roll back all state and commit hints`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine), exec = f.db.exec.bind(f.db), transaction = f.db.transaction.bind(f.db);
    let stopWork = () => {}, stopResource = () => {};
    try {
      await initializePolicyConfiguration(f.repos);
      const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), first = await current(service, p);
      const before = await capture(f.db), notices: unknown[] = [], access = { actor: actorForMember(p.manager) };
      stopWork = onWorkEventCommit(f.db, events => { notices.push(...events); });
      stopResource = onResourceChange(f.db, event => { notices.push(event); });
      const input = { decisionRef: first.ref, idempotencyKey: 'retry-after-rollback' };
      for (const [name, pattern] of [['event', /^INSERT INTO work_events\b/], ['receipt', /^INSERT INTO decision_command_receipts\b/]] as const) {
        let injected = false;
        const wrap = (execute: typeof exec): typeof exec => async (sql, params) => {
          const value = await execute(sql, params);
          if (!injected && pattern.test(sql.trim())) { injected = true; throw new Error(`scoped failure after ${name}`); }
          return value;
        };
        f.db.exec = wrap(exec); f.db.transaction = body => transaction(tx => body({ query: tx.query.bind(tx), exec: wrap(tx.exec.bind(tx)) }));
        try { await assert.rejects(service.refresh(access, p.project.id, first.ref.decisionId, input)); }
        finally { f.db.exec = exec; f.db.transaction = transaction; }
        assert.equal(injected, true, name); assert.deepEqual(await capture(f.db), before, name); assert.deepEqual(notices, [], name);
      }
      const result = await service.refresh(access, p.project.id, first.ref.decisionId, input);
      assert.equal(result.decisionRef.revision, first.ref.revision + 1); assert.equal((await requests(f.db, p)).length, 2);
      assert.equal(notices.length, 2, 'one resource hint and one WorkEvent, both after actual commit');
    } finally { f.db.exec = exec; f.db.transaction = transaction; stopWork(); stopResource(); await f.close(); }
  });

  test(`${engine}: S1-T5-R09 superseded, changed candidate, archived and foreign targets never notify`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      for (const kind of ['superseded', 'candidate', 'archive', 'foreign', 'forged-recipient'] as const) {
        const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), first = await current(service, p);
        if (kind === 'superseded') await service.request(p.owner, p.slot, { expectedTaskRevision: p.task.revision, expectedRoundRevision: p.round.revision,
          proposedVerdict: 'changes_requested', reason: '明确后继', requestedPath: 'management', expectedHead: first.head, idempotencyKey: 'successor' });
        if (kind === 'candidate') await p.service.update(p.owner, p.project.id, p.task.id, { expectedRevision: p.task.revision, body: '新的候选材料' });
        if (kind === 'archive') await f.repos.projects.archive(p.project.id);
        const before = await capture(f.db);
        const projectId = kind === 'foreign' ? (await f.repos.projects.create({ name: '无关项目' })).id : p.project.id;
        await assert.rejects(service.refresh(p.owner, projectId, first.ref.decisionId,
          { decisionRef: first.ref, idempotencyKey: `forbidden-${kind}`, ...(kind === 'forged-recipient' ? { assigneeMemberId: p.worker.id } : {}) }));
        assert.deepEqual(await capture(f.db), before, kind);
      }
    } finally { await f.close(); }
  });

  test(`${engine}: S1-T5-R10 reconstruction, reads, delivery and ACK never self-refresh`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), first = await current(service, p), access = { actor: actorForMember(p.manager) };
      const result = await service.refresh(access, p.project.id, first.ref.decisionId, { decisionRef: first.ref, idempotencyKey: 'restart-read' });
      const rebuilt = createDecisionService(f.db), saved = await f.db.query('SELECT * FROM decision_records'), events = await requests(f.db, p);
      for (let i = 0; i < 3; i++) {
        assert.deepEqual((await rebuilt.get(access, p.project.id, first.ref.decisionId) as LiveDecisionView).ref, result.decisionRef);
        await rebuilt.list(access, p.project.id); await rebuilt.changes(access, p.project.id, 0);
        const pending = await f.repos.tasks.listUnackedWorkEvents(p.project.id, p.manager.id);
        await f.repos.tasks.markWorkEventsDelivered(p.project.id, p.manager.id, pending.map(e => e.id), at);
        for (const event of pending) await f.repos.tasks.acknowledgeWorkEvent(p.project.id, p.manager.id, event.id, at);
      }
      assert.deepEqual(await f.db.query('SELECT * FROM decision_records'), saved);
      assert.deepEqual((await requests(f.db, p)).map(e => e.id), events.map(e => e.id));
      assert.deepEqual(await f.repos.tasks.listUnackedWorkEvents(p.project.id, p.manager.id), []);
      assert.equal((await f.db.query('SELECT * FROM decision_command_receipts')).length, 1);
    } finally { await f.close(); }
  });
}

function signal() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function boundary(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('required lock boundary not observed')), 1000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test('postgres: S1-T5-R07 distinct refresh writers actually contend on the production project lock', { skip: identitySkip('postgres'), timeout: 10_000 }, async t => {
  const f = await identityFixture('postgres'), observer = new Client({ connectionString: identityPgUrl });
  const release = signal(), held = signal(), attempted = signal(), trace = new AsyncLocalStorage<'first' | 'second'>();
  const exec = f.db.exec.bind(f.db), transaction = f.db.transaction.bind(f.db), pids = new Map<string, number>(), pending: Promise<unknown>[] = [];
  const seen = new Set<string>();
  try {
    await observer.connect(); await initializePolicyConfiguration(f.repos);
    const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), first = await current(service, p), access = { actor: actorForMember(p.manager) };
    const wrap = (execute: typeof exec): typeof exec => async (sql, params) => {
      const label = trace.getStore(), projectLock = /^UPDATE projects SET updated_at = updated_at WHERE id = \?$/.test(sql.trim());
      const globalLock = /^UPDATE policy_documents SET updated_at\s*=\s*updated_at WHERE scope_key\s*=\s*'user'/.test(sql.trim());
      if (label && projectLock && !pids.has(label)) {
        pids.set(label, Number((await f.db.query('SELECT pg_backend_pid() AS pid'))[0]!.pid));
        if (label === 'second') attempted.resolve();
      }
      const value = await execute(sql, params);
      if (label === 'first' && globalLock && !seen.has(label)) { seen.add(label); held.resolve(); await release.promise; }
      return value;
    };
    f.db.exec = wrap(exec); f.db.transaction = body => transaction(tx => body({ query: tx.query.bind(tx), exec: wrap(tx.exec.bind(tx)) }));
    const refresh = (label: 'first' | 'second') => trace.run(label, () => service.refresh(access, p.project.id, first.ref.decisionId,
      { decisionRef: first.ref, idempotencyKey: label }));
    const one = refresh('first'); pending.push(one); await boundary(held.promise);
    const two = refresh('second'); pending.push(two); const secondOutcome = two.then(value => ({ value, error: null }), error => ({ value: null, error }));
    await boundary(attempted.promise);
    assert.equal(pids.size, 2); assert.notEqual(pids.get('first'), pids.get('second'));
    let blocked = false; const deadline = Date.now() + 1000;
    while (!blocked && Date.now() < deadline) {
      const rows = await observer.query('SELECT pg_blocking_pids($1) AS blockers', [pids.get('second')]);
      blocked = rows.rows[0].blockers.includes(pids.get('first'));
    }
    assert.equal(blocked, true, 'actual second backend must wait for the first production lock');
    release.resolve(); const winner = await one, loser = await secondOutcome;
    assert.equal(loser.error?.reason, 'decision_revision_conflict'); assert.equal(winner.decisionRef.revision, first.ref.revision + 1);
    assert.equal((await requests(f.db, p)).length, 2); assert.equal((await f.db.query('SELECT * FROM decision_command_receipts')).length, 1);
    t.diagnostic(JSON.stringify({ backendPids: Object.fromEntries(pids), actualLockWait: blocked, committedRevision: winner.decisionRef.revision }));
  } finally { release.resolve(); await Promise.allSettled(pending); f.db.exec = exec; f.db.transaction = transaction; await observer.end(); await f.close(); }
});
