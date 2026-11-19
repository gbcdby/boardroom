// #153 P0-A shared internal types. No public closure contract or semantic success token.
import type { HistoryObservationInput, RawCell, RawRow } from "../m2-history-contracts.ts";
import type { ArtifactRef, EvidenceRef, ReadonlyDeep } from "../m2-value-contracts.ts";
export const P0_TABLE_NAMES = Object.freeze(["agent_legacy_aliases", "agent_runner_states", "agent_runtime_bindings", "agent_runtime_events", "agent_runtime_members", "agent_runtime_observation_meta", "agent_runtime_usage_snapshots", "agent_runtimes", "agents", "audit_log", "decision_action_requests", "decision_change_heads", "decision_changes", "decision_command_receipts", "decision_executions", "decision_legacy_records", "decision_local_initiations", "decision_records", "decision_resolutions", "decision_review_heads", "decision_review_projections", "decision_user_events", "group_participants", "groups", "mcp_catalog_heads", "mcp_catalog_snapshots", "mcp_connection_mutations", "mcp_connection_versions", "mcp_connections", "mcp_discovery_attempts", "mcp_sessions", "member_fact_revisions", "member_statuses", "members", "memory_documents", "memory_message_receipts", "memory_scan_checkpoints", "memory_summary_requests", "memory_trigger_counters", "memory_versions", "message_deliveries", "messages", "org_nodes", "policy_document_versions", "policy_documents", "project_task_settings", "project_workspace_versions", "projects", "role_template_versions", "role_templates", "schema_migrations", "storage_maintenance", "storage_source_clients", "task_comments", "task_history", "task_message_links", "task_review_reports", "task_review_rounds", "tasks", "work_event_delivery_invalidations", "work_events"] as const);
export const P0_RULES = Object.freeze(["PC1B-RAW01", "PC1B-KEY01", "PC1B-ID01", "PC1B-ROLE01", "PC1B-ROLE02", "PC1B-ORG01", "PC1B-CHAT01", "PC1B-TASK01", "PC1B-TASK02", "PC1B-DEC01", "PC1B-DEC02", "PC1B-DEC03", "PC1B-DEC04", "PC1B-DEC05", "PC1B-DEC06", "PC1B-DEC07", "PC1B-DEC08", "PC1B-DEC09", "PC1B-DEC10", "PC1B-DEC11", "PC1B-DEC12", "PC1B-WE01", "PC1B-WE02", "PC1B-WE03", "PC1B-WE04", "PC1B-AUD01", "PC1B-AUD02", "PC1B-AUD03", "PC1B-MEM01", "PC1B-MEM02", "PC1B-MEM03", "PC1B-MEM04", "PC1B-POL01", "PC1B-MCP01", "PC1B-MCP02", "PC1B-MCP03", "PC1B-WS01", "PC1B-RT01", "PC1B-RT02", "PC1B-M201", "PC1B-M202", "PC1B-M203", "PC1B-M204", "PC1B-ART01", "PC1B-DEL01", "PC1B-DEC13", "PC1B-TASK03", "PC1B-MEM05"] as const);
export type P0Table = typeof P0_TABLE_NAMES[number];
export type P0Rule = typeof P0_RULES[number];
export type P0Phase = "input" | "artifact" | "original-graph" | "retained-graph";
export type P0Code = "unsupported_shape" | "invalid_value" | "source_contract_mismatch" | "semantic_unsupported"
  | "semantic_invariant_failed" | "artifact_missing" | "artifact_bytes_mismatch" | "artifact_kind_unsupported"
  | "artifact_semantic_mismatch" | "retained_reference_conflict" | "format_unregistered" | "resource_limit";
export type P0Condition = "missing-target" | "scope-mismatch" | "state-mismatch" | "count-mismatch"
  | "history-gap" | "identity-mismatch" | "source-mismatch" | "format-mismatch" | "bytes-mismatch"
  | "immutable-history-mismatch" | "phase-mismatch" | "duplicate-key" | "conditional-target-required"
  | "negative-invariant" | "unsupported-value" | "undefined-grammar" | "budget-exceeded";
export type P0Path = "input.root" | "observation.root" | "artifact.root" | "row.cell" | `${P0Rule}.P01`;
export type P0Location = Readonly<{ inputPart: "input" | "observation" | "artifact";
  artifactOrdinal: number | null; table: P0Table | null; rowOrdinal: number | null;
  columnOrdinal: number | null; pathId: P0Path }>;
export type P0Conflict = Readonly<{ rule: P0Rule; source: P0Location; target: P0Location | null; condition: P0Condition }>;
export type P0Error = ReadonlyDeep<{ code: P0Code; phase: P0Phase; rule: P0Rule | null;
  location: P0Location | null; conflicts: P0Conflict[]; moreConflicts: boolean }>;
export type P0Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: P0Error };
export type P0SelectedArtifact = ReadonlyDeep<{ kind: string; artifact: ArtifactRef; bytesHex: string }>;
export type P0EvidenceSelection = ReadonlyDeep<{ kind: string; evidence: EvidenceRef; artifact: ArtifactRef }>;
export type P0Input = ReadonlyDeep<{ contract: "m2-history-closure-input/r2";
  graph: { kind: "m2-observation"; observation: HistoryObservationInput & { phase: "p0" }; origin: null };
  artifacts: P0SelectedArtifact[]; evidence: P0EvidenceSelection[];
  proposedDeletion: { rows: { table: P0Table; key: RawCell[]; rowid: string | null }[] } | null }>;
declare const rowBrand: unique symbol;
declare const viewBrand: unique symbol;
declare const requestBrand: unique symbol;
declare const siteBrand: unique symbol;
export interface P0Row { readonly [rowBrand]: true; readonly table: P0Table; readonly tableOrdinal: number;
  readonly rowOrdinal: number; readonly raw: ReadonlyDeep<RawRow>; }
export interface P0View { readonly [viewBrand]: true; readonly phase: "original-graph" | "retained-graph";
  rows(table: P0Table): readonly P0Row[]; readonly rowCount: number; }
export interface P0Request { readonly [requestBrand]: true; readonly input: P0Input; readonly original: P0View; }
export interface P0Site { readonly [siteBrand]: true; readonly location: P0Location; readonly phase: P0Phase; }
export type P0JsonPolicy = "reference" | "finite" | "legacy-display";
export type P0Cost = Readonly<{ work?: number; bytes?: number; tuples?: number; nodes?: number }>;
export type P0Usage = Readonly<{ work: number; bytes: number; tuples: number; nodes: number;
  rows: number; selectedBytes: number }>;
export type P0KeyPart = string | bigint | number | null | readonly ["blob", string];
export interface P0TupleIndex<T> { readonly size: number;
  get(key: readonly P0KeyPart[]): T | undefined;
  has(key: readonly P0KeyPart[]): boolean;
  /** Returns an existing value without replacing it; undefined means inserted. */
  insert(key: readonly P0KeyPart[], value: T): T | undefined;
}
export type P0KeyObservation = Readonly<{ classification: "sql-constraint-observation";
  phase: "original-graph" | "retained-graph"; tables: number; rows: number;
  fullSemanticClosure: "not-performed" }>;
export type P0Failure = Readonly<{ code: P0Code; rule: P0Rule | null; condition?: P0Condition;
  site?: P0Site; target?: P0Site | null }>;
