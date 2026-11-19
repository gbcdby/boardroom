import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import type { ControllerCommandScope } from "../../src/server/storage/maintenance/controller-write.ts";
import type { MaintenanceAdapter, OperationMutex, SourceLock } from "../../src/server/storage/maintenance/types.ts";
import { captureFixture } from "./maintenance-capture.ts";

/** Actual adapter/factory, SQL/COMMIT/close, D/V and source files. Only the
 * already established Fs native/profile fixture is substituted in an isolated
 * module copy. These checks never qualify an ext4 profile or alter production. */
export async function readyRevalidationFixture() {
  const source = await captureFixture();
  let directory: string | undefined, adapter: MaintenanceAdapter | undefined, mutex: OperationMutex | undefined;
  const names = new Set(["controller-write.ts", "control-sql.ts", "sqlite.ts", "postgres.ts", "snapshot-bundle.ts",
    "verify-bundle.ts", "snapshot-ready.ts", "verification-source-client-binding.ts", "restore-authorization.ts", "source-files.ts"]);
  try {
    directory = await mkdtemp(path.join(process.cwd(), ".agent-output-c3-ready-"));
    const copyDirectory = directory;
    for (const name of names) {
      const original = fileURLToPath(new URL("../../src/server/storage/maintenance/" + name, import.meta.url));
      let code = await readFile(original, "utf8");
      if (name === "source-files.ts") {
        const fixture = new URL("./maintenance-source-files.ts", import.meta.url).href;
        code = code.replaceAll('from "./source-file-native.ts"', "from " + JSON.stringify(fixture))
          .replaceAll('from "./source-file-profile.ts"', "from " + JSON.stringify(fixture));
      }
      code = code.replace(/from "(\.{1,2}\/[^"\n]+)"/g, (_, relative: string) => {
        const target = relative.startsWith("./") && names.has(relative.slice(2))
          ? path.join(copyDirectory, relative.slice(2)) : path.resolve(path.dirname(original), relative);
        return "from " + JSON.stringify(pathToFileURL(target).href);
      });
      await writeFile(path.join(copyDirectory, name), code, { mode: 0o600 });
    }
    const writer = await import(pathToFileURL(path.join(copyDirectory, "controller-write.ts")).href) as typeof import("../../src/server/storage/maintenance/controller-write.ts");
    const consumers = await import(pathToFileURL(path.join(copyDirectory, "restore-authorization.ts")).href) as typeof import("../../src/server/storage/maintenance/restore-authorization.ts");
    const sql = await import(pathToFileURL(path.join(copyDirectory, "control-sql.ts")).href) as typeof import("../../src/server/storage/maintenance/control-sql.ts");
    const sqlite = await import(pathToFileURL(path.join(copyDirectory, "sqlite.ts")).href) as typeof import("../../src/server/storage/maintenance/sqlite.ts");
    if (source.descriptor.kind !== "sqlite") throw new Error("SQLite real fixture required");
    adapter = await sqlite.createSqliteMaintenanceAdapter(source.descriptor);
    const store = await ArtifactStore.open(source.reference.controlRoot, source.plan.source);
    mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
    const heldAdapter = adapter, heldMutex = mutex;
    let scope: ControllerCommandScope | undefined;
    const select = async () => {
      await heldAdapter.withSourceLock("control", async lock => {
        const begun = await writer.beginControllerCommand(heldAdapter, heldMutex, lock, { operation: "resume-migration", request: source.request }, source.options);
        scope = begun.scope; return writer.commitControllerStep(scope, lock, { kind: "first-capture" });
      });
      await heldAdapter.withSourceLock("control", lock => writer.commitControllerStep(scope!, lock, { kind: "takeover" }));
      await heldAdapter.withSourceLock("control", lock => writer.commitControllerStep(scope!, lock, { kind: "recapture" }));
      return scope!;
    };
    const snapshot = <T>(consume: (lock: SourceLock) => Promise<T>) => heldAdapter.withSourceLock("snapshot", consume);
    return { ...source, store, adapter: heldAdapter, mutex: heldMutex, writer, consumers, sql, select, snapshot,
      async close() {
        try { await heldMutex.release(); }
        finally { try { await heldAdapter.close(); } finally { try { await source.close(); }
          finally { await rm(copyDirectory, { recursive: true }); } } }
      } };
  } catch (error) {
    const errors: unknown[] = [error];
    for (const cleanup of [() => mutex?.release(), () => adapter?.close(), () => source.close(),
      () => directory && rm(directory, { recursive: true, force: true })]) {
      try { await cleanup(); } catch (failure) { errors.push(failure); }
    }
    if (errors.length === 1) throw error;
    throw new AggregateError(errors, "ready fixture cleanup failed", { cause: error });
  }
}
