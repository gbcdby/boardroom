import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbDriver, DbRow } from "../db/driver.ts";
import { createRepositories, type RepositorySet } from "../db/repositories.ts";
import { InvalidArgumentError, NotFoundError } from "../db/errors.ts";
import { createRuntimeRepository } from "../runtime/repository.ts";
import { RUNTIME_BACKENDS, RUNTIME_CONFIG_VERSION, snapshotRuntimeConfig } from "../runtime/config.ts";
import type { RuntimeAppliedConfig, RuntimeBackend, RuntimeBindingView, RuntimeConfig } from "../runtime/types.ts";
import type { LegacyBindingInspection, LegacyConfigInspection, LegacyConfigSnapshotSource, LegacyInspectionIssue,
  LegacyProfileSource, LegacySnapshotKind, LegacySnapshotSelection } from "../../shared/legacy-config.ts";

const revision = z.number().int().positive();
const configSchema = z.object({ model: z.string().nullable(), workdir: z.string().min(1), tools: z.array(z.string()).nullable(),
  systemPrompt: z.string(), permissionMode: z.enum(["auto", "manual", "workspace-write"]) }).strict();
const advancedSchema = z.object({ strategy: z.literal("bypassPermissions"), runtimeRevision: revision, bindingRevision: revision }).strict();
const snapshotSchema = z.object({ backend: z.enum(["claude-code", "codex-cli", "dsh"]), config: configSchema,
  versions: z.object({ runtimeRevision: revision, bindingRevision: revision }).strict(), advancedStrategy: z.literal("bypassPermissions").nullable(),
  digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stringOrNull = (value: unknown): string | null => value == null ? null : String(value);
const key = (displayName: unknown, hostType: unknown): string => JSON.stringify([displayName, hostType]);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function validJson(raw: string | null, schema: z.ZodTypeAny, nullable = false): boolean {
  if (raw === null) return nullable;
  try { return schema.safeParse(JSON.parse(raw)).success; } catch { return false; }
}
function snapshotSource(view: RuntimeBindingView, kind: LegacySnapshotKind, snapshot: RuntimeAppliedConfig, rawJson: string | null): LegacyConfigSnapshotSource {
  return { ref: { authority: "legacy", kind, sourceId: view.binding.id, runtimeId: view.runtime.id, bindingId: view.binding.id,
    agentId: view.runtime.agentId, digest: snapshot.digest, versions: { ...snapshot.versions }, configVersion: view.runtime.configVersion },
    snapshot, workdir: snapshot.config.workdir, rawJson, rawDigest: rawJson === null ? null : hash(rawJson),
    digestValid: snapshotRuntimeConfig(snapshot.backend, snapshot.config, snapshot.versions, snapshot.advancedStrategy).digest === snapshot.digest };
}

/** 纯选择器只消费这次已捕获的旧事实；不能重新读取最新 Profile 或将选择记为应用。 */
export function selectLegacyConfigSnapshot(binding: LegacyBindingInspection): LegacySnapshotSelection {
  const base = { authority: "legacy" as const, readOnly: true as const, activationAllowed: false as const };
  if (!binding.identityValid) return { ...base, code: "migration_identity_ambiguous", configSnapshotRef: null,
    snapshot: null, rawJson: null, reasons: binding.issues.filter(issue => issue.code === "migration_identity_ambiguous").map(issue => issue.reason) };
  // 有请求但内容损坏时必须阻塞，不能把它当成「不存在」后降级选择 applied/effective。
  if (!binding.configurationValid || !binding.view) return { ...base, code: "legacy_config_invalid", configSnapshotRef: null,
    snapshot: null, rawJson: null, reasons: binding.issues.filter(issue => issue.code === "legacy_config_invalid").map(issue => issue.reason) };
  const selected = binding.snapshots.requested ?? binding.snapshots.applied ?? binding.snapshots.effective;
  if (!selected) return { ...base, code: "legacy_config_invalid", configSnapshotRef: null, snapshot: null, rawJson: null, reasons: ["config_snapshot_missing"] };
  const reasons = ["workspace_mapping_required"];
  if (selected.snapshot.advancedStrategy !== null) reasons.push("migration_reconfirmation_required");
  if (!binding.view.runner.exitConfirmed) reasons.push("process_exit_unknown");
  return { ...base, code: null, configSnapshotRef: selected.ref, snapshot: selected.snapshot, rawJson: selected.rawJson, reasons };
}

/** 只读来源服务：唯一可写配置仍为 legacy runtime；不启动、不改意图、不构造可执行 Profile。 */
export function createLegacyConfigInspector({ db, repos = createRepositories(db), now = () => new Date() }: {
  db: DbDriver; repos?: RepositorySet; now?: () => Date;
}) {
  const runtimes = createRuntimeRepository(db, { repos });
  async function preflight(): Promise<LegacyConfigInspection> {
    // PG 的多表视图必须来自自己的 repeatable-read 只读事务，不能借用未知隔离级别的写事务。
    if (db.currentTransactionContext()) throw new InvalidArgumentError("legacy_inspection_requires_own_snapshot");
    return db.transaction(async tx => {
      if (db.kind === "postgres") await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const captured: Record<string, DbRow[]> = {};
      for (const [table, order] of [["agents", "id"], ["agent_runtimes", "id"], ["agent_runtime_bindings", "id"],
        ["agent_runner_states", "binding_id"], ["agent_runtime_members", "member_id"], ["members", "id"], ["projects", "id"],
        ["groups", "id"], ["group_participants", "group_id, member_id"]] as const) {
        captured[table] = await tx.query(`SELECT * FROM ${table} ORDER BY ${order}`);
      }
      const persistedAliases = Boolean((await tx.query("SELECT version FROM schema_migrations WHERE version = 14"))[0]);
      captured["agent_legacy_aliases"] = persistedAliases ? await tx.query("SELECT * FROM agent_legacy_aliases ORDER BY display_name, host_type") : [];
      const rows = (table: string) => captured[table]!;
      const byId = (table: string) => new Map(rows(table).map(row => [String(row.id), row]));
      const agents = byId("agents"), runtimeRows = byId("agent_runtimes"), members = byId("members"), projects = byId("projects"), groups = byId("groups");
      const runners = new Map(rows("agent_runner_states").map(row => [String(row.binding_id), row]));
      const participants = new Set(rows("group_participants").map(row => key(row.group_id, row.member_id)));
      const issues: LegacyInspectionIssue[] = [];
      const invalidAgents = new Set<string>(), invalidRuntimes = new Set<string>();
      function issue(code: LegacyInspectionIssue["code"], reason: string, refs: LegacyInspectionIssue["refs"]) {
        const item = { code, reason, refs }; issues.push(item); return item;
      }
      const identities = new Map<string, string[]>();
      for (const agent of agents.values()) {
        const identity = key(agent.display_name, agent.host_type);
        identities.set(identity, [...(identities.get(identity) ?? []), String(agent.id)]);
      }
      for (const ids of identities.values()) if (ids.length > 1) {
        ids.forEach(id => invalidAgents.add(id)); issue("migration_identity_ambiguous", "legacy_alias_conflict", { agentIds: ids });
      }
      const aliases = new Map(rows("agent_legacy_aliases").map(row => [key(row.display_name, row.host_type), row]));
      for (const alias of aliases.values()) {
        const agentId = String(alias.agent_id), exists = agents.has(agentId), retired = alias.retired_at !== null;
        if (retired === exists) {
          invalidAgents.add(agentId);
          issue("migration_identity_ambiguous", retired ? "retired_alias_has_live_agent" : "agent_alias_target_missing",
            { agentId, displayName: String(alias.display_name), hostType: String(alias.host_type) });
        }
      }
      if (persistedAliases) for (const agent of agents.values()) {
        const alias = aliases.get(key(agent.display_name, agent.host_type));
        if (!alias || alias.agent_id !== agent.id || alias.retired_at !== null) {
          invalidAgents.add(String(agent.id));
          issue("migration_identity_ambiguous", alias ? "legacy_alias_conflict" : "agent_legacy_alias_missing", { agentId: String(agent.id),
            displayName: String(agent.display_name), hostType: String(agent.host_type), ...(alias ? { aliasAgentId: String(alias.agent_id) } : {}) });
        }
      }
      const runtimeIdsByAgent = new Map<string, string[]>();
      for (const runtime of runtimeRows.values()) {
        const id = String(runtime.id), agentId = String(runtime.agent_id);
        runtimeIdsByAgent.set(agentId, [...(runtimeIdsByAgent.get(agentId) ?? []), id]);
        if (!agents.has(agentId)) { invalidRuntimes.add(id); issue("migration_identity_ambiguous", "runtime_agent_missing", { runtimeId: id, agentId }); }
        if (Number(runtime.config_version) !== RUNTIME_CONFIG_VERSION) issue("legacy_config_invalid", "legacy_config_version_unsupported",
          { runtimeId: id, agentId, configVersion: String(runtime.config_version) });
        const backend = String(agents.get(agentId)?.host_type);
        if (agents.has(agentId) && !RUNTIME_BACKENDS.includes(backend as RuntimeBackend)) issue("legacy_config_invalid", "runtime_backend_unsupported", { runtimeId: id, agentId, backend });
        if (!validJson(String(runtime.defaults_json), configSchema)) issue("legacy_config_invalid", "source_json_invalid", { runtimeId: id, agentId, field: "defaultsJson" });
      }
      for (const [agentId, ids] of runtimeIdsByAgent) if (ids.length > 1) {
        ids.forEach(id => invalidRuntimes.add(id)); issue("migration_identity_ambiguous", "runtime_agent_not_unique", { agentId, runtimeIds: ids });
      }
      const reservations = new Map(rows("agent_runtime_members").map(row => [String(row.member_id), row]));
      const bindingRows = new Map(rows("agent_runtime_bindings").map(row => [String(row.id), row]));
      for (const reservation of reservations.values()) {
        const memberId = String(reservation.member_id), runtimeId = String(reservation.runtime_id), projectId = String(reservation.project_id);
        const member = members.get(memberId), runtime = runtimeRows.get(runtimeId);
        const bound = reservation.binding_id === null ? null : bindingRows.get(String(reservation.binding_id));
        if (!member || !runtime || member.agent_id !== runtime.agent_id || member.project_id !== projectId
          || reservation.binding_id !== null && (!bound || bound.runtime_id !== runtimeId || bound.member_id !== memberId || bound.project_id !== projectId)) {
          invalidRuntimes.add(runtimeId);
          issue("migration_identity_ambiguous", "runtime_member_reservation_mismatch", { runtimeId, memberId, projectId,
            ...(reservation.binding_id === null ? {} : { bindingId: String(reservation.binding_id) }) });
        }
      }
      for (const runner of runners.values()) if (!bindingRows.has(String(runner.binding_id))) {
        issue("migration_identity_ambiguous", "runner_binding_missing", { bindingId: String(runner.binding_id) });
      }
      const bindings: LegacyBindingInspection[] = [];
      for (const row of rows("agent_runtime_bindings")) {
        const bindingId = String(row.id), runtimeId = String(row.runtime_id), memberId = String(row.member_id),
          projectId = String(row.project_id), groupId = String(row.group_id);
        const runtime = runtimeRows.get(runtimeId), member = members.get(memberId), group = groups.get(groupId), runner = runners.get(bindingId);
        const agentId = runtime ? String(runtime.agent_id) : null;
        const refs = { bindingId, runtimeId, memberId, projectId, groupId, ...(agentId ? { agentId } : {}) };
        const ownIssues: LegacyInspectionIssue[] = issues.filter(entry => entry.refs["agentId"] === agentId || entry.refs["runtimeId"] === runtimeId
          || Array.isArray(entry.refs["agentIds"]) && agentId !== null && entry.refs["agentIds"].includes(agentId)
          || Array.isArray(entry.refs["runtimeIds"]) && entry.refs["runtimeIds"].includes(runtimeId));
        const add = (code: LegacyInspectionIssue["code"], reason: string, extra: Record<string, string> = {}) => { const next = issue(code, reason, { ...refs, ...extra }); ownIssues.push(next); };
        if (!runtime) add("migration_identity_ambiguous", "binding_runtime_missing");
        if (!member || member.kind !== "agent" || member.agent_id !== agentId) add("migration_identity_ambiguous", "binding_member_agent_mismatch", { memberAgentId: String(member?.agent_id ?? "missing") });
        if (!projects.has(projectId)) add("migration_identity_ambiguous", "binding_project_missing");
        if (!member || member.project_id !== projectId) add("migration_identity_ambiguous", "binding_member_project_mismatch");
        if (!group || group.project_id !== projectId) add("migration_identity_ambiguous", "binding_group_project_mismatch");
        if (!participants.has(key(groupId, memberId))) add("migration_identity_ambiguous", "binding_participant_missing");
        const reservation = reservations.get(memberId);
        if (!reservation || reservation.runtime_id !== runtimeId || reservation.project_id !== projectId) add("migration_identity_ambiguous", "binding_runtime_member_mismatch");
        if (!runner) add("legacy_config_invalid", "runtime_state_incomplete");
        const raw = { runtimeRow: runtime ?? null, bindingRow: row, runnerRow: runner ?? null,
          defaultsJson: stringOrNull(runtime?.defaults_json), overridesJson: String(row.overrides_json), advancedJson: stringOrNull(row.advanced_json),
          requestedSnapshotJson: stringOrNull(row.requested_snapshot_json), appliedJson: stringOrNull(runner?.applied_json), processIdentityJson: stringOrNull(runner?.process_identity_json) };
        for (const [field, schema, nullable] of [["defaultsJson", configSchema, false], ["overridesJson", configSchema.partial(), false],
          ["advancedJson", advancedSchema, true], ["requestedSnapshotJson", snapshotSchema, true], ["appliedJson", snapshotSchema, true],
          ["processIdentityJson", z.object({}).passthrough(), true]] as const) {
          if (!validJson(raw[field], schema, nullable)) add("legacy_config_invalid", "source_json_invalid", { field });
        }
        let view: RuntimeBindingView | null = null;
        if (runtime && agents.has(String(runtime.agent_id)) && runner && !ownIssues.some(entry => entry.code === "legacy_config_invalid")) {
          view = await runtimes.getBinding(bindingId);
        }
        const snapshots = { requested: view?.binding.requestedSnapshot ? snapshotSource(view, "requestedSnapshot", view.binding.requestedSnapshot, raw.requestedSnapshotJson) : null,
          applied: view?.runner.applied ? snapshotSource(view, "applied", view.runner.applied, raw.appliedJson) : null,
          effective: view ? snapshotSource(view, "effective", view.effective, null) : null };
        for (const source of Object.values(snapshots)) if (source) {
          if (!source.digestValid) add("legacy_config_invalid", "snapshot_digest_mismatch", { snapshotKind: source.ref.kind });
          if (view && source.snapshot.backend !== view.runtime.backend) add("legacy_config_invalid", "snapshot_backend_mismatch", { snapshotKind: source.ref.kind });
          if (source.snapshot.advancedStrategy !== null && source.snapshot.backend !== "claude-code") add("legacy_config_invalid", "advanced_backend_mismatch", { snapshotKind: source.ref.kind });
          add("migration_mapping_required", "workspace_mapping_required", { snapshotKind: source.ref.kind, workdir: source.workdir });
        }
        const advanced = view ? { raw: view.binding.advanced, effectiveStrategy: view.effective.advancedStrategy,
          validity: view.binding.advanced === null ? "not_selected" as const : view.effective.advancedStrategy === null ? "invalidated_by_revision" as const : "effective" as const } : null;
        if (advanced?.validity === "invalidated_by_revision") add("legacy_configuration_differs", "invalidated_by_revision");
        if (Object.values(snapshots).some(source => source?.snapshot.advancedStrategy)) add("migration_mapping_required", "migration_reconfirmation_required");
        if (new Set(Object.values(snapshots).filter(source => source !== null).map(source => source.ref.digest)).size > 1) add("legacy_configuration_differs", "non_equivalent_snapshots");
        if (view && !view.runner.exitConfirmed) add("migration_mapping_required", "process_exit_unknown");
        const identityValid = !invalidRuntimes.has(runtimeId) && (agentId === null || !invalidAgents.has(agentId)) && !ownIssues.some(entry => entry.code === "migration_identity_ambiguous");
        bindings.push({ bindingId, runtimeId, agentId, memberId, projectId, groupId, identityValid,
          configurationValid: view !== null && !ownIssues.some(entry => entry.code === "legacy_config_invalid"), view, raw, snapshots, advanced, issues: ownIssues });
      }
      const profiles: LegacyProfileSource[] = [];
      for (const agent of agents.values()) {
        const agentId = String(agent.id), runtimeIds = runtimeIdsByAgent.get(agentId) ?? [];
        const valid = !invalidAgents.has(agentId) && runtimeIds.length <= 1 && !runtimeIds.some(id => invalidRuntimes.has(id));
        const runtime = runtimeIds.length === 1 ? runtimeRows.get(runtimeIds[0]!) : undefined;
        let source: LegacyProfileSource["source"] = null;
        if (valid && runtime && !issues.some(entry => entry.code === "legacy_config_invalid" && entry.refs["runtimeId"] === runtime.id)
          && validJson(String(runtime.defaults_json), configSchema)) {
          const { workdir, ...nonDirectoryDefaults } = JSON.parse(String(runtime.defaults_json)) as RuntimeConfig;
          source = { runtimeId: String(runtime.id), backend: String(agent.host_type) as RuntimeBackend,
            configVersion: Number(runtime.config_version), runtimeRevision: Number(runtime.revision), nonDirectoryDefaults, legacyWorkdir: workdir };
        }
        profiles.push({ agentId, displayName: String(agent.display_name), authority: "legacy", writable: false, migrated: false,
          mode: !valid ? "ambiguous" : runtimeIds.length === 0 ? "external" : "legacy-runtime", runtimeIds,
          bindingIds: bindings.filter(binding => binding.agentId === agentId).map(binding => binding.bindingId), source });
      }
      return { schemaVersion: "legacy-config-inspection/v1", authority: "legacy", readOnly: true, migrated: false,
        observedAt: now().toISOString(), sourceDigest: hash(canonical(captured)), aliasCatalogState: persistedAliases ? "persisted" : "pre-migration",
        code: issues.some(entry => entry.code === "migration_identity_ambiguous") ? "migration_identity_ambiguous"
          : issues.some(entry => entry.code === "legacy_config_invalid") ? "legacy_config_invalid" : null, profiles, bindings, issues };
    });
  }
  return { preflight, async profile(agentId: string) {
    const report = await preflight(), profile = report.profiles.find(source => source.agentId === agentId);
    if (!profile) throw new NotFoundError("agent_not_found");
    const issues = report.issues.filter(issue => issue.refs["agentId"] === agentId
      || Array.isArray(issue.refs["agentIds"]) && issue.refs["agentIds"].includes(agentId)
      || typeof issue.refs["runtimeId"] === "string" && profile.runtimeIds.includes(issue.refs["runtimeId"]));
    return { profile, bindings: report.bindings.filter(binding => binding.agentId === agentId), observedAt: report.observedAt,
      sourceDigest: report.sourceDigest, code: issues.some(issue => issue.code === "migration_identity_ambiguous") ? "migration_identity_ambiguous"
        : issues.some(issue => issue.code === "legacy_config_invalid") ? "legacy_config_invalid" : null, issues };
  }, async binding(bindingId: string) {
    const report = await preflight(), binding = report.bindings.find(source => source.bindingId === bindingId);
    if (!binding) throw new NotFoundError("runtime_binding_not_found"); return binding;
  } };
}
