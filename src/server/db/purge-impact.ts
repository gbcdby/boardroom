import { DECISION_TABLE_NAMES } from "../decisions/tables.ts";
import { createHash } from "node:crypto";
import type { DbRow } from "./driver.ts";
import type { RepoCtx } from "./repositories.ts";

/** 与删群后的 cleanOrphanRuntimeMembers 完全相同的选择条件，在删除前求值。 */
export const groupOrphanRuntimeMembers = `SELECT rm.* FROM agent_runtime_members rm
  WHERE rm.project_id = (SELECT project_id FROM groups WHERE id = ?)
    AND rm.binding_id IS NULL
    AND EXISTS (SELECT 1 FROM agent_runtime_bindings b WHERE b.member_id = rm.member_id AND b.group_id = ?)
    AND NOT EXISTS (SELECT 1 FROM agent_runtime_bindings b WHERE b.member_id = rm.member_id AND b.group_id <> ?)`;

/**
 * 删除范围的稳定业务投影。保留身份与关系，排除仅反映消费/心跳/扫描进度的观测字段。
 * 这些记录的新增、移除或换身份仍会改变摘要；运行中的删除禁止继续由 stopped gate 判定。
 * 成员事实版本由各群共同推进，不能充当群的范围版本；下面直接捕获实际事实与关系。
 */
const ignored: Readonly<Record<string, readonly string[]>> = {
  member_fact_revisions: ["revision"],
  member_statuses: ["state", "updated_at"],
  mcp_sessions: ["state", "last_heartbeat_at", "disconnected_at", "updated_at"],
  message_deliveries: ["status", "attempt_count", "first_delivered_at", "last_delivered_at", "acked_at", "first_mcp_delivered_at", "updated_at"],
  work_events: ["delivery_state", "attempts", "first_delivered_at", "last_delivered_at", "acked_at"],
  memory_scan_checkpoints: ["after_cursor", "through_cursor", "sweep", "revision", "updated_at"],
  agent_runner_states: ["state", "phase", "lease_owner", "lease_expires_at", "pid", "exit_confirmed", "observed_at", "started_at", "attempt_count", "next_retry_at", "last_error_code", "last_exit_code", "last_exit_signal", "permission_observed", "updated_at"],
  agent_runtime_members: ["lease_owner", "lease_expires_at", "updated_at"],
};

function canonicalRow(table: string, row: DbRow): string {
  return JSON.stringify(Object.keys(row).filter(key => !ignored[table]?.includes(key)).sort().map(key =>
    [key, typeof row[key] === "bigint" ? String(row[key]) : row[key]]));
}

/** 调用方持有共同项目锁和事务；每个集合与 purge 的 DELETE/FK 闭包对应。 */
export async function purgeImpactDigest(ctx: RepoCtx, kind: "project" | "group", id: string): Promise<string> {
  const versions = new Set((await ctx.query<{ version: number }>("SELECT version FROM schema_migrations")).map(row => Number(row.version)));
  const project = kind === "project";
  const digest = createHash("sha256").update("boardroom-purge-impact-v1\n").update(JSON.stringify([kind, id]));
  const capture = async (table: string, where: string, params: readonly unknown[] = [id]) => {
    const rows = await ctx.query(`SELECT * FROM ${table} WHERE ${where}`, params);
    digest.update(JSON.stringify([table, rows.map(row => canonicalRow(table, row)).sort()]));
  };
  const groupIds = project ? "SELECT id FROM groups WHERE project_id = ?" : "SELECT id FROM groups WHERE id = ?";
  const messages = `SELECT id FROM messages WHERE group_id IN (${groupIds})`;
  const bindings = project ? "SELECT id FROM agent_runtime_bindings WHERE project_id = ?" : "SELECT id FROM agent_runtime_bindings WHERE group_id = ?";
  const scope = project ? "project_id = ?" : "group_id = ?";

  if (project) {
    if (versions.has(20)) for (const table of DECISION_TABLE_NAMES) await capture(table, "project_id = ?");
    await capture("projects", "id = ?");
    if (versions.has(15)) await capture("project_workspace_versions", "project_id = ?");
    if (versions.has(17)) {
      await capture("policy_documents", "project_id = ?");
      await capture("policy_document_versions", "document_id IN (SELECT scope_key FROM policy_documents WHERE project_id = ?)");
    }
    await capture("members", "project_id = ?");
    await capture("org_nodes", "project_id = ?");
    await capture("member_statuses", "project_id = ?");
    if (versions.has(13)) await capture("member_fact_revisions", "member_id IN (SELECT id FROM members WHERE project_id = ?)");
  }
  await capture("groups", project ? "project_id = ?" : "id = ?");
  await capture("group_participants", `group_id IN (${groupIds})`);
  await capture("messages", `group_id IN (${groupIds})`);
  await capture("message_deliveries", project ? "project_id = ?" : `message_id IN (${messages})`);
  await capture("mcp_sessions", scope);
  if (versions.has(8)) {
    await capture("agent_runtime_bindings", scope);
    await capture("agent_runner_states", `binding_id IN (${bindings})`);
    if (project) await capture("agent_runtime_members", "project_id = ?");
    else {
      const rows = await ctx.query(groupOrphanRuntimeMembers, [id, id, id]);
      digest.update(JSON.stringify(["agent_runtime_members", rows.map(row => canonicalRow("agent_runtime_members", row)).sort()]));
    }
  }
  if (versions.has(21)) await capture("work_event_delivery_invalidations", project ? "project_id = ?" : "work_event_id IN (SELECT id FROM work_events WHERE context_group_id = ?)");
  if (versions.has(11)) {
    if (project) {
      for (const table of ["project_task_settings", "tasks", "task_comments", "task_history", "task_review_rounds", "task_review_reports", "work_events"]) {
        await capture(table, "project_id = ?");
      }
    }
    await capture("task_message_links", scope);
  }
  if (versions.has(12)) {
    if (project) {
      await capture("memory_documents", "project_id = ?");
      await capture("memory_versions", "document_id IN (SELECT id FROM memory_documents WHERE project_id = ?)");
    } else await capture("work_events", "context_group_id = ?");
    await capture("memory_summary_requests", project ? "project_id = ?" : "context_group_id = ?");
    for (const table of ["memory_message_receipts", "memory_trigger_counters", "memory_scan_checkpoints"]) await capture(table, scope);
  }
  return digest.digest("hex");
}
