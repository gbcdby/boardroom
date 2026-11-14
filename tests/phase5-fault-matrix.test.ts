import test from "node:test";
import assert from "node:assert/strict";
import { ownerActor } from "../src/server/authz/actors.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { createAuditCompensationService } from "../src/server/audit-compensation.ts";
import { memoryFixture, pgUnavailable } from "./helpers/memory-fixture.ts";
import { relationTime, seedCompleteMemberRelations, snapshotRelationsDatabase, tableRows } from "./helpers/phase5-relations-fixture.ts";

const access = { actor: ownerActor() };
const faults = [
  { name: "成员生命周期 UPDATE", table: "members", sql: /^UPDATE members SET display_name = .*membership_revision/s, undo: true },
  { name: "task CAS", table: "tasks", sql: /^UPDATE tasks SET state = .*revision = revision \+ 1/s, undo: true },
  { name: "settings CAS", table: "project_task_settings", sql: /^UPDATE project_task_settings SET default_reviewer_member_id/, undo: true },
  { name: "round supersede", table: "task_review_rounds", sql: /^UPDATE task_review_rounds SET state = 'superseded'/, undo: false },
  { name: "request cancel", table: "memory_summary_requests", sql: /^UPDATE memory_summary_requests SET state = 'cancelled'/, undo: false },
  { name: "新通知 INSERT", table: "work_events", sql: /^INSERT INTO work_events/, undo: true },
  { name: "audit INSERT", table: "audit_log", sql: /^INSERT INTO audit_log/, undo: true },
  { name: "markReversed UPDATE", table: "audit_log", sql: /^UPDATE audit_log SET reversed_at/, undo: true, onlyUndo: true },
] as const;

for (const engine of ["sqlite", "postgres"] as const) {
  const gate = { skip: engine === "postgres" ? pgUnavailable : false };
  for (const action of ["remove", "undo"] as const) for (const fault of faults) {
    if (action === "undo" && !fault.undo || action === "remove" && "onlyUndo" in fault) continue;
    test(`${engine} S5-AUDIT-11 ${action}：${fault.name} 真实 DML 后失败，逐表完整回滚`, gate, async () => memoryFixture(async (repos, db) => {
      const f = await seedCompleteMemberRelations(repos, db);
      const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
      const original = action === "undo" ? await service.removeMember(access, f.project.id, f.member.id) : null;
      const before = await snapshotRelationsDatabase(db);
      for (const table of ["messages", "message_deliveries", "member_fact_revisions", "tasks", "project_task_settings", "task_review_rounds",
        "memory_summary_requests", "memory_message_receipts", "memory_trigger_counters", "memory_scan_checkpoints", "memory_documents", "memory_versions", "group_participants", "mcp_sessions"]) {
        assert.ok(before[table]!.length > 0, `缺少完整关系 fixture: ${table}`);
      }
      const exec = repos.context.exec;
      let hits = 0, writtenRows = 0, sameTransaction = false;
      repos.context.exec = async (sql, params) => {
        const changed = await exec(sql, params);
        if (hits === 0 && fault.sql.test(sql.trim())) {
          hits++; writtenRows = changed;
          sameTransaction = Boolean(db.currentTransactionContext() && repos.mutations.current());
          assert.ok(changed > 0, "必须在真实 DML 改变行之后注入，不能是零行/写入前替身");
          assert.notDeepEqual(await tableRows(db, fault.table), before[fault.table], "事务内读回必须看到已经写入的状态");
          throw new Error(`injected_post_dml:${fault.name}`);
        }
        return changed;
      };
      try {
        await assert.rejects(() => original
          ? compensation.revoke(access, f.project.id, original.auditId)
          : service.removeMember(access, f.project.id, f.member.id), new RegExp(`injected_post_dml:${fault.name}`));
      } finally { repos.context.exec = exec; }
      assert.equal(hits, 1); assert.ok(writtenRows > 0); assert.equal(sameTransaction, true);
      const after = await snapshotRelationsDatabase(db);
      assert.deepEqual(after, before, "错误响应时全部持久化表已回滚，包括审计、reversed、触发器事实版本与暂态清理");
      if (original) assert.equal((await repos.audit.get(f.project.id, original.auditId))!.reversedAt, null);
      // The physical connection remains usable and the same operation can commit after removing only the injected fault.
      if (original) await compensation.revoke(access, f.project.id, original.auditId);
      else await service.removeMember(access, f.project.id, f.member.id);
    }, engine));
  }

  test(`${engine} S5-AUDIT-07 完整关系 remove 与五次补偿逐表读回，历史字节及旧执行事实不复活`, gate, async () => memoryFixture(async (repos, db) => {
    const f = await seedCompleteMemberRelations(repos, db);
    const before = await snapshotRelationsDatabase(db);
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const removed = await service.removeMember(access, f.project.id, f.member.id);
    let current = (await repos.audit.get(f.project.id, removed.auditId))!;
    const cancelledRequests = await tableRows(db, "memory_summary_requests");
    const factsAfterRemove = await tableRows(db, "member_fact_revisions");
    const oldEventIds = new Set(f.events.filter(e => e.deliveryState !== "acked").map(e => e.id));
    const preservedEvents = new Map(before.work_events!.map(event => [String(event.id), event]));
    const firstInvalidations = (await tableRows(db, "work_event_delivery_invalidations")).filter(marker => oldEventIds.has(String(marker.work_event_id)));
    assert.deepEqual(firstInvalidations.map(marker => String(marker.work_event_id)).sort(), [...oldEventIds].sort());
    for (let step = 0; step < 6; step++) {
      if (step > 0) current = await compensation.revoke(access, f.project.id, current.id);
      const present = step % 2 === 1;
      const rows = await snapshotRelationsDatabase(db);
      for (const table of ["messages", "message_deliveries", "memory_message_receipts", "memory_trigger_counters", "memory_scan_checkpoints",
        "memory_documents", "memory_versions", "group_participants", "task_comments", "task_message_links", "org_nodes", "agent_runtimes"]) {
        assert.deepEqual(rows[table], before[table], `${step}: ${table} 历史内容、字节、作者、mentions/client key/seq 或 joined_at 被改写`);
      }
      assert.deepEqual(rows.memory_summary_requests, cancelledRequests, `${step}: 旧总结请求不得重启或改写终态`);
      assert.deepEqual(rows.member_fact_revisions, factsAfterRemove, `${step}: 只翻转关系，不凭空制造保留事实`);
      const actualFacts = (await repos.members.retainedFacts(f.member.id)).map(x => ({ kind: x.kind, revision: x.revision }));
      assert.deepEqual(actualFacts, JSON.parse(current.after!).retained, "审计事实版本必须与数据库真实值相等");
      const member = (await repos.members.getIncludingRemoved(f.member.id))!;
      assert.equal(member.membershipRevision, f.member.membershipRevision + step + 1);
      assert.equal(Boolean(await repos.members.get(f.member.id)), present);
      assert.equal(member.nodeId, present ? f.node.id : null);
      for (const group of f.groups) assert.equal((await repos.groups.participants(group.id)).includes(f.member.id), present);
      const settings = await repos.tasks.getSettings(f.project.id);
      assert.equal(settings.revision, step + 2);
      assert.equal(settings.defaultReviewerMemberId, present ? f.member.id : null);
      for (const original of f.tasks) {
        const task = (await repos.tasks.get(f.project.id, original.id))!;
        assert.equal(task.revision, original.revision + step + 1);
        assert.equal(task.assigneeMemberId, !present && original.assigneeMemberId === f.member.id ? null : original.assigneeMemberId);
        assert.equal(task.reviewerMemberId, !present && original.reviewerMemberId === f.member.id ? null : original.reviewerMemberId);
        assert.equal(task.state, original.state === "done" ? "done" : present ? "in-progress" : "blocked");
        assert.equal(task.currentReviewRoundId, null);
        assert.equal(task.body, original.body); assert.deepEqual(task.labels, original.labels);
        assert.equal((await repos.tasks.listHistory(f.project.id, task.id)).length, step + 1);
        const snapshotTask = JSON.parse(current.after!).tasks.find((t: { taskId: string }) => t.taskId === task.id);
        assert.deepEqual(snapshotTask, { taskId: task.id, revision: task.revision, assigneeMemberId: task.assigneeMemberId, reviewerMemberId: task.reviewerMemberId,
          state: task.state, blockedReason: task.blockedReason, currentReviewRoundId: task.currentReviewRoundId });
      }
      for (const round of f.rounds) {
        const actual = (await repos.tasks.getRound(f.project.id, round.taskId, round.id))!;
        assert.equal(actual.state, "superseded"); assert.equal(actual.revision, 2);
        assert.deepEqual(actual.specSnapshot, round.specSnapshot);
      }
      for (const request of f.requests) {
        const actual = (await repos.memory.getRequest(request.id))!;
        if (["pending", "running"].includes(request.state)) {
          assert.equal(actual.state, "cancelled"); assert.equal(actual.revision, 2); assert.equal(actual.error!.code, "member_removed");
        } else assert.deepEqual(actual, request);
      }
      for (const table of ["agent_runtime_bindings", "agent_runner_states", "agent_runtime_members", "member_statuses"]) assert.deepEqual(rows[table], []);
      assert.equal(rows.mcp_sessions![0]!.state, "disconnected");
      assert.equal(rows.mcp_sessions![0]!.id, f.session.id);
      assert.equal(rows.audit_log!.length, step + 1);
      // v21 retains every original event/delivery/ACK byte. Its first-cause
      // sidecar permanently excludes the old generation, including after undo.
      for (const [id, original] of preservedEvents) assert.deepEqual(rows.work_events!.find(e => e.id === id), original);
      assert.deepEqual((await tableRows(db, "work_event_delivery_invalidations")).filter(marker => oldEventIds.has(String(marker.work_event_id))), firstInvalidations);
      for (const recipient of [f.member.id, f.peer.id]) {
        assert.equal((await repos.tasks.listUnackedWorkEvents(f.project.id, recipient)).some(event => oldEventIds.has(event.id)), false);
        const old = f.events.filter(event => event.recipientMemberId === recipient && oldEventIds.has(event.id));
        if (recipient === f.member.id && !present) {
          await assert.rejects(repos.tasks.markWorkEventsDelivered(f.project.id, recipient, old.map(event => event.id), relationTime), /成员不存在、已移除/);
          continue;
        }
        assert.deepEqual(await repos.tasks.markWorkEventsDelivered(f.project.id, recipient, old.map(event => event.id), relationTime), []);
        for (const event of old) await assert.rejects(repos.tasks.acknowledgeWorkEvent(f.project.id, recipient, event.id, relationTime), { reason: "work_event_delivery_invalidated" });
      }
      const generated = rows.work_events!.filter(e => !preservedEvents.has(String(e.id)));
      assert.equal(generated.length, present ? 6 : 3, "只生成当前有效任务引用人的新通知");
      for (const event of generated) {
        assert.ok(String(event.event_key).startsWith(`${current.id}:`));
        assert.equal(event.delivery_state, "pending");
        preservedEvents.set(String(event.id), event);
      }
    }
  }, engine));
}
