import path from "node:path";
import { z } from "zod";
import { ConfigError } from "../../config-error.ts";
import { canonicalJson, digestJson, parseCanonical } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { parseMaintenanceCommand } from "./parse.ts";
import { postgresDescriptorDigest } from "./postgres-tools.ts";
import { counter, hash, id, ref, source, text } from "./parse-primitives.ts";
import type { DatabaseDescriptor } from "../../environment.ts";
import type { MaintenanceCommand, MaintenanceResult, MaintenanceServiceOptions, PersistedPlanRef, SourceRef } from "./types.ts";

/** Values only. None of these objects carries a lock, native owner, or permit. */
export interface InspectMaintenanceCommand {
  readonly operation: "inspect-migration";
  readonly request: { readonly plan: PersistedPlanRef; readonly expectedSource: SourceRef };
}
export type ControllerServiceCommand = MaintenanceCommand | InspectMaintenanceCommand;
export interface ControllerSelection {
  readonly originalCwd: string;
  readonly expectedSourceId: string;
  readonly controlRoot: string;
  readonly targetRoot: string;
  readonly dataDir?: string;
  readonly knownLegacyCwds: readonly string[];
}
export interface ControllerRequest {
  readonly selection: ControllerSelection;
  readonly command: ControllerServiceCommand;
}
export const controllerLimits = Object.freeze({ commandBytes: 64 * 1024, resultBytes: 256 * 1024 });
const absolutePath = text.refine(value => path.isAbsolute(value) && !value.includes("\0"));
const selectionSchema = z.object({ originalCwd: absolutePath, expectedSourceId: text.refine(value => !!value.trim() && !value.includes("\0")),
  controlRoot: absolutePath, targetRoot: absolutePath, dataDir: absolutePath.optional(), knownLegacyCwds: z.array(absolutePath).max(128) }).strict();
const persistedPlan = z.object({ migrationId: id, planDigest: hash, immutablePlan: ref, controlRoot: absolutePath }).strict()
  .refine(value => value.planDigest === value.immutablePlan.sha256 && value.immutablePlan.ref === `plans/${value.planDigest}.json`);
const inspectSchema = z.object({ operation: z.literal("inspect-migration"),
  request: z.object({ plan: persistedPlan, expectedSource: source }).strict() }).strict();

export function parseControllerCommand(value: unknown): ControllerServiceCommand {
  if (value !== null && typeof value === "object" && "operation" in value && value.operation === "inspect-migration") {
    const parsed = inspectSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new MaintenanceFailure("request_conflict", "controller-command");
  }
  const parsed = parseMaintenanceCommand(value);
  if (!absolutePath.safeParse(parsed.request.plan.controlRoot).success)
    throw new MaintenanceFailure("request_conflict", "controller-command");
  return parsed;
}
export function parseControllerRequest(value: unknown): ControllerRequest {
  const parsed = z.object({ selection: selectionSchema, command: z.unknown() }).strict().safeParse(value);
  if (!parsed.success) throw new MaintenanceFailure("request_conflict", "controller-command");
  const { dataDir, ...base } = parsed.data.selection;
  const result = { selection: { ...base, ...(dataDir === undefined ? {} : { dataDir }) }, command: parseControllerCommand(parsed.data.command) };
  // Include the actual envelope overhead in the public request budget.
  encodeControllerFrame({ version: 1, sequence: 0, type: "command", request: result }, controllerLimits.commandBytes);
  return result;
}

/** This is the existing read-only resolver, never an ordinary driver or source adapter. */
export async function resolveControllerOptions(selection: ControllerSelection): Promise<MaintenanceServiceOptions> {
  const { resolveBoardroomEnvironment, assertEnvironmentSelected, canonicalizePath } = await import("../../environment.ts");
  const env = { ...process.env };
  if (selection.dataDir !== undefined) env["AGENT_STUDIO_DATA_DIR"] = selection.dataDir;
  const environment = await resolveBoardroomEnvironment({ cwd: selection.originalCwd, env, knownLegacyCwds: selection.knownLegacyCwds });
  assertEnvironmentSelected(environment);
  if (environment.layoutVersion !== 1 || environment.startupState !== "legacy_found" || environment.inventory.selectedSourceId === null
    || environment.databaseDescriptor.kind === "sqlite" && environment.databaseDescriptor.identity === null)
    throw new MaintenanceFailure("source_missing");
  if (environment.inventory.selectedSourceId !== selection.expectedSourceId) throw new MaintenanceFailure("source_changed");
  return { environment, originalCwd: selection.originalCwd, expectedSourceId: selection.expectedSourceId,
    controlRoot: canonicalizePath(selection.controlRoot), targetRoot: canonicalizePath(selection.targetRoot) };
}

/** Cleanup aliases are deliberately hashes. They do not certify a source or authorize a later worker. */
export function controllerRequestAliases(request: ControllerRequest): readonly string[] {
  return ["marker:" + digestJson(request.selection.expectedSourceId), "source:" + digestJson(request.command.request.expectedSource),
    "plan:" + digestJson({ migrationId: request.command.request.plan.migrationId, planDigest: request.command.request.plan.planDigest,
      controlRoot: path.resolve(request.command.request.plan.controlRoot) })];
}
export function controllerDescriptorAliases(descriptor: DatabaseDescriptor): readonly string[] {
  return descriptor.kind === "sqlite"
    ? ["sqlite-path:" + digestJson(descriptor.sqlitePath), ...(descriptor.identity ? ["sqlite-inode:" + digestJson(descriptor.identity)] : [])]
    : ["postgres-descriptor:" + postgresDescriptorDigest(descriptor)];
}

const blockerCode = z.enum(["source_changed", "source_missing", "plan_stale", "target_conflict", "control_root_mismatch",
  "source_writer_unknown", "source_writer_active", "drain_incomplete", "maintenance_busy", "maintenance_lost", "schema_guard_incomplete",
  "journal_invalid", "snapshot_invalid", "restore_verification_unavailable", "unsupported_durability", "backup_capability_unavailable", "request_conflict", "phase_conflict"]);
const failureCode = z.enum([...blockerCode.options, "config_invalid", "legacy_migration_required", "storage_source_ambiguous",
  "storage_root_mismatch", "storage_maintenance", "migration_incomplete", "storage_source_changed", "controller_protocol_invalid",
  "controller_process_failed", "controller_service_failed", "controller_output_limit"]);
export type ControllerFailureCode = z.infer<typeof failureCode>;
const failureEvent = z.object({ kind: z.enum(["maintenance", "config", "aggregate", "undefined", "unknown"]),
  code: failureCode, parent: counter.nullable() }).strict();
const failureSchema = z.object({ occurred: z.literal(true), code: failureCode,
  events: z.array(failureEvent).min(1).max(64), truncated: z.boolean(), omittedBranches: counter }).strict();
export type SafeControllerFailure = z.infer<typeof failureSchema>;
export interface ControllerOutcome { readonly result: MaintenanceResult; readonly failure: SafeControllerFailure | null }

/** Keep occurrence even for throw undefined. Repeated independent AggregateError entries are not deduplicated. */
export function projectControllerFailure(error: unknown, fallback: ControllerFailureCode = "controller_service_failed"): SafeControllerFailure {
  const events: z.infer<typeof failureEvent>[] = [];
  let truncated = false, omittedBranches = 0;
  const visit = (value: unknown, parent: number | null, ancestors: readonly object[]): void => {
    if (events.length === 64) { truncated = true; omittedBranches++; return; }
    let kind: z.infer<typeof failureEvent>["kind"] = value === undefined ? "undefined" : "unknown";
    let code: ControllerFailureCode = fallback;
    if (value instanceof MaintenanceFailure) { kind = "maintenance"; const known = blockerCode.safeParse(value.code); if (known.success) code = known.data; }
    else if (value instanceof ConfigError) { kind = "config"; const known = failureCode.safeParse(value.code); if (known.success) code = known.data; }
    else if (value instanceof AggregateError) kind = "aggregate";
    const index = events.length; events.push({ kind, code, parent });
    if (value !== null && typeof value === "object") {
      if (ancestors.includes(value)) { truncated = true; omittedBranches++; return; }
      const next = [...ancestors, value];
      // Aggregate cause commonly aliases errors[0]; the ordered errors array is the independent-event list.
      if (value instanceof AggregateError) for (let i = 0; i < value.errors.length; i++) {
        if (events.length === 64) { truncated = true; omittedBranches += value.errors.length - i; break; }
        visit(value.errors[i], index, next);
      }
      else {
        const cause = Object.getOwnPropertyDescriptor(value, "cause");
        if (cause && "value" in cause) visit(cause.value, index, next);
      }
      // SourceFilesFailure keeps independent close occurrences beside its primary cause.
      const close = Object.getOwnPropertyDescriptor(value, "closeErrors");
      if (close && "value" in close && Array.isArray(close.value)) for (let i = 0; i < close.value.length; i++) {
        if (events.length === 64) { truncated = true; omittedBranches += close.value.length - i; break; }
        visit(close.value[i], index, next);
      }
    }
  };
  visit(error, null, []);
  let primary = 0;
  while (events[primary]!.kind === "aggregate") {
    const first = events.findIndex(event => event.parent === primary);
    if (first === -1) break;
    primary = first;
  }
  return { occurred: true, code: events[primary]!.code, events, truncated, omittedBranches };
}
export function controllerFailureOutcome(failure: SafeControllerFailure, enteredService: boolean): ControllerOutcome {
  const code = blockerCode.safeParse(failure.code);
  return { result: { status: enteredService ? "recovery_required" : "blocked", lastVerifiedPhase: null,
    blockers: [{ code: code.success ? code.data : "maintenance_lost", subjectRef: "controller-executor" }] }, failure };
}

const phase = z.enum(["planned", "quiesced", "snapshot_ready"]);
const safeArtifact = ref.refine(value => value.ref === `plans/${value.sha256}.json`
  || new RegExp(`^journals/[A-Za-z0-9_-]{1,100}/[1-9][0-9]*-${value.sha256}\\.json$`).test(value.ref)
  || new RegExp(`^snapshots/${value.sha256}/(?:source-files|database-manifests|capability|restore-bundle|publication|verification|receipt)\\.json$`).test(value.ref)
  || new RegExp(`^snapshots/${value.sha256}/(?:source-file-payload|database-snapshot)\\.bin$`).test(value.ref));
const capture = z.object({ migrationId: id, source, planDigest: hash, fenceEpoch: counter.positive(), journal: safeArtifact,
  journalSequence: counter.positive(), ownerGeneration: counter.positive() }).strict();
const observedAnchor = capture.extend({ phase, admission: z.enum(["open", "draining", "sealed"]), authority: z.literal("observation-only") }).strict();
const blockers = z.array(z.object({ code: blockerCode, subjectRef: text }).strict());
const resultSchema = z.union([
  z.object({ status: z.enum(["blocked", "recovery_required"]), lastVerifiedPhase: phase.nullable(), blockers, observedAnchor: observedAnchor.optional() }).strict(),
  z.object({ status: z.literal("paused"), phase: z.enum(["planned", "quiesced"]), ref: capture, observedAnchor: observedAnchor.optional() }).strict(),
  z.object({ status: z.literal("snapshot_ready"), phase: z.literal("snapshot_ready"), ref: capture, snapshot: safeArtifact, observedAnchor: observedAnchor.optional() }).strict(),
  z.object({ status: z.literal("cancel_pending"), phase, ref: capture, blockers, observedAnchor: observedAnchor.optional() }).strict(),
  z.object({ status: z.literal("cancelled"), lastPhase: phase, terminalJournal: safeArtifact,
    openedFenceEpoch: counter.positive(), restartRequired: z.literal(true), observedAnchor: observedAnchor.optional() }).strict(),
]);
export function projectControllerResult(value: unknown, request: ControllerRequest): MaintenanceResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw new MaintenanceFailure("request_conflict", "controller-result");
  const result = parsed.data;
  for (const anchor of ["ref" in result ? result.ref : undefined, result.observedAnchor]) {
    if (anchor && (digestJson(anchor.source) !== digestJson(request.command.request.expectedSource)
      || anchor.planDigest !== request.command.request.plan.planDigest || anchor.migrationId !== request.command.request.plan.migrationId))
      throw new MaintenanceFailure("source_changed", "controller-result");
  }
  // Public references stay exact; free-form diagnostics never cross the boundary.
  if ("blockers" in result) return { ...result, blockers: result.blockers.map(blocker => ({ code: blocker.code,
    subjectRef: /^source:[a-f0-9]{24}$/.test(blocker.subjectRef) ? blocker.subjectRef : "source:" + digestJson(blocker.subjectRef).slice(0, 24) })) } as MaintenanceResult;
  return result as MaintenanceResult;
}

export type ParentControllerFrame = { readonly version: 1; readonly sequence: 0; readonly type: "command"; readonly request: ControllerRequest }
  | { readonly version: 1; readonly sequence: 1; readonly type: "continue" };
export type WorkerControllerFrame = { readonly version: 1; readonly sequence: 0; readonly type: "resolved"; readonly aliases: readonly string[] }
  | { readonly version: 1; readonly sequence: 1; readonly type: "result"; readonly result: MaintenanceResult }
  | { readonly version: 1; readonly sequence: 0 | 1; readonly type: "failure"; readonly failure: SafeControllerFailure };
const common = { version: z.literal(1) };
export function parseParentControllerFrame(value: unknown): ParentControllerFrame {
  const parsed = z.union([
    z.object({ ...common, sequence: z.literal(0), type: z.literal("command"), request: z.unknown() }).strict(),
    z.object({ ...common, sequence: z.literal(1), type: z.literal("continue") }).strict(),
  ]).safeParse(value);
  if (!parsed.success) throw new MaintenanceFailure("request_conflict", "controller-protocol");
  return parsed.data.type === "command" ? { ...parsed.data, request: parseControllerRequest(parsed.data.request) } : parsed.data;
}
export function parseWorkerControllerFrame(value: unknown, request: ControllerRequest): WorkerControllerFrame {
  const parsed = z.union([
    z.object({ ...common, sequence: z.literal(0), type: z.literal("resolved"),
      aliases: z.array(z.string().regex(/^(?:sqlite-path|sqlite-inode|postgres-descriptor):[a-f0-9]{64}$/)).min(1).max(8) }).strict(),
    z.object({ ...common, sequence: z.literal(1), type: z.literal("result"), result: z.unknown() }).strict(),
    z.object({ ...common, sequence: z.union([z.literal(0), z.literal(1)]), type: z.literal("failure"), failure: failureSchema }).strict(),
  ]).safeParse(value);
  if (!parsed.success) throw new MaintenanceFailure("request_conflict", "controller-protocol");
  return parsed.data.type === "result" ? { ...parsed.data, result: projectControllerResult(parsed.data.result, request) } : parsed.data;
}
export function encodeControllerFrame(value: unknown, limit: number): Buffer {
  let raw: string;
  try { raw = canonicalJson(value); } catch { throw new MaintenanceFailure("request_conflict", "controller-frame"); }
  if (typeof raw !== "string" || Buffer.byteLength(raw) > limit) throw new MaintenanceFailure("request_conflict", "controller-frame-limit");
  return Buffer.from(raw + "\n");
}

/** Byte-bounded newline frames: reject before decoding/JSON parsing, including an unfinished oversized frame. */
export class ControllerFrameReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private failed = false;
  private readonly limit: number;
  private readonly onFrame: (value: unknown) => void;
  constructor(limit: number, onFrame: (value: unknown) => void) { this.limit = limit; this.onFrame = onFrame; }
  push(chunk: Buffer): void {
    if (this.failed) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset), stop = end === -1 ? chunk.length : end;
        const part = chunk.subarray(offset, stop); this.size += part.length;
        if (this.size > this.limit) throw new MaintenanceFailure("request_conflict", "controller-frame-limit");
        this.chunks.push(part);
        if (end === -1) break;
        let value: unknown;
        try { value = parseCanonical(Buffer.concat(this.chunks, this.size)); }
        catch { throw new MaintenanceFailure("request_conflict", "controller-frame"); }
        this.chunks = []; this.size = 0;
        this.onFrame(value); offset = end + 1;
      }
    } catch (error) { this.failed = true; this.chunks = []; this.size = 0; throw error; }
  }
  end(): void {
    if (this.size) { this.failed = true; this.chunks = []; this.size = 0; throw new MaintenanceFailure("request_conflict", "controller-frame-incomplete"); }
  }
}
