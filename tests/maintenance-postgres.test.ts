import test, { after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { auditPublicArchiveToc, readPublicRestoreCatalogBinding } from "../src/server/storage/maintenance/postgres-public-toc.ts";
import type { PostgresDatabaseIdentity } from "../src/server/storage/maintenance/postgres-identity.ts";
import type { PostgresDescriptor } from "../src/server/storage/maintenance/postgres-tools.ts";
import type { ControlRootIdentity, Json, MaintenanceAdapter, OperationMutex } from "../src/server/storage/maintenance/types.ts";
import { closePostgresWriterObservations, observePostgresWriters } from "./fixtures/maintenance-postgres-writer-observation.ts";

after(closePostgresWriterObservations);

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
  readonly observation: ReturnType<typeof observePostgresWriters>;
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
async function fixture(t: TestContext, caseId: string, seed = true, schema = "app", options: {
  readonly scenario?: string;
  readonly recreatePublic?: boolean; readonly unprivileged?: boolean; readonly databaseNameWithSpaces?: boolean; readonly specialRoleName?: boolean;
} = {}): Promise<Fixture> {
  if (!testUrl) throw new Error("PG fixture requires explicit AGENT_STUDIO_PG_TEST_URL");
  const id = randomUUID().replaceAll("-", ""), sourceName = `br_m152${options.databaseNameWithSpaces ? " source " : "_src_"}${id}`, targetName = `br_m152_ver_${id}`;
  const role = options.specialRoleName ? `br owner "semi;\n${id}` : `br_m152_owner_${id}`;
  const password = randomUUID();
  const descriptor = (name: string): PostgresDescriptor => {
    const url = new URL(testUrl); url.pathname = `/${name}`;
    if (options.unprivileged) { url.username = role; url.password = password; }
    return { kind: "postgres", connectionString: url.toString(), schema };
  };
  const source = descriptor(sourceName), target = descriptor(targetName);
  let observationDigest = "";
  try { observationDigest = parsePostgresConnection(source).descriptorDigest; }
  catch { /* An unavailable diagnostic scope must not change original setup. */ }
  const observation = observePostgresWriters({ caseId, scenario: options.scenario ?? "main",
    sourceDescriptorDigest: observationDigest });
  // This hook only closes diagnostic resources if original setup/cleanup exits
  // early. It never cleans business fixtures or replaces their original error.
  try { t.after(() => observation.close("test-hook")); } catch { observation.close("test-hook"); }
  observation.mark("fixture-start");
  try {
  const directory = await mkdtemp(join(tmpdir(), "boardroom-pg-maintenance-")); await chmod(directory, 0o700);
  const info = await lstat(directory, { bigint: true });
  const root = { path: directory, device: info.dev.toString(), inode: info.ino.toString(), hostIdentityDigest: await maintenanceHostIdentityDigest() };
  const admin = new Client({ connectionString: testUrl }); admin.on("error", () => {}); await admin.connect();
  const created: string[] = [];
  let roleCreated = false;
  const cleanup = async () => {
    observation.mark("fixture-close-start");
    try {
      for (const name of created.reverse()) await admin.query(`DROP DATABASE ${quoted(name)}`);
      if (roleCreated) await admin.query(`DROP ROLE ${quoted(role)}`);
      await admin.end(); await rm(directory, { recursive: true, force: true });
      observation.mark("fixture-close-returned");
    } catch (error) { observation.failure("cleanup", error); throw error; }
    finally { observation.close(); }
  };
  try {
    await admin.query(`CREATE ROLE ${quoted(role)} ${options.unprivileged ? `LOGIN PASSWORD '${password}'` : "NOLOGIN"}`); roleCreated = true;
    await admin.query(`CREATE DATABASE ${quoted(sourceName)} TEMPLATE template0 ${options.unprivileged ? `OWNER ${quoted(role)}` : ""}`); created.push(sourceName);
    await admin.query(`CREATE DATABASE ${quoted(targetName)} TEMPLATE template0 ${options.unprivileged ? `OWNER ${quoted(role)}` : ""}`); created.push(targetName);
    if (options.unprivileged || options.recreatePublic) for (const name of created) {
      const url = new URL(testUrl); url.pathname = `/${name}`;
      const setup = new Client({ connectionString: url.toString() }); await setup.connect();
      try {
        if (options.unprivileged) await setup.query(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${quoted(role)}`);
        if (name === sourceName && options.recreatePublic) await setup.query(`DROP SCHEMA public RESTRICT; CREATE SCHEMA public${options.unprivileged ? ` AUTHORIZATION ${quoted(role)}` : ""}`);
      } finally { await setup.end(); }
    }
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
    observation.mark("fixture-returned");
    return { source, target, directory, root, role, admin, observation,
      connectSource: () => connectDescriptor(source), connectTarget: () => connectDescriptor(target), close: cleanup };
  } catch (error) { observation.failure("setup", error); await cleanup(); throw error; }
  } catch (error) { observation.failure("setup", error); observation.close(); throw error; }
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

pgTest("#152 PG column ACL preserves grants and grant options while accepting NULL and empty privilege sets", async t => {
  const f = await fixture(t, "pg-column-acl", false), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  const client = await f.connectSource();
  const columnState = async () => (await client.query(`SELECT attacl IS NULL AS absent,
    cardinality(attacl) AS count,array_ndims(attacl) AS dimensions FROM pg_catalog.pg_attribute
    WHERE attrelid='projects'::regclass AND attname='name'`)).rows[0];
  const observe = async () => {
    const schema = (await adapter.observe()).manifests.schema as Record<string, Json>;
    const column = (schema.columns as Record<string, Json>[]).find(c => c.table_name === "projects" && c.name === "name");
    assert.ok(column);
    return { acl: column.acl, roles: schema.requiredRoles as Record<string, Json>[] };
  };
  try {
    assert.equal((await columnState()).absent, true);
    const baseline = await observe();
    assert.deepEqual(baseline.acl, []);
    assert.ok(!baseline.roles.some(role => role.name === f.role));
    const grantor = (await client.query("SELECT current_user AS name")).rows[0].name;
    await client.query(`GRANT SELECT(name),UPDATE(name) ON projects TO ${quoted(f.role)} WITH GRANT OPTION;
      GRANT SELECT(name) ON projects TO PUBLIC`);
    const granted = await observe();
    assert.deepEqual(granted.acl, [
      { grantor, grantee: "PUBLIC", privilege: "SELECT", grantable: false },
      { grantor, grantee: f.role, privilege: "SELECT", grantable: true },
      { grantor, grantee: f.role, privilege: "UPDATE", grantable: true },
    ]);
    assert.ok(granted.roles.some(role => role.name === f.role));
    await client.query(`REVOKE GRANT OPTION FOR SELECT(name) ON projects FROM ${quoted(f.role)}`);
    assert.deepEqual((await observe()).acl, [
      { grantor, grantee: "PUBLIC", privilege: "SELECT", grantable: false },
      { grantor, grantee: f.role, privilege: "SELECT", grantable: false },
      { grantor, grantee: f.role, privilege: "UPDATE", grantable: true },
    ]);
    await client.query(`REVOKE ALL(name) ON projects FROM ${quoted(f.role)},PUBLIC`);
    assert.deepEqual(await observe(), baseline);

    // Exercise a zero-dimensional empty array in this disposable database only.
    // GRANT/REVOKE normally restores NULL; the old COALESCE manufactured this value itself.
    try {
      await client.query(`UPDATE pg_catalog.pg_attribute SET attacl='{}'::aclitem[]
        WHERE attrelid='projects'::regclass AND attname='name'`);
      assert.deepEqual(await columnState(), { absent: false, count: 0, dimensions: null });
      assert.deepEqual(await observe(), baseline);
    } finally {
      await client.query(`UPDATE pg_catalog.pg_attribute SET attacl=NULL
        WHERE attrelid='projects'::regclass AND attname='name'`);
    }
    assert.equal((await columnState()).absent, true);
    assert.deepEqual(await observe(), baseline);
  } finally { await client.end(); await adapter.close(); await f.close(); }
});

pgTest("#152 PG migration catalog orders two-digit versions numerically and rejects changed migration identity", async t => {
  const f = await fixture(t, "pg-migration-identity", false), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  try {
    const baseline = await adapter.observe();
    const applied = (baseline.manifests.schema as Record<string, Json>).migrations as Record<string, Json>[];
    assert.equal(applied[1]?.version, "2"); assert.equal(applied[9]?.version, "10");
    const client = await f.connectSource();
    try {
      const original = (await client.query("SELECT version,name,checksum,applied_at FROM schema_migrations WHERE version=2")).rows[0];
      assert.ok(original);
      for (const [name, change] of [
        ["missing version", "DELETE FROM schema_migrations WHERE version=2"],
        ["extra version", "INSERT INTO schema_migrations(version,name,checksum,applied_at) SELECT 2147483647,name,checksum,applied_at FROM schema_migrations WHERE version=2"],
        ["replaced version", "UPDATE schema_migrations SET version=2147483647 WHERE version=2"],
        ["changed name", "UPDATE schema_migrations SET name='unexpected migration' WHERE version=2"],
        ["changed checksum", "UPDATE schema_migrations SET checksum='unexpected checksum' WHERE version=2"],
      ]) await t.test(name!, async () => {
        await assert.doesNotReject(adapter.observe());
        try {
          await client.query(change!);
          await assert.rejects(adapter.observe(), /schema_guard_incomplete/);
        } finally {
          await client.query("DELETE FROM schema_migrations WHERE version IN (2,2147483647)");
          await client.query("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES($1,$2,$3,$4)",
            [original.version, original.name, original.checksum, original.applied_at]);
        }
        await assert.doesNotReject(adapter.observe());
      });
    } finally { await client.end(); }
  } finally { await adapter.close(); await f.close(); }
});

pgTest("#152 PG16 real nonempty native dump/restore preserves catalog, owner/ACL, controls, typed values and migration identity sequence", async t => {
  const f = await fixture(t, "pg-native-roundtrip"), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
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

async function namespaceState(f: Fixture): Promise<unknown> {
  const client = await f.connectTarget();
  try { return (await client.query(`SELECT oid::text,nspowner::text,nspacl::text,pg_catalog.obj_description(oid,'pg_namespace') AS comment,
    (SELECT count(*)::text FROM pg_catalog.pg_class WHERE relnamespace=n.oid) AS relations,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(d.classid::text,d.objid::text,d.objsubid,d.deptype)
      ORDER BY d.classid,d.objid,d.objsubid,d.deptype) FROM pg_catalog.pg_depend d
      WHERE d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid),'[]'::jsonb) AS dependents
    FROM pg_catalog.pg_namespace n WHERE nspname='public'`)).rows; }
  finally { await client.end(); }
}

pgTest("#152 public native restore preserves six owner/ACL profiles with present or absent target public", { timeout: 180_000 }, async t => {
  for (const kind of ["default", "custom-public-usage", "custom-no-public", "recreated", "owner-no-privileges", "grantor-chain"] as const)
    for (const present of [true, false]) await t.test(`${kind} / target ${present ? "present" : "absent"}`, async () => {
      const f = await fixture(t, "public-owner-profiles", kind === "default" && present, "public", { recreatePublic: kind === "recreated", specialRoleName: kind !== "default", scenario: `${kind}-target-${present ? "present" : "absent"}` });
      const adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
      const extraRole = `br_pub_grantor_${randomUUID().replaceAll("-", "")}`;
      let extraCreated = false;
      try {
        const source = await f.connectSource(), target = await f.connectTarget();
        try {
          if (!["default", "recreated"].includes(kind)) {
            await source.query(`ALTER SCHEMA public OWNER TO ${quoted(f.role)}; COMMENT ON SCHEMA public IS 'source namespace comment'`);
            if (kind === "custom-no-public") await source.query("REVOKE USAGE ON SCHEMA public FROM PUBLIC");
            if (kind === "owner-no-privileges") await source.query(`REVOKE ALL ON SCHEMA public FROM ${quoted(f.role)}`);
            if (kind === "custom-public-usage" || kind === "grantor-chain") {
              await f.admin.query(`CREATE ROLE ${quoted(extraRole)} NOLOGIN`); extraCreated = true;
              await source.query(`GRANT USAGE ON SCHEMA public TO ${quoted(extraRole)} WITH GRANT OPTION`);
              if (kind === "custom-public-usage") await source.query(`GRANT SELECT ON projects TO ${quoted(extraRole)};
                GRANT SELECT(name),UPDATE(name) ON projects TO ${quoted(extraRole)} WITH GRANT OPTION;
                COMMENT ON COLUMN projects.name IS 'column metadata'`);
              if (kind === "grantor-chain") {
                const original = (await source.query("SELECT current_user AS name")).rows[0].name;
                await source.query(`SET ROLE ${quoted(extraRole)}; GRANT USAGE ON SCHEMA public TO ${quoted(original)}; RESET ROLE`);
              }
            }
          }
          if (!present) await target.query("DROP SCHEMA public RESTRICT");
          else await target.query("ALTER SCHEMA public OWNER TO CURRENT_USER; REVOKE ALL ON SCHEMA public FROM PUBLIC; COMMENT ON SCHEMA public IS 'different target metadata'");
        } finally { await source.end(); await target.end(); }
        const mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
        await adapter.withSourceLock("snapshot", async lock => {
          const archive = join(f.directory, "public.dump"), backup = await lock.backup(archive);
          const result = await adapter.verifyDatabase(archive, backup.manifests, f.directory) as Record<string, Json>;
          const restoredWith = result.restoredWith as Record<string, Json>;
          assert.equal(restoredWith.profile, "pg16-public-native-segments-v1");
          assert.equal(restoredWith.pgRestore, "16.15"); assert.equal(restoredWith.psql, "16.15");
          assert.equal(restoredWith.singleTransaction, true); assert.equal(restoredWith.aclPreserved, true);
          assert.equal(result.exactFullDataAndControlMatched, true);
          assert.equal((restoredWith.audit as Record<string, Json>).databaseEnvelopeExecuted, false);
        });
        await mutex.release();
      } finally { await adapter.close(); await f.close(); if (extraCreated) {
        const admin = new Client({ connectionString: testUrl }); await admin.connect();
        try { await admin.query(`DROP ROLE ${quoted(extraRole)}`); } finally { await admin.end(); }
      } }
    });
});

pgTest("#152 public valid source DATABASE envelope is audited but target database properties and ACL remain unchanged", async t => {
  const f = await fixture(t, "public-database-envelope", false, "public", { databaseNameWithSpaces: true }), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  const databaseState = async (target: boolean) => {
    const client = await (target ? f.connectTarget() : f.connectSource());
    try { return (await client.query(`SELECT oid::text,datname,datdba::text,datacl::text,datconnlimit,
      pg_catalog.shobj_description(oid,'pg_database') AS comment FROM pg_catalog.pg_database WHERE datname=current_database()`)).rows; }
    finally { await client.end(); }
  };
  try {
    const sourceName = parsePostgresConnection(f.source).database, targetName = parsePostgresConnection(f.target).database;
    await f.admin.query(`ALTER DATABASE ${quoted(sourceName)} CONNECTION LIMIT 41; ALTER DATABASE ${quoted(targetName)} CONNECTION LIMIT 43;
      COMMENT ON DATABASE ${quoted(sourceName)} IS 'source database comment'; COMMENT ON DATABASE ${quoted(targetName)} IS 'target database comment';
      GRANT CONNECT ON DATABASE ${quoted(sourceName)} TO ${quoted(f.role)} WITH GRANT OPTION`);
    const sourceBefore = await databaseState(false), targetBefore = await databaseState(true);
    const mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
    await adapter.withSourceLock("snapshot", async lock => {
      const archive = join(f.directory, "database-envelope.dump"), backup = await lock.backup(archive);
      const result = await adapter.verifyDatabase(archive, backup.manifests, f.directory) as Record<string, Json>;
      const audit = (result.restoredWith as Record<string, Json>).audit as Record<string, Json>;
      assert.equal((audit.databaseIds as Json[]).length, 4);
      assert.equal(audit.databaseEnvelopeExecuted, false);
    });
    assert.deepEqual(await databaseState(false), sourceBefore); assert.deepEqual(await databaseState(true), targetBefore);
    await mutex.release();
  } finally { await adapter.close(); await f.close(); }
});

pgTest("#152 public native restore supports an authorized non-superuser database owner", async t => {
  const f = await fixture(t, "public-owner-non-superuser", false, "public", { unprivileged: true }), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  try {
    const source = await f.connectSource();
    try { assert.equal((await source.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper, false); }
    finally { await source.end(); }
    const mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
    await adapter.withSourceLock("snapshot", async lock => {
      const archive = join(f.directory, "non-superuser.dump"), backup = await lock.backup(archive);
      assert.equal((await adapter.verifyDatabase(archive, backup.manifests, f.directory) as Record<string, Json>).exactFullDataAndControlMatched, true);
    });
    await mutex.release();
  } finally { await adapter.close(); await f.close(); }
});

pgTest("#152 public target unknown namespace dependencies block before DROP and preserve their identity", async t => {
  for (const kind of ["collation", "operator"] as const) {
    const f = await fixture(t, "public-namespace-dependencies", false, "public", { scenario: kind }), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
    try {
      const target = await f.connectTarget();
      try { await target.query(kind === "collation" ? "CREATE COLLATION public.unknown_collation FROM pg_catalog.\"C\""
        : "CREATE OPERATOR public.=== (LEFTARG=integer, RIGHTARG=integer, FUNCTION=pg_catalog.int4eq)"); }
      finally { await target.end(); }
      const before = await namespaceState(f), mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
      await adapter.withSourceLock("snapshot", async lock => {
        const archive = join(f.directory, "unknown-dependency.dump"), backup = await lock.backup(archive);
        await assert.rejects(adapter.verifyDatabase(archive, backup.manifests, f.directory), /restore_verification_unavailable/);
      });
      assert.deepEqual(await namespaceState(f), before);
      const check = await f.connectTarget();
      try { assert.equal((await check.query(kind === "collation"
        ? "SELECT count(*)::text AS count FROM pg_collation WHERE collname='unknown_collation' AND collnamespace='public'::regnamespace"
        : "SELECT count(*)::text AS count FROM pg_operator WHERE oprname='===' AND oprnamespace='public'::regnamespace")).rows[0].count, "1"); }
      finally { await check.end(); }
      await mutex.release();
    } finally { await adapter.close(); await f.close(); }
  }
});

pgTest("#152 public archive bytes must still match this active snapshot before target writes", async t => {
  const f = await fixture(t, "public-archive-bytes", false, "public"), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  try {
    const before = await namespaceState(f), mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
    await adapter.withSourceLock("snapshot", async lock => {
      const archive = join(f.directory, "changed.dump"), backup = await lock.backup(archive);
      await appendFile(archive, "changed after native backup");
      await assert.rejects(adapter.verifyDatabase(archive, backup.manifests, f.directory), /snapshot_invalid/);
    });
    assert.deepEqual(await namespaceState(f), before); await mutex.release();
  } finally { await adapter.close(); await f.close(); }
});

pgTest("#152 public missing or mismatched psql capability blocks before target writes", async t => {
  const realDump = await locateTool("pg_dump"), realRestore = await locateTool("pg_restore");
  for (const scenario of ["missing", "mismatch"] as const) {
    const f = await fixture(t, "public-psql-capability", false, "public", { scenario }), directory = join(f.directory, "capability-tools"); await mkdir(directory, { mode: 0o700 });
    await symlink(realDump, join(directory, "pg_dump")); await symlink(realRestore, join(directory, "pg_restore"));
    if (scenario === "mismatch") await writeFile(join(directory, "psql"), `#!${process.execPath}\nprocess.stdout.write('psql (PostgreSQL) 16.14\\n');\n`, { mode: 0o700 });
    const oldPath = process.env.PATH;
    let adapter: MaintenanceAdapter;
    try { process.env.PATH = directory; adapter = await createPostgresMaintenanceAdapter(f.source, f.target); }
    finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
    try {
      const before = await namespaceState(f), mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
      await adapter.withSourceLock("snapshot", async lock => {
        const archive = join(f.directory, "capability.dump"), backup = await lock.backup(archive);
        await assert.rejects(adapter.verifyDatabase(archive, backup.manifests, f.directory), /restore_verification_unavailable/);
      });
      assert.deepEqual(await namespaceState(f), before); await mutex.release();
    } finally { await adapter.close(); await f.close(); }
  }
});

pgTest("#152 public native CREATE permission failure rolls back the already executed DROP", async t => {
  const f = await fixture(t, "public-create-rollback", false, "public", { unprivileged: true }), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  try {
    const targetName = parsePostgresConnection(f.target).database, adminName = (await f.admin.query("SELECT current_user AS name")).rows[0].name;
    const target = await f.connectTarget();
    try { await target.query(`ALTER SCHEMA public OWNER TO ${quoted(f.role)}; COMMENT ON SCHEMA public IS 'namespace to preserve after CREATE fails'`); }
    finally { await target.end(); }
    await f.admin.query(`ALTER DATABASE ${quoted(targetName)} OWNER TO ${quoted(adminName)}; REVOKE CREATE ON DATABASE ${quoted(targetName)} FROM PUBLIC,${quoted(f.role)}`);
    const before = await namespaceState(f), mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
    await adapter.withSourceLock("snapshot", async lock => {
      const archive = join(f.directory, "permission.dump"), backup = await lock.backup(archive);
      await assert.rejects(adapter.verifyDatabase(archive, backup.manifests, f.directory), /restore_verification_unavailable/);
    });
    assert.deepEqual(await namespaceState(f), before); await mutex.release();
  } finally { await adapter.close(); await f.close(); }
});

pgTest("#152 public archive, selection and native SQL replacement or truncation fail before target execution", async t => {
  assert.equal(process.platform, "linux", "this owned FD fault injector uses Linux procfs; Darwin needs its native acceptance");
  const realRestore = await locateTool("pg_restore");
  for (const scenario of ["archive-replace", "selection-replace", "sql-replace", "sql-truncate"] as const) {
    const f = await fixture(t, "public-input-fault", false, "public", { scenario }), directory = join(f.directory, "tamper-tools");
    await mkdir(directory, { mode: 0o700 });
    // Real pg_restore produces each output first. The owned shim then changes one already-bound
    // private input to challenge the production post-child/pre-executor identity checks.
    await writeFile(join(directory, "pg_restore"), `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2), mode=${JSON.stringify(scenario)}, render=args.includes('--use-list=/dev/fd/4'), list=args.includes('--list');
const result=spawnSync(${JSON.stringify(realRestore)},args,{shell:false,env:process.env,stdio:[0,1,2,...(render?[3,4]:list?[3]:[])]});
if(result.error||result.status!==0) process.exit(9);
let target;
if(mode==='archive-replace'&&list) target=fs.readlinkSync('/proc/self/fd/3');
if(mode==='selection-replace'&&render) target=fs.readlinkSync('/proc/self/fd/4');
if(mode.startsWith('sql-')&&render){const selection=fs.readlinkSync('/proc/self/fd/4');if(selection.endsWith('-body.list')){
const dir=path.dirname(selection), matches=fs.readdirSync(dir).filter(name=>name.startsWith('.public-')&&name.endsWith('-namespace.sql'));
if(matches.length!==1)process.exit(8);target=path.join(dir,matches[0]);}}
if(target){if(!path.basename(target).startsWith('.public-'))process.exit(7);if(mode==='sql-truncate')fs.truncateSync(target,0);
else{fs.renameSync(target,target+'.original');fs.copyFileSync(target+'.original',target);fs.chmodSync(target,0o600);}}
`, { mode: 0o700 });
    const oldPath = process.env.PATH;
    let adapter: MaintenanceAdapter;
    try { process.env.PATH = `${directory}:${oldPath ?? ""}`; adapter = await createPostgresMaintenanceAdapter(f.source, f.target); }
    finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
    const observation = f.observation;
    try {
      observation.mark("scenario-start");
      const before = await namespaceState(f), mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
      await adapter.withSourceLock("snapshot", async lock => {
        observation.mark("backup-start");
        const archive = join(f.directory, "immutable.dump"), backup = await lock.backup(archive);
        observation.mark("backup-returned"); observation.mark("verify-start");
        await assert.rejects(adapter.verifyDatabase(archive, backup.manifests, f.directory), /snapshot_invalid/);
        observation.mark("verify-rejected-as-expected");
      });
      assert.deepEqual(await namespaceState(f), before); await mutex.release();
      observation.mark("assertions-complete");
    } catch (error) { observation.failure("case", error); throw error; }
    finally {
      try {
        observation.mark("adapter-close-start"); await adapter.close(); observation.mark("adapter-close-returned");
        await f.close();
      } catch (error) { observation.failure("cleanup", error); throw error; }
      finally { observation.close("test-hook"); }
    }
  }
});

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function publicPsqlFaultAdapter(f: Fixture, command: string) {
  const realPsql = await locateTool("psql"), directory = join(f.directory, "public-fault-tools"), marker = join(f.directory, "native-psql-pid");
  await mkdir(directory, { mode: 0o700 });
  // The shim execs the real native executable with unchanged SQL files. The final -c is a
  // test-only fault/hold point inside that same single transaction, not a production input.
  await writeFile(join(directory, "psql"), `#!/bin/sh\nif [ "$1" = --version ]; then exec ${shellQuote(realPsql)} "$@"; fi\nprintf '%s' "$$" > ${shellQuote(marker)}\nexec ${shellQuote(realPsql)} "$@" -c ${shellQuote(command)}\n`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${directory}:${oldPath ?? ""}`;
    return { adapter: await createPostgresMaintenanceAdapter(f.source, f.target), marker };
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
}

pgTest("#152 public native error, abort and source/target lock loss roll back and await actual child/backend exit", { timeout: 90_000 }, async t => {
  for (const scenario of ["native-error", "abort", "source-lock-loss", "target-lock-loss"] as const) await t.test(scenario, async () => {
    const f = await fixture(t, "public-native-fault", false, "public", { scenario }), fault = await publicPsqlFaultAdapter(f, scenario === "native-error" ? "SELECT 1/0" : "SELECT pg_sleep(30)"), adapter = fault.adapter;
    let closing: Promise<void> | undefined;
    try {
      const target = await f.connectTarget();
      try { await target.query("COMMENT ON SCHEMA public IS 'original rollback state'; REVOKE USAGE ON SCHEMA public FROM PUBLIC"); }
      finally { await target.end(); }
      const before = await namespaceState(f), mutex = await acquire(adapter, f); await seal(adapter, f, mutex);
      const targetName = parsePostgresConnection(f.target).database, sourceName = parsePostgresConnection(f.source).database;
      const operation = adapter.withSourceLock("snapshot", async lock => {
        const archive = join(f.directory, "interrupted-public.dump"), backup = await lock.backup(archive);
        return adapter.verifyDatabase(archive, backup.manifests, f.directory);
      }).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
      let nativeBackend: { pid: number; backend_start: string } | undefined;
      if (scenario !== "native-error") {
        const until = performance.now() + 15_000;
        while (performance.now() < until) {
          nativeBackend = (await f.admin.query(`SELECT pid,backend_start::text FROM pg_catalog.pg_stat_activity
            WHERE datname=$1 AND application_name LIKE 'boardroom-public-restore:%' AND state='active' AND query='SELECT pg_sleep(30)'`, [targetName])).rows[0];
          if (nativeBackend) break; await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(nativeBackend, "real psql must reach the in-transaction native hold point");
        if (scenario === "abort") closing = adapter.close();
        else {
          const lockOwner = (await f.admin.query(`SELECT a.pid FROM pg_catalog.pg_stat_activity a WHERE a.datname=$1
            AND a.application_name LIKE 'boardroom-maintenance:%' AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks l
              WHERE l.pid=a.pid AND l.granted AND ${scenario === "source-lock-loss" ? "l.locktype='relation' AND l.mode='ShareLock'" : "l.locktype='advisory' AND l.mode='ExclusiveLock'"})`,
          [scenario === "source-lock-loss" ? sourceName : targetName])).rows;
          assert.equal(lockOwner.length, 1);
          assert.equal((await f.admin.query("SELECT pg_terminate_backend($1,5000) AS stopped", [lockOwner[0].pid])).rows[0].stopped, true);
        }
      }
      const outcome = await operation; await closing;
      assert.ok(outcome.error); assert.match(String(outcome.error), scenario === "native-error" ? /restore_verification_unavailable/ : /maintenance_lost/);
      assert.deepEqual(await namespaceState(f), before);
      assert.equal((await f.admin.query(`SELECT count(*)::text AS count FROM pg_catalog.pg_stat_activity WHERE datname=$1
        AND application_name LIKE 'boardroom-public-restore:%'`, [targetName])).rows[0].count, "0");
      if (nativeBackend) assert.equal((await f.admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz",
        [nativeBackend.pid, nativeBackend.backend_start])).rows[0].count, "0");
      const nativePid = Number(await readFile(fault.marker, "utf8")); assert.ok(Number.isSafeInteger(nativePid) && nativePid > 1);
      assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" }, "exec kept the real native child PID; it must actually have exited");
      if (scenario === "native-error") await mutex.release();
    } finally { await adapter.close(); await closing; await f.close(); }
  });
});

pgTest("#152 complete public TOC rejects actual LO, VIEW, cross-schema and foreign-database archives", async t => {
  const f = await fixture(t, "public-toc-scope", false, "public", { scenario: "source" }), other = await fixture(t, "public-toc-scope", false, "public", { scenario: "foreign-archive" }), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  const source = await f.connectSource();
  try {
    // Match the adapter's canonical TIMESTAMPTZ projection before comparing complete manifests.
    await source.query("SET TimeZone='UTC'");
    const observed = await adapter.observe();
    const version = (await source.query("SELECT current_setting('server_version_num') AS version")).rows[0].version;
    const binding = await readPublicRestoreCatalogBinding(source, { ...(observed.sourceIdentity as object), serverVersion: version } as PostgresDatabaseIdentity, observed.manifests, "16.15");
    const before = await namespaceState(f);
    for (const scenario of ["normal", "lo", "view", "cross-schema", "foreign-database"] as const) {
      let lo: string | undefined;
      try {
        if (scenario === "lo") lo = (await source.query("SELECT lo_create(0)::text AS oid")).rows[0].oid;
        if (scenario === "view") await source.query("CREATE VIEW public.unsupported_view AS SELECT 1 AS value");
        if (scenario === "cross-schema") await source.query("CREATE SCHEMA other_scope; CREATE TABLE other_scope.outside(value integer)");
        const archive = await open(join(f.directory, `${scenario}.dump`), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
        const toc = await open(join(f.directory, `${scenario}.toc`), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          const environment = parsePostgresConnection(scenario === "foreign-database" ? other.source : f.source).childEnvironment;
          const args = ["--format=custom", "--schema=public", "--no-password", ...(scenario === "lo" ? ["--large-objects"] : []), ...(scenario === "cross-schema" ? ["--schema=other_scope"] : [])];
          await runPostgresTool("pg_dump", args, environment, { failure: "backup_capability_unavailable", outputFd: archive.fd });
          // A new read-only description is necessary; the writer's offset is already at EOF.
          const reader = await open(join(f.directory, `${scenario}.dump`), constants.O_RDONLY | constants.O_NOFOLLOW);
          try { await runPostgresTool("pg_restore", ["--format=custom", "--list", "--verbose", "/dev/fd/3"], environment,
            { failure: "restore_verification_unavailable", outputFd: toc.fd, readFds: [reader.fd] }); }
          finally { await reader.close(); }
        } finally { await archive.close(); await toc.close(); }
        const actualToc = await readFile(join(f.directory, `${scenario}.toc`), "utf8");
        if (scenario === "normal") assert.ok(auditPublicArchiveToc(actualToc, binding).bodyIds.length > 0);
        else assert.throws(() => auditPublicArchiveToc(actualToc, binding), /snapshot_invalid/);
      } finally {
        if (lo) await source.query("SELECT lo_unlink($1::oid)", [lo]);
        if (scenario === "view") await source.query("DROP VIEW public.unsupported_view");
        if (scenario === "cross-schema") await source.query("DROP TABLE other_scope.outside; DROP SCHEMA other_scope RESTRICT");
      }
    }
    assert.deepEqual(await namespaceState(f), before);
  } finally { await source.end(); await adapter.close(); await f.close(); await other.close(); }
});

pgTest("#152 PG actual-source advisory mutex excludes aliases and leaves an independent source available", async t => {
  const f = await fixture(t, "pg-source-alias", false, "app", { scenario: "source" }), other = await fixture(t, "pg-source-alias", false, "app", { scenario: "independent" });
  const aliasUrl = new URL(f.source.connectionString); aliasUrl.protocol = aliasUrl.protocol === "postgres:" ? "postgresql:" : "postgres:";
  const alias = { ...f.source, connectionString: aliasUrl.toString() };
  try { f.observation.registerAlias(parsePostgresConnection(alias).descriptorDigest); }
  catch { f.observation.registerAlias(""); }
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

pgTest("#152 PG physical locks reject an in-flight writer; unknown idle backend is still a blocker", async t => {
  const f = await fixture(t, "pg-writer-guards"), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
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

pgTest("#152 PG scope rejects extra sequence, cross-schema FK, extension, RLS and unknown type without silently excluding them", async t => {
  const f = await fixture(t, "pg-rejected-schema", false), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
  try {
    for (const [setup, teardown] of [
      ["CREATE SEQUENCE extra_sequence", "DROP SEQUENCE extra_sequence"],
      ["CREATE SCHEMA outside; CREATE TABLE outside.parent(id TEXT PRIMARY KEY); ALTER TABLE projects ADD CONSTRAINT cross_scope FOREIGN KEY(id) REFERENCES outside.parent(id)", "ALTER TABLE projects DROP CONSTRAINT cross_scope; DROP SCHEMA outside CASCADE"],
      ["CREATE EXTENSION hstore", "DROP EXTENSION hstore"],
      ["ALTER TABLE projects ENABLE ROW LEVEL SECURITY", "ALTER TABLE projects DISABLE ROW LEVEL SECURITY"],
      ["ALTER TABLE projects ADD COLUMN unsupported integer[]", "ALTER TABLE projects DROP COLUMN unsupported"],
    ]) {
      await assert.doesNotReject(adapter.observe());
      const client = await f.connectSource();
      try { await client.query(setup!); } finally { await client.end(); }
      try { await assert.rejects(adapter.observe(), /schema_guard_incomplete/); }
      finally {
        const cleanup = await f.connectSource();
        try { await cleanup.query(teardown!); } finally { await cleanup.end(); }
      }
      await assert.doesNotReject(adapter.observe());
    }
  } finally { await adapter.close(); await f.close(); }
});

pgTest("#152 PG restore refuses source/occupied target, missing declared owner role and corrupt dump; never clears a target", async t => {
  const f = await fixture(t, "pg-restore-refusal"), adapter = await createPostgresMaintenanceAdapter(f.source, f.target);
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

pgTest("#152 PG missing/failed native dump stays sealed and never leaks tool stderr", async t => {
  const f = await fixture(t, "pg-dump-capability", false);
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

pgTest("#152 PG exporter loss cancels its dump and sequence drift invalidates an attempted snapshot", async t => {
  const realDump = await locateTool("pg_dump");
  for (const scenario of ["sequence", "exporter"] as const) {
    const f = await fixture(t, "pg-exporter-drift", false, "app", { scenario });
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
