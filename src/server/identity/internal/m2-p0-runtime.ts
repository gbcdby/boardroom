import { z } from "zod";
import { snapshotRuntimeConfig } from "../../runtime/config.ts";
import type { RuntimeBackend, RuntimeConfig } from "../../runtime/types.ts";
import type { P0Row } from "./m2-p0.ts";
import { EContext, digestValue, safeRevision } from "./m2-p0-e-context.ts";

const RT = "PC1B-RT01";
const configSchema = z.object({ model: z.string().nullable(), workdir: z.string().min(1), tools: z.array(z.string()).nullable(),
  systemPrompt: z.string(), permissionMode: z.enum(["auto", "manual", "workspace-write"]) }).strict();
const advancedSchema = z.object({ strategy: z.literal("bypassPermissions"), runtimeRevision: safeRevision, bindingRevision: safeRevision }).strict();
const snapshotSchema = z.object({ backend: z.enum(["claude-code", "codex-cli", "dsh"]), config: configSchema,
  versions: z.object({ runtimeRevision: safeRevision, bindingRevision: safeRevision }).strict(),
  advancedStrategy: z.literal("bypassPermissions").nullable(), digest: digestValue }).strict();
const processSchema = z.object({ version: z.literal(1), launcherProtocol: z.literal("linux-private-net-v1"), pid: safeRevision,
  kernelBootId: z.string().regex(/^[0-9a-f-]{36}$/), pidNamespace: z.string().regex(/^pid:\[\d+\]$/), startTicks: z.string().regex(/^\d+$/) }).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type Inspected<T> = { valid: boolean; present: boolean; value: T | null };
export type RuntimeUsability = Readonly<{
  table: "agent_runtimes" | "agent_runtime_bindings"; rowOrdinal: number; usable: boolean;
  selected: "requestedSnapshot" | "applied" | "effective" | null;
  advanced: "not_selected" | "effective" | "invalidated_by_revision" | "unusable";
}>;

/** Same legacy inspection branch: invalid nonselected configuration remains observable.
 * SQL NULL and JSON null are intentionally different. No fallback after invalid requested JSON. */
function inspect<S extends z.ZodTypeAny>(ctx: EContext, row: P0Row, column: string, schema: S, nullable: boolean): Inspected<z.infer<S>> {
  const raw = ctx.nullableText(row, column, RT);
  if (raw === null) return { valid: nullable, present: false, value: null };
  const value = ctx.json(row, column, RT, "legacy-display");
  if (value === undefined) return { valid: false, present: true, value: null };
  ctx.reserve(value, ctx.site(row, RT, column), 1);
  const parsed = schema.safeParse(value);
  return parsed.success ? { valid: true, present: true, value: parsed.data } : { valid: false, present: true, value: null };
}

function snapshotUsable(ctx: EContext, snapshot: Snapshot | null, backend: string, row: P0Row, column: string): boolean {
  if (!snapshot) return true;
  const site = ctx.site(row, RT, column);
  // Actual old snapshotRuntimeConfig: a config/tool-array clone, fixed-key stringify and SHA.
  const cost = ctx.reserve(snapshot, site, 2, 1, 4);
  ctx.charge(4, cost.encoded * 2 + 512, site, 0, 4);
  const actual = snapshotRuntimeConfig(snapshot.backend, snapshot.config, snapshot.versions, snapshot.advancedStrategy);
  return snapshot.backend === backend && (snapshot.advancedStrategy === null || snapshot.backend === "claude-code")
    && actual.digest === snapshot.digest;
}

export function checkP0Runtime(ctx: EContext): readonly RuntimeUsability[] {
  const agents = ctx.index("agents", ["id"], RT), runtimes = ctx.index("agent_runtimes", ["id"], RT);
  const bindings = ctx.index("agent_runtime_bindings", ["id"], RT), runners = ctx.index("agent_runner_states", ["binding_id"], RT);
  const members = ctx.index("members", ["id"], RT), projects = ctx.index("projects", ["id"], RT), groups = ctx.index("groups", ["id"], RT);
  const reservations = ctx.index("agent_runtime_members", ["member_id"], RT);
  const participants = ctx.index("group_participants", ["group_id", "member_id"], RT);
  ctx.charge(3, 0, undefined, 0, 3);
  const runtimeFacts = new Map<P0Row, { backend: string; revision: number; usable: boolean; defaults: RuntimeConfig | null }>();
  const runnerConfiguration = new Map<P0Row, boolean>();
  const observations: RuntimeUsability[] = [];
  const observe = (item: RuntimeUsability): void => { ctx.charge(8, 256, undefined, 1, 1); observations.push(Object.freeze(item)); };
  for (const row of ctx.rows("agent_runtimes")) {
    const agent = ctx.target(agents, [ctx.text(row, "agent_id", RT)], row, RT, "agent_id");
    const backend = ctx.text(agent, "host_type", RT), revision = ctx.integer(row, "revision", RT, 1), version = ctx.integer(row, "config_version", RT, 1);
    const defaults = inspect(ctx, row, "defaults_json", configSchema, false);
    const usable = version === 1 && ["claude-code", "codex-cli", "dsh"].includes(backend) && defaults.valid;
    ctx.text(row, "created_at", RT); ctx.text(row, "updated_at", RT);
    ctx.charge(1, 0, ctx.site(row, RT), 0, 1); runtimeFacts.set(row, { backend, revision, usable, defaults: defaults.value });
    observe({ table: "agent_runtimes", rowOrdinal: row.rowOrdinal, usable, selected: null, advanced: "not_selected" });
  }
  for (const row of ctx.rows("agent_runner_states")) {
    const bindingId = ctx.text(row, "binding_id", RT);
    const binding = ctx.target(bindings, [bindingId], row, RT, "binding_id");
    ctx.oneOf(row, "state", RT, ["stopped", "starting", "running", "stopping", "failed"]);
    ctx.oneOf(row, "phase", RT, ["idle", "working", "unknown"]);
    ctx.oneOf(row, "session_state", RT, ["new", "resumable", "invalid", "reset", "unknown"]);
    ctx.oneOf(row, "permission_observed", RT, ["unknown", "auto", "manual", "workspace-write", "bypassPermissions"]);
    ctx.integer(row, "generation", RT); ctx.integer(row, "attempt_count", RT); ctx.bool(row, "exit_confirmed", RT);
    ctx.nullableInteger(row, "pid", RT, 1); ctx.nullableInteger(row, "last_exit_code", RT, Number.MIN_SAFE_INTEGER);
    for (const column of ["lease_owner", "lease_expires_at", "harness_session_id", "session_key", "observed_at", "started_at", "next_retry_at", "last_error_code", "last_exit_signal"]) ctx.nullableText(row, column, RT);
    const owner = ctx.nullableText(row, "lease_owner", RT), expiry = ctx.nullableText(row, "lease_expires_at", RT);
    if ((owner === null) !== (expiry === null)) ctx.fail(row, RT, "state-mismatch", "lease_owner");
    if (owner !== null) {
      // claim/renew/markExit persist the same ownership tuple in both tables.
      // Released runners may keep old generations and snapshots; only a runner
      // that actually owns a lease must be pointed to by its member reservation.
      const reservation = ctx.target(reservations, [ctx.text(binding, "member_id", RT)], row, RT, "binding_id");
      ctx.equal(ctx.nullableText(reservation, "binding_id", RT), bindingId, row, RT, "binding_id", "state-mismatch", reservation);
      ctx.equal(ctx.nullableText(reservation, "lease_owner", RT), owner, row, RT, "lease_owner", "state-mismatch", reservation);
      ctx.equal(ctx.integer(reservation, "generation", RT), ctx.integer(row, "generation", RT), row, RT, "generation", "state-mismatch", reservation);
      ctx.equal(ctx.nullableText(reservation, "lease_expires_at", RT), expiry, row, RT, "lease_expires_at", "state-mismatch", reservation);
    }
    ctx.text(row, "updated_at", RT);
    const identityRaw = ctx.nullableText(row, "process_identity_json", RT), identity = ctx.json(row, "process_identity_json", RT);
    if (identity !== null) ctx.schema(processSchema, identity, row, RT, "process_identity_json");
    ctx.charge(1, 0, ctx.site(row, RT), 0, 1); runnerConfiguration.set(row, identityRaw === null || identity !== null);
    // No lease clock, process lookup, session-key rewrite or exit authorization is performed.
  }
  for (const row of ctx.rows("agent_runtime_members")) {
    const memberId = ctx.text(row, "member_id", RT), runtimeId = ctx.text(row, "runtime_id", RT), projectId = ctx.text(row, "project_id", RT);
    const member = ctx.target(members, [memberId], row, RT, "member_id"), runtime = ctx.target(runtimes, [runtimeId], row, RT, "runtime_id");
    ctx.target(projects, [projectId], row, RT, "project_id");
    ctx.equal(ctx.text(member, "project_id", RT), projectId, row, RT, "project_id", "scope-mismatch", member);
    ctx.equal(ctx.nullableText(member, "agent_id", RT), ctx.text(runtime, "agent_id", RT), row, RT, "member_id", "identity-mismatch", member);
    const bindingId = ctx.nullableText(row, "binding_id", RT), owner = ctx.nullableText(row, "lease_owner", RT), expiry = ctx.nullableText(row, "lease_expires_at", RT);
    const generation = ctx.integer(row, "generation", RT); ctx.text(row, "updated_at", RT);
    if (bindingId === null) {
      if (owner !== null || expiry !== null) ctx.fail(row, RT, "state-mismatch", "binding_id");
    } else {
      if (owner === null || expiry === null) ctx.fail(row, RT, "state-mismatch", "lease_owner");
      const binding = ctx.target(bindings, [bindingId], row, RT, "binding_id");
      for (const [column, expected] of [["runtime_id", runtimeId], ["member_id", memberId], ["project_id", projectId]] as const)
        ctx.equal(ctx.text(binding, column, RT), expected, row, RT, "binding_id", "scope-mismatch", binding);
      const runner = ctx.target(runners, [bindingId], row, RT, "binding_id");
      ctx.equal(ctx.integer(runner, "generation", RT), generation, row, RT, "generation", "state-mismatch", runner);
      ctx.equal(ctx.nullableText(runner, "lease_owner", RT), owner, row, RT, "lease_owner", "state-mismatch", runner);
      ctx.equal(ctx.nullableText(runner, "lease_expires_at", RT), expiry, row, RT, "lease_expires_at", "state-mismatch", runner);
    }
  }
  for (const row of ctx.rows("agent_runtime_bindings")) {
    const runtimeId = ctx.text(row, "runtime_id", RT), projectId = ctx.text(row, "project_id", RT), memberId = ctx.text(row, "member_id", RT), groupId = ctx.text(row, "group_id", RT);
    const runtime = ctx.target(runtimes, [runtimeId], row, RT, "runtime_id"), member = ctx.target(members, [memberId], row, RT, "member_id"), group = ctx.target(groups, [groupId], row, RT, "group_id");
    ctx.target(projects, [projectId], row, RT, "project_id");
    ctx.equal(ctx.text(member, "kind", RT), "agent", row, RT, "member_id", "identity-mismatch", member);
    ctx.equal(ctx.nullableText(member, "agent_id", RT), ctx.text(runtime, "agent_id", RT), row, RT, "member_id", "identity-mismatch", member);
    ctx.equal(ctx.text(member, "project_id", RT), projectId, row, RT, "project_id", "scope-mismatch", member);
    ctx.equal(ctx.text(group, "project_id", RT), projectId, row, RT, "group_id", "scope-mismatch", group);
    // A retained detached P1 shell has its own exact snapshot/head relations in
    // M202. It does not occupy the current participant/reservation joins.
    // The row stage is authenticated by the owned raw view, never a caller flag.
    const detached=row.stage==='p1'&&ctx.oneOf(row,'attachment_state',RT,['attached','detached'])==='detached';
    if(!detached){
      ctx.target(participants, [groupId, memberId], row, RT, "member_id");
      const reservation = ctx.target(reservations, [memberId], row, RT, "member_id");
      ctx.equal(ctx.text(reservation, "runtime_id", RT), runtimeId, row, RT, "runtime_id", "scope-mismatch", reservation);
      ctx.equal(ctx.text(reservation, "project_id", RT), projectId, row, RT, "project_id", "scope-mismatch", reservation);
    }
    const revision = ctx.integer(row, "revision", RT, 1); ctx.integer(row, "intent_revision", RT); ctx.bool(row, "reset_session_requested", RT);
    ctx.oneOf(row, "desired_state", RT, ["running", "stopped"]); ctx.text(row, "created_at", RT); ctx.text(row, "updated_at", RT);
    const overrides = inspect(ctx, row, "overrides_json", configSchema.partial(), false), advanced = inspect(ctx, row, "advanced_json", advancedSchema, true);
    const requested = inspect(ctx, row, "requested_snapshot_json", snapshotSchema, true);
    const runner = runners.get([ctx.text(row, "id", RT)]);
    const applied = runner ? inspect(ctx, runner, "applied_json", snapshotSchema, true) : { valid: false, present: false, value: null };
    const facts = runtimeFacts.get(runtime)!;
    let usable = facts.usable && overrides.valid && advanced.valid && requested.valid && applied.valid && runner !== undefined && runnerConfiguration.get(runner) === true;
    const requestedUsable = snapshotUsable(ctx, requested.value, facts.backend, row, "requested_snapshot_json");
    const appliedUsable = runner ? snapshotUsable(ctx, applied.value, facts.backend, runner, "applied_json") : false;
    usable = usable && requestedUsable && appliedUsable;
    let advancedState: RuntimeUsability["advanced"] = !advanced.valid ? "unusable" : advanced.value === null ? "not_selected"
      : advanced.value.runtimeRevision === facts.revision && advanced.value.bindingRevision === revision ? "effective" : "invalidated_by_revision";
    if (advancedState === "effective" && facts.backend !== "claude-code") { usable = false; advancedState = "unusable"; }
    if (usable) {
      // The effective value is derived only after every original inspected source passed.
      ctx.charge(8, 0, ctx.site(row, RT), 0, 3);
      const defaults = facts.defaults!, override = overrides.value!;
      const config: RuntimeConfig = {
        model: override.model === undefined ? defaults.model : override.model,
        workdir: override.workdir === undefined ? defaults.workdir : override.workdir,
        tools: override.tools === undefined ? defaults.tools : override.tools,
        systemPrompt: override.systemPrompt === undefined ? defaults.systemPrompt : override.systemPrompt,
        permissionMode: override.permissionMode === undefined ? defaults.permissionMode : override.permissionMode,
      };
      const value = { backend: facts.backend as RuntimeBackend, config, versions: { runtimeRevision: facts.revision, bindingRevision: revision },
        advancedStrategy: advancedState === "effective" ? "bypassPermissions" as const : null, digest: "" };
      const site = ctx.site(row, RT, "overrides_json"), cost = ctx.reserve(value, site, 2, 1, 4);
      ctx.charge(4, cost.encoded * 2 + 512, site, 0, 4);
      snapshotRuntimeConfig(value.backend, value.config, value.versions, value.advancedStrategy);
    }
    observe({ table: "agent_runtime_bindings", rowOrdinal: row.rowOrdinal, usable,
      selected: !usable ? null : requested.present ? "requestedSnapshot" : applied.present ? "applied" : "effective", advanced: advancedState });
  }
  ctx.charge(observations.length, 0, undefined, 0, 1);
  return Object.freeze(observations);
}
