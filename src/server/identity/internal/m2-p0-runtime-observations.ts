import { z } from "zod";
import { isId } from "../../db/ids.ts";
import { RUNTIME_EVENT_NAMES, RUNTIME_REASON_CODES, OBSERVABLE_CONFIG_FIELDS, USAGE_SOURCES, USAGE_METRICS } from "../../runtime/observation-types.ts";
import { EContext, objectValue, safeUnits, timestampValue } from "./m2-p0-e-context.ts";
import type { P0Row } from "./m2-p0.ts";
const RT = "PC1B-RT02";
const id = z.string().refine(isId);
const version = z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/);
const amount = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const context = { projectId: id.optional(), memberId: id.optional(), runtimeId: id.optional(), bindingId: id.optional(),
  attemptId: id.optional(), turnId: id.optional(), triggerBatchId: id.optional(), messageId: id.optional(), runnerGeneration: safeUnits.optional() };
const summary = z.object({ id, source: z.enum(USAGE_SOURCES), harnessVersion: version, metric: z.enum(USAGE_METRICS),
  scope: z.enum(["turn", "invocation", "session"]), scopeId: id, epochId: id, sequence: safeUnits,
  coverage: z.enum(["complete", "partial", "unavailable"]), value: amount, cumulative: z.boolean(), delta: amount, estimated: z.boolean() }).strict();
const eventSchema = z.object({ ...context, event: z.enum(RUNTIME_EVENT_NAMES), eventId: id, observedAt: timestampValue, truncated: z.boolean(),
  reasonCode: z.enum(RUNTIME_REASON_CODES).optional(), exitCode: safeUnits.optional(), durationMs: safeUnits.optional(), retryAt: safeUnits.optional(),
  configRevision: safeUnits.optional(), attempt: safeUnits.optional(), queuedCount: safeUnits.optional(), droppedCount: safeUnits.optional(),
  signal: z.enum(["SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV",
    "SIGSTOP", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUSR1", "SIGUSR2", "SIGXCPU", "SIGXFSZ", "SIGSYS"]).optional(),
  changedFields: z.array(z.enum(OBSERVABLE_CONFIG_FIELDS)).max(64).optional(), usage: summary.optional() }).strict();
const usageSchema = summary.extend({ ...context, bindingId: id, reportedAt: timestampValue, observedAt: timestampValue,
  reasonCode: z.enum(RUNTIME_REASON_CODES).nullable(), baselineReliable: z.boolean(), epochReliable: z.boolean(), cumulativeHighWatermark: amount }).strict();

function metricNumbers(ctx: EContext, row: P0Row, value: z.infer<typeof summary> & { cumulativeHighWatermark?: number | null }): void {
  // Only the stored scalar domain is checked; no cumulative sum/baseline is reconstructed.
  if (value.metric !== "costUsd") for (const item of [value.value, value.delta, value.cumulativeHighWatermark ?? null]) {
    ctx.charge(1); if (item !== null && !Number.isSafeInteger(item)) ctx.fail(row, RT, "format-mismatch", "payload", "semantic_unsupported");
  }
  ctx.equal(value.estimated, value.metric === "costUsd", row, RT, "payload", "state-mismatch");
}

export function checkP0RuntimeObservations(ctx: EContext): void {
  for (const row of ctx.rows("agent_runtime_events")) {
    const name = ctx.text(row, "event_name", RT), rowId = ctx.text(row, "id", RT), binding = ctx.nullableText(row, "binding_id", RT), observedAt = ctx.text(row, "observed_at", RT);
    const historical = ctx.json(row, "payload", RT, "legacy-display");
    if (!objectValue(historical)) ctx.fail(row, RT, "format-mismatch", "payload", "semantic_unsupported");
    ctx.charge(RUNTIME_EVENT_NAMES.length * 2, name.length * 3, ctx.site(row, RT, "payload"));
    const known = (RUNTIME_EVENT_NAMES as readonly unknown[]).includes(name) || (RUNTIME_EVENT_NAMES as readonly unknown[]).includes(historical.event);
    if (!known) continue;
    const value = ctx.schema(eventSchema, ctx.json(row, "payload", RT, "finite"), row, RT, "payload");
    ctx.equal(value.event, name, row, RT, "event_name"); ctx.equal(value.eventId, rowId, row, RT, "id");
    ctx.equal(value.bindingId ?? null, binding, row, RT, "binding_id"); ctx.equal(value.observedAt, observedAt, row, RT, "observed_at");
    if (value.changedFields) {
      const n = value.changedFields.length; ctx.charge(n * n, n * n * 64, ctx.site(row, RT, "payload"), 0, n);
      if (new Set(value.changedFields).size !== n) ctx.fail(row, RT, "duplicate-key", "payload");
    }
    if (value.usage) metricNumbers(ctx, row, value.usage);
  }
  for (const row of ctx.rows("agent_runtime_usage_snapshots")) {
    const rowId = ctx.text(row, "id", RT), binding = ctx.text(row, "binding_id", RT);
    const source = ctx.oneOf(row, "source", RT, USAGE_SOURCES), metric = ctx.oneOf(row, "metric", RT, USAGE_METRICS);
    const harnessVersion = ctx.text(row, "harness_version", RT), scope = ctx.oneOf(row, "scope", RT, ["turn", "invocation", "session"]);
    const scopeId = ctx.text(row, "scope_id", RT), epoch = ctx.text(row, "epoch_id", RT), sequence = ctx.integer(row, "sequence", RT), observedAt = ctx.text(row, "observed_at", RT);
    const historical = ctx.json(row, "payload", RT, "legacy-display");
    if (!objectValue(historical)) ctx.fail(row, RT, "format-mismatch", "payload", "semantic_unsupported");
    // The old table also holds opaque historical objects. A registered source/metric
    // discriminates the current payload variant; the SQL columns alone do not.
    ctx.charge(USAGE_SOURCES.length + USAGE_METRICS.length);
    if (!(USAGE_SOURCES as readonly unknown[]).includes(historical.source) && !(USAGE_METRICS as readonly unknown[]).includes(historical.metric)) continue;
    const value = ctx.schema(usageSchema, ctx.json(row, "payload", RT, "finite"), row, RT, "payload");
    const pairs = [[value.id, rowId, "id"], [value.bindingId, binding, "binding_id"], [value.source, source, "source"],
      [value.metric, metric, "metric"], [value.harnessVersion, harnessVersion, "harness_version"], [value.scope, scope, "scope"],
      [value.scopeId, scopeId, "scope_id"], [value.epochId, epoch, "epoch_id"], [value.sequence, sequence, "sequence"], [value.observedAt, observedAt, "observed_at"]] as const;
    ctx.charge(pairs.length, 0, ctx.site(row, RT), 0, pairs.length);
    for (const [actual, expected, column] of pairs) ctx.equal(actual, expected, row, RT, column);
    // Earlier session observations without generation are explicitly handled by
    // the old consumer as an unreliable baseline. Keep that historical branch.
    metricNumbers(ctx, row, value);
  }
  for (const row of ctx.rows("agent_runtime_observation_meta")) {
    ctx.equal(ctx.integer(row, "id", RT, 1), 1, row, RT, "id");
    for (const column of ["storage_failures", "logger_failures", "rejected_records", "dropped_events"]) ctx.integer(row, column, RT);
    ctx.bool(row, "history_truncated", RT);
  }
}
