import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { extendPostgresStorageGuards } from "../src/server/storage/schema-guards.ts";
import { maintenanceHostIdentityDigest } from "../src/server/storage/maintenance/host.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import { encodePostgresCell } from "../src/server/storage/maintenance/postgres-manifests.ts";
import { buildDatabaseManifests, digestRowMultiset } from "../src/server/storage/maintenance/manifests.ts";
import { parsePostgresConnection, postgresDatabaseArgument, runPostgresTool, waitForPostgresTools } from "../src/server/storage/maintenance/postgres-tools.ts";
import type { PostgresDescriptor } from "../src/server/storage/maintenance/postgres-tools.ts";
import type { ControlRootIdentity, Json, MaintenanceAdapter, OperationMutex } from "../src/server/storage/maintenance/types.ts";

test("#152 PG typed cells preserve int8/numeric precision, NULL, binary and duplicate rows", () => {
  const integer = encodePostgresCell("20", "9223372036854775807");
  const numeric = encodePostgresCell("1700", "9007199254740993.000000000000000001");
  assert.deepEqual(integer, ["pg:20", "9223372036854775807"]);
  assert.deepEqual(numeric, ["pg:1700", "9007199254740993.000000000000000001"]);
  assert.notDeepEqual(encodePostgresCell("25", null), encodePostgresCell("25", "null"));
  assert.notDeepEqual(encodePostgresCell("17", "\\x0000ff"), encodePostgresCell("25", "\\x0000ff"));
  assert.equal(digestRowMultiset([integer, numeric]).digest, digestRowMultiset([numeric, integer]).digest);
  assert.notEqual(digestRowMultiset([integer]).digest, digestRowMultiset([integer, integer]).digest);
  assert.throws(() => encodePostgresCell("999999", "anything"), /schema_guard_incomplete/);
});

test("#152 PG source is explicit and connection fingerprints omit passwords", () => {
  const first = parsePostgresConnection({ kind: "postgres", connectionString: "postgres://owner:s3cret@127.0.0.1:5432/app", schema: "scope" });
  const second = parsePostgresConnection({ kind: "postgres", connectionString: "postgres://owner:different@127.0.0.1:5432/app", schema: "scope" });
  assert.equal(first.descriptorDigest, second.descriptorDigest);
  assert.equal(first.clientConfig.host, "127.0.0.1");
  assert.equal(first.clientConfig.database, "app");
  assert.equal(first.childEnvironment.PGPASSWORD, "s3cret");
  assert.throws(() => parsePostgresConnection({ kind: "postgres", connectionString: "postgres:///" }), /source_missing/);
  assert.throws(() => parsePostgresConnection({ kind: "postgres", connectionString: "postgres://owner:secret@localhost/app?options=-c%20search_path=elsewhere" }), /backup_capability_unavailable/);
});

test("#152 native process errors redact stderr/credentials and pass database names without a credential DSN", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boardroom-pg-tool-contract-"));
  const controller = new AbortController();
  try {
    const connection = parsePostgresConnection({ kind: "postgres", connectionString: "postgres://owner:secret-canary@localhost/app" });
    const argumentsFile = join(directory, "arguments.json");
    const environment = { ...connection.childEnvironment, PATH: directory, BOARDROOM_TEST_ARGUMENTS: argumentsFile };
    await assert.rejects(runPostgresTool("pg_dump", ["--version"], environment, { failure: "backup_capability_unavailable", signal: controller.signal }), /backup_capability_unavailable/);
    await writeFile(join(directory, "pg_restore"), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.BOARDROOM_TEST_ARGUMENTS,JSON.stringify(process.argv.slice(2)),{mode:0o600});\nprocess.stderr.write(process.env.PGPASSWORD);\nprocess.exit(9);\n`, { mode: 0o700 });
    const args = [postgresDatabaseArgument("app"), "--single-transaction", "--exit-on-error", "--no-password"];
    await assert.rejects(runPostgresTool("pg_restore", args, environment, { failure: "restore_verification_unavailable", signal: controller.signal }),
      (error: unknown) => /restore_verification_unavailable/.test(String(error)) && !/secret-canary|owner|postgres:\/\//.test(String(error)));
    assert.deepEqual(JSON.parse(await readFile(argumentsFile, "utf8")), args);
    assert.ok(!args.some(arg => /secret-canary|owner|postgres:\/\//.test(arg)));
    await waitForPostgresTools(controller.signal);
  } finally { controller.abort(); await waitForPostgresTools(controller.signal); await rm(directory, { recursive: true, force: true }); }
});

const testUrl = process.env["AGENT_STUDIO_PG_TEST_URL"];
const pgTest = testUrl ? test : test.skip;
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
interface Fixture {
  readonly source: PostgresDescriptor;
  readonly target: PostgresDescriptor;
  readonly directory: string;
  readonly root: ControlRootIdentity;
  readonly role: string;
  readonly admin: Client;
  connectSource(): Promise<Client>;
  connectTarget(): Promise<Client>;
  close(): Promise<void>;
}
async function connectDescriptor(descriptor: PostgresDescriptor): Promise<Client> {
  const parsed = parsePostgresConnection(descriptor);
  const client = new Client(parsed.clientConfig); client.on("error", () => {}); await client.connect();
  await client.query(`SET search_path TO ${quoted(parsed.schema)},pg_catalog`);
  return client;
}
async function fixture(seed = true): Promise<Fixture> {
  if (!testUrl) throw new Error("PG fixture requires explicit AGENT_STUDIO_PG_TEST_URL");
  const id = randomUUID().replaceAll("-", ""), sourceName = `br_m152_src_${id}`, targetName = `br_m152_ver_${id}`;
  const role = `br_m152_owner_${id}`;
  const descriptor = (name: string): PostgresDescriptor => {
    const url = new URL(testUrl); url.pathname = `/${name}`;
    return { kind: "postgres", connectionString: url.toString(), schema: "app" };
  };
  const source = descriptor(sourceName), target = descriptor(targetName);
  const directory = await mkdtemp(join(tmpdir(), "boardroom-pg-maintenance-")); await chmod(directory, 0o700);
  const info = await lstat(directory, { bigint: true });
  const root = { path: directory, device: info.dev.toString(), inode: info.ino.toString(), hostIdentityDigest: await maintenanceHostIdentityDigest() };
  const admin = new Client({ connectionString: testUrl }); admin.on("error", () => {}); await admin.connect();
  const created: string[] = [];
  let roleCreated = false;
  const cleanup = async () => {
    for (const name of created.reverse()) await admin.query(`DROP DATABASE ${quoted(name)}`);
    if (roleCreated) await admin.query(`DROP ROLE ${quoted(role)}`);
    await admin.end(); await rm(directory, { recursive: true, force: true });
  };
  try {
    await admin.query(`CREATE DATABASE ${quoted(sourceName)} TEMPLATE template0`); created.push(sourceName);
    await admin.query(`CREATE DATABASE ${quoted(targetName)} TEMPLATE template0`); created.push(targetName);
    await admin.query(`CREATE ROLE ${quoted(role)} NOLOGIN`); roleCreated = true;
    const driver = new PostgresDriver({ connectionString: source.connectionString, schema: source.schema! });
    try { await driver.connect(); await driver.migrate(migrations); } finally { await driver.close(); }
    if (seed) {
      const client = await connectDescriptor(source);
      try {
        await client.query(`BEGIN;
          CREATE TABLE typed_values(i BIGINT,n NUMERIC,t TEXT,b BYTEA,flag BOOLEAN,j JSONB,stamp TIMESTAMPTZ,f DOUBLE PRECISION);
          INSERT INTO typed_values VALUES(9223372036854775807,9007199254740993.000000000000000001,'汉字\\nnull',decode('0000ff','hex'),true,'{"n":9007199254740993}','2026-11-12 08:09:10.123456+00','NaN');
          INSERT INTO typed_values SELECT * FROM typed_values;
          INSERT INTO typed_values VALUES(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
          INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','PG restore fixture','t','t');
          INSERT INTO agents(id,display_name,host_type,created_at,updated_at) VALUES('a','Agent','codex','t','t');
          INSERT INTO members(id,project_id,agent_id,kind,display_name,created_at,updated_at) VALUES('m','p','a','agent','Member','t','t');
          INSERT INTO groups(id,project_id,name,created_at,updated_at) VALUES('g','p','Group','t','t');
          INSERT INTO role_templates(id,revision,created_at,updated_at) VALUES('role',2,'t','t');
          INSERT INTO role_template_versions(role_template_id,revision,name,purpose,instructions,recommended_skill_refs_json,created_at)
            VALUES('role',1,'Role v1','purpose','old instructions','[]','t'),('role',2,'Role v2','purpose','current instructions','[]','t');
          INSERT INTO agent_legacy_aliases(display_name,host_type,agent_id,created_at) VALUES('Legacy','codex','a','t');
          INSERT INTO tasks(id,project_id,title,body,labels,state,revision,author,created_at,updated_at,delivery_kind,acceptance_text)
            VALUES('task','p','Task','immutable body','[]','todo',7,'fixture','t','t','artifact','typed exact restore');
          INSERT INTO memory_documents(id,scope,agent_id,version,markdown,byte_length,updated_at,updated_by,source)
            VALUES('memory','global','a',1,'memory body',11,'t','fixture','human');
          INSERT INTO memory_versions(id,document_id,version,parent_version,markdown,byte_length,content_sha256,author,actor_id,source,client_mutation_id,created_at)
            VALUES('mv','memory',1,0,'memory body',11,'${"a".repeat(64)}','fixture','fixture','human','mutation','t');
          INSERT INTO agent_runtimes(id,agent_id,defaults_json,created_at,updated_at) VALUES('runtime','a','{"model":"fixture"}','t','t');
          INSERT INTO agent_runtime_bindings(id,runtime_id,project_id,group_id,member_id,desired_state,intent_revision,requested_snapshot_json,created_at,updated_at)
            VALUES('binding','runtime','p','g','m','running',9,'{"version":7,"requested":"exact"}','t','t');
          INSERT INTO agent_runner_states(binding_id,state,generation,applied_json,harness_session_id,session_key,session_state,updated_at)
            VALUES('binding','stopped',3,'{"applied":"earlier"}','fixture-native-sid','fixture-session-key','resumable','t');
          INSERT INTO policy_documents(scope_key,scope,revision,created_at,updated_at) VALUES('user','user',1,'t','t');
          INSERT INTO policy_document_versions(document_id,revision,schema_version,document_json,content_digest,default_revision,created_by_kind,created_by_id,created_at)
            VALUES('user',1,1,'{"version":1}','${"b".repeat(64)}',1,'human','fixture','t');
          INSERT INTO audit_log(id,scope,actor_kind,actor_name,action,target_kind,target_id,target_name,created_at)
            VALUES('audit','user','human','fixture','restore-fixture','policy_document','user','User policy','t');
          INSERT INTO storage_source_clients(client_id,database_instance_id,entrypoint,build_id,protocol_version,host_identity_json,process_identity_json,db_sessions_json,
            registered_epoch,observed_epoch,registered_at,last_observed_at,ended_at)
            SELECT 'fixture-finished',database_instance_id,'local-management','fixture',1,'{}','{}','{}',0,0,'t','t','t' FROM storage_maintenance;
          ALTER TABLE projects OWNER TO ${quoted(role)};
          GRANT SELECT ON members TO ${quoted(role)};
          COMMENT ON TABLE projects IS 'ownership and ACL restoration fixture';`);
        await extendPostgresStorageGuards(client); await client.query("COMMIT");
      } finally { await client.end(); }
    }
    return { source, target, directory, root, role, admin,
      connectSource: () => connectDescriptor(source), connectTarget: () => connectDescriptor(target), close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}
async function acquire(adapter: MaintenanceAdapter, f: Fixture): Promise<OperationMutex> {
  return adapter.acquireMutex(f.root, (await adapter.observe()).state);
}
async function seal(adapter: MaintenanceAdapter, f: Fixture, mutex: OperationMutex): Promise<void> {
  // Fixture-only anchors test the native CAS primitive; D owns real durable journal publication.
  for (const admission of ["draining", "sealed"] as const) await adapter.withSourceLock("control", async lock => {
    const before = await lock.observe();
    await lock.anchor({ expected: before.state, admission,
      fenceEpoch: before.state.fenceEpoch + (admission === "draining" ? 1 : 0),
      ownerGeneration: before.state.ownerGeneration + (admission === "draining" ? 1 : 0),
      activeMigrationId: "fixture-migration", planDigest: "c".repeat(64), controlRootIdentity: { ...f.root },
      mutexIdentity: mutex.identity, journalSequence: admission === "draining" ? 1 : before.state.journalSequence + 1,
      journal: { ref: `fixture-${admission}`, sha256: (admission === "draining" ? "d" : "e").repeat(64), bytes: "1" } });
  });
}

pgTest("#152 PG16 real nonempty native dump/restore preserves catalog, owner/ACL, controls, typed values and migration identity sequence", async () => {
  const f = await fixture(), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  try {
    const mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
    const evidence = await adapter.withSourceLock("snapshot", async lock => {
      const backup = await lock.backup(join(f.directory, "snapshot.dump"));
      assert.equal(backup.manifests.tables.find(table => table.name === "typed_values")?.count, "3");
      for (const name of ["agent_legacy_aliases", "audit_log", "tasks", "memory_versions", "agent_runtime_bindings", "policy_document_versions"])
        assert.notEqual(backup.manifests.tables.find(table => table.name === name)?.count, "0");
      assert.equal(backup.manifests.controlRows.storage_source_clients.length, 1);
      const result = await adapter.verifyDatabase(join(f.directory, "snapshot.dump"), backup.manifests, f.directory);
      return { backup, result };
    });
    assert.equal((evidence.result as { exactFullDataAndControlMatched: boolean }).exactFullDataAndControlMatched, true);
    assert.equal((await readFile(join(f.directory, "snapshot.dump"))).subarray(0, 5).toString(), "PGDMP");
    const restored = await f.connectTarget();
    try {
      const values = (await restored.query("SELECT i::text,n::text,encode(b,'hex') AS bytes,stamp::text FROM typed_values WHERE i IS NOT NULL")).rows;
      assert.equal(values.length, 2); assert.equal(values[0].i, "9223372036854775807");
      assert.equal(values[0].n, "9007199254740993.000000000000000001"); assert.equal(values[0].bytes, "0000ff");
      assert.equal((await restored.query("SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='projects'::regclass")).rows[0].owner, f.role);
      assert.equal((await restored.query("SELECT has_table_privilege($1,'members','SELECT') AS granted", [f.role])).rows[0].granted, true);
      assert.equal((await restored.query("SELECT admission FROM storage_maintenance")).rows[0].admission, "sealed");
      assert.equal((await restored.query("SELECT harness_session_id FROM agent_runner_states")).rows[0].harness_session_id, "fixture-native-sid");
      await assert.rejects(restored.query("UPDATE projects SET name='forbidden'"), /BOARDROOM_STORAGE_MAINTENANCE/);
    } finally { await restored.end(); }
    await mutex.release();
  } finally { await adapter.close(); await f.close(); }
});

pgTest("#152 PG actual-source advisory mutex excludes aliases and leaves an independent source available", async () => {
  const f = await fixture(false), other = await fixture(false);
  const aliasUrl = new URL(f.source.connectionString); aliasUrl.protocol = aliasUrl.protocol === "postgres:" ? "postgresql:" : "postgres:";
  const alias = { ...f.source, connectionString: aliasUrl.toString() };
  assert.notEqual(alias.connectionString, f.source.connectionString);
  const one = await createPostgresMaintenanceAdapter(f.source, f.target), two = await createPostgresMaintenanceAdapter(alias, f.target);
  const independent = await createPostgresMaintenanceAdapter(other.source, other.target);
  try {
    const first = await acquire(one, f);
    await assert.rejects(acquire(two, f), /maintenance_busy/);
    const third = await acquire(independent, other); await third.assertHeld(); await first.assertHeld();
    await third.release(); await first.release();
    const replacement = await acquire(two, f); await replacement.assertHeld(); await replacement.release();
  } finally { await Promise.all([one.close(), two.close(), independent.close()]); await f.close(); await other.close(); }
});

pgTest("#152 PG physical locks reject an in-flight writer; unknown idle backend is still a blocker", async () => {
  const f = await fixture(), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  let writer: Client | undefined;
  try {
    const mutex = await acquire(adapter, f); writer = await f.connectSource();
    await writer.query("BEGIN; UPDATE projects SET name='completed writer' WHERE id='p'");
    await assert.rejects(adapter.withSourceLock("control", async () => {}), /maintenance_busy/);
    await writer.query("COMMIT");
    assert.equal((await adapter.inspectWriters(await adapter.observe()))[0]?.code, "source_writer_unknown");
    await adapter.withSourceLock("control", async lock => {
      await lock.assertHeld(); await writer!.query("SET lock_timeout='25ms'");
      await assert.rejects(writer!.query("UPDATE projects SET name='blocked' WHERE id='p'"), (error: unknown) => (error as { code?: string }).code === "55P03");
    });
    await writer.end(); writer = undefined;
    assert.deepEqual(await adapter.inspectWriters(await adapter.observe()), []);
    await mutex.release();
  } finally { await writer?.end(); await adapter.close(); await f.close(); }
});

pgTest("#152 PG scope rejects extra sequence, cross-schema FK, extension, RLS and unknown type without silently excluding them", async () => {
  const f = await fixture(false);
  try {
    for (const [setup, teardown] of [
      ["CREATE SEQUENCE extra_sequence", "DROP SEQUENCE extra_sequence"],
      ["CREATE SCHEMA outside; CREATE TABLE outside.parent(id TEXT PRIMARY KEY); ALTER TABLE projects ADD CONSTRAINT cross_scope FOREIGN KEY(id) REFERENCES outside.parent(id)", "ALTER TABLE projects DROP CONSTRAINT cross_scope; DROP SCHEMA outside CASCADE"],
      ["CREATE EXTENSION hstore", "DROP EXTENSION hstore"],
      ["ALTER TABLE projects ENABLE ROW LEVEL SECURITY", "ALTER TABLE projects DISABLE ROW LEVEL SECURITY"],
      ["ALTER TABLE projects ADD COLUMN unsupported integer[]", "ALTER TABLE projects DROP COLUMN unsupported"],
    ]) {
      const client = await f.connectSource();
      try { await client.query(setup!); } finally { await client.end(); }
      const adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
      try { await assert.rejects(adapter.observe(), /schema_guard_incomplete/); }
      finally { await adapter.close(); }
      const cleanup = await f.connectSource();
      try { await cleanup.query(teardown!); } finally { await cleanup.end(); }
    }
  } finally { await f.close(); }
});

pgTest("#152 PG restore refuses source/occupied target, missing declared owner role and corrupt dump; never clears a target", async () => {
  const f = await fixture(), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  try {
    const mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
    await adapter.withSourceLock("snapshot", async lock => {
      const file = join(f.directory, "snapshot.dump"), backup = await lock.backup(file);
      const schema = backup.manifests.schema as Record<string, Json>;
      const roles = schema.requiredRoles as readonly Json[];
      const missingRole = { ...(roles[0] as Record<string, Json>), name: `missing_${randomUUID().replaceAll("-", "")}` };
      const absent = buildDatabaseManifests("postgres", { ...schema, requiredRoles: [...roles, missingRole] }, backup.manifests.tables, backup.manifests.controlRows);
      await assert.rejects(adapter.verifyDatabase(file, absent, f.directory), /restore_verification_unavailable/);
      const bad = join(f.directory, "corrupt.dump"); await writeFile(bad, "PGDMPinvalid archive", { flag: "wx", mode: 0o600 });
      await assert.rejects(adapter.verifyDatabase(bad, backup.manifests, f.directory), /restore_verification_unavailable/);
      const target = await f.connectTarget();
      try { await target.query("CREATE TABLE public.keep_me(value text); INSERT INTO public.keep_me VALUES('user supplied target content')"); }
      finally { await target.end(); }
      await assert.rejects(adapter.verifyDatabase(file, backup.manifests, f.directory), /restore_verification_unavailable/);
      const check = await f.connectTarget();
      try { assert.equal((await check.query("SELECT value FROM public.keep_me")).rows[0].value, "user supplied target content"); }
      finally { await check.end(); }
    });
    await mutex.release(); await adapter.close();
    const self = await createPostgresMaintenanceAdapter(f.source, f.source);
    try {
      const selfMutex = await acquire(self, f);
      await self.withSourceLock("snapshot", async lock => {
        const expected = (await lock.observe()).manifests;
        await assert.rejects(self.verifyDatabase(join(f.directory, "snapshot.dump"), expected, f.directory), /restore_verification_unavailable/);
      });
      await selfMutex.release();
    } finally { await self.close(); }
  } finally { await adapter.close(); await f.close(); }
});

async function locateTool(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const path = resolve(directory, name);
    try { await access(path, constants.X_OK); return path; } catch { /* Keep the explicitly configured PATH order. */ }
  }
  throw new Error("CI requires PostgreSQL 16 native tools");
}
async function wrappedAdapter(f: Fixture, script: string): Promise<MaintenanceAdapter> {
  const directory = join(f.directory, `tools-${randomUUID()}`); await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "pg_dump"), script, { mode: 0o700 });
  await writeFile(join(directory, "pg_restore"), "#!/bin/sh\nprintf 'pg_restore (PostgreSQL) 16.0\\n'\n", { mode: 0o700 });
  const oldPath = process.env.PATH;
  try { process.env.PATH = directory; return await createPostgresMaintenanceAdapter(f.source, f.target); }
  finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
}

pgTest("#152 PG missing/failed native dump stays sealed and never leaks tool stderr", async () => {
  const f = await fixture(false);
  let adapter: MaintenanceAdapter | undefined;
  try {
    const oldPath = process.env.PATH;
    try { process.env.PATH = f.directory; adapter = await createPostgresMaintenanceAdapter(f.source, f.target); }
    finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
    let mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
    await assert.rejects(adapter.withSourceLock("snapshot", lock => lock.backup(join(f.directory, "missing.dump"))), /backup_capability_unavailable/);
    assert.equal((await adapter.observe()).state.admission, "sealed");
    await mutex.release(); await adapter.close();
    adapter = await wrappedAdapter(f, "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'pg_dump (PostgreSQL) 16.0\\n'; exit 0; fi\nprintf 'secret-test-canary postgres://user:password@fixture' >&2\nexit 1\n");
    mutex = await acquire(adapter, f);
    await assert.rejects(adapter.withSourceLock("snapshot", lock => lock.backup(join(f.directory, "failed.dump"))),
      (error: unknown) => /backup_capability_unavailable/.test(String(error)) && !/secret-test-canary|password|postgres:\/\//.test(String(error)));
    assert.equal((await adapter.observe()).state.admission, "sealed"); await mutex.release();
  } finally { await adapter?.close(); await f.close(); }
});

pgTest("#152 PG exporter loss cancels its dump and sequence drift invalidates an attempted snapshot", async () => {
  const realDump = await locateTool("pg_dump");
  for (const scenario of ["sequence", "exporter"] as const) {
    const f = await fixture(false);
    const beforeReal = process.env.BOARDROOM_TEST_REAL_DUMP, beforeStarted = process.env.BOARDROOM_TEST_DUMP_STARTED;
    const started = join(f.directory, "dump-started");
    process.env.BOARDROOM_TEST_REAL_DUMP = realDump; process.env.BOARDROOM_TEST_DUMP_STARTED = started;
    let adapter: MaintenanceAdapter;
    try { adapter = await wrappedAdapter(f, "#!/bin/sh\nif [ \"$1\" = --version ]; then exec \"$BOARDROOM_TEST_REAL_DUMP\" \"$@\"; fi\n: > \"$BOARDROOM_TEST_DUMP_STARTED\"\n/bin/sleep 1\nexec \"$BOARDROOM_TEST_REAL_DUMP\" \"$@\"\n"); }
    finally {
      if (beforeReal === undefined) delete process.env.BOARDROOM_TEST_REAL_DUMP; else process.env.BOARDROOM_TEST_REAL_DUMP = beforeReal;
      if (beforeStarted === undefined) delete process.env.BOARDROOM_TEST_DUMP_STARTED; else process.env.BOARDROOM_TEST_DUMP_STARTED = beforeStarted;
    }
    try {
      const mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
      await assert.rejects(adapter.withSourceLock("snapshot", async lock => {
        const backup = lock.backup(join(f.directory, "interrupted.dump")).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        // The private tool-start marker is after capture/export, making fault injection deterministic.
        let observedStart = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          try { await access(started); observedStart = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
        }
        assert.equal(observedStart, true, "native dump must reach its process boundary before injecting a fault");
        const mutator = await f.connectSource();
        try {
          if (scenario === "sequence") await mutator.query("SELECT nextval(pg_get_serial_sequence('schema_migrations','version'))");
          else {
            const exporter = (await mutator.query(`SELECT a.pid FROM pg_stat_activity a
              WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND a.pid<>pg_backend_pid()
              AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.mode='ShareLock' AND l.relation='projects'::regclass AND l.granted)`)).rows;
            assert.equal(exporter.length, 1);
            assert.equal((await mutator.query("SELECT pg_terminate_backend($1,5000) AS stopped", [exporter[0].pid])).rows[0].stopped, true);
          }
        } finally { await mutator.end(); }
        const outcome = await backup;
        if (outcome.error) throw outcome.error;
      }), scenario === "sequence" ? /source_changed/ : /maintenance_lost/);
      const check = await f.connectSource();
      try { assert.equal((await check.query("SELECT admission FROM storage_maintenance")).rows[0].admission, "sealed"); }
      finally { await check.end(); }
      if (scenario === "sequence") await mutex.release();
    } finally { await adapter.close(); await f.close(); }
  }
});
