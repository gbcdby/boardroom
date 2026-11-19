import type { RawCell } from "../../src/server/identity/m2-history-contracts.ts";
import { addP0Row, p0Fixture, p0Integer, p0Text } from "./m2-p0-a-fixture.ts";
export type BFixture = ReturnType<typeof p0Fixture>;
export function addB(input: BFixture, table: string, fields: Record<string, string | bigint | null>, rowid?: string): void {
  const backend = input.graph.observation.backend;
  const cells = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, value === null ? ["null"]
    : typeof value === "bigint" ? p0Integer(backend, table, name, value) : p0Text(backend, value)])) as Record<string, RawCell>;
  addP0Row(input, table, cells, rowid);
}
export function setB(input: BFixture, table: string, ordinal: number, column: string, value: string | bigint | null): void {
  const target = input.graph.observation.tables.find(t => t.name === table)!;
  target.rows[ordinal]!.cells[target.columns.indexOf(column)] = value === null ? ["null"]
    : typeof value === "bigint" ? p0Integer(input.graph.observation.backend, table, column, value) : p0Text(input.graph.observation.backend, value);
}
export function removeB(input: BFixture, table: string, ordinal: number): void {
  const target = input.graph.observation.tables.find(t => t.name === table)!;
  target.rows.splice(ordinal, 1); target.count = String(target.rows.length);
}
export function aliasFixture(backend: "sqlite" | "postgres" = "sqlite"): BFixture {
  const input = p0Fixture(backend);
  addB(input, "agents", { id: "agent-one", display_name: "new-one", host_type: "h", created_at: "t", updated_at: "t" });
  addB(input, "agents", { id: "agent-two", display_name: "two", host_type: "h", created_at: "t", updated_at: "t" });
  for (const [name, target, retired] of [["new-one", "agent-one", null], ["two", "agent-two", null], ["old-one", "agent-one", null], ["retired", "gone", "t"]] as const) {
    addB(input, "agent_legacy_aliases", { display_name: name, host_type: "h", agent_id: target, created_at: "t", retired_at: retired });
  }
  return input;
}
export function addRoleVersion(input: BFixture, id: string, revision: bigint, copiedId: string | null = null, copiedRevision: bigint | null = null,
  skills = "[]"): void {
  addB(input, "role_template_versions", { role_template_id: id, revision, name: " role ", purpose: "purpose", instructions: "instructions",
    recommended_skill_refs_json: skills, archived_at: null, copied_from_role_template_id: copiedId, copied_from_revision: copiedRevision, created_at: "t" });
}
export function roleFixture(backend: "sqlite" | "postgres" = "sqlite"): BFixture {
  const input = p0Fixture(backend);
  addB(input, "role_templates", { id: "source", revision: 1n, created_at: "t", updated_at: "t" });
  addB(input, "role_templates", { id: "copy", revision: 1n, created_at: "t", updated_at: "t" });
  addRoleVersion(input, "source", 1n);
  addRoleVersion(input, "source", 2n);
  addRoleVersion(input, "copy", 1n, "source", 2n, '[ { "version" : "v1", "contentDigest" : "' + "a".repeat(64) + '", "skillId": "not-installed" } ]');
  return input;
}
export function addProject(input: BFixture, id = "project"): void {
  addB(input, "projects", { id, name: id, created_at: "t", updated_at: "t", archived_at: null, project_revision: 1n, workspace_revision: 0n });
}
export function addMember(input: BFixture, id: string, project = "project", node: string | null = null, role = "normal", agent: string | null = null): void {
  addB(input, "members", { id, project_id: project, agent_id: agent, kind: agent === null ? "human" : "agent", display_name: id, role,
    node_id: node, status: "active", removed_at: null, membership_revision: 1n, created_at: "t", updated_at: "t" });
  for (const kind of ["authored-messages", "deliveries", "memory-requests", "memory-receipts", "memory-counters", "memory-checkpoints"]) {
    addB(input, "member_fact_revisions", { member_id: id, kind, revision: 1n });
  }
}
export function addNode(input: BFixture, id: string, parent: string | null, role: string, project = "project"): void {
  addB(input, "org_nodes", { id, project_id: project, parent_id: parent, name: id, role, sort_order: 0n, created_at: "t", updated_at: "t" });
}
export function orgFixture(backend: "sqlite" | "postgres" = "sqlite"): BFixture {
  const input = p0Fixture(backend); addProject(input); addNode(input, "root", null, "top_manager"); addNode(input, "leaf", "root", "member");
  addMember(input, "manager", "project", "root", "manager"); addMember(input, "worker", "project", "leaf");
  addMember(input, "removed"); setB(input, "members", 2, "status", "disabled"); setB(input, "members", 2, "removed_at", "t");
  addProject(input, "legacy"); addMember(input, "legacy-manager", "legacy", null, "manager");
  return input;
}
export function chatFixture(backend: "sqlite" | "postgres" = "sqlite"): BFixture {
  const input = orgFixture(backend);
  addB(input, "agents", { id: "agent", display_name: "current-agent", host_type: "current-host", created_at: "t", updated_at: "t" });
  addB(input, "agent_legacy_aliases", { display_name: "current-agent", host_type: "current-host", agent_id: "agent", retired_at: null, created_at: "t" });
  addMember(input, "agent-member", "project", null, "normal", "agent");
  setB(input, "members", 1, "status", "disabled"); setB(input, "members", 4, "status", "disabled");
  for (const [id, project] of [["group", "project"], ["other-group", "legacy"]]) {
    addB(input, "groups", { id: id!, project_id: project!, name: id!, archived_at: "old", created_at: "t", updated_at: "t" });
  }
  addB(input, "group_participants", { group_id: "group", member_id: "worker", joined_at: "t" });
  addMessage(input, "message", "group", "removed", 7n);
  addB(input, "message_deliveries", { id: "delivery", message_id: "message", member_id: "worker", project_id: "project", status: "acked",
    attempt_count: 2n, first_delivered_at: "first", last_delivered_at: "last", acked_at: "acked", created_at: "t", updated_at: "t",
    wake_decision: null, wake_suppressed_reason: null, first_mcp_delivered_at: null });
  addB(input, "member_statuses", { project_id: "project", member_id: "worker", state: "online", updated_at: "t" });
  addSession(input, "session", "disconnected");
  return input;
}
export function addMessage(input: BFixture, id: string, group = "group", sender = "removed", seq = 8n, client: string | null = null): void {
  addB(input, "messages", { id, group_id: group, sender_member_id: sender, seq, body: "old body", created_at: "t", client_message_id: client,
    mentions: '[ "no-longer-a-member", "legacy-manager", "no-longer-a-member", "" ]' });
}
export function addSession(input: BFixture, id: string, state: string): void {
  addB(input, "mcp_sessions", { id, agent_id: "agent", project_id: "project", group_id: "group", member_id: "agent-member",
    display_name: "past-agent", host_type: "past-host", state, connected_at: "t", last_heartbeat_at: null, disconnected_at: "t", updated_at: "t" });
}
