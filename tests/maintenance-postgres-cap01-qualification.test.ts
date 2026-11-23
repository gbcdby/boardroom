import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Client, QueryResultRow } from "pg";
import { PG_CATALOG_GUARD_SOURCE_DIGESTS, PG_CATALOG_GUARD_SQL } from "../src/server/storage/maintenance/postgres-catalog-guard/fixed-module.ts";
import { comparePgCatalogGuardModuleObservations, parsePgCatalogGuardModuleObservation } from "../src/server/storage/maintenance/postgres-catalog-guard/observation-values.ts";
import { h04Roles, openCatalogGuardTestCluster } from "./fixtures/postgres-catalog-guard-cluster.ts";
import { readFixtureCatalogGuardModule } from "./fixtures/postgres-catalog-guard-observation.ts";

const execute = promisify(execFile);
const toolsDirectory = process.env["AGENT_STUDIO_PG_RESTART_BIN"];
const appOwner = "cap01_app_owner";
const upgradedNamespace = "boardroom_catalog_guard_v2";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const pgEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG")));
const errorInfo = (error: unknown) => error instanceof Error
  ? { name: error.name, message: error.message } : { thrownType: typeof error };

type Cluster = Awaited<ReturnType<typeof openCatalogGuardTestCluster>>;
type Purpose = "source-control" | "verification-only";
type Gap = "crossClusterRestore" | "lifecycleCleanupUpgrade" | "serverEpochBinding" | "qualificationReceipt";
type Status = "PASS" | "FAIL" | "NOT_RUN";
type Observation = Awaited<ReturnType<typeof readFixtureCatalogGuardModule>>;

function text(row: QueryResultRow | undefined, key: string): string {
  assert.ok(row, `missing row field ${key}`);
  const value = row[key];
  assert.equal(typeof value, "string", `expected string field ${key}`);
  return value as string;
}

function number(row: QueryResultRow | undefined, key: string): number {
  assert.ok(row, `missing row field ${key}`);
  const value = row[key];
  assert.equal(typeof value, "number", `expected numeric field ${key}`);
  return value as number;
}

async function serverIdentity(client: Client) {
  const row = (await client.query(`SELECT
    current_setting('server_version_num') AS version,
    (pg_control_system()).system_identifier::text AS system_identifier,
    pg_postmaster_start_time()::text AS started,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    pg_is_in_recovery() AS recovery,
    current_setting('data_directory') AS directory`)).rows[0];
  assert.equal(text(row, "version"), "160015");
  assert.equal(row?.recovery, false, "fixture must be a real primary server, not recovery");
  return { version: text(row, "version"), systemIdentifier: text(row, "system_identifier"),
    started: text(row, "started"), databaseOid: text(row, "database_oid"), directory: text(row, "directory") };
}

function publicIdentity(identity: Awaited<ReturnType<typeof serverIdentity>>) {
  return { version: identity.version, systemIdentifier: identity.systemIdentifier,
    started: identity.started, databaseOid: identity.databaseOid,
    directoryStableAcrossReads: true, inRecovery: false };
}

async function installGuard(client: Client, purpose: Purpose): Promise<Observation> {
  const caller = purpose === "source-control" ? h04Roles.control : h04Roles.verification;
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
  try {
    await client.query(`CREATE SCHEMA "boardroom_catalog_guard_v1" AUTHORIZATION "${h04Roles.administrator}"`);
    await client.query('REVOKE ALL PRIVILEGES ON SCHEMA "boardroom_catalog_guard_v1" FROM PUBLIC');
    for (const key of ["acquire_share", "acquire_sre"] as const)
      await client.query(PG_CATALOG_GUARD_SQL[key].create);
    for (const key of ["acquire_share", "acquire_sre"])
      await client.query(`REVOKE ALL PRIVILEGES ON FUNCTION "boardroom_catalog_guard_v1"."${key}"() FROM PUBLIC`);
    await client.query(`GRANT USAGE ON SCHEMA "boardroom_catalog_guard_v1" TO "${caller}"`);
    await client.query(`GRANT EXECUTE ON FUNCTION "boardroom_catalog_guard_v1"."acquire_share"() TO "${caller}"`);
    if (purpose === "source-control")
      await client.query(`GRANT EXECUTE ON FUNCTION "boardroom_catalog_guard_v1"."acquire_sre"() TO "${caller}"`);
    const observed = await readFixtureCatalogGuardModule(client, purpose);
    assert.ok(parsePgCatalogGuardModuleObservation(JSON.stringify(observed)).ok,
      "real catalog readback must match the frozen module before fixture COMMIT");
    await client.query("COMMIT");
    return observed;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function createApplication(client: Client, populated: boolean) {
  await client.query(`CREATE SCHEMA "cap01_app" AUTHORIZATION "${appOwner}"`);
  await client.query(`CREATE TABLE "cap01_app"."records" (id integer PRIMARY KEY, label text NOT NULL)`);
  await client.query(`ALTER TABLE "cap01_app"."records" OWNER TO "${appOwner}"`);
  await client.query('CREATE SEQUENCE "cap01_app"."counter" AS bigint START WITH 100');
  await client.query(`ALTER SEQUENCE "cap01_app"."counter" OWNER TO "${appOwner}"`);
  await client.query(`GRANT USAGE ON SCHEMA "cap01_app" TO "${h04Roles.verification}"`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON "cap01_app"."records" TO "${h04Roles.verification}"`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON SEQUENCE "cap01_app"."counter" TO "${h04Roles.verification}"`);
  if (populated) await client.query(`INSERT INTO "cap01_app"."records" (id, label) VALUES
    (1, 'alpha'), (2, 'beta'), (3, 'gamma')`);
}

async function applicationFacts(client: Client) {
  const relations = (await client.query(`SELECT c.relname, c.oid::text AS oid, c.relowner::regrole::text AS owner,
    (SELECT json_agg(json_build_object('grantor', a.grantor::text, 'grantee', a.grantee::text,
       'privilege', a.privilege_type, 'grantable', a.is_grantable) ORDER BY a.grantor::text, a.grantee::text, a.privilege_type)
     FROM aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))) a) AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='cap01_app' AND c.relname IN ('records','counter') ORDER BY c.relname`)).rows;
  const records = (await client.query(`SELECT json_agg(json_build_object('id', id, 'label', label) ORDER BY id) AS rows
    FROM "cap01_app"."records"`)).rows[0];
  const schemaOid = text((await client.query(`SELECT oid::text FROM pg_namespace WHERE nspname='cap01_app'`)).rows[0], "oid");
  const counter = relations[0], recordsRelation = relations[1];
  assert.equal(counter?.relname, "counter");
  assert.equal(recordsRelation?.relname, "records");
  return { schemaOid, sequenceOid: text(counter, "oid"), tableOid: text(recordsRelation, "oid"),
    owner: text(recordsRelation, "owner"), aclDigest: digest(JSON.stringify(recordsRelation?.acl ?? null)),
    rows: (records?.rows ?? []) as readonly { id: number; label: string }[],
    rowsDigest: digest(JSON.stringify(records?.rows ?? [])) };
}

async function helperBody(client: Client, namespace: string) {
  const rows = (await client.query(`SELECT p.proname, p.prosrc AS body, p.oid::text AS oid,
    p.proowner::text AS owner_oid, p.pronamespace::text AS namespace_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=$1 ORDER BY p.proname COLLATE "C"`, [namespace])).rows;
  assert.equal(rows.length, 2);
  return rows;
}

async function createRoles(cluster: Cluster) {
  const admin = await cluster.connect();
  try {
    for (const name of [h04Roles.control, h04Roles.verification])
      await admin.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE ROLE "${appOwner}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    for (const database of ["h04_source", "h04_verification"])
      await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  } finally { await admin.end(); }
}

async function dumpAndRestoreApplication(directory: string, source: Cluster, target: Cluster) {
  const sourcePort = new URL(source.connectionString("h04_source")).port;
  const targetPort = new URL(target.connectionString("h04_verification")).port;
  const dumpFile = path.join(directory, "cap01-app.dump");
  const common = ["--host=127.0.0.1", "--username=" + h04Roles.administrator, "--no-password"];
  const dumped = await execute(path.join(toolsDirectory!, "pg_dump"),
    ["--format=custom", "--schema=cap01_app", "--file=" + dumpFile, "--port=" + sourcePort,
      "--dbname=h04_source", ...common], { env: pgEnvironment(), timeout: 30_000, maxBuffer: 64_000 });
  const restored = await execute(path.join(toolsDirectory!, "pg_restore"),
    ["--data-only", "--no-owner", "--no-acl", "--dbname=h04_verification", "--port=" + targetPort,
      ...common, dumpFile], { env: pgEnvironment(), timeout: 30_000, maxBuffer: 64_000 });
  return { dumpSha256: digest(await readFile(dumpFile)), childExits: { pgDump: 0, pgRestore: 0 },
    stderrBytes: { pgDump: Buffer.byteLength(dumped.stderr), pgRestore: Buffer.byteLength(restored.stderr) } };
}

test("CAP01 owned PG16.15 qualification gaps: cross-cluster restore, lifecycle, server epoch and receipt",
  { skip: toolsDirectory === undefined, timeout: 150_000 }, async t => {
    const statuses: Record<Gap, Status> = { crossClusterRestore: "NOT_RUN", lifecycleCleanupUpgrade: "NOT_RUN",
      serverEpochBinding: "NOT_RUN", qualificationReceipt: "NOT_RUN" };
    const details: Record<Gap, Record<string, unknown>> = { crossClusterRestore: {}, lifecycleCleanupUpgrade: {},
      serverEpochBinding: {}, qualificationReceipt: {} };
    const errors: Record<string, unknown>[] = [];
    const clients: Client[] = [];
    let source: Cluster | undefined, target: Cluster | undefined, directory: string | undefined;
    let toolDigests: Record<string, string> = {};
    const receiptPath = path.resolve(".agent-output/maintenance-pg-restart/cap01-qualification-receipt.json");
    const connect = async (cluster: Cluster, database: "postgres" | "h04_source" | "h04_verification",
      user: string = h04Roles.administrator) => {
      const client = await cluster.connect(database, user);
      clients.push(client);
      await client.query("SET statement_timeout='12s'");
      return client;
    };
    const run = async (gap: Gap, name: string, body: () => Promise<void>) => {
      statuses[gap] = "FAIL";
      await t.test(name, async () => {
        try { await body(); statuses[gap] = "PASS"; }
        catch (error) { statuses[gap] = "FAIL"; errors.push({ gap, ...errorInfo(error) }); throw error; }
      });
    };

    try {
      directory = await mkdtemp(path.join(tmpdir(), "br-cap01-qualification-"));
      source = await openCatalogGuardTestCluster(toolsDirectory!, "cap01-source");
      target = await openCatalogGuardTestCluster(toolsDirectory!, "cap01-target");
      await createRoles(source);
      await createRoles(target);
      for (const name of ["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore", "psql"])
        assert.match((await execute(path.join(toolsDirectory!, name), ["--version"],
          { env: pgEnvironment(), timeout: 10_000, maxBuffer: 32_000 })).stdout, /PostgreSQL\) 16\.15(?:\s|$)/);
      toolDigests = {};
      for (const name of ["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore", "psql"])
        toolDigests[name] = digest(await readFile(path.join(toolsDirectory!, name)));

      await run("crossClusterRestore", "CAP01-R2-1: two clusters, strict preset target, cross-cluster rejections and H04-order restore", async () => {
        assert.notEqual(source!.systemIdentifier, target!.systemIdentifier, "the two real clusters must have distinct system_identifier");
        const sourceAdmin = await connect(source!, "h04_source"), targetAdmin = await connect(target!, "h04_verification");
        const sourceObservation = await installGuard(sourceAdmin, "source-control");
        const targetObservation = await installGuard(targetAdmin, "verification-only");
        await createApplication(sourceAdmin, true);
        await createApplication(targetAdmin, false);
        assert.ok(parsePgCatalogGuardModuleObservation(JSON.stringify(sourceObservation)).ok);
        assert.ok(parsePgCatalogGuardModuleObservation(JSON.stringify(targetObservation)).ok);
        const compared = comparePgCatalogGuardModuleObservations(JSON.stringify({ source: sourceObservation, target: targetObservation }));
        assert.ok(compared.ok, "real two-cluster observation pair must be accepted");
        assert.deepEqual(compared.value.helperOids.map(row => row.sourceOid),
          sourceObservation.helpers.map(helper => helper.oid), "source OIDs must survive the comparison unchanged");

        await targetAdmin.query(`CREATE FUNCTION "boardroom_catalog_guard_v1"."cap01_unknown"() RETURNS void
          LANGUAGE sql AS $$ SELECT $$`);
        const withUnknown = await readFixtureCatalogGuardModule(targetAdmin, "verification-only");
        assert.equal(parsePgCatalogGuardModuleObservation(JSON.stringify(withUnknown)).ok, false,
          "an extra real namespace object must be rejected by the frozen value boundary");
        assert.equal(comparePgCatalogGuardModuleObservations(JSON.stringify({ source: sourceObservation, target: withUnknown })).ok, false);
        await targetAdmin.query('DROP FUNCTION "boardroom_catalog_guard_v1"."cap01_unknown"()');
        const sameCluster = JSON.parse(JSON.stringify(sourceObservation)) as Record<string, unknown>;
        sameCluster.purpose = "verification-only";
        assert.equal(comparePgCatalogGuardModuleObservations(JSON.stringify({ source: sourceObservation, target: sameCluster })).ok, false,
          "equal system_identifier must be rejected even with the right purpose mapping");
        const wrongPurpose = JSON.parse(JSON.stringify(targetObservation)) as Record<string, unknown>;
        wrongPurpose.purpose = "unknown";
        assert.equal(parsePgCatalogGuardModuleObservation(JSON.stringify(wrongPurpose)).ok, false);

        const sourceFactsBefore = await applicationFacts(sourceAdmin), targetFactsBefore = await applicationFacts(targetAdmin);
        assert.equal(sourceFactsBefore.rows.length, 3);
        assert.equal(targetFactsBefore.rows.length, 0);
        const transport = await dumpAndRestoreApplication(directory!, source!, target!);
        const sourceFactsAfter = await applicationFacts(sourceAdmin), targetFactsAfter = await applicationFacts(targetAdmin);
        assert.deepEqual(sourceFactsAfter, sourceFactsBefore, "source data, owner, ACL and OIDs must not be rewritten");
        assert.deepEqual(targetFactsAfter, { ...targetFactsBefore, rows: sourceFactsBefore.rows,
          rowsDigest: sourceFactsBefore.rowsDigest }, "strict preset target owner/ACL/OIDs stay; only application rows arrive");
        assert.deepEqual(sourceObservation, await readFixtureCatalogGuardModule(sourceAdmin, "source-control"),
          "source module OIDs and body bytes must remain byte-identical after cross-cluster restore");

        const idle = (await targetAdmin.query(`SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE backend_type='client backend' AND (application_name IS NULL OR application_name <> 'boardroom-owned-h04-component-fixture')`)).rows[0];
        assert.equal(text(idle, "n"), "0", "restore tool backends must have actually exited before H04 postcondition");

        const epochBefore = await serverIdentity(targetAdmin);
        const guard = await connect(target!, "h04_verification", h04Roles.verification);
        const admin = await connect(target!, "h04_verification");
        const writer = await connect(target!, "h04_verification", h04Roles.verification);
        let writerFinished = false;
        try {
          await guard.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
          const voidResult = await guard.query('SELECT "boardroom_catalog_guard_v1"."acquire_share"() AS guard');
          assert.deepEqual(voidResult.rows, [{ guard: "" }], "SHARE must be the first real query of the postcondition transaction");
          const guardPid = text((await guard.query("SELECT pg_backend_pid()::text AS pid")).rows[0], "pid");
          const lockRows = (await admin.query(`SELECT c.relname, c.oid::text AS oid, c.relisshared
            FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
            WHERE l.pid=$1 AND l.locktype='relation' AND l.granted AND l.mode='ShareLock'
              AND c.relnamespace='pg_catalog'::regnamespace ORDER BY c.relname COLLATE "C"`, [guardPid])).rows;
          assert.equal(lockRows.length, 64, "all 64 catalog relations must really be locked");
          assert.equal(lockRows.filter(row => row.relisshared).length, 11);
          assert.ok(number((await guard.query("SELECT count(*)::integer AS n FROM pg_catalog.pg_class")).rows[0], "n") > 0,
            "fresh catalog precheck must follow the shared lock");
          await guard.query('LOCK TABLE ONLY "cap01_app"."counter", ONLY "cap01_app"."records" IN ACCESS EXCLUSIVE MODE NOWAIT');

          const writerPid = text((await writer.query("SELECT pg_backend_pid()::text AS pid")).rows[0], "pid");
          await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
          const writerWork = (async () => {
            await writer.query('SELECT nextval(\'cap01_app."counter"\')');
            await writer.query('UPDATE "cap01_app"."records" SET label=label || \'-moved\' WHERE id=1');
          })().then(() => { writerFinished = true; });
          void writerWork.catch(() => undefined);
          await delay(300);
          assert.equal(writerFinished, false, "a real writer must remain blocked while the postcondition holds locks");
          const waiting = (await admin.query(`SELECT state, wait_event_type FROM pg_stat_activity WHERE pid=$1`, [writerPid])).rows[0];
          assert.equal(text(waiting, "state"), "active");
          assert.equal(text(waiting, "wait_event_type"), "Lock", "the writer must wait on a real lock, not an instantaneous sample");
          const epochDuring = await serverIdentity(admin);
          assert.deepEqual(epochDuring, epochBefore, "server identity must stay bound during writer exclusion");
          const complete = (await guard.query(`SELECT json_agg(json_build_object('id', id, 'label', label) ORDER BY id) AS rows
            FROM "cap01_app"."records"`)).rows[0];
          assert.equal(digest(JSON.stringify(complete?.rows ?? [])), sourceFactsBefore.rowsDigest,
            "fresh RC T_complete comparison must match the restored source rows");
          await guard.query("COMMIT");
          await writerWork;
          await writer.query("COMMIT");
          assert.equal(writerFinished, true);
          const epochAfter = await serverIdentity(admin);
          assert.deepEqual(epochAfter, epochBefore, "server identity must stay bound through commit and writer release");
          assert.equal(number((await admin.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
            WHERE pid=$1 AND wait_event_type='Lock'`, [writerPid])).rows[0], "n"), 0);

          details.crossClusterRestore = { scope: "fixture-scale owned PG16.15 data-only cross-cluster restore; production 72-table program NOT_RUN",
            sourceSystemIdentifier: source!.systemIdentifier,
            targetSystemIdentifier: target!.systemIdentifier, distinctClusters: true,
            applicationRows: { source: sourceFactsBefore.rows.length, targetBefore: 0, targetAfter: targetFactsAfter.rows.length },
            preservedOids: { source: sourceFactsBefore.tableOid, target: targetFactsBefore.tableOid },
            toolChildren: transport, guardLocks: lockRows.length, sharedCatalogLocks: 11,
            writerBlock: { pid: writerPid, waitEventType: "Lock", releasedAfterCommit: true },
            restoreBackendExited: true, h04Order: "SHARE first, catalog precheck, AX/sequence, T_complete, COMMIT" };
        } finally { await writer.end(); await guard.end(); }
      });

      await run("serverEpochBinding", "CAP01-R2-3: real server identity stays bound across a continuously blocked writer", async () => {
        const admin = await connect(target!, "h04_verification");
        const writer = await connect(target!, "h04_verification", h04Roles.verification);
        const before = await serverIdentity(admin);
        try {
          await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
          await admin.query('LOCK TABLE ONLY "cap01_app"."records" IN ACCESS EXCLUSIVE MODE NOWAIT');
          const writerPid = text((await writer.query("SELECT pg_backend_pid()::text AS pid")).rows[0], "pid");
          await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
          let finished = false;
          const work = writer.query('UPDATE "cap01_app"."records" SET label=label || \'-epoch\' WHERE id=1')
            .then(() => { finished = true; });
          void work.catch(() => undefined);
          await delay(250);
          assert.equal(finished, false, "the writer must still be blocked when the in-flight identity is read");
          const waiting = (await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [writerPid])).rows[0];
          assert.equal(text(waiting, "wait_event_type"), "Lock", "the writer must wait on a real lock");
          const during = await serverIdentity(admin);
          assert.deepEqual(during, before, "server identity must stay bound while the writer is blocked");
          await admin.query("COMMIT");
          await work;
          await writer.query("COMMIT");
          assert.equal(finished, true);
          const after = await serverIdentity(admin);
          assert.deepEqual(after, before, "server identity must stay bound after commit and writer release");
          details.serverEpochBinding = { scope: "owned PG16.15 native identity bound to the real cluster/database and stable across actual writer exclusion",
            source: "administrator/superuser fixture connection reads version, system_identifier, postmaster start, database OID and data_directory",
            before: publicIdentity(before), duringWriterExclusion: publicIdentity(during), after: publicIdentity(after),
            recovery: false, writerWaitEvent: "Lock", productionEpochRegistry: "NOT_RUN" };
        } finally {
          await admin.query("ROLLBACK").catch(() => undefined);
          await writer.query("ROLLBACK").catch(() => undefined);
        }
      });

      await run("lifecycleCleanupUpgrade", "CAP01-R2-2: cleanup and upgrade keep old bytes, application facts and prior receipt", async () => {
        const admin = await connect(source!, "h04_verification");
        await createApplication(admin, false);
        const priorObservation = await installGuard(admin, "verification-only");
        assert.ok(parsePgCatalogGuardModuleObservation(JSON.stringify(priorObservation)).ok);
        const priorReceipt = path.join(directory!, "cap01-prior-receipt.json");
        const receiptBytes = JSON.stringify({ kind: "cap01-fixture-prior-receipt", sequence: 1 }) + "\n";
        await writeFile(priorReceipt, receiptBytes, { mode: 0o600 });
        const priorReceiptDigest = digest(receiptBytes);
        const before = await applicationFacts(admin), oldHelpers = await helperBody(admin, "boardroom_catalog_guard_v1");

        const helperKeys = ["acquire_share", "acquire_sre"] as const;
        await admin.query(`CREATE SCHEMA "${upgradedNamespace}" AUTHORIZATION "${h04Roles.administrator}"`);
        await admin.query(`REVOKE ALL PRIVILEGES ON SCHEMA "${upgradedNamespace}" FROM PUBLIC`);
        for (const key of helperKeys)
          await admin.query(PG_CATALOG_GUARD_SQL[key].create.replaceAll('"boardroom_catalog_guard_v1"', '"' + upgradedNamespace + '"'));
        for (const key of helperKeys)
          await admin.query(`REVOKE ALL PRIVILEGES ON FUNCTION "${upgradedNamespace}"."${key}"() FROM PUBLIC`);
        await admin.query(`GRANT USAGE ON SCHEMA "${upgradedNamespace}" TO "${h04Roles.verification}"`);
        await admin.query(`GRANT EXECUTE ON FUNCTION "${upgradedNamespace}"."acquire_share"() TO "${h04Roles.verification}"`);
        const upgradedHelpers = await helperBody(admin, upgradedNamespace);
        assert.deepEqual(upgradedHelpers.map(row => row.body), helperKeys.map(key => PG_CATALOG_GUARD_SQL[key].body),
          "upgraded helper body bytes must equal the frozen source body");
        assert.deepEqual(oldHelpers, await helperBody(admin, "boardroom_catalog_guard_v1"),
          "upgrade must not overwrite old namespace bytes or OIDs");
        assert.deepEqual(await applicationFacts(admin), before, "upgrade must not change application owner, rows, ACL or OIDs");
        assert.equal(digest(await readFile(priorReceipt)), priorReceiptDigest);
        assert.ok(parsePgCatalogGuardModuleObservation(JSON.stringify(priorObservation)).ok,
          "the old observation must still parse after upgrade");

        const revoke = async (namespace: string) => {
          await admin.query(`REVOKE EXECUTE ON FUNCTION "${namespace}"."acquire_share"() FROM "${h04Roles.verification}"`);
          await admin.query(`REVOKE EXECUTE ON FUNCTION "${namespace}"."acquire_sre"() FROM "${h04Roles.verification}"`);
          await admin.query(`REVOKE USAGE ON SCHEMA "${namespace}" FROM "${h04Roles.verification}"`);
          const caller = await connect(source!, "h04_verification", h04Roles.verification);
          try {
            await assert.rejects(caller.query(`SELECT "${namespace}"."acquire_share"()`),
              (error: unknown) => ["42501", "42883"].includes((error as { code?: string }).code ?? ""));
          } finally { await caller.end(); }
          for (const key of ["acquire_share", "acquire_sre"])
            await admin.query(`DROP FUNCTION "${namespace}"."${key}"()`);
          await admin.query(`DROP SCHEMA "${namespace}" RESTRICT`);
          assert.equal(number((await admin.query(`SELECT count(*)::integer AS n FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1`, [namespace])).rows[0], "n"), 0);
          assert.equal(number((await admin.query(`SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname=$1`,
            [namespace])).rows[0], "n"), 0);
          assert.equal(number((await admin.query(`SELECT count(*)::integer AS n FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND EXISTS (
              SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              WHERE a.privilege_type='EXECUTE' AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$2))`, [namespace, h04Roles.verification])).rows[0], "n"), 0);
        };
        await revoke("boardroom_catalog_guard_v1");
        assert.deepEqual(await helperBody(admin, upgradedNamespace), upgradedHelpers,
          "cleanup of the old namespace must not change upgraded helper bytes");
        await revoke(upgradedNamespace);
        assert.deepEqual(await applicationFacts(admin), before);
        assert.equal(digest(await readFile(priorReceipt)), priorReceiptDigest);
        assert.ok(parsePgCatalogGuardModuleObservation(JSON.stringify(priorObservation)).ok,
          "the old observation remains parseable after full cleanup");
        details.lifecycleCleanupUpgrade = { scope: "fixture-owned v1/v2 namespaces with frozen helper body bytes; production installer NOT_RUN",
          upgradedNamespace, upgradedBodyMatchesFrozenBytes: true,
          oldNamespaceBytesUnchanged: true, oldObservationStillParses: true,
          executeAfterRevoke: "rejected (42501/42883)", namespaceAndAclResidue: 0,
          applicationOwnerRowsAclOidsUnchanged: true, priorReceiptDigestUnchanged: true };
      });

    } catch (error) {
      errors.push({ gap: "setup", ...errorInfo(error) });
    } finally {
      for (const client of clients.reverse()) await client.end().catch(() => undefined);
      if (target) await target.close().catch(error => errors.push({ gap: "target-close", ...errorInfo(error) }));
      if (source) await source.close().catch(error => errors.push({ gap: "source-close", ...errorInfo(error) }));
      const tempPath = receiptPath + ".tmp";
      const buildReceipt = () => {
        const receipt = {
          scope: "CAP01 owned PG16.15 fixture gap coverage; not the production registry or a signed qualification",
          status: errors.length || Object.values(statuses).some(status => status !== "PASS") ? "FAIL" : "PASS",
          serverVersionNum: "160015",
          serverEpochQualification: statuses.serverEpochBinding,
          fullRestoreR2: statuses.crossClusterRestore,
          lifecycleCleanupUpgrade: statuses.lifecycleCleanupUpgrade,
          completeCap01PdO04: "NOT_RUN",
          productionRegistry: "UNCHANGED_EMPTY",
          qualificationSigned: false,
          items: statuses, details,
          fixedSourceDigests: PG_CATALOG_GUARD_SOURCE_DIGESTS,
          toolDigests,
          candidate: /^[0-9a-f]{40}$/.test(process.env["GITHUB_SHA"] ?? "") ? process.env["GITHUB_SHA"] : null,
          credentialFieldsWritten: false,
          errors,
        };
        details.qualificationReceipt = { toolDigests, receiptSha256: "" };
        details.qualificationReceipt.receiptSha256 = digest(JSON.stringify(receipt));
        return receipt;
      };
      try {
        await mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
        const draft = buildReceipt();
        await writeFile(tempPath, JSON.stringify(draft, null, 2) + "\n", { mode: 0o600 });
        assert.deepEqual(JSON.parse(await readFile(tempPath, "utf8")), draft,
          "receipt draft must round-trip through JSON before the item can pass");
        const gapsPassed = Object.entries(statuses).every(([gap, status]) =>
          gap === "qualificationReceipt" || status === "PASS");
        statuses.qualificationReceipt = gapsPassed && errors.length === 0 ? "PASS" : "FAIL";
        const finalReceipt = buildReceipt();
        await writeFile(tempPath, JSON.stringify(finalReceipt, null, 2) + "\n", { mode: 0o600 });
        assert.deepEqual(JSON.parse(await readFile(tempPath, "utf8")), finalReceipt,
          "final receipt must round-trip through JSON before publication");
        await rename(tempPath, receiptPath);
      } catch (error) {
        errors.push({ gap: "receipt-write", ...errorInfo(error) });
        statuses.qualificationReceipt = "FAIL";
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
      const receipt = buildReceipt();
      const finalStatus = errors.length ? "FAIL" : receipt.status;
      t.diagnostic(JSON.stringify({ scope: receipt.scope, status: finalStatus,
        items: statuses, serverVersionNum: receipt.serverVersionNum, qualificationSigned: false,
        completeCap01PdO04: "NOT_RUN", productionRegistry: "UNCHANGED_EMPTY", errors: errors.length }));
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if (errors.length) throw new AggregateError(errors, "CAP01 qualification gap fixture failed");
    }
  });
