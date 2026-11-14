import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { release, version } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Stage = "after-external-close" | "held-source-lock";
type Source = { dataDir: string; sqlitePath: string; sourcePath: string; identity: { device: string; inode: string } };
type Operation = "stat" | "readdir" | "readlink";
type Call = (...args: unknown[]) => Promise<unknown>;
const root = fileURLToPath(new URL("../../", import.meta.url));
const context = new AsyncLocalStorage<object>();

/** Trace only the original call's /proc metadata operations; no retry, process contents or production API change. */
export async function inspectWithLinuxInventoryDiagnostics<T extends readonly unknown[]>(
  stage: Stage, source: Source, inspect: () => Promise<T>,
): Promise<T> {
  if (process.platform !== "linux") return inspect();
  const token = {}, mutable = fs as unknown as Record<Operation, Call>;
  const operations = ["stat", "readdir", "readlink"] as const;
  const originals = { stat: mutable.stat, readdir: mutable.readdir, readlink: mutable.readlink };
  const errors: object[] = [], processStats: object[] = [];
  let callCount = 0, droppedErrors = 0, droppedProcessStats = 0;
  const errorLimit = 256, processStatLimit = 128, startedAt = new Date().toISOString();
  const restore = () => { for (const operation of operations) mutable[operation] = originals[operation]; syncBuiltinESMExports(); };
  try {
    for (const operation of operations) mutable[operation] = async (...args: unknown[]) => {
      const file = typeof args[0] === "string" ? args[0] : "";
      const tracing = context.getStore() === token && /^\/proc(?:\/(?:self|[1-9][0-9]*)(?:\/fd(?:\/[0-9]+)?)?)?$/.test(file);
      const call = tracing ? ++callCount : 0;
      let result: unknown;
      try { result = await Reflect.apply(originals[operation], fs, args); }
      catch (error) {
        if (tracing) {
          const failure = error as NodeJS.ErrnoException;
          if (errors.length < errorLimit) errors.push({ call, operation, path: file, at: new Date().toISOString(),
            code: failure.code ?? null, errno: failure.errno ?? null, syscall: failure.syscall ?? null });
          else droppedErrors++;
        }
        throw error;
      }
      if (tracing && operation === "stat" && /^\/proc\/[1-9][0-9]*$/.test(file)) {
        const info = result as { uid: number; gid: number; mode: number };
        if (processStats.length < processStatLimit) processStats.push({ call, path: file, uid: info.uid, gid: info.gid, mode: info.mode });
        else droppedProcessStats++;
      }
      return result;
    };
    syncBuiltinESMExports();
  } catch (error) {
    restore();
    process.stderr.write(`Linux inventory tracing unavailable: ${String(error)}\n`);
    return inspect();
  }
  let result: T | undefined, originalError: unknown, threw = false;
  try { result = await context.run(token, inspect); }
  catch (error) { threw = true; originalError = error; }
  finally { restore(); }
  const finishedAt = new Date().toISOString();
  if (threw || result!.length !== 0) {
    try {
      const output = path.join(root, ".agent-output", "maintenance-native-diagnostics", "linux-inventory");
      await fs.mkdir(output, { recursive: true, mode: 0o700 });
      const directory = await fs.mkdtemp(path.join(output, `${stage}-`));
      const save = (name: string, value: unknown) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
      await save("failure.json", { stage, source, blockers: result ?? null, threw, startedAt, finishedAt,
        observation: "Errors and process stat metadata were captured inside this exact inspectWriters invocation; no inventory retry.",
        pid: process.pid, uid: process.getuid?.() ?? null, platform: process.platform, arch: process.arch, node: process.version,
        kernelRelease: release(), kernelVersion: version(), candidate: process.env.GITHUB_SHA ?? null,
        runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null });
      await save("fs-events.json", { callCount, errors, processStats, errorLimit, processStatLimit, droppedErrors, droppedProcessStats });
      const digest = async (file: string) => createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex");
      await save("identity.json", { sqliteSourceSha256: await digest("src/server/storage/maintenance/sqlite.ts"),
        helperSha256: await digest("tests/fixtures/maintenance-linux-inventory-diagnostic.ts"),
        testSha256: await digest("tests/maintenance-sqlite.test.ts") });
      process.stderr.write(`Linux inventory diagnostics: ${directory}\n`);
    } catch (error) { process.stderr.write(`Linux inventory diagnostic capture failed: ${String(error)}\n`); }
  }
  if (threw) throw originalError;
  return result!;
}
