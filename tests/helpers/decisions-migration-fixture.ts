import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DbDriver } from '../../src/server/db/driver.ts';
import { SqliteDriver } from '../../src/server/db/drivers/sqlite.ts';
import { seedSampleData } from '../../src/server/db/seed-sample-data.ts';
import { createRepositories } from '../../src/server/db/repositories.ts';
import { appendAuditEntry } from '../../src/server/audit.ts';
import { initializePolicyConfiguration } from '../../src/server/policy/configuration.ts';
import { seedDecisionDatabase } from './decisions-database-fixture.ts';
import type { MemoryDocument, MemorySummaryRequest } from '../../src/shared/memory.ts';
import type { Task, ReviewRound, ReviewReport } from '../../src/shared/tasks.ts';
import { createToolCatalogSnapshot, inspectMcpConnection } from '../../src/server/mcp/capabilities/catalog.ts';
import { canonicalJson } from '../../src/server/policy/canonical.ts';
import { createOrgMutationService } from '../../src/server/org/mutations.ts';
import { ownerActor } from '../../src/server/authz/actors.ts';

export const DECISION_MIGRATION_TABLES = ['mcp_connections', 'mcp_connection_versions', 'mcp_catalog_snapshots', 'mcp_catalog_heads', 'mcp_connection_mutations', 'mcp_discovery_attempts', 'agents', 'agent_legacy_aliases', 'role_templates', 'role_template_versions', 'projects', 'policy_documents', 'policy_document_versions', 'project_workspace_versions', 'memory_documents', 'memory_versions', 'org_nodes', 'members', 'project_task_settings', 'tasks', 'task_review_rounds', 'task_review_reports', 'task_comments', 'task_history', 'groups', 'work_events', 'memory_summary_requests', 'memory_trigger_counters', 'memory_scan_checkpoints', 'group_participants', 'messages', 'memory_message_receipts', 'task_message_links', 'message_deliveries', 'member_statuses', 'mcp_sessions', 'audit_log', 'work_event_delivery_invalidations', 'agent_runtimes', 'agent_runtime_bindings', 'agent_runner_states', 'agent_runtime_members', 'agent_runtime_events', 'agent_runtime_observation_meta', 'agent_runtime_usage_snapshots', 'decision_legacy_records', 'decision_action_requests', 'decision_records', 'decision_review_heads', 'decision_user_events', 'decision_local_initiations', 'decision_resolutions', 'decision_executions', 'decision_command_receipts', 'decision_review_projections', 'decision_change_heads', 'decision_changes', 'member_fact_revisions'] as const;

/** SQLite原始58表非空源；所有runtime/MCP数据是历史fixture，不启动实例或外部发现。 */
export async function seedDecisionMigrationSource(db:DbDriver) {
  assert.equal(db.kind,"sqlite");
    seedSampleData((db as SqliteDriver).handle);
    // 迁移往返也必须保留 v7 的幂等键和唤醒事实，不能只验证全 NULL 的新列。
    await db.exec(
      "UPDATE messages SET client_message_id = ? WHERE id = (SELECT id FROM messages ORDER BY id LIMIT 1)",
      ["migration-request"],
    );
    await db.exec(
      "UPDATE message_deliveries SET wake_decision = 'allowed' WHERE id = (SELECT id FROM message_deliveries ORDER BY id LIMIT 1)",
    );
    await db.exec(
      "UPDATE message_deliveries SET wake_decision = 'suppressed', wake_suppressed_reason = 'rate_limited' WHERE id = 'md2'",
    );
    // 阶段 3 每张新表都有非空数据，copy 不能靠「空表一致」获得绿灯。
    const repos = createRepositories(db);
    const at = "2026-11-10T12:00:00.000Z";
    const author = { kind: "human" as const, actorId: "owner", displayName: "人" };
    const task: Task = { id: "task-copy", projectId: "pr1", title: "迁移任务", body: "验收正文", deliveryKind: "code", acceptanceText: "明确验收与 Unicode 🧪\n独立于目标", acceptanceSource: "explicit", labels: ["迁移"], state: "in-progress",
      assigneeMemberId: "mb1", reviewerMemberId: "mb2", repoPath: "/repo", fixedPoint: "HEAD~1", revision: 1,
      currentReviewRoundId: null, blockedReason: null, author, createdAt: at, updatedAt: at };
    await repos.tasks.setSettings("pr1", 0, "mb2");
    await repos.tasks.create(task);
    const round: ReviewRound = { id: "round-copy", taskId: task.id, projectId: "pr1", revision: 1, taskRevision: 2, state: "ready", reviewerMemberId: "mb2",
      specSnapshot: { title: task.title, body: task.body, labels: task.labels }, candidate: { repositoryRoot: "/repo", fixedPointInput: "HEAD~1", baseCommit: "base", candidateCommit: "candidate",
        policy: "committed-clean", gitVersion: "test", diff: "diff --git a/a b/a\n+任务", diffSha256: "diff", commits: [{ sha: "candidate", subject: "任务提交" }], commands: [], capturedAt: at },
      failure: null, decision: null, createdAt: at, updatedAt: at };
    await repos.tasks.createRound(round);
    await repos.tasks.updateCas("pr1", task.id, 1, { state: "review", currentReviewRoundId: round.id }, at);
    const report: ReviewReport = { id: "report-copy", roundId: round.id, taskId: task.id, projectId: "pr1", axis: "spec", verdict: "pass", body: "通过", sources: ["spec"],
      evidence: { provenance: "reviewer-declared", host: "test", hostVersion: "1", parentRunId: "parent", invocationId: "run", contextId: "context", startedAt: at, completedAt: at,
        command: { argv: ["test"], cwd: "/repo", startedAt: at, completedAt: at, exitCode: 0 }, promptSha256: "prompt", transcriptSha256: "transcript", evidenceRef: "log",
        baseCommit: "base", candidateCommit: "candidate", diffSha256: "diff" }, contentSha256: "content", author, createdAt: at };
    await repos.tasks.addReport(report);
    await repos.tasks.addComment({ id: "comment-copy", taskId: task.id, projectId: "pr1", kind: "review_report", author, body: "通过", createdAt: at, reviewReportId: report.id });
    await repos.tasks.appendHistory({ id: "history-copy", taskId: task.id, projectId: "pr1", action: "task.review_started", actor: author, taskRevision: 2, detail: { roundId: round.id }, createdAt: at });
    await repos.tasks.linkMessage("pr1", { taskId: task.id, messageId: "msg1", groupId: "gp1", createdAt: at });
    await repos.tasks.enqueueWorkEvent({ id: "event-copy", projectId: "pr1", recipientMemberId: "mb2", taskId: task.id, kind: "task.review_ready", eventKey: "review:round-copy:ready",
      payload: { roundId: round.id, revision: 2 }, deliveryState: "pending", attempts: 0, createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
    await repos.tasks.markWorkEventsDelivered("pr1", "mb2", ["event-copy"], at);
    await appendAuditEntry(repos.audit, { projectId: "pr1", actor: { kind: "human", name: "人" }, action: "task.review_started", targetKind: "task", targetId: task.id, targetName: task.title });
    // v12 每张表非空，包含 global 私有版本及群绑定事件，验证真实 FK 复制顺序。
    const memoryAuthor = { ...author, agentId: null };
    for (const key of [{ scope: "global" as const, projectId: null, agentId: "ag1" },
      { scope: "project" as const, projectId: "pr1", agentId: null },
      { scope: "project-agent" as const, projectId: "pr1", agentId: "ag1" }]) {
      const markdown = `# ${key.scope} 记忆 🧠`;
      const doc: MemoryDocument = { id: `memory-${key.scope}`, key, version: 1, markdown, byteLength: Buffer.byteLength(markdown), updatedAt: at, updatedBy: memoryAuthor, source: "human" };
      await repos.memory.insertHead(doc);
      await repos.memory.insertVersion({ id: `version-${key.scope}`, documentId: doc.id, version: 1, parentVersion: 0, markdown,
        byteLength: doc.byteLength, contentSha256: createHash("sha256").update(markdown).digest("hex"), author: memoryAuthor, source: "human",
        clientMutationId: `copy-${key.scope}`, summaryRequestId: null, createdAt: at });
    }
    await repos.deliveries.markMcpDelivered("msg1", "mb1", at);
    await db.exec("UPDATE message_deliveries SET id = 'md3' WHERE message_id = 'msg1' AND member_id = 'mb1'");
    await repos.memory.observeDeliveredMessage({ projectId: "pr1", agentId: "ag1", groupId: "gp1", messageId: "msg1", threshold: 1, at });
    const request: MemorySummaryRequest = { id: "memory-request-copy", projectId: "pr1", agentId: "ag1", recipientMemberId: "mb1", contextGroupId: "gp1",
      documentId: "memory-project-agent", baseVersion: 1, revision: 1, state: "pending", trigger: "message_threshold", triggerKey: "threshold:1",
      taskId: null, completedTaskRevision: null, messageIds: ["msg1"], sourceWorkEventId: null, retryOfRequestId: null, attemptId: null,
      beginMutationId: null, resultVersion: null, resultSha256: null, error: null, evidence: null, createdAt: at, startedAt: null, finishedAt: null };
    await repos.memory.createRequest(request);
    await repos.tasks.enqueueWorkEvent({ id: "memory-event-copy", projectId: "pr1", recipientMemberId: "mb1", taskId: null, contextGroupId: "gp1",
      kind: "memory.summary_requested", eventKey: "memory:request-copy", payload: { requestId: request.id, requestRevision: 1, trigger: request.trigger },
      deliveryState: "pending", attempts: 0, createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
    for (const kind of ["message_threshold", "task_completed"] as const) {
      const scope = { kind, projectId: "pr1", agentId: "ag1", groupId: kind === "message_threshold" ? "gp1" : null };
      await repos.memory.updateScanCheckpointCas({ scope, after: null, through: await repos.memory.scanHighWater(scope), sweep: 1, revision: 1 }, 0);
    }
    await db.exec("UPDATE members SET removed_at = ?, membership_revision = 2, status = 'disabled', node_id = NULL, role = 'normal' WHERE id = 'mb3'", [at]);
    for (const [index, kind] of ["authored-messages", "deliveries", "memory-requests", "memory-receipts", "memory-counters", "memory-checkpoints"].entries()) {
      await db.exec("UPDATE member_fact_revisions SET revision = ? WHERE kind = ?", [101 + index, kind]);
    }

  await initializePolicyConfiguration(repos);
  const decision=await seedDecisionDatabase(db);
  const insert=async(table:string,row:Record<string,unknown>)=>{const columns=Object.keys(row);await db.exec(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(()=>"?").join(",")})`,columns.map(c=>row[c]));};
  await insert('role_templates',{id:'role-copy',revision:1,created_at:at,updated_at:at});
  await insert('role_template_versions',{role_template_id:'role-copy',revision:1,name:'迁移角色',purpose:'历史文本',instructions:'原文\n🧪',recommended_skill_refs_json:'[]',archived_at:null,copied_from_role_template_id:null,copied_from_revision:null,created_at:at});
  await db.exec("UPDATE projects SET project_revision = 2, workspace_revision = 1 WHERE id = 'pr1'");
  await insert('project_workspace_versions',{project_id:'pr1',workspace_revision:1,project_revision:2,root_path:null,canonical_root:null,mode:'isolated',root_identity_json:null,physical_resource_key:null,repository_info_json:null,observed_at:at,mutation_id:'workspace-copy',input_digest:createHash('sha256').update('unconfigured').digest('hex'),updated_at:at});
  await insert('agent_runtimes',{id:'runtime-copy',agent_id:'ag1',config_version:1,revision:1,defaults_json:'{}',created_at:at,updated_at:at});
  await insert('agent_runtime_bindings',{id:'binding-copy',runtime_id:'runtime-copy',project_id:'pr1',group_id:'gp1',member_id:'mb1',created_at:at,updated_at:at});
  await insert('agent_runner_states',{binding_id:'binding-copy',updated_at:at});
  await insert('agent_runtime_members',{member_id:'mb1',runtime_id:'runtime-copy',project_id:'pr1',updated_at:at});
  await insert('agent_runtime_events',{id:'runtime-event-copy',binding_id:'binding-copy',observed_at:at,event_name:'fixture.history',payload:'{"historical":true}'});
  await db.exec('INSERT INTO agent_runtime_observation_meta (id, storage_failures) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET storage_failures = 2');
  await insert('agent_runtime_usage_snapshots',{id:'usage-copy',binding_id:'binding-copy',source:'codex-cli',harness_version:'fixture',metric:'inputTokens',scope:'invocation',scope_id:'invocation-copy',epoch_id:'epoch-copy',sequence:1,observed_at:at,payload:'{"tokens":42}'});

  // Pure catalog construction: no server, discovery call, credential, or tool execution.
  const connection={connectionId:'connection-copy',revision:Number.MAX_SAFE_INTEGER,enabled:true,transport:{type:'streamable-http',endpoint:'http://127.0.0.1:1/not-contacted'}};
  const projection=inspectMcpConnection(connection);
  const catalog=createToolCatalogSnapshot({connection,observedAt:at,discovery:{status:'available',tools:[{name:'historical-fixture',description:'保存的目录 🧪',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]}});
  await insert('mcp_connections',{id:connection.connectionId,revision:connection.revision,discovery_sequence:1,created_at:at,updated_at:at});
  await insert('mcp_connection_versions',{connection_id:connection.connectionId,revision:connection.revision,name:'历史连接',configuration_json:canonicalJson(connection),configuration_digest:projection.configurationDigest,created_at:at});
  await insert('mcp_catalog_snapshots',{id:catalog.snapshotDigest,connection_id:connection.connectionId,connection_revision:connection.revision,snapshot_json:canonicalJson(catalog),observed_at:at});
  await insert('mcp_catalog_heads',{connection_id:connection.connectionId,connection_revision:connection.revision,snapshot_id:catalog.snapshotDigest});
  await insert('mcp_connection_mutations',{request_id:'mutation-copy',input_digest:createHash('sha256').update('mutation-copy').digest('hex'),connection_id:connection.connectionId,result_json:canonicalJson({projection,name:'历史连接',createdAt:at,updatedAt:at}),created_at:at});
  await insert('mcp_discovery_attempts',{id:'discovery-copy',request_id:'discovery-request-copy',input_digest:createHash('sha256').update('discovery-copy').digest('hex'),connection_id:connection.connectionId,connection_revision:connection.revision,sequence:1,owner_id:'historical-fixture',status:'succeeded',error_code:null,snapshot_id:catalog.snapshotDigest,cleanup:'closed',protocol_version:'2025-06-18',page_count:1,created_at:at,finished_at:at});
  const audit=await appendAuditEntry(repos.audit,{projectId:'pr1',actor:{kind:'human',name:'原审计人'},action:'task.review_decided',targetKind:'decision',targetId:'historical-copy',targetName:'历史裁决',before:{value:'旧'},after:{value:'新'},detail:{fixture:true}});
  const reversal=await appendAuditEntry(repos.audit,{projectId:'pr1',actor:{kind:'human',name:'原审计人'},action:'task.review_decided',targetKind:'decision',targetId:'historical-copy',targetName:'历史裁决',before:{value:'新'},after:{value:'旧'},detail:{reverses:audit.id}});
  await db.exec('UPDATE audit_log SET reversed_at = ?, reversed_by_audit_id = ? WHERE id = ?',[at,reversal.id,audit.id]);
  // v21 uses an actual lifecycle producer and the real immutable audit closure.
  // Isolated project lets purge prove that the independent Decision graph survives.
  const eventProject = await repos.projects.create({ name: '工作事件失效迁移来源' });
  const org = createOrgMutationService({ repos, now: () => new Date(at) });
  const member = (await org.addMember({ actor: ownerActor() }, {
    projectId: eventProject.id, kind: 'human', displayName: '迁移来源成员',
  })).member;
  const lifecycleTask = await repos.tasks.create({ ...task, id: 'invalidation-task', projectId: eventProject.id,
    assigneeMemberId: member.id, reviewerMemberId: null, state: 'done', currentReviewRoundId: null });
  for (const [index, state] of ['pending','delivered','acked'].entries()) {
    const id = `invalidation-event-${index}`;
    await repos.tasks.enqueueWorkEvent({ id, projectId: eventProject.id, recipientMemberId: member.id, taskId: lifecycleTask.id,
      kind: 'task.assigned', eventKey: id, payload: { fixture: state }, deliveryState: 'pending', attempts: 0,
      createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
    if (state !== 'pending') await repos.tasks.markWorkEventsDelivered(eventProject.id, member.id, [id], at);
    if (state === 'acked') await repos.tasks.acknowledgeWorkEvent(eventProject.id, member.id, id, at);
  }
  await org.removeMember({ actor: ownerActor() }, eventProject.id, member.id);
  const counts:Record<string,number>={};
  for(const table of DECISION_MIGRATION_TABLES){const rows=await db.query<{n:number|string}>(`SELECT count(*) AS n FROM ${table}`);counts[table]=Number(rows[0]!.n);assert.ok(counts[table]!>0,`${table} must contain real rows`);}
  return {decision,counts};
}
