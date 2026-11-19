import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/server/policy/canonical.ts";
import { snapshotRuntimeConfig } from "../../src/server/runtime/config.ts";
import { addP0Row, p0Fixture, p0Integer, p0Text } from "./m2-p0-a-fixture.ts";
import type { RawCell } from "../../src/server/identity/m2-history-contracts.ts";
export const E_TIME = "2026-11-19T00:00:00.000Z";
export const E_DIGEST = "a".repeat(64);
export type EInput = ReturnType<typeof p0Fixture>;
export function eAdd(input: EInput, table: string, values: Record<string, string | number | null>): void {
  const backend = input.graph.observation.backend;
  addP0Row(input, table, Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
    value === null ? ["null"] : typeof value === "number" ? p0Integer(backend, table, key, BigInt(value)) : p0Text(backend, value),
  ])) as Record<string, RawCell>);
}
export function eSet(input: EInput, table: string, ordinal: number, column: string, value: string | number | null): void {
  const t = input.graph.observation.tables.find(t => t.name === table)!;
  t.rows[ordinal]!.cells[t.columns.indexOf(column)] = value === null ? ["null"] : typeof value === "number"
    ? p0Integer(input.graph.observation.backend, table, column, BigInt(value)) : p0Text(input.graph.observation.backend, value);
}
export function eCore(backend: "sqlite" | "postgres" = "sqlite"): EInput {
  const input = p0Fixture(backend);
  eAdd(input, "projects", { id: "p", name: "P", project_revision: 5, workspace_revision: 0, created_at: E_TIME, updated_at: E_TIME });
  eAdd(input, "agents", { id: "a", display_name: "A", host_type: "claude-code", created_at: E_TIME, updated_at: E_TIME });
  eAdd(input, "groups", { id: "g", project_id: "p", name: "G", created_at: E_TIME, updated_at: E_TIME });
  eAdd(input, "members", { id: "m", project_id: "p", agent_id: "a", kind: "agent", display_name: "A", role: "normal", status: "active", membership_revision: 1, created_at: E_TIME, updated_at: E_TIME });
  return input;
}
export function ePolicy(input: EInput, document: { scope: "user" | "project"; revision: number; projectId?: string } & Record<string, unknown>, basedOn: number | null = null): void {
  const raw = canonicalJson(document), key = document.scope === "user" ? "user" : `project:${document.projectId}`;
  eAdd(input, "policy_document_versions", { document_id: key, revision: document.revision, schema_version: 1, document_json: raw,
    content_digest: createHash("sha256").update("boardroom.policy-document.v1\n" + raw).digest("hex"), based_on_global_revision: basedOn,
    default_revision: 1, created_by_kind: "human", created_by_id: "h", created_at: E_TIME });
}
export function ePolicyHead(input: EInput, scope: "user" | "project", revision: number): void {
  eAdd(input, "policy_documents", { scope_key: scope === "user" ? "user" : "project:p", scope, project_id: scope === "user" ? null : "p", revision, created_at: E_TIME, updated_at: E_TIME });
}
export function eRuntime(input: EInput): void {
  const config = { model: null, workdir: "/not-contacted", tools: null, systemPrompt: "", permissionMode: "auto" as const };
  const requested = snapshotRuntimeConfig("claude-code", { ...config, model: "requested" }, { runtimeRevision: 2, bindingRevision: 2 }, "bypassPermissions");
  const applied = snapshotRuntimeConfig("claude-code", { ...config, model: "applied" }, { runtimeRevision: 1, bindingRevision: 1 }, null);
  eAdd(input, "group_participants", { group_id: "g", member_id: "m", joined_at: E_TIME });
  eAdd(input, "agent_runtimes", { id: "r", agent_id: "a", config_version: 1, revision: 3, defaults_json: JSON.stringify(config), created_at: E_TIME, updated_at: E_TIME });
  eAdd(input, "agent_runtime_bindings", { id: "b", runtime_id: "r", project_id: "p", group_id: "g", member_id: "m", revision: 3,
    overrides_json: '{"model":"effective"}', advanced_json: '{"strategy":"bypassPermissions","runtimeRevision":2,"bindingRevision":2}', desired_state: "stopped",
    intent_revision: 5, requested_snapshot_json: JSON.stringify(requested), reset_session_requested: 1, created_at: E_TIME, updated_at: E_TIME });
  eAdd(input, "agent_runner_states", { binding_id: "b", state: "stopped", phase: "unknown", generation: 4, lease_owner: null, lease_expires_at: null,
    applied_json: JSON.stringify(applied), harness_session_id: "old-SID", session_key: "claude-code:old-SID", session_state: "resumable", pid: null,
    exit_confirmed: 1, observed_at: E_TIME, started_at: E_TIME, attempt_count: 1, next_retry_at: null, last_error_code: null, last_exit_code: 0,
    last_exit_signal: null, permission_observed: "unknown", updated_at: E_TIME, process_identity_json: null });
  eAdd(input, "agent_runtime_members", { member_id: "m", runtime_id: "r", project_id: "p", binding_id: null, generation: 4, lease_owner: null, lease_expires_at: null, updated_at: E_TIME });
}
