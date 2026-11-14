import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, appendFile, copyFile, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import { loadPersistedPlan, persistMigrationPlan, planMigration, revalidatePlan } from "../src/server/storage/maintenance/plan.ts";
import type { MaintenanceAdapter, OperationMutex } from "../src/server/storage/maintenance/types.ts";

const execute = promisify(execFile);
const toolsDirectory = process.env["AGENT_STUDIO_PG_RESTART_BIN"];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** This test owns the data directory and the actual postgres child; no shared PG URL is used. */
async function isolatedCluster(binaryDirectory: string) {
  assert.ok(isAbsolute(binaryDirectory), "restart tools must be an explicit absolute path");
  assert.equal(process.platform, "linux", "the independent restart fixture is a Linux CI capability");
  assert.notEqual(process.getuid?.(), 0, "initdb must run as the unprivileged CI user");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG")));
  const binary = (name: string) => join(binaryDirectory, name);
  const command = async (program: string, args: readonly string[]) => {
    try { return (await execute(binary(program), [...args], { env: environment, timeout: 30_000, maxBuffer: 512_000 })).stdout; }
    catch { throw new Error(`isolated PostgreSQL fixture ${program} failed; no shared service was changed`); }
  };
  for (const name of ["postgres", "initdb", "pg_ctl"]) {
    await access(binary(name), constants.X_OK); // An explicitly enabled but missing tool is a failure, never a skip.
    assert.match(await command(name, ["--version"]), /PostgreSQL\) 16\./);
  }
  const directory = await mkdtemp(join(tmpdir(), "br-pg-restart-"));
  const data = join(directory, "cluster"), log = join(directory, "postgres.log");
  const retainDiagnostics = async () => {
    const evidenceDirectory = resolve(".agent-output/maintenance-pg-restart");
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await copyFile(log, join(evidenceDirectory, "postgres.log")).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  };
  const probe = createServer();
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address(); assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  assert.notEqual(port, 5432);
  const user = "boardroom_restart_fixture";
  let child: ReturnType<typeof spawn> | undefined;
  let childClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let systemIdentifier: string | undefined;
  const connect = async (database = "postgres") => {
    const client = new Client({ host: "127.0.0.1", port, user, database, password: () => "", ssl: false,
      connectionTimeoutMillis: 1_000, application_name: "boardroom-owned-restart-fixture" });
    client.on("error", () => {});
    try { await client.connect(); return client; }
    catch (error) { await client.end().catch(() => {}); throw error; }
  };
  const verifyOwner = async () => {
    const client = await connect();
    try {
      const row = (await client.query(`SELECT current_setting('data_directory') AS directory,
        current_setting('port') AS port,pg_catalog.host(inet_server_addr()) AS address,
        (pg_control_system()).system_identifier::text AS system_identifier,
        pg_postmaster_start_time()::text AS started,pg_backend_pid() AS backend`)).rows[0];
      assert.equal(await realpath(row.directory), await realpath(data), "never connect to a different cluster");
      assert.equal(row.port, String(port)); assert.equal(row.address, "127.0.0.1");
      if (systemIdentifier !== undefined) assert.equal(row.system_identifier, systemIdentifier);
      systemIdentifier ??= row.system_identifier;
      return { started: row.started as string };
    } finally { await client.end(); }
  };
  const stop = async () => {
    if (!child) return;
    const owned = child, exited = childClosed!;
    if (owned.exitCode === null && owned.signalCode === null) {
      // The private data directory has been verified against this exact child and SQL instance.
      await command("pg_ctl", ["-D", data, "-w", "-t", "30", "-m", "fast", "stop"]);
    }
    const result = await exited;
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    await assert.rejects(access(join(data, "postmaster.pid")), { code: "ENOENT" });
    child = undefined; childClosed = undefined;
  };
  const start = async () => {
    assert.equal(child, undefined);
    const output = await open(log, "a", 0o600);
    try {
      const owned = spawn(binary("postgres"), ["-D", data], { shell: false, env: environment,
        stdio: ["ignore", output.fd, output.fd] });
      child = owned;
      childClosed = new Promise(resolve => owned.once("close", (code, signal) => resolve({ code, signal })));
      await once(owned, "spawn");
    } finally { await output.close(); }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("isolated PostgreSQL child exited before readiness");
      try { return await verifyOwner(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED" && !/starting up/.test(String(error))) throw error;
      }
      await delay(50);
    }
    throw new Error("isolated PostgreSQL readiness was not observed");
  };
  try {
    // The private package layout is preserved. No postinst, system service or default cluster runs.
    const share = resolve(binaryDirectory, "../../../../share/postgresql/16");
    const library = resolve(binaryDirectory, "../lib");
    await access(join(share, "postgres.bki"));
    await command("initdb", ["-D", data, "-U", user, "--auth=trust", "--no-locale", "--encoding=UTF8", "-L", share]);
    await appendFile(join(data, "postgresql.conf"), `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nfsync=on\nsynchronous_commit=on\njit=off\ndynamic_library_path=${sqlString(library)}\n`);
    const first = await start();
    return { directory, data, first, connect,
      url: (database: string) => `postgres://${user}@127.0.0.1:${port}/${database}`,
      async restart(fsync: "on" | "off") {
        await verifyOwner(); await stop();
        await appendFile(join(data, "postgresql.conf"), `\nfsync=${fsync}\n`);
        return start();
      },
      async close() { await stop(); await retainDiagnostics(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await retainDiagnostics(); await stop(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}

test("#152 PG real private-cluster restarts preserve sealed source/plan binding, retire old handles and recheck execution capabilities (native prerequisites)",
  { skip: toolsDirectory === undefined, timeout: 180_000 }, async () => {
    const cluster = await isolatedCluster(toolsDirectory!);
    const adapters: MaintenanceAdapter[] = [];
    const createAdapter = async () => {
      const adapter = await createPostgresMaintenanceAdapter({ kind: "postgres", connectionString: cluster.url("source") },
        { kind: "postgres", connectionString: cluster.url("verification") });
      adapters.push(adapter); return adapter;
    };
    try {
      const admin = await cluster.connect();
      try { await admin.query("CREATE DATABASE source TEMPLATE template0"); await admin.query("CREATE DATABASE verification TEMPLATE template0"); }
      finally { await admin.end(); }
      const driver = new PostgresDriver({ connectionString: cluster.url("source") });
      try {
        await driver.connect(); await driver.migrate(migrations);
      } finally { await driver.close(); }
      const seed = await cluster.connect("source");
      try { await seed.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,$2,$3,$4)", ["restart", "persistent business value", "t", "t"]); }
      finally { await seed.end(); }
      const dataDir = join(cluster.directory, "data"), configFile = join(cluster.directory, "config.json");
      await mkdir(dataDir);
      await writeFile(configFile, JSON.stringify({ dataDir, dbDriver: "postgres", pgConnectionString: cluster.url("source") }), { mode: 0o600 });
      const environment = await resolveBoardroomEnvironment({ cwd: cluster.directory, homeDir: cluster.directory,
        env: { AGENT_STUDIO_CONFIG: configFile, BOARDROOM_HOME: join(cluster.directory, "home") } });
      const options = { environment, originalCwd: cluster.directory, expectedSourceId: environment.inventory.selectedSourceId!,
        controlRoot: join(dataDir, "maintenance-control"), targetRoot: join(cluster.directory, "future-target") };
      const before = await createAdapter(), idleOld = await createAdapter();
      const plan = await planMigration(options, before), persisted = await persistMigrationPlan(plan, options, before);
      const store = await ArtifactStore.open(persisted.controlRoot, plan.source);
      await idleOld.observe();
      const mutex = await before.acquireMutex(store.identity, (await before.observe()).state);
      assert.deepEqual(await before.inspectWriters(await before.observe()), []);
      // These are explicit native-primitive fixture anchors. They do not claim a service journal,
      // a completed drain or a certified snapshot receipt. Full service restart tests are separate.
      for (const admission of ["draining", "sealed"] as const) await before.withSourceLock("control", async lock => {
        const current = await lock.observe(), sequence = current.state.journalSequence + 1;
        const journal = await store.putJson("journal", { fixture: "native-restart-only", migrationId: plan.migrationId, sequence, admission });
        await lock.anchor({ expected: current.state, admission, fenceEpoch: current.state.fenceEpoch + (admission === "draining" ? 1 : 0),
          ownerGeneration: current.state.ownerGeneration + (admission === "draining" ? 1 : 0), activeMigrationId: plan.migrationId,
          planDigest: persisted.planDigest, controlRootIdentity: { ...store.identity }, mutexIdentity: mutex.identity, journalSequence: sequence, journal });
      });
      const frozen = await before.observe();
      const restarted = await cluster.restart("on"); assert.notEqual(restarted.started, cluster.first.started);
      await assert.rejects(mutex.assertHeld(), /maintenance_lost/);
      await assert.rejects(before.observe(), /maintenance_lost/);
      await assert.rejects(idleOld.observe(), /maintenance_lost/);
      await before.close(); await idleOld.close();
      const resumed = await createAdapter(), current = await resumed.observe();
      assert.deepEqual(current.source, frozen.source); assert.deepEqual(current.sourceIdentity, frozen.sourceIdentity);
      assert.deepEqual(current.state, frozen.state); assert.equal(current.state.admission, "sealed");
      assert.deepEqual(await loadPersistedPlan(persisted, current.source), plan);
      await revalidatePlan(plan, options, resumed);
      const sameRoot = await ArtifactStore.open(persisted.controlRoot, current.source);
      const resumedMutex = await resumed.acquireMutex(sameRoot.identity, current.state);
      assert.deepEqual(resumedMutex.identity, mutex.identity); await resumedMutex.assertHeld();
      const attempt = await store.createAttempt(current.state.ownerGeneration);
      await resumed.withSourceLock("snapshot", async lock => {
        const dump = join(attempt, "snapshot.dump"), backup = await lock.backup(dump);
        assert.equal(backup.manifests.tables.find(table => table.name === "projects")?.count, "1");
        const restored = await resumed.verifyDatabase(dump, backup.manifests, attempt);
        assert.equal((restored as { exactFullDataAndControlMatched: boolean }).exactFullDataAndControlMatched, true);
      });
      await resumedMutex.release(); await resumed.close();

      await cluster.restart("off");
      const unsafe = await createAdapter(), unsafeObservation = await unsafe.observe();
      assert.deepEqual(unsafeObservation.source, frozen.source);
      await assert.rejects(unsafe.acquireMutex(store.identity, unsafeObservation.state), /unsupported_durability/);
      await unsafe.close();

      await cluster.restart("on");
      const cancelling = await createAdapter(), last = await cancelling.observe();
      await revalidatePlan(plan, options, cancelling);
      const cancelMutex: OperationMutex = await cancelling.acquireMutex(store.identity, last.state);
      assert.deepEqual(await cancelling.inspectWriters(last), []);
      await cancelling.withSourceLock("control", async lock => {
        const live = await lock.observe(), sequence = live.state.journalSequence + 1;
        const journal = await store.putJson("journal", { fixture: "native-cancel-only", migrationId: plan.migrationId, sequence });
        await lock.anchor({ expected: live.state, admission: "open", fenceEpoch: live.state.fenceEpoch + 1,
          ownerGeneration: live.state.ownerGeneration + 1, activeMigrationId: null, planDigest: null,
          controlRootIdentity: { ...store.identity }, mutexIdentity: cancelMutex.identity, journalSequence: sequence, journal });
      });
      const opened = await cancelling.observe();
      assert.equal(opened.state.admission, "open"); assert.equal(opened.state.fenceEpoch, frozen.state.fenceEpoch + 1);
      assert.equal(opened.manifests.frozenBusinessManifestDigest, frozen.manifests.frozenBusinessManifestDigest);
      await cancelMutex.release();
      console.log(JSON.stringify({ proof: "owned-postgres-child-exit-and-real-restart", sourceBindingPreserved: true,
        oldMutexAndIdleAdapterRejected: true, samePlanAndRootReopened: true, actualDumpAndRestoreAfterRestart: true,
        freshFsyncOffRejected: true, nativeCancelReopenedNewEpoch: true, serviceResumeCancelCertified: false }));
    } finally { await Promise.all(adapters.map(adapter => adapter.close())); await cluster.close(); }
  });
