import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { DbDriver, DbRow } from "../../src/server/db/driver.ts";
import type { RepositorySet } from "../../src/server/db/repositories.ts";
import type { MemoryDocument, MemorySummaryRequest } from "../../src/shared/memory.ts";
import type { Task, WorkEvent } from "../../src/shared/tasks.ts";

export const relationTime = "2026-11-11T12:00:00.000Z";
const author = { kind: "human" as const, actorId: "human:local", agentId: null, displayName: "本地用户" };

/** Synthetic persisted relations, not a model-execution or native-host fixture. */
export async function seedCompleteMemberRelations(repos: RepositorySet, db: DbDriver) {
  const project = await repos.projects.create({ name: "完整成员关系与故障回滚" });
  const agent = await repos.agents.create({ displayName: "待移除 Agent", hostType: "fixture" });
  const peerAgent = await repos.agents.create({ displayName: "继续在岗 Agent", hostType: "fixture" });
  const member = await repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName: agent.displayName });
  const peer = await repos.members.create({ projectId: project.id, agentId: peerAgent.id, kind: "agent", displayName: peerAgent.displayName });
  const root = await repos.org.createNode({ projectId: project.id, role: "top_manager", name: "负责人" });
  const node = await repos.org.createNode({ projectId: project.id, parentId: root.id, role: "member", name: "执行岗位" });
  await repos.org.assignNode(member.id, node.id);
  const groups = [];
  for (const name of ["开发", "验收"]) groups.push(await repos.groups.create({ projectId: project.id, name, participantMemberIds: [member.id, peer.id] }));
  const group = groups[0]!;
  const authored = await repos.messages.create({ groupId: group.id, senderMemberId: member.id, body: "保留原作者、@提及、稳定重放键和 Unicode 🧠", mentions: [peer.id], clientMessageId: "member-authored-stable-key" });
  const incoming = await repos.messages.create({ groupId: groups[1]!.id, senderMemberId: peer.id, body: "确已进入 MCP 投递的来源事实", mentions: [member.id], clientMessageId: "peer-authored-stable-key" });
  await repos.deliveries.markMcpDelivered(incoming.id, member.id, relationTime);
  await repos.deliveries.recordAttempt(incoming.id, member.id, "acked", relationTime);
  await repos.deliveries.markMcpDelivered(authored.id, peer.id, relationTime);
  await repos.deliveries.recordAttempt(authored.id, peer.id, "acked", relationTime);
  await repos.memory.observeDeliveredMessage({ projectId: project.id, agentId: agent.id, groupId: groups[1]!.id, messageId: incoming.id, threshold: 2, at: relationTime });
  for (const kind of ["message_threshold", "task_completed"] as const) {
    const scope = { kind, projectId: project.id, agentId: agent.id, groupId: kind === "message_threshold" ? groups[1]!.id : null };
    await repos.memory.updateScanCheckpointCas({ scope, after: null, through: await repos.memory.scanHighWater(scope), sweep: 1, revision: 1 }, 0);
  }

  const documents: MemoryDocument[] = [];
  for (const key of [
    { scope: "global" as const, projectId: null, agentId: agent.id },
    { scope: "project" as const, projectId: project.id, agentId: null },
    { scope: "project-agent" as const, projectId: project.id, agentId: agent.id },
  ]) {
    const markdown = `# ${key.scope}\n人工保存原文，不代表模型总结成功。🧠`;
    const doc: MemoryDocument = { id: randomUUID(), key, version: 1, markdown, byteLength: Buffer.byteLength(markdown), updatedAt: relationTime, updatedBy: author, source: "human" };
    await repos.memory.insertHead(doc);
    await repos.memory.insertVersion({ id: randomUUID(), documentId: doc.id, version: 1, parentVersion: 0, markdown, byteLength: doc.byteLength,
      contentSha256: createHash("sha256").update(markdown).digest("hex"), author, source: "human", clientMutationId: `initial-${key.scope}`, summaryRequestId: null, createdAt: relationTime });
    documents.push(doc);
  }
  const projectMemory = documents[2]!;
  const updatedBody = `${projectMemory.markdown}\n第二版仍须逐字保留。`;
  await repos.memory.updateHeadCas(projectMemory.id, 1, { ...projectMemory, version: 2, markdown: updatedBody, byteLength: Buffer.byteLength(updatedBody) });
  await repos.memory.insertVersion({ id: randomUUID(), documentId: projectMemory.id, version: 2, parentVersion: 1, markdown: updatedBody, byteLength: Buffer.byteLength(updatedBody),
    contentSha256: createHash("sha256").update(updatedBody).digest("hex"), author, source: "human", clientMutationId: "second-project-agent", summaryRequestId: null, createdAt: relationTime });

  const tasks: Task[] = [];
  for (const [title, assigneeMemberId, reviewerMemberId, state] of [
    ["执行中指派", member.id, peer.id, "in-progress"],
    ["准备评审", peer.id, member.id, "in-progress"],
    ["运行评审", peer.id, member.id, "in-progress"],
    ["已完成事实", member.id, peer.id, "done"],
  ] as const) {
    tasks.push(await repos.tasks.create({ id: randomUUID(), projectId: project.id, title, body: "固定任务正文 🧠", labels: ["不可变正文"], state,
      assigneeMemberId, reviewerMemberId, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null,
      author, createdAt: relationTime, updatedAt: relationTime }));
  }
  const rounds = [];
  for (const [taskIndex, state] of [[1, "ready"], [2, "running"]] as const) {
    const task = tasks[taskIndex]!;
    const round = await repos.tasks.createRound({ id: randomUUID(), projectId: project.id, taskId: task.id, revision: 1, taskRevision: 2, state,
      reviewerMemberId: member.id, specSnapshot: { title: task.title, body: task.body, labels: task.labels }, candidate: null, failure: null, decision: null, createdAt: relationTime, updatedAt: relationTime });
    tasks[taskIndex] = await repos.tasks.updateCas(project.id, task.id, 1, { state: "review", currentReviewRoundId: round.id }, relationTime);
    rounds.push(round);
  }
  await repos.tasks.setSettings(project.id, 0, member.id);
  await repos.tasks.addComment({ id: randomUUID(), taskId: tasks[0]!.id, projectId: project.id, kind: "comment", author, body: "旧讨论永久保留", createdAt: relationTime, reviewReportId: null });
  await repos.tasks.linkMessage(project.id, { taskId: tasks[0]!.id, messageId: authored.id, groupId: group.id, createdAt: relationTime });

  const requests: MemorySummaryRequest[] = [];
  for (const state of ["pending", "running", "completed", "failed", "conflicted", "cancelled"] as const) {
    const terminal = state !== "pending" && state !== "running";
    // All states are synthetic persisted fixtures; no model invocation/evidence is claimed.
    const request: MemorySummaryRequest = { id: randomUUID(), projectId: project.id, agentId: agent.id, recipientMemberId: member.id, contextGroupId: group.id,
      documentId: projectMemory.id, baseVersion: 2, revision: 1, state, trigger: "session_end", triggerKey: `fixture-${state}`,
      taskId: null, completedTaskRevision: null, messageIds: [], sourceWorkEventId: null, retryOfRequestId: null,
      attemptId: state === "pending" ? null : `synthetic-${state}`, beginMutationId: state === "pending" ? null : `fixture-${state}`,
      resultVersion: null, resultSha256: null, error: state === "failed" ? { code: "fixture_failure", message: "合成失败状态" } : null,
      evidence: null, createdAt: relationTime, startedAt: state === "pending" ? null : relationTime, finishedAt: terminal ? relationTime : null };
    requests.push(await repos.memory.createRequest(request));
  }
  const events: WorkEvent[] = [];
  for (const [recipientMemberId, deliveryState, taskId] of [
    [member.id, "pending", tasks[0]!.id], [peer.id, "pending", tasks[1]!.id],
    [peer.id, "delivered", tasks[2]!.id], [peer.id, "acked", tasks[3]!.id],
  ] as const) {
    let event = await repos.tasks.enqueueWorkEvent({ id: randomUUID(), projectId: project.id, recipientMemberId, taskId, contextGroupId: null,
      kind: "task.assigned", eventKey: randomUUID(), payload: { taskId, fixture: true }, deliveryState: "pending", attempts: 0,
      createdAt: relationTime, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
    if (deliveryState !== "pending") event = (await repos.tasks.markWorkEventsDelivered(project.id, recipientMemberId, [event.id], relationTime))[0]!;
    if (deliveryState === "acked") event = (await repos.tasks.acknowledgeWorkEvent(project.id, recipientMemberId, event.id, relationTime)).event;
    events.push(event);
  }
  const session = await repos.mcpSessions.connect({ agentId: agent.id, projectId: project.id, groupId: group.id, memberId: member.id, displayName: member.displayName, hostType: "fixture" });
  await repos.statuses.set(project.id, member.id, "working");
  const runtimeId = randomUUID(), bindingId = randomUUID();
  await db.exec("INSERT INTO agent_runtimes (id, agent_id, defaults_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [runtimeId, agent.id, '{"fixture":true}', relationTime, relationTime]);
  await db.exec("INSERT INTO agent_runtime_bindings (id, runtime_id, project_id, group_id, member_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [bindingId, runtimeId, project.id, group.id, member.id, relationTime, relationTime]);
  await db.exec("INSERT INTO agent_runner_states (binding_id, state, exit_confirmed, updated_at) VALUES (?, 'stopped', 1, ?)", [bindingId, relationTime]);
  await db.exec("INSERT INTO agent_runtime_members (member_id, runtime_id, project_id, updated_at) VALUES (?, ?, ?, ?)", [member.id, runtimeId, project.id, relationTime]);
  return { project, agent, member: (await repos.members.get(member.id))!, peer, node, groups, authored, incoming, tasks, rounds, documents, requests, events, session, runtimeId, bindingId };
}

export async function tableRows(db: DbDriver, table: string): Promise<DbRow[]> {
  assert.match(table, /^[a-z_][a-z0-9_]*$/);
  const rows = await db.query(`SELECT * FROM ${table}`);
  const key = (row: DbRow) => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]])));
  return rows.sort((a, b) => key(a).localeCompare(key(b), "en"));
}

/** Enumerate every application table, so adding a related table cannot silently reduce rollback coverage. */
export async function snapshotRelationsDatabase(db: DbDriver): Promise<Record<string, DbRow[]>> {
  const tables = await db.query<{ name: string }>(db.kind === "sqlite"
    ? "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name"
    : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name");
  const result: Record<string, DbRow[]> = {};
  for (const { name } of tables) result[name] = await tableRows(db, name);
  return result;
}
