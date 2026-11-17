/** #152：计划保持原行为；维护命令只向固定执行器传递严格值。 */
import path from "node:path";
import { createHash } from "node:crypto";
import { ConfigError } from "../src/server/config-error.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { parseControllerRequest } from "../src/server/storage/maintenance/controller-command.ts";
import type { ControllerRequest } from "../src/server/storage/maintenance/controller-command.ts";
import type { ArtifactRef, Blocker, MaintenanceAdapter, MigrationPlan, SourceRef } from "../src/server/storage/maintenance/types.ts";

const usage = "用法：storage-maintenance.ts <plan|persist-plan|inspect|execute|resume|cancel> --expected-source-id <sourceId> --control-root <绝对路径> --target-root <绝对路径> [--data-dir <绝对路径>] [--legacy-cwd <绝对路径>]...；persist-plan 可选 --output-version <1|2>；维护命令还需 --migration-id --plan-digest --plan-bytes --expected-source-kind --expected-database-instance-id --expected-source-identity-digest；execute/resume/cancel 另需 --request-id --expected-phase <planned|quiesced|snapshot_ready|none> --expected-journal-digest <sha256|none>。";
class UsageError extends Error {}
interface PlanArguments {
  readonly command: "plan" | "persist-plan";
  readonly expectedSourceId: string;
  readonly controlRoot: string;
  readonly targetRoot: string;
  readonly dataDir?: string;
  readonly knownLegacyCwds: readonly string[];
  readonly outputVersion: 1 | 2;
}
interface ControllerArguments {
  readonly command: "inspect" | "execute" | "resume" | "cancel";
  readonly request: ControllerRequest;
}
export interface PlanPreview {
  readonly formatVersion: 1;
  readonly command: "plan";
  readonly result: "preview";
  readonly observationMode: "logical_read_only";
  readonly persisted: false;
  readonly executionAuthorized: false;
  readonly source: { readonly sourceId: string; readonly databaseKind: "sqlite" | "postgres" };
  readonly observedAt: string;
  readonly tableCounts: Readonly<Record<string, string>>;
  readonly requiredCapabilities: readonly string[];
  readonly blockers: readonly Blocker[];
}
export interface PlanPersistenceResult {
  readonly formatVersion: 1;
  readonly command: "persist-plan";
  readonly result: "persisted";
  readonly persisted: true;
  readonly executionAuthorized: false;
  readonly source: { readonly sourceId: string; readonly databaseKind: "sqlite" | "postgres" };
  readonly migrationId: string;
  readonly planDigest: string;
  readonly planRef: ArtifactRef;
}
export interface PlanPersistenceResultV2 extends Omit<PlanPersistenceResult, "formatVersion"> {
  readonly formatVersion: 2;
  readonly expectedSource: SourceRef;
}

function parseArguments(args: readonly string[]): PlanArguments | ControllerArguments {
  const command = args[0];
  if (command !== "plan" && command !== "persist-plan" && command !== "inspect" && command !== "execute" && command !== "resume" && command !== "cancel") throw new UsageError();
  const planning = command === "plan" || command === "persist-plan";
  const values = new Map<string, string>(), knownLegacyCwds: string[] = [];
  const flags = new Set(["--expected-source-id", "--control-root", "--target-root", "--data-dir", "--legacy-cwd"]);
  if (command === "persist-plan") flags.add("--output-version");
  const pathFlags = new Set(["--control-root", "--target-root", "--data-dir", "--legacy-cwd"]);
  if (!planning) {
    for (const flag of ["--migration-id", "--plan-digest", "--plan-bytes", "--expected-source-kind",
      "--expected-database-instance-id", "--expected-source-identity-digest"]) flags.add(flag);
    if (command !== "inspect") for (const flag of ["--request-id", "--expected-phase", "--expected-journal-digest"]) flags.add(flag);
  }
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!flag || !flags.has(flag) || !value || value.startsWith("--") || value.includes("\0")
      || pathFlags.has(flag) && !path.isAbsolute(value)) throw new UsageError();
    if (flag === "--legacy-cwd") knownLegacyCwds.push(value);
    else {
      if (values.has(flag)) throw new UsageError();
      values.set(flag, value);
    }
  }
  const expectedSourceId = values.get("--expected-source-id"), controlRoot = values.get("--control-root"), targetRoot = values.get("--target-root");
  if (!expectedSourceId?.trim() || !controlRoot || !targetRoot) throw new UsageError();
  const dataDir = values.get("--data-dir");
  const outputVersion = values.get("--output-version") ?? "1";
  if (outputVersion !== "1" && outputVersion !== "2") throw new UsageError();
  if (planning) return { command, expectedSourceId, controlRoot, targetRoot, knownLegacyCwds, outputVersion: outputVersion === "2" ? 2 : 1,
    ...(dataDir === undefined ? {} : { dataDir }) };
  const planDigest = values.get("--plan-digest");
  const request = { plan: { migrationId: values.get("--migration-id"), planDigest,
    immutablePlan: { ref: `plans/${planDigest}.json`, sha256: planDigest, bytes: values.get("--plan-bytes") }, controlRoot },
    expectedSource: { kind: values.get("--expected-source-kind"), databaseInstanceId: values.get("--expected-database-instance-id"),
      identityDigest: values.get("--expected-source-identity-digest") } };
  const expectedPhase = values.get("--expected-phase"), expectedJournalDigest = values.get("--expected-journal-digest");
  try {
    return { command, request: parseControllerRequest({ selection: { originalCwd: process.cwd(), expectedSourceId, controlRoot, targetRoot,
      knownLegacyCwds, ...(dataDir === undefined ? {} : { dataDir }) }, command: command === "inspect"
      ? { operation: "inspect-migration", request }
      : { operation: `${command}-migration`, request: { ...request, requestId: values.get("--request-id"),
        expectedPhase: expectedPhase === "none" ? null : expectedPhase,
        expectedJournalDigest: expectedJournalDigest === "none" ? null : expectedJournalDigest } } }) };
  } catch { throw new UsageError(); }
}

function publicSubject(subject: string): string {
  if (["source-admission", "host-platform", "os-inventory-unavailable", "postgres-prepared-transaction"].includes(subject)
    || /^(?:os-process|unreadable-process):[0-9]+$/.test(subject)
    || /^postgres-backend:[a-f0-9]{24}$/.test(subject)) return subject;
  // Runtime binding IDs and future internal references may contain user-controlled text.
  // A diagnostic fingerprint preserves correlation without exposing that text as output.
  return `source:${createHash("sha256").update(subject).digest("hex").slice(0, 24)}`;
}
function preview(plan: MigrationPlan, sourceId: string): PlanPreview {
  return { formatVersion: 1, command: "plan", result: "preview", observationMode: "logical_read_only",
    persisted: false, executionAuthorized: false, source: { sourceId, databaseKind: plan.source.kind },
    observedAt: plan.preview.observedAt, tableCounts: plan.preview.tableCounts,
    requiredCapabilities: plan.requiredCapabilities,
    blockers: plan.blockers.map(blocker => ({ code: blocker.code, subjectRef: publicSubject(blocker.subjectRef) })) };
}

async function main(): Promise<void> {
  // Reject unsupported operations and malformed arguments before resolver I/O or adapter loading.
  const args = parseArguments(process.argv.slice(2));
  if ("request" in args) {
    const { runControllerCommand } = await import("../src/server/storage/maintenance/controller-executor.ts");
    const outcome = await runControllerCommand(args.request);
    process.stdout.write(`${JSON.stringify({ formatVersion: 1, command: args.command, ...outcome }, null, 2)}\n`);
    if (outcome.failure || ["blocked", "recovery_required", "cancel_pending"].includes(outcome.result.status)) {
      const code = outcome.failure?.code ?? ("blockers" in outcome.result ? outcome.result.blockers[0]?.code : undefined) ?? "maintenance_lost";
      process.stderr.write(`[${code}] 维护命令未完成；请核对安全结果与 exact anchor 后再决定后续命令。\n`);
      process.exitCode = 1;
    }
    return;
  }
  const { resolveBoardroomEnvironment, assertEnvironmentSelected, canonicalizePath } = await import("../src/server/environment.ts");
  const env = { ...process.env };
  if (args.dataDir !== undefined) env["AGENT_STUDIO_DATA_DIR"] = args.dataDir;
  const environment = await resolveBoardroomEnvironment({ env, knownLegacyCwds: args.knownLegacyCwds });
  assertEnvironmentSelected(environment);
  if (environment.layoutVersion !== 1 || environment.startupState !== "legacy_found" || environment.inventory.selectedSourceId === null)
    throw new MaintenanceFailure("source_missing");
  if (environment.inventory.selectedSourceId !== args.expectedSourceId) throw new MaintenanceFailure("source_changed");
  const descriptor = environment.databaseDescriptor;
  if (descriptor.kind === "sqlite" && descriptor.identity === null) throw new MaintenanceFailure("source_missing");
  // Resolve existing aliases without creating missing suffixes; shared planning still checks identities and protected roots.
  const controlRoot = canonicalizePath(args.controlRoot), targetRoot = canonicalizePath(args.targetRoot);
  const { planMigration, persistMigrationPlan, loadPersistedPlan } = await import("../src/server/storage/maintenance/plan.ts");
  let adapter: MaintenanceAdapter | undefined, result: PlanPreview | PlanPersistenceResult | PlanPersistenceResultV2;
  try {
    adapter = descriptor.kind === "sqlite"
      ? await (await import("../src/server/storage/maintenance/sqlite.ts")).createSqliteMaintenanceAdapter(descriptor)
      : await (await import("../src/server/storage/maintenance/postgres.ts")).createPostgresMaintenanceAdapter(descriptor, undefined);
    const options = { environment, originalCwd: process.cwd(), expectedSourceId: args.expectedSourceId, controlRoot, targetRoot };
    const plan = await planMigration(options, adapter);
    if (args.command === "plan") result = preview(plan, environment.inventory.selectedSourceId);
    else {
      const reference = await persistMigrationPlan(plan, options, adapter);
      const restored = await loadPersistedPlan(reference, plan.source);
      const persisted: PlanPersistenceResult = { formatVersion: 1, command: "persist-plan", result: "persisted", persisted: true, executionAuthorized: false,
        source: { sourceId: environment.inventory.selectedSourceId, databaseKind: restored.source.kind },
        migrationId: restored.migrationId, planDigest: reference.planDigest,
        planRef: { ref: reference.immutablePlan.ref, sha256: reference.immutablePlan.sha256, bytes: reference.immutablePlan.bytes } };
      result = args.outputVersion === 1 ? persisted : { ...persisted, formatVersion: 2, expectedSource: restored.source };
    }
  } finally { await adapter?.close(); }
  // Report only after adapter cleanup; neither preview nor persisted P is an execution permit.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main().catch((error: unknown) => {
  const persisting = process.argv[2] === "persist-plan";
  const persistenceFailure = "无法确认计划保存与回读成功；控制根中可能已保留计划产物，未自动回滚。请核对所选来源与控制根。";
  if (error instanceof UsageError) process.stderr.write(`[config_invalid] ${usage}\n`);
  else if (error instanceof ConfigError || error instanceof MaintenanceFailure)
    process.stderr.write(`[${error.code}] ${persisting ? persistenceFailure : "无法完成所选来源的只读计划预览。请使用 inspect-storage 核对来源、配置、格式与权限。"}\n`);
  else process.stderr.write(persisting ? `[plan_persist_failed] ${persistenceFailure}\n`
    : "[plan_preview_failed] 无法完成只读计划预览。请检查所选来源与权限；没有自动改换数据源或执行维护。\n");
  process.exitCode = 1;
});
