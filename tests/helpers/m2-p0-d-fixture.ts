import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_MEMORY_CONFIG } from '../../src/server/config.ts';
import { actorForMember } from '../../src/server/authz/actors.ts';
import { newId } from '../../src/server/db/ids.ts';
import { createMemoryService, type MemoryAccess } from '../../src/server/memory/service.ts';
import { createOrgMutationService } from '../../src/server/org/mutations.ts';
import { createAuditCompensationService } from '../../src/server/audit-compensation.ts';
import { appendAuditEntry } from '../../src/server/audit.ts';
import type { SelfSummaryEvidence } from '../../src/shared/memory.ts';
import { captureP0CInput, makeP0CHumanFixture } from './m2-p0-c-fixture.ts';

const at = '2026-11-19T02:00:00.000Z';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export function declaredP0SummaryEvidence(markdown: string): SelfSummaryEvidence {
  return { provenance: 'agent-declared', host: 'p0-family-protocol-fixture', hostVersion: 'fixture',
    invocationId: 'declared-invocation', contextId: 'declared-context', startedAt: at,
    completedAt: '2026-11-19T02:00:01.000Z', promptSha256: sha('declared authorized fixture inputs'),
    outputSha256: sha(markdown), evidenceRef: 'fixture:protocol-only' };
}

/** Real SQLite, Task/Decision HTTP, Memory service and audit compensation writers.
 * External model evidence and injection availability are explicitly declared test
 * inputs; they do not claim actual model execution, native IO or whole P0 closure. */
export async function makeP0DFixture() {
  const fixture = await makeP0CHumanFixture('approve');
  try {
    const { repos, source } = fixture;
    const group = await repos.groups.create({ projectId: source.project.id, name: 'D 来源群', participantMemberIds: [source.worker.id, source.reviewer.id] });
    const own: MemoryAccess = { actor: actorForMember(source.worker), connection: { projectId: source.project.id,
      memberId: source.worker.id, groupId: group.id, membershipRevision: source.worker.membershipRevision }, injectionBindingGeneration: 'p0-d-session' };
    const service = createMemoryService({ repos, config: { ...DEFAULT_MEMORY_CONFIG, messageThreshold: 1 }, now: () => new Date(at),
      injectionReader: { readOwn: async () => ({ state: 'available' as const, entries: [], errors: [], maxBytes: 8192 }), close: async () => {} },
      readVisibleMessages: async (_access, ids) => (await Promise.all(ids.map(id => repos.messages.get(id))))
        .flatMap(message => message ? [{ id: message.id, groupId: message.groupId, text: message.body, createdAt: message.createdAt }] : []) });
    const key = { scope: 'project-agent' as const, projectId: source.project.id, agentId: source.worker.agentId! };
    await service.write(own, { scope: 'global', projectId: null, agentId: source.worker.agentId! },
      { expectedVersion: 0, clientMutationId: 'global', markdown: '全局记忆' });
    await service.write(source.owner, { scope: 'project', projectId: source.project.id, agentId: null },
      { expectedVersion: 0, clientMutationId: 'project', markdown: '项目记忆' });
    await service.write(source.owner, key, { expectedVersion: 0, clientMutationId: 'baseline', markdown: '旧项目事实' });
    const legacyTask = await repos.tasks.create({ ...(await repos.tasks.get(source.project.id, source.task.id))!, id: newId(),
      title: '原 pre-Decision 来源', state: 'done', revision: 1, currentReviewRoundId: null });
    for (const completionRevision of [1, 99]) {
      const id = newId();
      await repos.tasks.enqueueWorkEvent({ id, projectId: source.project.id,
        recipientMemberId: source.worker.id, taskId: legacyTask.id, kind: 'task.review_decided', eventKey: `legacy:${legacyTask.id}:${completionRevision}`,
        payload: { enteredDone: true, completionRevision, assigneeAgentId: source.worker.agentId }, deliveryState: 'pending', attempts: 0,
        createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
      await repos.tasks.acknowledgeWorkEvent(source.project.id, source.worker.id, id, at);
    }
    const message = await repos.messages.create({ groupId: group.id, senderMemberId: source.reviewer.id, body: '实际消息投递来源' });
    await repos.deliveries.markMcpDelivered(message.id, source.worker.id, at);
    const reconciled = await service.reconcileTriggers(own);
    assert.equal(reconciled.scheduled, 3, 'live and legacy completion plus actual MCP delivery; stale legacy source creates a cancelled request without notification');
    const requests = await repos.memory.listRequests(source.project.id, source.worker.agentId!);
    const taskRequest = requests.find(request => request.trigger === 'task_completed' && request.taskId === source.task.id)!;
    assert.ok(taskRequest);
    const begun = await service.beginSummary(own, taskRequest.id, { expectedRevision: 1, clientMutationId: 'task-begin' });
    const markdown = '完成时的不可变项目记忆';
    const completed = await service.submitSummary(own, taskRequest.id,
      { expectedRequestRevision: begun.revision, attemptId: begun.attemptId!, markdown, evidence: declaredP0SummaryEvidence(markdown) });
    assert.equal(completed.writtenVersion.version, 2);
    await service.write(source.owner, key, { expectedVersion: 2, clientMutationId: 'later-head', markdown: '后续人工修订' });
    const failedSchedule = await service.reportSessionEnd(own, 'will-fail');
    assert.ok(failedSchedule.requestId);
    const failing = await service.beginSummary(own, failedSchedule.requestId, { expectedRevision: 1, clientMutationId: 'failure-begin' });
    await service.failSummary(own, failing.id, { expectedRevision: failing.revision, attemptId: failing.attemptId!, code: 'declared_failure' });
    const retry = await service.retrySummary(source.owner, failing.id, 'retry');
    await service.beginSummary(own, retry.id, { expectedRevision: 1, clientMutationId: 'retry-begin' });
    await service.reportSessionEnd(own, 'still-pending');
    // ACK and later Task changes do not rewrite immutable completion provenance.
    const task = (await repos.tasks.get(source.project.id, source.task.id))!;
    await source.service.transition(source.owner, source.project.id, task.id, { expectedRevision: task.revision, state: 'todo', reason: '历史完成仍保留' });
    const mutation = createOrgMutationService({ repos, now: () => new Date(at) });
    const compensation = createAuditCompensationService({ repos, now: () => new Date(at) });
    const node = await mutation.createNode(source.owner, { projectId: source.project.id, name: '审计岗位', parentId: null, role: 'top_manager', sortOrder: 1.5 });
    const renamed = await mutation.updateNode(source.owner, source.project.id, node.node.id, { name: '新岗位名' });
    const undo = await compensation.revoke(source.owner, source.project.id, renamed.auditId);
    await compensation.revoke(source.owner, source.project.id, undo.id);
    const added = await mutation.addMember(source.owner, { projectId: source.project.id, kind: 'human', displayName: '审计人员' });
    await mutation.setMemberStatus(source.owner, source.project.id, added.member.id, 'disabled');
    const removed = await mutation.removeMember(source.owner, source.project.id, added.member.id);
    await compensation.revoke(source.owner, source.project.id, removed.auditId);
    for (const changed of [[], ['field'], '历史显示', 1.5, true, false, null, { truncated: true, bytes: 40000 }]) {
      await appendAuditEntry(repos.audit, { projectId: source.project.id, actor: { kind: 'human', name: '人' },
        action: 'fixture.display', targetKind: 'project', targetId: source.project.id, targetName: '历史', changed }, { createdAt: at });
    }
    return { ...fixture, own, service, group, message, taskRequest, retry, input: captureP0CInput(path.join(fixture.dir, 'agent-studio.db')) };
  } catch (error) { await fixture.close(); throw error; }
}
