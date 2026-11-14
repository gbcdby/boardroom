import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client, type QueryResult } from "pg";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { maintenanceHostIdentityDigest } from "../src/server/storage/maintenance/host.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import type { PostgresDescriptor } from "../src/server/storage/maintenance/postgres-tools.ts";
import type { MaintenanceAdapter, OperationMutex } from "../src/server/storage/maintenance/types.ts";

const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const modes = ["normal", "helper-source", "helper-target", "helper-before-empty", "monitor-source", "monitor-native", "post-helper-source",
  "begin-identity", "manifest-activity", "pre-release-source", "pre-release-target", "final-source", "final-snapshot"] as const;
type Mode = typeof modes[number];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const errorCode = (error: unknown) => String((error as { code?: string })?.code ?? (error as Error)?.message);
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

// Scope tags distinguish this verification and its real periodic monitor from the
// independently running mutex heartbeat and from genuine failure cleanup. Native
// tools, query results, transactions, locks, and session end are never simulated.
async function queryBudgetCase(t: TestContext, mode: Mode): Promise<void> {
  const baseUrl = process.env.AGENT_STUDIO_PG_TEST_URL; assert.ok(baseUrl);
  const id = randomUUID().replaceAll("-", ""), sourceName = `br_budget_src_${id}`, targetName = `br_budget_ver_${id}`;
  const directory = await mkdtemp(join(tmpdir(), "boardroom-public-query-budget-"));
  const stat = await lstat(directory, { bigint: true });
  const root = { path: directory, device: String(stat.dev), inode: String(stat.ino), hostIdentityDigest: await maintenanceHostIdentityDigest() };
  const descriptor = (name: string): PostgresDescriptor => {
    const url = new URL(baseUrl); url.pathname = `/${name}`;
    return { kind: "postgres", connectionString: url.toString(), schema: "public" };
  };
  const admin = new Client({ connectionString: baseUrl }); admin.on("error", () => {}); await admin.connect();
  const created: { name: string; oid: string }[] = [];
  const children: { program: string; pid: number | undefined; closed: boolean; code?: number | null; signal?: string | null }[] = [];
  const successQueriesAfterExpiry: unknown[] = [], cleanupQueriesAfterExpiry: unknown[] = [], backgroundQueriesAfterExpiry: unknown[] = [];
  const evidence: Record<string, unknown> = { mode, productionBudgetMilliseconds: 300_000, children,
    successQueriesAfterExpiry, cleanupQueriesAfterExpiry, backgroundQueriesAfterExpiry };
  const scope = new AsyncLocalStorage<"pipeline" | "monitor">();
  const originalQuery = Client.prototype.query, originalEnd = Client.prototype.end;
  const originalSpawn = childProcess.spawn, originalSetInterval = globalThis.setInterval;
  const nativeNow = performance.now.bind(performance), startedAt = nativeNow();
  let adapter: MaintenanceAdapter | undefined, mutex: OperationMutex | undefined;
  let clockOffset = 0, injected = false, collecting = false, listClosed = false, bodyClosed = false;
  let renderCount = 0, bodyAdvisoryChecks = 0, backendExitChecks = 0, targetEnded = false, finalSourceIdentities = 0;
  let commitAcknowledged = false, holdCommit = false, manifestChecksUntilExpiry = 0;
  let nativePsqlRunning = false;
  const expire = (boundary: string) => {
    assert.equal(injected, false); injected = true; clockOffset = 300_001;
    evidence.clockInjection = { boundary, addedMilliseconds: clockOffset, wallElapsedMilliseconds: nativeNow() - startedAt };
  };
  const database = (client: Client) => (client as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
  const dispatch = (client: Client, args: unknown[]) => Reflect.apply(originalQuery, client, args) as Promise<QueryResult>;
  try {
    for (const name of [sourceName, targetName]) {
      await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`);
      created.push({ name, oid: (await admin.query("SELECT oid::text FROM pg_database WHERE datname=$1", [name])).rows[0].oid });
    }
    evidence.databaseIdentities = created.map(value => ({ ...value }));
    const driver = new PostgresDriver({ connectionString: descriptor(sourceName).connectionString, schema: "public" });
    try { await driver.connect(); await driver.migrate(migrations); } finally { await driver.close(); }
    const seed = new Client({ connectionString: descriptor(sourceName).connectionString }); await seed.connect();
    try { await seed.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES('budget','query budget fixture','t','t')"); }
    finally { await seed.end(); }
    const beforeTarget = new Client({ connectionString: descriptor(targetName).connectionString }); await beforeTarget.connect();
    try { evidence.targetNamespaceBefore = (await beforeTarget.query("SELECT oid::text,nspowner::text,nspacl::text FROM pg_namespace WHERE nspname='public'")).rows[0]; }
    finally { await beforeTarget.end(); }
    if (mode === "monitor-native") {
      const realPsql = childProcess.spawnSync("which", ["psql"], { encoding: "utf8" });
      assert.equal(realPsql.status, 0); const executable = realPsql.stdout.trim(); assert.ok(executable.startsWith("/"));
      const bin = join(directory, "native-hold"); await mkdir(bin, { mode: 0o700 });
      const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      // Same test-only native hold used by the existing real 300-second acceptance:
      // exec real psql with unchanged SQL plus a final in-transaction query.
      await writeFile(join(bin, "psql"), `#!/bin/sh\nif [ "$1" = --version ]; then exec ${shellQuote(executable)} "$@"; fi\nexec ${shellQuote(executable)} "$@" -c 'SELECT pg_sleep(30)'\n`, { mode: 0o700 });
      const previousPath = process.env.PATH;
      try {
        process.env.PATH = `${bin}:${previousPath ?? ""}`;
        adapter = await createPostgresMaintenanceAdapter(descriptor(sourceName), descriptor(targetName));
      } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
    } else adapter = await createPostgresMaintenanceAdapter(descriptor(sourceName), descriptor(targetName));
    mutex = await adapter.acquireMutex(root, (await adapter.observe()).state);
    for (const admission of ["draining", "sealed"] as const) await adapter.withSourceLock("control", async lock => {
      const before = await lock.observe();
      await lock.anchor({ expected: before.state, admission, fenceEpoch: before.state.fenceEpoch + (admission === "draining" ? 1 : 0),
        ownerGeneration: before.state.ownerGeneration + (admission === "draining" ? 1 : 0), activeMigrationId: "query-budget-fixture",
        planDigest: "a".repeat(64), controlRootIdentity: root, mutexIdentity: mutex!.identity,
        journalSequence: before.state.journalSequence + 1, journal: { ref: `fixture-${admission}`, sha256: "b".repeat(64), bytes: "1" } });
    });
    evidence.sourceBefore = (await adapter.observe()).state;
    t.mock.method(performance, "now", () => {
      const now = nativeNow() + clockOffset;
      // The last manifest query and the adapter's existing post-manifest check see
      // an in-budget time. Expiry immediately afterwards models time spent comparing
      // manifests, before a new activity SELECT is dispatched.
      if (scope.getStore() === "pipeline" && manifestChecksUntilExpiry > 0 && --manifestChecksUntilExpiry === 0)
        expire("after the completed manifest budget check, before activity SELECT");
      return now;
    });
    t.mock.method(globalThis, "setInterval", ((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
      const wrapped = scope.getStore() === "pipeline" && milliseconds === 500
        ? () => scope.run("monitor", () => callback(...args)) : callback;
      return Reflect.apply(originalSetInterval, globalThis, [wrapped, milliseconds, ...args]);
    }) as typeof globalThis.setInterval);
    t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = Reflect.apply(originalSpawn, childProcess, args) as ReturnType<typeof childProcess.spawn>;
      const receipt = { program: args[0], pid: child.pid, closed: false } as typeof children[number]; children.push(receipt);
      const argv = (args[1] ?? []) as string[];
      if (args[0] === "psql" && argv.includes("--single-transaction")) nativePsqlRunning = true;
      child.once("close", (code, signal) => {
        receipt.closed = true; receipt.code = code; receipt.signal = signal;
        if (args[0] === "psql" && argv.includes("--single-transaction")) nativePsqlRunning = false;
        if (args[0] === "pg_restore" && argv.includes("--list")) listClosed = true;
        if (args[0] === "pg_restore" && argv.includes("--file=-") && ++renderCount === 2) bodyClosed = true;
      });
      return child;
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    t.mock.method(Client.prototype, "query", function (this: Client, ...args: unknown[]) {
      const sql = String(typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "").replace(/\s+/g, " ").trim();
      const where = database(this), context = scope.getStore();
      const target = where === targetName, source = where === sourceName;
      const cleanup = sql.includes("AS same_postmaster")
        || sql.startsWith("SELECT pid,backend_start::text FROM pg_catalog.pg_stat_activity WHERE datid=$1::oid AND application_name=$2")
        || sql.startsWith("SELECT pg_catalog.pg_terminate_backend") || sql === "ROLLBACK";
      if (collecting && injected && (source || target)) {
        const entry = { database: source ? "source" : "target", context: context ?? "outside-operation", sql,
          wallElapsedMilliseconds: nativeNow() - startedAt };
        (context ? cleanup ? cleanupQueriesAfterExpiry : successQueriesAfterExpiry : backgroundQueriesAfterExpiry).push(entry);
      }
      return dispatch(this, args).then(async result => {
        if (!context || !collecting) return result;
        const identity = sql.startsWith("SELECT control.system_identifier");
        const advisory = target && sql.startsWith("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks") && sql.includes("pid=pg_backend_pid()");
        if (target && sql.startsWith("SELECT pid,backend_start::text FROM pg_catalog.pg_stat_activity WHERE datid=$1::oid AND application_name=$2")) backendExitChecks++;
        if (context === "pipeline" && bodyClosed && advisory) bodyAdvisoryChecks++;
        if (context === "pipeline" && targetEnded && source && identity) finalSourceIdentities++;
        if (!injected && context === "monitor" && mode === "monitor-native" && nativePsqlRunning && source && identity) {
          const backend = (await admin.query(`SELECT pid,backend_start::text FROM pg_stat_activity WHERE datname=$1
            AND application_name LIKE 'boardroom-public-restore:%' AND state='active' AND query='SELECT pg_sleep(30)'`, [targetName])).rows[0];
          if (backend) { evidence.nativeBackendAtExpiry = backend; expire("monitor source identity returned while real native psql backend is in transaction"); }
        }
        if (!injected) {
          const boundary = context === "pipeline" && listClosed && !bodyClosed && mode === "helper-source" && source && identity ? "helper source identity query completed"
            : context === "pipeline" && listClosed && !bodyClosed && mode === "helper-target" && target && identity ? "helper target identity query completed"
            : context === "pipeline" && bodyAdvisoryChecks === 2 && mode === "helper-before-empty" && advisory ? "beforeExecute target lock query completed before assertEmpty"
            : context === "monitor" && holdCommit && mode === "monitor-source" && source && identity ? "periodic monitor source identity completed after real COMMIT acknowledgement"
            : context === "pipeline" && backendExitChecks === 1 && !commitAcknowledged && mode === "post-helper-source" && source && identity ? "post-helper source identity query completed"
            : context === "pipeline" && mode === "begin-identity" && target && sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" ? "final BEGIN completed before restored target identity query"
            : context === "pipeline" && backendExitChecks >= 2 && !targetEnded && mode === "pre-release-source" && source && identity ? "pre-release source identity query completed"
            : context === "pipeline" && backendExitChecks >= 2 && !targetEnded && mode === "pre-release-target" && target && identity ? "pre-release target identity query completed"
            : context === "pipeline" && targetEnded && finalSourceIdentities === 1 && mode === "final-source" && source && identity ? "first final source identity completed after actual target end"
            : context === "pipeline" && targetEnded && finalSourceIdentities === 2 && mode === "final-snapshot" && source && identity ? "nested final snapshot source identity completed after actual target end" : undefined;
          if (boundary) expire(boundary);
          if (context === "pipeline" && mode === "manifest-activity" && target && sql.startsWith("SELECT last_value::text,is_called::text")) manifestChecksUntilExpiry = 2;
        }
        if (context === "pipeline" && target && sql === "COMMIT") {
          assert.equal(result.command, "COMMIT"); commitAcknowledged = true; evidence.realVerificationCommitCommand = result.command;
          if (mode === "monitor-source") {
            holdCommit = true;
            const until = nativeNow() + 2_000;
            while (!injected && nativeNow() < until) await delay(10);
            assert.equal(injected, true, "real periodic monitor must reach the source query while COMMIT receipt is held");
          }
        }
        return result;
      });
    } as typeof Client.prototype.query);
    t.mock.method(Client.prototype, "end", function (this: Client, ...args: unknown[]) {
      const ended = Reflect.apply(originalEnd, this, args) as Promise<void>;
      return database(this) === targetName && scope.getStore() === "pipeline"
        ? ended.then(() => { targetEnded = true; evidence.targetSessionActuallyEnded = true; }) : ended;
    } as typeof Client.prototype.end);
    let direct: { status: string; error?: string } | undefined, outer: { status: string; error?: string } | undefined;
    try {
      await adapter.withSourceLock("snapshot", async lock => {
        const archive = join(directory, "bound.dump"), backup = await lock.backup(archive);
        collecting = true;
        try {
          const result = await scope.run("pipeline", () => adapter!.verifyDatabase(archive, backup.manifests, directory));
          direct = { status: "RESOLVED" }; return result;
        } catch (error) { direct = { status: "REJECTED", error: errorCode(error) }; throw error; }
        finally { collecting = false; }
      }); outer = { status: "RESOLVED" };
    } catch (error) { outer = { status: "REJECTED", error: errorCode(error) }; }
    evidence.direct = direct; evidence.outer = outer; evidence.backendExitChecks = backendExitChecks;
    const sourceCheck = new Client({ connectionString: descriptor(sourceName).connectionString }); await sourceCheck.connect();
    const targetCheck = new Client({ connectionString: descriptor(targetName).connectionString }); await targetCheck.connect();
    try {
      evidence.sourceAfter = (await sourceCheck.query(`SELECT admission,database_instance_id,fence_epoch::text,owner_generation::text,
        (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid FROM public.storage_maintenance`)).rows[0];
      evidence.targetNamespaceAfter = (await targetCheck.query("SELECT oid::text,nspowner::text,nspacl::text FROM pg_namespace WHERE nspname='public'")).rows[0];
      const restored = (await targetCheck.query("SELECT to_regclass('public.projects') IS NOT NULL AS present")).rows[0].present;
      evidence.restoredRows = restored ? (await targetCheck.query("SELECT count(*)::int AS n FROM public.projects WHERE id='budget'")).rows[0].n : 0;
    } finally { await sourceCheck.end(); await targetCheck.end(); }
    evidence.nativeBackendsRemaining = (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND application_name LIKE 'boardroom-public-restore:%'", [targetName])).rows[0].n;
    assert.ok(children.length > 0); assert.ok(children.every(child => child.closed)); assert.equal(evidence.nativeBackendsRemaining, 0);
    const before = evidence.sourceBefore as { databaseInstanceId: string; fenceEpoch: number; ownerGeneration: number };
    assert.deepEqual(evidence.sourceAfter, { admission: "sealed", database_instance_id: before.databaseInstanceId,
      fence_epoch: String(before.fenceEpoch), owner_generation: String(before.ownerGeneration), database_oid: created.find(item => item.name === sourceName)!.oid });
    assert.equal(injected, mode !== "normal");
    assert.equal(direct?.status, mode === "normal" ? "RESOLVED" : "REJECTED");
    assert.equal(outer.status, mode === "normal" ? "RESOLVED" : "REJECTED");
    if (mode === "monitor-native") assert.equal(direct?.error, "restore_verification_unavailable", "deadline cancellation preserves the existing native timeout failure code");
    assert.equal(successQueriesAfterExpiry.length, 0, "no new success-validation SQL after this operation's absolute deadline");
    if (mode.startsWith("helper-") || mode === "monitor-native") {
      assert.deepEqual(evidence.targetNamespaceAfter, evidence.targetNamespaceBefore); assert.equal(evidence.restoredRows, 0);
    } else assert.equal(evidence.restoredRows, 1, "already committed isolated native restore remains real");
    evidence.assertions = "PASS";
  } catch (error) { evidence.assertions = "FAIL"; evidence.assertionError = (error as Error).message; throw error; }
  finally {
    collecting = false; t.mock.restoreAll(); syncBuiltinESMExports(); await adapter?.close();
    for (const own of created.reverse()) {
      assert.equal((await admin.query("SELECT oid::text FROM pg_database WHERE datname=$1", [own.name])).rows[0]?.oid, own.oid);
      await admin.query(`DROP DATABASE ${quote(own.name)}`);
    }
    await admin.end(); await rm(directory, { recursive: true, force: true });
    evidence.fixtureDatabasesDroppedAfterOidCheck = true; evidence.elapsedMilliseconds = nativeNow() - startedAt;
    const output = process.env.AGENT_STUDIO_PG_TERMINAL_EVIDENCE_DIRECTORY;
    if (output) { await mkdir(output, { recursive: true }); await writeFile(join(output, `query-budget-${mode}.json`), JSON.stringify(evidence, null, 2) + "\n"); }
    t.diagnostic(JSON.stringify(evidence));
  }
}

for (const mode of modes) pgTest(`#152 public query budget ${mode}`, { concurrency: false }, async t => queryBudgetCase(t, mode));
