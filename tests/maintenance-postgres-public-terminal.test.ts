import assert from "node:assert/strict";
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
import type { Json, MaintenanceAdapter, OperationMutex } from "../src/server/storage/maintenance/types.ts";

const testUrl = process.env.AGENT_STUDIO_PG_TEST_URL;
const pgTest = testUrl ? test : test.skip;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Mode = "normal" | "deadline-manifest" | "deadline-manifest-queries" | "deadline-backend-cleanup" | "deadline-session-close"
  | "late-close" | "late-source-lock-loss" | "late-target-lock-loss" | "late-monitor-failure" | "commit-ack-unknown" | "commit-rollback";
interface ChildReceipt { program: string; pid: number | undefined; closed: boolean; code?: number | null; signal?: string | null }
const errorCode = (error: unknown) => String((error as { code?: string })?.code ?? (error as Error)?.message);
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

// Real native tools, databases, manifests and COMMIT are used throughout. Only the
// monotonic clock at the selected tail boundary is advanced; this avoids another
// five-minute native timeout test and does not expose a production timeout override.
async function terminalCase(t: TestContext, mode: Mode): Promise<void> {
  assert.ok(testUrl);
  const id = randomUUID().replaceAll("-", ""), sourceName = `br_pub_terminal_src_${id}`, targetName = `br_pub_terminal_ver_${id}`;
  const directory = await mkdtemp(join(tmpdir(), "boardroom-pg-public-terminal-"));
  const stat = await lstat(directory, { bigint: true });
  const root = { path: directory, device: String(stat.dev), inode: String(stat.ino), hostIdentityDigest: await maintenanceHostIdentityDigest() };
  const descriptor = (name: string): PostgresDescriptor => {
    const url = new URL(testUrl); url.pathname = `/${name}`;
    return { kind: "postgres", connectionString: url.toString(), schema: "public" };
  };
  const admin = new Client({ connectionString: testUrl }); admin.on("error", () => {}); await admin.connect();
  const created: { name: string; oid: string }[] = [], children: ChildReceipt[] = [];
  const evidence: Record<string, unknown> = { mode, nativeBudgetMilliseconds: 300_000, clockInjection: "none", children };
  const originalQuery = Client.prototype.query, originalEnd = Client.prototype.end, originalSpawn = childProcess.spawn;
  const nativeNow = performance.now.bind(performance), startedAt = nativeNow();
  let clockOffset = 0, injected = false, backendChecks = 0, manifestReadsAfterExpiration = 0;
  let adapter: MaintenanceAdapter | undefined, mutex: OperationMutex | undefined;
  let closing: Promise<void> | undefined, commitHeld = false, monitorCaptured = false;
  let releaseMonitor!: () => void;
  const monitorReleased = new Promise<void>(resolve => { releaseMonitor = resolve; });
  const dispatch = (client: Client, args: unknown[]): Promise<QueryResult> => Reflect.apply(originalQuery, client, args) as Promise<QueryResult>;
  const isTarget = (client: Client) => (client as unknown as { connectionParameters: { database: string } }).connectionParameters.database === targetName;
  const expire = (boundary: string) => {
    assert.equal(injected, false); injected = true; clockOffset = 300_001;
    evidence.clockInjection = { boundary, addedMilliseconds: clockOffset, wallElapsedMilliseconds: nativeNow() - startedAt };
  };
  try {
    for (const name of [sourceName, targetName]) {
      await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`);
      created.push({ name, oid: (await admin.query("SELECT oid::text FROM pg_database WHERE datname=$1", [name])).rows[0].oid });
    }
    evidence.databaseIdentities = created.map(value => ({ ...value }));
    const driver = new PostgresDriver({ connectionString: descriptor(sourceName).connectionString, schema: "public" });
    try { await driver.connect(); await driver.migrate(migrations); } finally { await driver.close(); }
    const seed = new Client({ connectionString: descriptor(sourceName).connectionString }); await seed.connect();
    try { await seed.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES('terminal','public terminal fixture','t','t')"); }
    finally { await seed.end(); }
    adapter = await createPostgresMaintenanceAdapter(descriptor(sourceName), descriptor(targetName));
    mutex = await adapter.acquireMutex(root, (await adapter.observe()).state);
    for (const admission of ["draining", "sealed"] as const) await adapter.withSourceLock("control", async lock => {
      const before = await lock.observe();
      await lock.anchor({ expected: before.state, admission, fenceEpoch: before.state.fenceEpoch + (admission === "draining" ? 1 : 0),
        ownerGeneration: before.state.ownerGeneration + (admission === "draining" ? 1 : 0), activeMigrationId: "terminal-fixture",
        planDigest: "a".repeat(64), controlRootIdentity: root, mutexIdentity: mutex!.identity,
        journalSequence: before.state.journalSequence + 1, journal: { ref: `fixture-${admission}`, sha256: "b".repeat(64), bytes: "1" } });
    });
    evidence.sourceBefore = (await adapter.observe()).state;
    t.mock.method(performance, "now", () => nativeNow() + clockOffset);
    t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = Reflect.apply(originalSpawn, childProcess, args) as ReturnType<typeof childProcess.spawn>;
      const receipt: ChildReceipt = { program: args[0], pid: child.pid, closed: false }; children.push(receipt);
      child.once("close", (code, signal) => { receipt.closed = true; receipt.code = code; receipt.signal = signal; });
      return child;
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    t.mock.method(Client.prototype, "query", function (this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text;
      if (isTarget(this)) {
        if (mode === "deadline-manifest-queries" && (args[0] as { rowMode?: string })?.rowMode === "array") {
          if (injected) manifestReadsAfterExpiration++;
          else return dispatch(this, args).then(result => { expire("first typed manifest data query completed"); return result; });
        }
        if (mode === "late-monitor-failure" && commitHeld && !monitorCaptured && sql?.includes("SELECT control.system_identifier")) {
          monitorCaptured = true; evidence.inFlightMonitorCaptured = true;
          const client = this;
          return (async () => {
            await monitorReleased;
            // Deliver a real PostgreSQL query error to the in-flight monitor only
            // after the main verification COMMIT has already been acknowledged.
            try { return await dispatch(client, ["SELECT 1/0"]); }
            catch (error) { evidence.monitorError = errorCode(error); throw error; }
          })();
        }
        if (sql?.includes("AS same_postmaster")) {
          backendChecks++;
          if (mode === "deadline-backend-cleanup" && backendChecks === 2) expire("final owned-backend cleanup");
        }
        if (sql === "COMMIT") {
          evidence.fullManifestCompleted = true;
          if (mode === "deadline-manifest") expire("after complete manifest, before read-only COMMIT");
          const client = this;
          return (async () => {
            if (mode === "late-close") {
              injected = true; closing = adapter!.close(); await delay(20);
            } else if (mode === "late-source-lock-loss") {
              injected = true;
              const owners = (await admin.query(`SELECT a.pid,a.backend_start::text FROM pg_stat_activity a
                WHERE a.datname=$1 AND a.application_name LIKE 'boardroom-maintenance:%'
                AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.granted AND l.locktype='relation' AND l.mode='ShareLock')`, [sourceName])).rows;
              assert.equal(owners.length, 1); const owner = owners[0];
              assert.equal((await admin.query(`SELECT pg_terminate_backend(pid,1000) AS stopped FROM pg_stat_activity
                WHERE datname=$1 AND pid=$2 AND backend_start=$3::timestamptz`, [sourceName, owner.pid, owner.backend_start])).rows[0]?.stopped, true);
              evidence.sourceBackendTermination = { pid: owner.pid, backendStart: owner.backend_start,
                exited: (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz", [owner.pid, owner.backend_start])).rows[0].n === 0 };
              await delay(50);
            } else if (mode === "late-target-lock-loss") {
              injected = true; await dispatch(client, ["SELECT pg_advisory_unlock_all()"]);
              evidence.targetAdvisoryLocksRemaining = (await dispatch(client, ["SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted"])).rows[0].n;
              assert.equal(evidence.targetAdvisoryLocksRemaining, 0);
            } else if (mode === "late-monitor-failure") {
              injected = true; commitHeld = true;
              const until = nativeNow() + 2_000;
              while (!monitorCaptured && nativeNow() < until) await delay(10);
              assert.equal(monitorCaptured, true, "capture the real periodic monitor before allowing COMMIT");
            } else if (mode === "commit-ack-unknown" || mode === "commit-rollback") injected = true;
            if (mode === "late-close" || mode === "late-source-lock-loss") {
              try { await adapter!.observe(); evidence.invalidationObserved = "unexpectedly-open"; }
              catch (error) { evidence.invalidationObserved = errorCode(error); }
              assert.equal(evidence.invalidationObserved, "maintenance_lost");
            }
            const result = await dispatch(client, mode === "commit-rollback" ? ["ROLLBACK"] : args);
            evidence.verificationCommitCommand = result.command;
            releaseMonitor();
            if (mode === "commit-ack-unknown") throw new Error("injected lost COMMIT acknowledgement after the real server COMMIT");
            return result;
          })();
        }
      }
      return dispatch(this, args);
    } as typeof Client.prototype.query);
    t.mock.method(Client.prototype, "end", function (this: Client, ...args: unknown[]) {
      const ended = Reflect.apply(originalEnd, this, args) as Promise<void>;
      return isTarget(this) && mode === "deadline-session-close" && !injected
        ? ended.then(() => { expire("target session real end before success receipt"); }) : ended;
    } as typeof Client.prototype.end);
    let direct: { status: string; result?: Json; error?: string } | undefined, outer: { status: string; error?: string } | undefined;
    try {
      await adapter.withSourceLock("snapshot", async lock => {
        const archive = join(directory, "bound.dump"), backup = await lock.backup(archive);
        try {
          const result = await adapter!.verifyDatabase(archive, backup.manifests, directory);
          direct = { status: "RESOLVED", result }; return result;
        } catch (error) { direct = { status: "REJECTED", error: errorCode(error) }; throw error; }
      }); outer = { status: "RESOLVED" };
    } catch (error) { outer = { status: "REJECTED", error: errorCode(error) }; }
    await closing;
    evidence.direct = direct; evidence.outer = outer; evidence.backendChecks = backendChecks;
    evidence.manifestReadsAfterExpiration = manifestReadsAfterExpiration;
    assert.ok(direct);
    // Collect actual postconditions before asserting the expected result, including RED runs.
    const sourceCheck = new Client({ connectionString: descriptor(sourceName).connectionString }); await sourceCheck.connect();
    const targetCheck = new Client({ connectionString: descriptor(targetName).connectionString }); await targetCheck.connect();
    try {
      evidence.sourceAfter = (await sourceCheck.query(`SELECT admission,fence_epoch,owner_generation,database_instance_id,
        (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid FROM public.storage_maintenance`)).rows[0];
      evidence.targetAfter = (await targetCheck.query(`SELECT current_database() AS database,
        (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
        (SELECT oid::text FROM pg_namespace WHERE nspname='public') AS schema_oid,
        (SELECT count(*)::int FROM public.projects WHERE id='terminal') AS restored_rows`)).rows[0];
    } finally { await sourceCheck.end(); await targetCheck.end(); }
    evidence.nativeBackendsRemaining = (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND application_name LIKE 'boardroom-public-restore:%'", [targetName])).rows[0].n;
    assert.equal(evidence.nativeBackendsRemaining, 0);
    assert.ok(children.length > 0); assert.ok(children.every(child => child.closed && child.code === 0 && child.signal === null));
    const sourceBefore = evidence.sourceBefore as { databaseInstanceId: string; fenceEpoch: number; ownerGeneration: number };
    assert.deepEqual(evidence.sourceAfter, { admission: "sealed", database_instance_id: sourceBefore.databaseInstanceId,
      fence_epoch: String(sourceBefore.fenceEpoch), owner_generation: String(sourceBefore.ownerGeneration),
      database_oid: created.find(item => item.name === sourceName)!.oid });
    assert.equal((evidence.targetAfter as { database_oid: string }).database_oid, created.find(item => item.name === targetName)!.oid);
    assert.equal((evidence.targetAfter as { restored_rows: number }).restored_rows, 1, "the committed isolated restore remains real even when its verification receipt fails");
    assert.equal(injected, mode !== "normal");
    assert.equal(manifestReadsAfterExpiration, 0, "a completed query must not start another manifest read after the shared budget expired");
    assert.equal(direct.status, mode === "normal" ? "RESOLVED" : "REJECTED");
    assert.equal(outer.status, mode === "normal" ? "RESOLVED" : "REJECTED");
    if (mode === "normal") {
      assert.equal((direct.result as Record<string, Json>).exactFullDataAndControlMatched, true);
      assert.equal(((direct.result as Record<string, Json>).restoredWith as Record<string, Json>).profile, "pg16-public-native-segments-v1");
    } else assert.equal(direct.error, mode.startsWith("late-") ? "maintenance_lost" : "restore_verification_unavailable");
    if (mode === "late-monitor-failure") assert.equal(evidence.monitorError, "22012");
    if (mode === "normal" || mode.startsWith("deadline-") || mode.startsWith("commit-")) await mutex.release();
    evidence.assertions = "PASS";
  } catch (error) { evidence.assertions = "FAIL"; evidence.assertionError = (error as Error).message; throw error; }
  finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    releaseMonitor(); await adapter?.close(); await closing;
    for (const own of created.reverse()) {
      assert.equal((await admin.query("SELECT oid::text FROM pg_database WHERE datname=$1", [own.name])).rows[0]?.oid, own.oid);
      await admin.query(`DROP DATABASE ${quote(own.name)}`);
    }
    await admin.end(); await rm(directory, { recursive: true, force: true });
    evidence.fixtureDatabasesDroppedAfterOidCheck = true; evidence.elapsedMilliseconds = nativeNow() - startedAt;
    const output = process.env.AGENT_STUDIO_PG_TERMINAL_EVIDENCE_DIRECTORY;
    if (output) { await mkdir(output, { recursive: true }); await writeFile(join(output, `${mode}.json`), JSON.stringify(evidence, null, 2) + "\n"); }
    t.diagnostic(JSON.stringify(evidence));
  }
}

for (const mode of ["normal", "deadline-manifest", "deadline-manifest-queries", "deadline-backend-cleanup", "deadline-session-close", "late-close",
  "late-source-lock-loss", "late-target-lock-loss", "late-monitor-failure", "commit-ack-unknown", "commit-rollback"] as const)
  pgTest(`#152 public terminal ${mode}`, { concurrency: false }, async t => terminalCase(t, mode));
