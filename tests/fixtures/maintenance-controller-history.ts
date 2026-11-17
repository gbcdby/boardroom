import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { PostgresDescriptor } from "../../src/server/storage/maintenance/postgres-tools.ts";
import { canonicalJson } from "../../src/server/storage/maintenance/canonical.ts";
import { captureReference } from "../../src/server/storage/maintenance/journal.ts";
import { parseReceipt } from "../../src/server/storage/maintenance/parse.ts";
import type { VerifiedMaintenanceGuard } from "../../src/server/storage/maintenance/verified-maintenance.ts";
import { registeredProcess, type EventFacts } from "../../src/server/storage/maintenance/control-candidate/schema.ts";
import type { ControllerOwner } from "../../src/server/storage/maintenance/controller-owner.ts";
import type { MaintenanceAdapter, OperationMutex, SourceLock, SourceRef } from "../../src/server/storage/maintenance/types.ts";
import { captureFixture } from "./maintenance-capture.ts";
import { withSqliteSourceInventoryDiagnostics } from "./maintenance-source-inventory-diagnostic.ts";

/** Actual adapter/factory/SQL/COMMIT/close paths, with the existing explicitly
 * synthetic filesystem-profile fixture only. Never a production qualification. */
export async function controllerWriterFixture(kind: "sqlite" | "postgres" = "sqlite",
  options: { legacyCapture?: boolean; legacyReady?: boolean; verification?: boolean; commandOwner?: boolean } = {}) {
  const source = await captureFixture(kind);
  let directory: string | undefined, adapter: MaintenanceAdapter | undefined, mutex: OperationMutex | undefined;
  let admin: Client | undefined, target: string | undefined, verificationTarget: PostgresDescriptor | undefined;
  let commandOwner: ControllerOwner | undefined;
  const dropTarget = async () => {
    if (target && admin) {
      assert.equal((await admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1", [target])).rows[0].count, "0");
      await admin.query(`DROP DATABASE "${target}"`); target = undefined; verificationTarget = undefined;
    }
  };
  const freshTarget = async () => {
    assert(process.env.AGENT_STUDIO_PG_TEST_URL);
    if (!admin) { admin = new Client({ connectionString: process.env.AGENT_STUDIO_PG_TEST_URL }); admin.on("error", () => {}); await admin.connect(); }
    await dropTarget();
    const name = `br_c3_archive_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`); target = name;
    const url = new URL(process.env.AGENT_STUDIO_PG_TEST_URL); url.pathname = `/${name}`;
    verificationTarget = { kind: "postgres", connectionString: url.toString() };
  };
  const names = new Set(["controller-write.ts", "control-sql.ts", "sqlite.ts", "postgres.ts", "restore-authorization.ts", "controller-owner.ts", "verified-maintenance.ts",
    "snapshot-bundle.ts", "snapshot-ready.ts", "verify-bundle.ts", "verification-source-client-binding.ts", "source-files.ts"]);
  try {
    if (kind === "postgres" && (options.legacyReady || options.verification)) await freshTarget();
    let request = source.request;
    if (options.legacyCapture || options.legacyReady) {
      const captured = await source.capture(source.options, source.request);
      assert.equal(captured.status, "paused"); if (captured.status !== "paused") throw new Error("actual legacy capture required");
      request = { ...request, requestId: "c3-legacy-command", expectedPhase: "quiesced", expectedJournalDigest: captured.ref.journal.sha256 };
    }
    directory = await mkdtemp(path.join(process.cwd(), ".agent-output-c3-writer-"));
    const copyDirectory = directory;
    for (const name of names) {
      const original = fileURLToPath(new URL("../../src/server/storage/maintenance/" + name, import.meta.url));
      let code = await readFile(original, "utf8");
      if (name === "controller-write.ts") code = code.replaceAll('from "./source-files.ts"', "from " + JSON.stringify(new URL("./maintenance-capture.ts", import.meta.url).href));
      if (name === "source-files.ts") {
        const profile = new URL("./maintenance-source-files.ts", import.meta.url).href;
        code = code.replaceAll('from "./source-file-native.ts"', "from " + JSON.stringify(profile))
          .replaceAll('from "./source-file-profile.ts"', "from " + JSON.stringify(profile));
      }
      code = code.replace(/from "(\.{1,2}\/[^"\n]+)"/g, (_, relative: string) => {
        const target = relative.startsWith("./") && names.has(relative.slice(2))
          ? path.join(copyDirectory, relative.slice(2)) : path.resolve(path.dirname(original), relative);
        return "from " + JSON.stringify(pathToFileURL(target).href);
      });
      await writeFile(path.join(directory, name), code, { mode: 0o600 });
    }
    const writer = await import(pathToFileURL(path.join(directory, "controller-write.ts")).href) as typeof import("../../src/server/storage/maintenance/controller-write.ts");
    const sql = await import(pathToFileURL(path.join(directory, "control-sql.ts")).href) as typeof import("../../src/server/storage/maintenance/control-sql.ts");
    const consumers = await import(pathToFileURL(path.join(directory, "restore-authorization.ts")).href) as typeof import("../../src/server/storage/maintenance/restore-authorization.ts");
    const owners = await import(pathToFileURL(path.join(directory, "controller-owner.ts")).href) as typeof import("../../src/server/storage/maintenance/controller-owner.ts");
    const guard = await import(pathToFileURL(path.join(directory, "verified-maintenance.ts")).href) as typeof import("../../src/server/storage/maintenance/verified-maintenance.ts");
    const bundle = await import(pathToFileURL(path.join(directory, "snapshot-bundle.ts")).href) as typeof import("../../src/server/storage/maintenance/snapshot-bundle.ts");
    const verify = await import(pathToFileURL(path.join(directory, "verify-bundle.ts")).href) as typeof import("../../src/server/storage/maintenance/verify-bundle.ts");
    const readyStage = await import(pathToFileURL(path.join(directory, "snapshot-ready.ts")).href) as typeof import("../../src/server/storage/maintenance/snapshot-ready.ts");
    const createAdapter = async () => {
      if (options.commandOwner) {
        commandOwner = await owners.createControllerOwner({ ...source.options,
          ...(verificationTarget ? { postgresVerification: verificationTarget } : {}) }, source.plan);
        return commandOwner.adapter;
      }
      return source.descriptor.kind === "sqlite"
        ? await (await import(pathToFileURL(path.join(copyDirectory, "sqlite.ts")).href) as typeof import("../../src/server/storage/maintenance/sqlite.ts")).createSqliteMaintenanceAdapter(source.descriptor)
        : await (await import(pathToFileURL(path.join(copyDirectory, "postgres.ts")).href) as typeof import("../../src/server/storage/maintenance/postgres.ts")).createPostgresMaintenanceAdapter(source.descriptor, verificationTarget);
    };
    adapter = await createAdapter();
    const store = await import("../../src/server/storage/maintenance/objects.ts").then(module => module.ArtifactStore.open(source.reference.controlRoot, source.plan.source));
    mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
    if (options.legacyReady) {
      const oldAdapter = adapter, oldMutex = mutex;
      const actual = await adapter.withSourceLock("snapshot", async lock => {
        const refs = await bundle.publishSnapshotBundle(store, lock);
        const verification = await verify.verifyRestoreBundle(store, oldAdapter, lock, refs.bundle, refs.publication);
        return { ...refs, verification };
      });
      const ready = await adapter.withSourceLock("control", lock => readyStage.stageSnapshotReady(store, lock, oldMutex,
        actual, { ...request, requestId: "actual-legacy-ready" }));
      // A genuine new native owner follows actual old mutex/source/archive/target
      // completion. No publicBackup, scope table or successful result is copied.
      await oldMutex.release(); await oldAdapter.close();
      if (kind === "postgres") await freshTarget();
      adapter = await createAdapter(); mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
      request = { ...request, requestId: "c3-legacy-ready-new-owner", expectedPhase: "snapshot_ready", expectedJournalDigest: ready.journal.sha256 };
    }
    const ownedAdapter = adapter, held = mutex;
    if (commandOwner) owners.rememberControllerStore(commandOwner, store);
    return { ...source, request, adapter: ownedAdapter, mutex: held, store, writer, sql, consumers, owners, guard, commandOwner, verificationTarget, async close() {
      const errors: unknown[] = [];
      for (const cleanup of [() => held.release(), () => ownedAdapter.close(), dropTarget, () => admin?.end(),
        () => source.close(), () => rm(copyDirectory, { recursive: true })]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "controller writer fixture cleanup failed", { cause: errors[0] });
    } };
  } catch (error) {
    const errors: unknown[] = [error];
    for (const cleanup of [() => mutex?.release(), () => adapter?.close(), dropTarget, () => admin?.end(), () => source.close(),
      () => directory && rm(directory, { recursive: true, force: true })]) {
      try { await cleanup(); } catch (failure) { errors.push(failure); }
    }
    if (errors.length === 1) throw error;
    throw new AggregateError(errors, "controller writer fixture cleanup failed", { cause: error });
  }
}

/** The original source callback and an already owned callback fail separately.
 * All locks, operations, transactions and cleanup owners below are real; only
 * the fixture's existing Fs profile is synthetic. */
export async function assertControllerPendingFailures(kind: "sqlite" | "postgres",
  variant: "distinct" | "same" | "undefined" | "parent-and-child" | "control-writer") {
  const f = await controllerWriterFixture(kind, { legacyCapture: variant !== "control-writer", commandOwner: true });
  const first = variant === "undefined" ? undefined : new Error("outer source callback failure");
  const later = variant === "same" || variant === "undefined" ? first : new Error("independent pending callback failure");
  const laterErrors = variant === "parent-and-child" ? [later, later] : [later];
  let release!: () => void, entered!: () => void, releaseParent!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
  let original: SourceLock | undefined, operation: Promise<unknown> | undefined, outer: Promise<void> | undefined;
  try {
    const { scope } = await f.adapter.withSourceLock("control", lock => f.writer.beginControllerCommand(f.adapter, f.mutex, lock,
      { operation: "resume-migration", request: f.request }));
    const before = await f.adapter.observe(), rows = await f.adapter.observeSourceClients();
    const files = (await readdir(f.store.root, { recursive: true })).sort();
    if (variant === "control-writer") f.state.hook = async stage => { if (stage === "capture-begin") { entered(); await gate; throw later; } };
    let finished = false;
    outer = f.adapter.withSourceLock(variant === "control-writer" ? "control" : "snapshot", async lock => {
      original = lock;
      if (variant === "control-writer") operation = f.writer.commitControllerStep(scope, lock, { kind: "first-capture" });
      else if (variant === "same" || variant === "parent-and-child") {
        const read = lock.observeSourceClients.bind(lock); let child = false;
        lock.observeSourceClients = async () => { if (child) { entered(); await gate; throw later; } return read(); };
        operation = f.consumers.withControllerRestoreCallback(scope, lock, () => {
          child = true; const pending = f.consumers.prepareControllerSnapshot(scope, lock);
          if (variant === "same") return pending;
          void pending.catch(() => undefined); return parentGate.then(() => { throw later; });
        });
      } else operation = f.consumers.withControllerRestoreCallback(scope, lock, async () => { entered(); await gate; throw later; });
      void operation.catch(() => undefined); await reached; throw first;
    });
    void outer.then(() => { finished = true; }, () => { finished = true; });
    await reached; await new Promise<void>(resolve => setImmediate(resolve));
    assert(original); assert.equal(finished, false);
    assert.equal(f.sql.controlSqlOutcome(original).commitStarted, false);
    assert.equal(f.sql.controlSqlOutcome(original).localSourceHandleClosed, false);
    await original.assertHeld();
    if (variant === "parent-and-child") {
      releaseParent(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(finished, false, "the original child remains pending after the parent callback's independent failure");
      assert.deepEqual(f.sql.controlSqlOutcome(original).cleanupEvents, [{ stage: "pending-operation-failure", error: later }]);
      await original.assertHeld();
    }
    release();
    let caught = false;
    try { await outer; } catch (error) { caught = true; assert.strictEqual(error, first, "adapter keeps the original raw source callback contract"); }
    assert(caught); caught = false;
    try { await operation; } catch (error) {
      caught = true;
      if (variant === "parent-and-child") { assert(error instanceof AggregateError); assert.deepEqual(error.errors, laterErrors); }
      else assert.strictEqual(error, later);
    }
    assert(caught);
    const outcome = f.sql.controlSqlOutcome(original);
    assert.equal(outcome.failureObserved, true); assert.strictEqual(outcome.originalError, first);
    assert.equal(outcome.commitStarted, false); assert.equal(outcome.commitReturned, false);
    assert.equal(outcome.localSourceHandleClosed, true);
    assert.deepEqual(outcome.cleanupEvents, laterErrors.map(error => ({ stage: "pending-operation-failure", error })));
    assert.deepEqual(await f.adapter.observe(), before); assert.deepEqual(await f.adapter.observeSourceClients(), rows);
    assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), files);
    assert(f.commandOwner);
    const failures = [first]; caught = false;
    try { await f.owners.finishControllerCommandOwner(f.commandOwner, f.mutex, original, failures, "pending-callback-test"); }
    catch (error) {
      caught = true; assert(error instanceof AggregateError); assert.strictEqual(error.cause, first);
      assert.deepEqual(error.errors, [first, ...laterErrors]); assert.strictEqual(error.errors[0], first);
      for (const value of error.errors.slice(1)) assert.strictEqual(value, later);
    }
    assert(caught); assert.equal(f.commandOwner.adapterClosed, true);
    assert.deepEqual(failures, [first, ...laterErrors]); assert.strictEqual(failures[0], first);
    for (const value of failures.slice(1)) assert.strictEqual(value, later);
  } finally { releaseParent(); release(); await Promise.allSettled([...(outer ? [outer] : []), ...(operation ? [operation] : [])]); await f.close(); }
}

/** Actual fixed withVerifiedMaintenance entry, including N07 and original owner.
 * Only explicit terminal forwarding uses the guard's private checking identity. */
export async function assertVerifiedConsumerFailure(kind: "sqlite" | "postgres",
  variant: "admission" | "revalidate" | "check-early" | "check-child" | "join" | "last-check" | "independent-same" | "independent-undefined" | "independent-after") {
  const f = await controllerWriterFixture(kind, { legacyReady: true, commandOwner: true });
  const first = new Error("outer source callback occurrence");
  const later = variant === "independent-undefined" ? undefined : new Error("actual guarded operation occurrence");
  const independent = variant.startsWith("independent-");
  const admission = variant === "admission";
  let release!: () => void, reached!: () => void, releaseConsumer!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
  const consumerGate = new Promise<void>(resolve => { releaseConsumer = resolve; });
  let original: SourceLock | undefined, checking: Promise<void> | undefined, consumerPromise: Promise<unknown> | undefined;
  let retained: VerifiedMaintenanceGuard | undefined, outer: Promise<void> | undefined;
  let throws = 0, consumed = 0;
  const exercise = async () => {
    const { scope } = await f.adapter.withSourceLock("control", lock => f.writer.beginControllerCommand(f.adapter, f.mutex, lock,
      { operation: "resume-migration", request: f.request }));
    const before = await f.adapter.observe(), rows = await f.adapter.observeSourceClients();
    outer = f.adapter.withSourceLock("snapshot", async lock => {
      original = lock;
      const current = await f.writer.assertControllerCommandWindow(scope, lock), head = current.chain?.nodes.at(-1);
      assert(head?.record.snapshot);
      const consumer = await f.guard.createVerifiedMaintenanceConsumer(scope, lock);
      const arm = (at: number) => {
        const read = lock.observeSourceClients.bind(lock); let count = 0;
        lock.observeSourceClients = async () => {
          const raw = await read();
          if (++count === at) { reached(); await gate; if (!admission) { throws++; throw later; } }
          return raw;
        };
      };
      // Parent currentWindow, fixed consumer currentWindow, then the actual
      // revalidate child's currentWindow. All reads run before injecting C.
      if (admission) arm(2);
      else if (variant === "revalidate") arm(3);
      consumerPromise = consumer.withVerifiedMaintenance(captureReference(head),
        parseReceipt(await current.store.readJson(head.record.snapshot, "receipt")), async guard => {
          retained = guard; consumed++;
          assert.equal(admission, false, "closed admission must not restore or enter the consumer");
          assert.notEqual(variant, "revalidate", "initial revalidation must fail before consumer entry");
          // First checking read is its own native precheck. The next read is
          // within the original ControllerReadyView.assertCurrent child.
          arm(variant === "check-child" ? 2 : 1);
          if (variant === "last-check") return;
          checking = guard.assertCurrent();
          assert.strictEqual(guard.assertCurrent(), checking, "concurrent check returns the original Promise");
          assert.throws(() => f.guard.forwardVerifiedMaintenanceFailure({ ...guard }, checking!), { code: "maintenance_lost" });
          assert.throws(() => f.guard.forwardVerifiedMaintenanceFailure(guard, Promise.resolve()), { code: "maintenance_lost" });
          if (variant === "join") { void checking.catch(() => undefined); return; }
          if (independent && variant !== "independent-after") {
            void checking.catch(() => undefined); await consumerGate; throws++; throw later;
          }
          try { await checking; }
          catch (error) {
            assert.strictEqual(error, later, "the guard exposes the original raw value, never a carrier");
            assert.strictEqual(guard.assertCurrent(), checking, "sticky failure retains its original checking after the current slot clears");
            if (variant === "independent-after") { throws++; throw later; }
            f.guard.forwardVerifiedMaintenanceFailure(guard, checking);
          }
        });
      void consumerPromise.catch(() => undefined);
      await Promise.race([entered, consumerPromise.then(() => { throw new Error("consumer unexpectedly completed before fault"); })]);
      throw first;
    });
    void outer.catch(() => undefined);
    await Promise.race([entered, outer.then(() => { throw new Error("source unexpectedly completed before fault"); })]);
    await new Promise<void>(resolve => setImmediate(resolve)); assert(original);
    const files = (await readdir(f.store.root, { recursive: true })).sort();
    assert.equal(f.sql.controlSqlOutcome(original).commitStarted, false);
    assert.equal(f.sql.controlSqlOutcome(original).localSourceHandleClosed, false); await original.assertHeld();
    if (independent) { releaseConsumer(); await new Promise<void>(resolve => setImmediate(resolve)); await original.assertHeld(); }
    release();
    let caught = false;
    try { await outer; } catch (error) { caught = true; assert.strictEqual(error, first); }
    assert(caught); caught = false;
    try { await consumerPromise; } catch (error) {
      caught = true;
      if (independent) { assert(error instanceof AggregateError); assert.deepEqual(error.errors, [later, later]);
        assert(error.errors.every(value => value === later)); }
      else if (admission) {
        assert.equal((error as { code?: unknown })?.code, "maintenance_lost");
        // The already owned parent and its close barrier expose the same raw
        // private marker; rejection of a new entry is not a new occurrence.
        await assert.rejects(f.consumers.finishControllerRestoreCallback(original)!, value => value === error);
      }
      else assert.strictEqual(error, later, "the original consumer parent exposes only the raw single occurrence");
    }
    assert(caught); assert.equal(throws, admission ? 0 : independent ? 2 : 1); assert.equal(consumed, admission || variant === "revalidate" ? 0 : 1);
    if (checking) { caught = false; try { await checking; } catch (error) { caught = true; assert.strictEqual(error, later); } assert(caught); }
    const outcome = f.sql.controlSqlOutcome(original), laterErrors = admission ? [] : independent ? [later, later] : [later];
    assert.strictEqual(outcome.originalError, first); assert.equal(outcome.commitStarted, false); assert.equal(outcome.commitReturned, false);
    assert.equal(outcome.localSourceHandleClosed, true);
    assert.deepEqual(outcome.cleanupEvents?.map(event => event.error), laterErrors);
    assert(outcome.cleanupEvents?.every(event => event.stage === "pending-operation-failure"));
    assert.deepEqual(await f.adapter.observe(), before); assert.deepEqual(await f.adapter.observeSourceClients(), rows);
    assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), files);
    if (retained && checking) {
      await assert.rejects(retained.assertCurrent(), { code: "maintenance_lost" });
      assert.throws(() => f.guard.forwardVerifiedMaintenanceFailure(retained!, checking!), { code: "maintenance_lost" });
      assert.throws(() => f.consumers.forwardControllerRestoreFailure(scope, original!, checking!), { code: "maintenance_lost" });
    }
    assert(f.commandOwner); caught = false; const failures = [first];
    try { await f.owners.finishControllerCommandOwner(f.commandOwner, f.mutex, original, failures, "verified-consumer-test"); }
    catch (error) { caught = true;
      if (admission) assert.strictEqual(error, first);
      else { assert(error instanceof AggregateError); assert.strictEqual(error.cause, first); assert.deepEqual(error.errors, [first, ...laterErrors]); }
    }
    assert(caught); assert.equal(f.commandOwner.adapterClosed, true);
  };
  try {
    // Observe only the original adapter's native calls. A refusal is preserved;
    // failed PID summaries are derived from that invocation, never guessed or retried.
    if (kind === "sqlite") await withSqliteSourceInventoryDiagnostics(f.adapter, phase => {
      phase(`verified-consumer-${variant}`); return exercise();
    });
    else await exercise();
  } finally { releaseConsumer(); release(); await Promise.allSettled([...(outer ? [outer] : []), ...(consumerPromise ? [consumerPromise] : [])]); await f.close(); }
}

/** A real otherwise idle child, not a registered maintenance controller or a simulated exit. */
export async function historicalControllerProcess(sourceFile?: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { randomUUID } from 'node:crypto';
    import { open, readFile, readlink } from 'node:fs/promises';
    import { hostname } from 'node:os';
    import { darwinCurrentProcessIdentity } from ${JSON.stringify(new URL("../../src/server/storage/maintenance/darwin.ts", import.meta.url).href)};
    let identity;
    const instanceId = randomUUID();
    if (process.platform === 'linux') {
      const text = await readFile('/proc/self/stat', 'utf8');
      identity = { version: 1, platform: 'linux', pid: process.pid, instanceId,
        verification: 'linux_proc_identity_v1',
        kernelBootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
        pidNamespace: await readlink('/proc/self/ns/pid'),
        startTicks: text.slice(text.lastIndexOf(') ') + 2).trim().split(/\\s+/)[19] };
    } else if (process.platform === 'darwin') identity = { ...darwinCurrentProcessIdentity(), instanceId };
    else throw new Error('actual supported native platform required');
    const held = ${JSON.stringify(sourceFile ?? null)};
    const handle = held === null ? undefined : await open(held, 'r');
    process.on('message', async value => { if (value === 'stop') { await handle?.close(); process.disconnect(); } });
    process.send({ host: { version: 1, hostname: hostname(), platform: process.platform }, identity });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 30_000 });
  let stderr = "";
  child.stderr!.on("data", value => { stderr = (stderr + String(value)).slice(-8192); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    const value = await Promise.race([
      new Promise<{ host: EventFacts["actor"]["host"]; identity: unknown }>(resolve => child.once("message", message => resolve(message as never))),
      closed.then(result => { throw new Error(`identity child exited before observation: ${result.code}/${result.signal}: ${stderr}`); }),
    ]);
    const identity = registeredProcess.parse(value.identity);
    assert.equal(identity.pid, child.pid);
    return { host: value.host, identity,
      async exit() {
        assert(child.connected, "the owned child must still be live before the exit request");
        child.send("stop");
        const result = await closed;
        assert.deepEqual(result, { code: 0, signal: null });
      },
      async close() {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      } };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.catch(() => {}); throw error;
  }
}

/** Controlled historical input only; this never claims that a controller registration committed. */
export function historicalControllerRow(source: SourceRef, actor: Pick<Awaited<ReturnType<typeof historicalControllerProcess>>, "host" | "identity">) {
  const migrationId = randomUUID(), previousDigest = "8".repeat(64), planDigest = "7".repeat(64);
  return { client_id: randomUUID(), database_instance_id: source.databaseInstanceId,
    entrypoint: "maintenance-controller", build_id: "boardroom-maintenance-control-v1", protocol_version: 1,
    registered_epoch: 1, observed_epoch: 1, drain_epoch: null, drain_state: "none", drain_receipt_digest: null,
    registered_at: "2026-11-01T00:00:00.000Z", last_observed_at: "2026-11-01T00:00:00.000Z", ended_at: null,
    host_identity_json: canonicalJson(actor.host), process_identity_json: canonicalJson(actor.identity),
    db_sessions_json: canonicalJson({ formatVersion: 1, kind: "maintenance-controller-registration", source,
      sourceIdentityDigest: source.identityDigest,
      creation: { migrationId, plan: { ref: `plans/${planDigest}.json`, sha256: planDigest, bytes: "1" }, fenceEpoch: "1", ownerGeneration: "7",
        previousAnchor: { ref: `journals/${migrationId}/1-${previousDigest}.json`, sha256: previousDigest, bytes: "1" }, targetSequence: "2" },
      sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null }) };
}
