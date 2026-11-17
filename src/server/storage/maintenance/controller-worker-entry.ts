/** Fixed Node entry. All native capabilities and actual service assembly stay in this process. */
import { Socket } from "node:net";
import { ControllerFrameReader, controllerDescriptorAliases, controllerLimits, encodeControllerFrame, parseParentControllerFrame,
  projectControllerFailure, projectControllerResult, resolveControllerOptions } from "./controller-command.ts";
import type { ControllerRequest } from "./controller-command.ts";
import type { MaintenanceServiceOptions } from "./types.ts";
import { MaintenanceFailure } from "./error.ts";
import { parsePostgresConnection } from "./postgres-tools.ts";

/** Only the fixed worker reads this explicit private credential slot. Parsing is not target isolation proof. */
function withPostgresVerification(options: MaintenanceServiceOptions): MaintenanceServiceOptions {
  if (options.environment.databaseDescriptor.kind !== "postgres") return options;
  const connectionString = process.env["AGENT_STUDIO_MAINTENANCE_PG_VERIFICATION_CONNECTION_STRING"];
  const schema = process.env["AGENT_STUDIO_MAINTENANCE_PG_VERIFICATION_SCHEMA"];
  if (connectionString === undefined && schema === undefined) return options;
  if (!connectionString?.trim() || schema !== undefined && !schema.trim())
    throw new MaintenanceFailure("restore_verification_unavailable", "verification-configuration");
  const descriptor = { kind: "postgres" as const, connectionString, ...(schema === undefined ? {} : { schema }) };
  try { parsePostgresConnection(descriptor); }
  catch (error) {
    const failure = new MaintenanceFailure("restore_verification_unavailable", "verification-configuration");
    Object.defineProperty(failure, "cause", { value: error }); throw failure;
  }
  return { ...options, postgresVerification: descriptor };
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new MaintenanceFailure("request_conflict", "controller-entry");
  const ipc = new Socket({ fd: 3, readable: true, writable: true, allowHalfOpen: true });
  const failures: unknown[] = [];
  let state: "command" | "resolving" | "continue" | "running" | "finished" = "command";
  let request: ControllerRequest | undefined, options: MaintenanceServiceOptions | undefined;
  let sequence: 0 | 1 = 0;
  let finishPromise: Promise<void> | undefined;
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const write = (value: unknown): Promise<void> => new Promise((resolve, reject) => {
    let bytes: Buffer;
    try { bytes = encodeControllerFrame(value, controllerLimits.resultBytes); } catch (error) { reject(error); return; }
    ipc.write(bytes, error => error ? reject(error) : resolve());
  });
  const fail = (error: unknown) => {
    failures.push(error); process.exitCode = 1;
    if (state === "finished") ipc.end();
    else if (state === "command" || state === "continue") void finish();
  };
  const finish = (value?: unknown): Promise<void> => finishPromise ??= (async () => {
    state = "finished";
    try {
      if (!failures.length) {
        try {
          const result = projectControllerResult(value, request!);
          await write({ version: 1, sequence: 1, type: "result", result });
        } catch (error) { failures.push(error); }
      }
      if (failures.length) {
        process.exitCode = 1;
        await write({ version: 1, sequence, type: "failure", failure: projectControllerFailure(failures.length === 1 ? failures[0]
          : new AggregateError(failures, "controller failures", { cause: failures[0] })) });
      }
    } catch { process.exitCode = 1; }
    finally { ipc.end(); complete(); }
  })();
  const prepare = async () => {
    try {
      options = withPostgresVerification(await resolveControllerOptions(request!.selection));
      const { canonicalizePath } = await import("../../environment.ts");
      if (canonicalizePath(request!.command.request.plan.controlRoot) !== options.controlRoot)
        throw new MaintenanceFailure("control_root_mismatch");
      if (failures.length) { await finish(); return; }
      state = "continue"; sequence = 1;
      await write({ version: 1, sequence: 0, type: "resolved", aliases: controllerDescriptorAliases(options.environment.databaseDescriptor) });
    } catch (error) { failures.push(error); await finish(); }
  };
  const execute = async () => {
    try {
      // I05 supplies the actual service. There is no fallback, callback IPC, or successful test service in production.
      const { runMaintenanceServiceCommand } = await import("./service.ts");
      const result = await runMaintenanceServiceCommand(options!, request!.command);
      await finish(result);
    } catch (error) { failures.push(error); await finish(); }
  };
  const reader = new ControllerFrameReader(controllerLimits.commandBytes, value => {
    const frame = parseParentControllerFrame(value);
    if (frame.type === "command" && state === "command") {
      request = frame.request; state = "resolving"; void prepare();
    } else if (frame.type === "continue" && state === "continue" && failures.length === 0) {
      state = "running"; void execute();
    } else throw new MaintenanceFailure("request_conflict", "controller-frame-order");
  });
  ipc.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch (error) { fail(error); } });
  ipc.on("end", () => {
    try { reader.end(); } catch (error) { fail(error); }
    if (state !== "finished") fail(new MaintenanceFailure("maintenance_lost", "controller-parent-closed"));
  });
  ipc.on("error", error => { fail(error); });
  await completed;
  // Normal event-loop exit proves actual completion. Do not process.exit() over pending native/stdio cleanup.
}

await main().catch(() => {
  process.stderr.write("[controller_process_failed] 维护执行器未完成。\n");
  process.exitCode = 1;
});
