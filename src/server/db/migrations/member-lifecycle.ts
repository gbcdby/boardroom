import type { Migration } from "../migrate.ts";

const kinds = ["authored-messages", "deliveries", "memory-requests", "memory-receipts", "memory-counters", "memory-checkpoints"] as const;
type FactSpec = { table: string; kind: typeof kinds[number]; columns: readonly string[]; ownerColumn?: string };
/** 明确列出事实列；updated_at 仅为观测时间的表特意排除它。 */
const facts: readonly FactSpec[] = [
  { table: "messages", kind: "authored-messages", ownerColumn: "sender_member_id", columns: ["id", "group_id", "sender_member_id", "seq", "body", "mentions", "created_at", "client_message_id"] },
  { table: "message_deliveries", kind: "deliveries", ownerColumn: "member_id", columns: ["id", "message_id", "member_id", "project_id", "status", "attempt_count", "first_delivered_at", "last_delivered_at", "acked_at", "created_at", "wake_decision", "wake_suppressed_reason", "first_mcp_delivered_at"] },
  { table: "memory_summary_requests", kind: "memory-requests", ownerColumn: "recipient_member_id", columns: ["id", "project_id", "agent_id", "recipient_member_id", "context_group_id", "document_id", "base_version", "revision", "state", "trigger", "trigger_key", "task_id", "completed_task_revision", "message_ids", "source_work_event_id", "retry_of_request_id", "attempt_id", "begin_mutation_id", "result_version", "result_sha256", "error", "evidence", "created_at", "started_at", "finished_at"] },
  { table: "memory_message_receipts", kind: "memory-receipts", columns: ["project_id", "agent_id", "group_id", "message_id", "first_observed_at", "counter_value"] },
  { table: "memory_trigger_counters", kind: "memory-counters", columns: ["project_id", "agent_id", "group_id", "lifetime_count", "next_threshold", "configured_n", "threshold_sequence", "revision"] },
  { table: "memory_scan_checkpoints", kind: "memory-checkpoints", columns: ["id", "kind", "project_id", "agent_id", "group_id", "after_cursor", "through_cursor", "sweep", "revision"] },
];
const base = `
  ALTER TABLE members ADD COLUMN removed_at TEXT;
  ALTER TABLE members ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 1 CHECK (membership_revision BETWEEN 1 AND 9007199254740991);
  CREATE INDEX ix_members_effective ON members (project_id, removed_at, status, id);
  CREATE TABLE member_fact_revisions (
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN (${kinds.map(kind => `'${kind}'`).join(",")})),
    revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (member_id, kind)
  );
  INSERT INTO member_fact_revisions (member_id, kind, revision)
    SELECT m.id, k.kind, 1 FROM members m CROSS JOIN (${kinds.map(kind => `SELECT '${kind}' AS kind`).join(" UNION ALL ")}) k;
  CREATE INDEX ix_participants_member_group ON group_participants (member_id, group_id);
  CREATE INDEX ix_tasks_assignee_seek ON tasks (project_id, assignee_member_id, id);
  CREATE INDEX ix_tasks_reviewer_seek ON tasks (project_id, reviewer_member_id, id);
  CREATE INDEX ix_rounds_reviewer_seek ON task_review_rounds (project_id, reviewer_member_id, id);
  CREATE INDEX ix_rounds_reviewer_state_seek ON task_review_rounds (project_id, reviewer_member_id, state, id);
  CREATE INDEX ix_memory_requests_recipient_seek ON memory_summary_requests (recipient_member_id, state, id);
  CREATE INDEX ix_work_events_recipient_seek ON work_events (recipient_member_id, id);
  CREATE INDEX ix_work_events_task_state_seek ON work_events (project_id, task_id, delivery_state, id);
  CREATE INDEX ix_sessions_member_state_seek ON mcp_sessions (member_id, state, id);
  CREATE INDEX ix_bindings_member_seek ON agent_runtime_bindings (member_id, id);
  CREATE INDEX ix_org_project_parent_seek ON org_nodes (project_id, parent_id, id);
`;
function owner(spec: FactSpec, row: "OLD" | "NEW"): string {
  return `SELECT id FROM members WHERE ${spec.ownerColumn ? `id = ${row}.${spec.ownerColumn}` : `project_id = ${row}.project_id AND agent_id = ${row}.agent_id`}`;
}
function sqliteFactTriggers(spec: FactSpec): string {
  return (["INSERT", "UPDATE", "DELETE"] as const).map(operation => {
    const affected = operation === "INSERT" ? owner(spec, "NEW") : operation === "DELETE" ? owner(spec, "OLD") : `${owner(spec, "OLD")} UNION ${owner(spec, "NEW")}`;
    const when = operation === "UPDATE" ? `WHEN ${spec.columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}` : "";
    return `CREATE TRIGGER fact_${spec.table}_${operation.toLowerCase()} AFTER ${operation} ON ${spec.table} ${when} BEGIN
      SELECT CASE WHEN EXISTS (SELECT id FROM members WHERE id IN (${affected}) AND NOT EXISTS
        (SELECT 1 FROM member_fact_revisions f WHERE f.member_id = members.id AND f.kind = '${spec.kind}' AND f.revision < 9007199254740991))
        THEN RAISE(ABORT, 'member_fact_revision_missing_or_overflow') END;
      UPDATE member_fact_revisions SET revision = revision + 1 WHERE kind = '${spec.kind}' AND member_id IN (${affected});
    END;`;
  }).join("\n");
}
function postgresFactTriggers(spec: FactSpec): string {
  const bump = (affected: string) => `FOR target_id IN ${affected} LOOP
    UPDATE member_fact_revisions SET revision = revision + 1 WHERE member_id = target_id AND kind = '${spec.kind}' AND revision < 9007199254740991;
    IF NOT FOUND THEN RAISE EXCEPTION 'member_fact_revision_missing_or_overflow' USING ERRCODE = '23514'; END IF;
  END LOOP;`;
  return `CREATE FUNCTION bump_fact_${spec.table}() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_id TEXT;
    BEGIN
      IF TG_OP = 'UPDATE' AND NOT (${spec.columns.map(column => `OLD.${column} IS DISTINCT FROM NEW.${column}`).join(" OR ")}) THEN RETURN NEW; END IF;
      IF TG_OP = 'INSERT' THEN ${bump(owner(spec, "NEW"))}
      ELSIF TG_OP = 'DELETE' THEN ${bump(owner(spec, "OLD"))}
      ELSE ${bump(`${owner(spec, "OLD")} UNION ${owner(spec, "NEW")}`)} END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END; $$;
    CREATE TRIGGER fact_${spec.table} AFTER INSERT OR UPDATE OR DELETE ON ${spec.table} FOR EACH ROW EXECUTE FUNCTION bump_fact_${spec.table}();`;
}
const sqliteMembers = `
  CREATE TRIGGER member_lifecycle_insert BEFORE INSERT ON members
    WHEN NEW.removed_at IS NOT NULL AND (NEW.status <> 'disabled' OR NEW.node_id IS NOT NULL OR NEW.role <> 'normal')
    BEGIN SELECT RAISE(ABORT, 'member_removed_invariant'); END;
  CREATE TRIGGER member_lifecycle_update BEFORE UPDATE ON members
    WHEN (NEW.removed_at IS NOT NULL AND (NEW.status <> 'disabled' OR NEW.node_id IS NOT NULL OR NEW.role <> 'normal'))
      OR NEW.membership_revision < OLD.membership_revision
      OR (NEW.removed_at IS NOT OLD.removed_at AND NEW.membership_revision <> OLD.membership_revision + 1)
    BEGIN SELECT RAISE(ABORT, 'member_lifecycle_revision_conflict'); END;
  CREATE TRIGGER member_facts_initialize AFTER INSERT ON members BEGIN
    ${kinds.map(kind => `INSERT INTO member_fact_revisions (member_id, kind, revision) VALUES (NEW.id, '${kind}', 1);`).join("\n")}
  END;
`;
const postgresMembers = `
  CREATE FUNCTION validate_member_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.removed_at IS NOT NULL AND (NEW.status <> 'disabled' OR NEW.node_id IS NOT NULL OR NEW.role <> 'normal') THEN
      RAISE EXCEPTION 'member_removed_invariant' USING ERRCODE = '23514'; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.membership_revision < OLD.membership_revision OR
      (NEW.removed_at IS DISTINCT FROM OLD.removed_at AND NEW.membership_revision <> OLD.membership_revision + 1)) THEN
      RAISE EXCEPTION 'member_lifecycle_revision_conflict' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END; $$;
  CREATE TRIGGER member_lifecycle BEFORE INSERT OR UPDATE ON members FOR EACH ROW EXECUTE FUNCTION validate_member_lifecycle();
  CREATE FUNCTION initialize_member_facts() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    ${kinds.map(kind => `INSERT INTO member_fact_revisions (member_id, kind, revision) VALUES (NEW.id, '${kind}', 1);`).join("\n")}
    RETURN NEW;
  END; $$;
  CREATE TRIGGER member_facts_initialize AFTER INSERT ON members FOR EACH ROW EXECUTE FUNCTION initialize_member_facts();
`;

/** v13 只追加：历史身份墓碑、单调代际、六类事实版本与有界关系采集索引。 */
export const memberLifecycleMigration: Migration = {
  version: 13, name: "member_tombstones_and_retained_fact_revisions",
  up: base + sqliteMembers + facts.map(sqliteFactTriggers).join("\n"),
  upPostgres: base + postgresMembers + facts.map(postgresFactTriggers).join("\n"),
};
