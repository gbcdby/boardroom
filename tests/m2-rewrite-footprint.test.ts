import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import type { DbReadSnapshot, DbRow } from "../src/server/db/driver.ts";
import { readM2RewriteFootprint, M2RewriteFootprintError } from "../src/server/identity/m2-rewrite-footprint.ts";
import type { M2UniqueFootprint } from "../src/server/identity/m2-rewrite-footprint.ts";
import { canonicalJson, sha256 } from "../src/server/storage/maintenance/canonical.ts";
import { identityFixture, identityEngines, identityPgUrl, identitySkip } from "./helpers/identity-fixture.ts";

type Engine = typeof identityEngines[number];
type Fixture = Awaited<ReturnType<typeof identityFixture>>;
const names = ["agent_runner_states", "agent_runtime_bindings", "agent_runtime_members", "storage_maintenance", "storage_source_clients"] as const;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const read = (f: Fixture, engine: Engine) => f.db.readSnapshot(s => readM2RewriteFootprint(s, engine));
function code(expected: string) {
  return (error: unknown) => {
    assert(error instanceof M2RewriteFootprintError);
    assert.equal(error.code, expected); assert.equal(error.message, `M2_REWRITE_FOOTPRINT: ${expected}`);
    assert.equal(Object.hasOwn(error, "cause"), false); return true;
  };
}
function frozen(value: unknown): void {
  if (value !== null && typeof value === "object") { assert(Object.isFrozen(value)); for (const v of Object.values(value)) frozen(v); }
}
async function rows(f: Fixture) {
  const entries = [];
  for (const name of [...names, "schema_migrations"]) entries.push([name, await f.db.query(`SELECT * FROM ${name} ORDER BY 1`)]);
  return Object.fromEntries(entries);
}
async function seed(f: Fixture) {
  await f.db.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','p','t','t')");
  await f.db.exec("INSERT INTO groups(id,project_id,name,created_at,updated_at) VALUES('g','p','g','t','t')");
  await f.db.exec("INSERT INTO agents(id,display_name,host_type,created_at,updated_at) VALUES('a','a','claude-code','t','t')");
  await f.db.exec("INSERT INTO members(id,project_id,kind,agent_id,display_name,created_at,updated_at) VALUES('m','p','agent','a','a','t','t')");
  await f.db.exec("INSERT INTO agent_runtimes(id,agent_id,defaults_json,created_at,updated_at) VALUES('r','a',?,'t','t')", ['{  "model": "old" }']);
  await f.db.exec("INSERT INTO agent_runtime_bindings(id,runtime_id,project_id,group_id,member_id,advanced_json,requested_snapshot_json,created_at,updated_at) VALUES('b','r','p','g','m',?,?,'t','t')", ['{ "legacy": 1 }', '{  "requested": 2 }']);
  await f.db.exec("INSERT INTO agent_runner_states(binding_id,session_key,applied_json,process_identity_json,updated_at) VALUES('b','historical-session',?,?,'t')", ['{ "applied": 3 }', '{  "pid": 47, "birth": "old" }']);
  await f.db.exec("INSERT INTO agent_runtime_members(member_id,runtime_id,project_id,binding_id,generation,lease_owner,lease_expires_at,updated_at) VALUES('m','r','p','b',7,'old-owner','old-expiry','t')");
  await f.db.exec("INSERT INTO storage_source_clients(client_id,database_instance_id,entrypoint,build_id,protocol_version,host_identity_json,process_identity_json,db_sessions_json,registered_epoch,observed_epoch,registered_at,last_observed_at) SELECT 'c',database_instance_id,'http','old-build',1,?,?,?,0,0,'t','t' FROM storage_maintenance", ['{ "host": 1 }', '{ "pid": 2 }', '[ ]']);
}
/** Real fixture DDL, not catalog-row mocks: restore the five-table closure with FK enforcement on. */
async function rebuildSqlite(f: Fixture, transform: (name: string, sql: string) => string) {
  const catalog = await f.db.query<{ type: string; name: string; tbl_name: string; sql: string }>(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name");
  const definitions = new Map(catalog.filter(r => r.type === "table").map(r => [r.name, r.sql]));
  const objects = catalog.filter(r => names.includes(r.tbl_name as typeof names[number]) && ["index", "trigger"].includes(r.type));
  await f.db.transaction(async tx => {
    for (const name of names) await tx.exec(`CREATE TEMP TABLE ${quote(`rf_saved_${name}`)} AS SELECT * FROM ${quote(name)}`);
    for (const name of ["agent_runner_states", "agent_runtime_members", "storage_source_clients", "agent_runtime_bindings", "storage_maintenance"]) await tx.exec(`DROP TABLE ${quote(name)}`);
    for (const name of ["agent_runtime_bindings", "storage_maintenance", "agent_runner_states", "agent_runtime_members", "storage_source_clients"]) {
      await tx.exec(transform(name, definitions.get(name)!));
      await tx.exec(`INSERT INTO ${quote(name)} SELECT * FROM ${quote(`rf_saved_${name}`)}`);
    }
    for (const object of objects) await tx.exec(object.sql);
    for (const name of names) await tx.exec(`DROP TABLE ${quote(`rf_saved_${name}`)}`);
    assert.deepEqual(await tx.query("SELECT * FROM pragma_foreign_key_check"), []);
    assert.equal((await tx.query("SELECT * FROM pragma_foreign_keys"))[0]!.foreign_keys, 1);
  });
}

for (const engine of identityEngines) {
  test(`${engine} M2 footprint reads nonempty v21 history through the actual readonly snapshot`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine, 21);
    try {
      await seed(f); const before = await rows(f); let pending = 0, count = 0;
      const result = await f.db.readSnapshot(async snapshot => {
        const mode = await snapshot.query(engine === "sqlite" ? "SELECT * FROM pragma_query_only" : "SELECT current_setting('transaction_read_only') AS mode");
        assert.equal(engine === "sqlite" ? mode[0]!.query_only : mode[0]!.mode, engine === "sqlite" ? 1 : "on");
        return readM2RewriteFootprint({ query: async <T extends DbRow>(sql: string, params?: readonly unknown[]) => {
          assert.match(sql, /^SELECT\b/); assert.equal(pending++, 0); count++;
          try { return await snapshot.query<T>(sql, params); } finally { pending--; }
        } }, engine);
      });
      assert(count <= 16); assert.equal(pending, 0);
      assert.deepEqual(result.relations.map(r => [r.name, r.columns.length]), [["agent_runner_states", 22], ["agent_runtime_bindings", 14], ["agent_runtime_members", 8], ["storage_maintenance", 14], ["storage_source_clients", 16]]);
      const migrationContract: readonly { readonly version: number; readonly name: string; readonly checksum: string }[] = result.migrations;
      const uniqueContract: readonly [M2UniqueFootprint, M2UniqueFootprint] = result.legacyBindingUniques;
      assert.equal(result.incomingForeignKeys.length, 3); assert.equal(migrationContract.length, 21);
      assert.equal(migrationContract[0]!.version, 1); assert.equal(migrationContract[20]!.version, 21);
      assert.deepEqual(uniqueContract.map(u => u.keys), [["runtime_id", "project_id", "group_id"], ["member_id", "group_id"]]);
      assert(result.relations.some(r => r.indexes.some(i => i.metadata.name === "ix_bindings_member_seek")));
      const singleton = result.relations.find(r => r.name === "storage_maintenance")!.columns[0]!;
      assert.equal(singleton.not_null, engine === "sqlite" ? 0 : true);
      assert.equal(result.relations.find(r => r.name === "storage_source_clients")!.columns[0]!.not_null, engine === "sqlite" ? 0 : true);
      assert.equal(result.incomingForeignKeys[0]!.deferrable, engine === "sqlite" ? null : false);
      const { digest, ...value } = result;
      assert.equal(digest, sha256(`boardroom:m2-rewrite-footprint:internal\0${canonicalJson(value)}`)); frozen(result);
      assert.deepEqual(await read(f, engine), result); assert.deepEqual(await rows(f), before);
      await assert.rejects(f.db.readSnapshot(s => s.query("DELETE FROM agent_runner_states")));
      assert.deepEqual(await rows(f), before);
      assert.deepEqual(Object.keys(result).sort(), ["dialect", "digest", "incomingForeignKeys", "kind", "legacyBindingUniques", "migrations", "namespace", "relations"]);
    } finally { await f.close(); }
  });

  test(`${engine} M2 footprint locates actual renamed/reordered unique identities`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine, 21);
    try {
      await seed(f); const before = await read(f, engine), oldRows = await rows(f);
      if (engine === "sqlite") await rebuildSqlite(f, (name, sql) => name === "agent_runtime_bindings"
        ? sql.replace("UNIQUE (runtime_id, project_id, group_id)", "UNIQUE (member_id, group_id)").replace(/UNIQUE \(member_id, group_id\)([\s\S]*?)UNIQUE \(member_id, group_id\)/, "UNIQUE (member_id, group_id)$1UNIQUE (runtime_id, project_id, group_id)") : sql);
      else for (const [i, unique] of before.legacyBindingUniques.entries()) await f.db.exec(`ALTER TABLE agent_runtime_bindings RENAME CONSTRAINT ${quote(unique.constraintName!)} TO ${quote(`renamed_original_${i}`)}`);
      const after = await read(f, engine);
      assert.deepEqual(after.legacyBindingUniques.map(u => u.keys), before.legacyBindingUniques.map(u => u.keys));
      assert.notDeepEqual(after.legacyBindingUniques.map(u => u.indexName), before.legacyBindingUniques.map(u => u.indexName));
      assert.notEqual(after.digest, before.digest); assert.deepEqual(await rows(f), oldRows);
    } finally { await f.close(); }
  });

  test(`${engine} M2 footprint rejects every unknown incoming child even when empty`, { skip: identitySkip(engine) }, async t => {
    for (const [table, key] of [["agent_runtime_bindings", "id"], ["agent_runner_states", "binding_id"], ["agent_runtime_members", "member_id"], ["storage_source_clients", "client_id"]]) {
      await t.test(table!, async () => {
        const f = await identityFixture(engine, 21);
        try { await seed(f); await f.db.exec(`CREATE TABLE unknown_child (id TEXT PRIMARY KEY, parent TEXT REFERENCES ${table}(${key}) ON DELETE CASCADE)`);
          const before = await rows(f); await assert.rejects(read(f, engine), code("unexpected_inbound_fk")); assert.deepEqual(await rows(f), before);
        } finally { await f.close(); }
      });
    }
    if (engine === "sqlite") await t.test("case-insensitive referenced relation", async () => {
      const f = await identityFixture(engine, 21);
      try { await f.db.exec("CREATE TABLE unknown_child (parent TEXT REFERENCES AGENT_RUNTIME_BINDINGS(id))"); await assert.rejects(read(f, engine), code("unexpected_inbound_fk")); }
      finally { await f.close(); }
    });
    if (engine === "sqlite") await t.test("ordinary sqliteX name is not an internal sqlite_ table", async () => {
      const f = await identityFixture(engine, 21);
      try { await f.db.exec("CREATE TABLE sqliteXunknown (parent TEXT REFERENCES agent_runtime_bindings(id))"); await assert.rejects(read(f, engine), code("unexpected_inbound_fk")); }
      finally { await f.close(); }
    });
    if (engine === "postgres") await t.test("actual cross-schema child", async () => {
      const f = await identityFixture(engine, 21); let other = "";
      try {
        const namespace = (await read(f, engine)).namespace.name; other = `${namespace}_child`;
        await f.db.exec(`CREATE SCHEMA ${quote(other)}`);
        await f.db.exec(`CREATE TABLE ${quote(other)}.outside_child (parent TEXT REFERENCES ${quote(namespace)}.agent_runtime_bindings(id))`);
        await assert.rejects(read(f, engine), code("unexpected_inbound_fk"));
      } finally { if (other) await f.db.exec(`DROP SCHEMA ${quote(other)} CASCADE`); await f.close(); }
    });
  });

  test(`${engine} M2 footprint rejects missing, changed and duplicate legacy FK semantics`, { skip: identitySkip(engine) }, async t => {
    for (const mode of ["missing", "action", "duplicate", ...(engine === "postgres" ? ["deferred", "unvalidated"] : [])]) {
      await t.test(mode, async () => {
        const f = await identityFixture(engine, 21);
        try {
          await seed(f);
          if (engine === "sqlite") await rebuildSqlite(f, (name, sql) => name !== "agent_runner_states" ? sql : mode === "missing"
            ? sql.replace(" REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE", "") : mode === "action"
              ? sql.replace("REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE", "REFERENCES agent_runtime_bindings(id) ON DELETE RESTRICT")
              : sql.replace(/\)\s*$/, ", FOREIGN KEY(binding_id) REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE)"));
          else {
            const fk = (await read(f, engine)).incomingForeignKeys.find(k => k.table === "agent_runner_states")!;
            if (mode === "deferred") await f.db.exec(`ALTER TABLE agent_runner_states ALTER CONSTRAINT ${quote(fk.name!)} DEFERRABLE INITIALLY DEFERRED`);
            else {
              if (mode !== "duplicate") await f.db.exec(`ALTER TABLE agent_runner_states DROP CONSTRAINT ${quote(fk.name!)}`);
              if (mode !== "missing") await f.db.exec(`ALTER TABLE agent_runner_states ADD CONSTRAINT changed_fk FOREIGN KEY(binding_id) REFERENCES agent_runtime_bindings(id) ON DELETE ${mode === "action" ? "RESTRICT" : "CASCADE"}${mode === "unvalidated" ? " NOT VALID" : ""}`);
            }
          }
          const before = await rows(f); await assert.rejects(read(f, engine), code("unexpected_inbound_fk")); assert.deepEqual(await rows(f), before);
        } finally { await f.close(); }
      });
    }
  });

  test(`${engine} M2 footprint does not substitute partial, reversed, missing or additional unique keys`, { skip: identitySkip(engine) }, async t => {
    for (const mode of ["missing", "partial", "additional-partial", "reversed", "additional", "expression", ...(engine === "postgres" ? ["included", "deferrable"] : [])]) {
      await t.test(mode, async () => {
        const f = await identityFixture(engine, 21);
        try {
          await seed(f);
          if (["missing", "partial", "reversed", "included", "deferrable"].includes(mode)) {
            if (engine === "sqlite") await rebuildSqlite(f, (name, sql) => name !== "agent_runtime_bindings" ? sql : mode === "reversed"
              ? sql.replace("UNIQUE (member_id, group_id)", "UNIQUE (group_id, member_id)") : sql.replace(/,\s*UNIQUE \(member_id, group_id\)/, ""));
            else {
              const unique = (await read(f, engine)).legacyBindingUniques[1]!;
              await f.db.exec(`ALTER TABLE agent_runtime_bindings DROP CONSTRAINT ${quote(unique.constraintName!)}`);
              if (mode === "reversed") await f.db.exec("ALTER TABLE agent_runtime_bindings ADD CONSTRAINT reversed_unique UNIQUE(group_id,member_id)");
              if (mode === "included") await f.db.exec("CREATE UNIQUE INDEX included_unique ON agent_runtime_bindings(member_id,group_id) INCLUDE(id)");
              if (mode === "deferrable") await f.db.exec("ALTER TABLE agent_runtime_bindings ADD CONSTRAINT deferred_unique UNIQUE(member_id,group_id) DEFERRABLE INITIALLY DEFERRED");
            }
          }
          if (["partial", "additional-partial"].includes(mode)) await f.db.exec("CREATE UNIQUE INDEX partial_unique ON agent_runtime_bindings(member_id,group_id) WHERE desired_state='running'");
          if (mode === "additional") await f.db.exec("CREATE UNIQUE INDEX additional_unique ON agent_runtime_bindings(runtime_id)");
          if (mode === "expression") await f.db.exec("CREATE UNIQUE INDEX expression_unique ON agent_runtime_bindings(lower(member_id))");
          await assert.rejects(read(f, engine), code("legacy_unique_mismatch"));
        } finally { await f.close(); }
      });
    }
  });

  test(`${engine} M2 footprint also enforces member/control edges and real column-pair arity`, { skip: identitySkip(engine) }, async t => {
    for (const table of ["agent_runtime_members", "storage_source_clients"]) for (const mode of ["missing", "action", "duplicate"]) await t.test(`${table}/${mode}`, async () => {
      const f = await identityFixture(engine, 21);
      try {
        await seed(f); const fk = (await read(f, engine)).incomingForeignKeys.find(k => k.table === table)!;
        const column = fk.pairs[0]!.from_column as string, target = fk.targetTable, targetColumn = fk.pairs[0]!.to_column as string;
        const clause = ` REFERENCES ${target}(${targetColumn})${table === "agent_runtime_members" ? " ON DELETE RESTRICT" : ""}`;
        const duplicate = `FOREIGN KEY(${column}) REFERENCES ${target}(${targetColumn}) ON DELETE ${fk.deleteAction}`;
        if (engine === "sqlite") await rebuildSqlite(f, (name, sql) => name !== table ? sql : mode === "missing" ? sql.replace(clause, "")
          : mode === "action" ? sql.replace(clause, ` REFERENCES ${target}(${targetColumn}) ON DELETE CASCADE`) : sql.replace(/\)\s*$/, `, ${duplicate})`));
        else {
          if (mode !== "duplicate") await f.db.exec(`ALTER TABLE ${table} DROP CONSTRAINT ${quote(fk.name!)}`);
          if (mode !== "missing") await f.db.exec(`ALTER TABLE ${table} ADD CONSTRAINT changed_fk FOREIGN KEY(${column}) REFERENCES ${target}(${targetColumn}) ON DELETE ${mode === "action" ? "CASCADE" : fk.deleteAction}`);
        }
        const before = await rows(f); await assert.rejects(read(f, engine), code("unexpected_inbound_fk")); assert.deepEqual(await rows(f), before);
      } finally { await f.close(); }
    });
    for (const mode of ["wrong-column", "composite"]) await t.test(mode, async () => {
      const f = await identityFixture(engine, 21);
      try {
        await seed(f);
        if (engine === "sqlite") await rebuildSqlite(f, (name, sql) => {
          if (mode === "wrong-column" && name === "agent_runner_states") return sql.replace(" REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE", "")
            .replace(/\)\s*$/, ", FOREIGN KEY(harness_session_id) REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE)");
          if (mode === "composite" && name === "agent_runtime_bindings") return sql.replace(/\)\s*$/, ", UNIQUE(id,runtime_id))");
          if (mode === "composite" && name === "agent_runtime_members") return sql.replace(" REFERENCES agent_runtime_bindings(id) ON DELETE RESTRICT", "")
            .replace(/\)\s*$/, ", FOREIGN KEY(binding_id,runtime_id) REFERENCES agent_runtime_bindings(id,runtime_id) ON DELETE RESTRICT)");
          return sql;
        });
        else {
          const table = mode === "wrong-column" ? "agent_runner_states" : "agent_runtime_members";
          const fk = (await read(f, engine)).incomingForeignKeys.find(k => k.table === table)!;
          await f.db.exec(`ALTER TABLE ${table} DROP CONSTRAINT ${quote(fk.name!)}`);
          if (mode === "composite") await f.db.exec("ALTER TABLE agent_runtime_bindings ADD CONSTRAINT composite_parent UNIQUE(id,runtime_id)");
          await f.db.exec(mode === "wrong-column" ? "ALTER TABLE agent_runner_states ADD CONSTRAINT changed_fk FOREIGN KEY(harness_session_id) REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE"
            : "ALTER TABLE agent_runtime_members ADD CONSTRAINT changed_fk FOREIGN KEY(binding_id,runtime_id) REFERENCES agent_runtime_bindings(id,runtime_id) ON DELETE RESTRICT");
        }
        const before = await rows(f); await assert.rejects(read(f, engine), code("unexpected_inbound_fk")); assert.deepEqual(await rows(f), before);
      } finally { await f.close(); }
    });
  });

  test(`${engine} M2 footprint rejects lost current columns/indexes and binds indexes to their table`, { skip: identitySkip(engine) }, async t => {
    for (const mode of ["latest-column", "extra-column", "generated-column", "member-seek", "index-order", "wrong-index-owner"]) await t.test(mode, async () => {
      const f = await identityFixture(engine, 21);
      try {
        if (mode === "latest-column") await f.db.exec("ALTER TABLE agent_runner_states DROP COLUMN process_identity_json");
        if (mode === "extra-column") await f.db.exec("ALTER TABLE agent_runner_states ADD COLUMN unreviewed TEXT");
        if (mode === "generated-column") {
          await f.db.exec("ALTER TABLE agent_runner_states DROP COLUMN process_identity_json");
          await f.db.exec(`ALTER TABLE agent_runner_states ADD COLUMN process_identity_json TEXT GENERATED ALWAYS AS ('generated') ${engine === "sqlite" ? "VIRTUAL" : "STORED"}`);
        }
        if (mode === "member-seek" || mode === "index-order") {
          await f.db.exec("DROP INDEX ix_bindings_member_seek");
          if (mode === "index-order") await f.db.exec("CREATE INDEX ix_bindings_member_seek ON agent_runtime_bindings(id,member_id)");
        }
        if (mode === "wrong-index-owner") { await f.db.exec("DROP INDEX ix_runtime_members_runtime"); await f.db.exec("CREATE INDEX ix_runtime_members_runtime ON agent_runtime_bindings(runtime_id)"); }
        await assert.rejects(read(f, engine), code("unsupported_catalog"));
      } finally { await f.close(); }
    });
  });

  test(`${engine} M2 footprint observes additional metadata without declaring a rewrite permitted`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine, 21);
    try {
      await seed(f); const before = await read(f, engine), oldRows = await rows(f);
      await f.db.exec("CREATE TABLE unrelated_business (id TEXT PRIMARY KEY, note TEXT)");
      await f.db.exec("INSERT INTO unrelated_business VALUES ('u','untouched')");
      assert.deepEqual(await read(f, engine), before);
      await f.db.exec("CREATE INDEX additional_nonunique ON agent_runtime_bindings(advanced_json)");
      const after = await read(f, engine);
      assert.notEqual(after.digest, before.digest); assert(after.relations.find(r => r.name === "agent_runtime_bindings")!.indexes.some(i => i.metadata.name === "additional_nonunique"));
      if (engine === "sqlite") {
        await f.db.exec("CREATE TRIGGER observed_extra AFTER UPDATE ON agent_runner_states BEGIN SELECT 1; END");
      } else await f.db.exec("ALTER TABLE agent_runner_states ALTER COLUMN generation SET DEFAULT (0::integer + 0)");
      assert.notEqual((await read(f, engine)).digest, after.digest); assert.deepEqual(await rows(f), oldRows);
      assert.deepEqual(await f.db.query("SELECT * FROM unrelated_business"), [{ id: "u", note: "untouched" }]);
    } finally { await f.close(); }
  });

  test(`${engine} M2 footprint rejects changed baseline and preexisting M2 relations`, { skip: identitySkip(engine) }, async t => {
    for (const mode of ["missing", "checksum", "name", "new-version", "empty-table", "view", ...(engine === "sqlite" ? ["case-table"] : [])]) await t.test(mode, async () => {
      const f = await identityFixture(engine, 21);
      try {
        if (mode === "missing") await f.db.exec("DELETE FROM schema_migrations WHERE version=21");
        if (mode === "checksum") await f.db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=21");
        if (mode === "name") await f.db.exec("UPDATE schema_migrations SET name='wrong' WHERE version=21");
        if (mode === "new-version") await f.db.exec("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(22,'unreviewed','wrong','2026-11-18T00:00:00.000Z')");
        if (mode === "empty-table") await f.db.exec("CREATE TABLE config_authority (unused TEXT)");
        if (mode === "case-table") await f.db.exec("CREATE TABLE Config_Authority (unused TEXT)");
        if (mode === "view") await f.db.exec("CREATE VIEW config_authority AS SELECT 'unused' AS value");
        await assert.rejects(read(f, engine), code("migration_baseline_mismatch"));
      } finally { await f.close(); }
    });
  });
}

test("sqlite M2 footprint bounds actual table/index/definition catalogs and refuses unsupported views", async t => {
  for (const mode of ["tables", "index-items", "definition", "view"]) await t.test(mode, async () => {
    const f = await identityFixture("sqlite", 21);
    try {
      if (mode === "tables") await f.db.transaction(async tx => { for (let i = 0; i < 257; i++) await tx.exec(`CREATE TABLE budget_${i}(id TEXT)`); });
      if (mode === "index-items") await f.db.exec(`CREATE INDEX too_wide ON agent_runtime_bindings(${Array(32).fill("id").join(",")})`);
      if (mode === "definition") await f.db.exec(`CREATE TRIGGER too_large AFTER UPDATE ON agent_runner_states BEGIN SELECT '${"a".repeat(65537)}'; END`);
      if (mode === "view") await f.db.exec("CREATE VIEW unrelated_view AS SELECT id FROM agent_runtime_bindings");
      await assert.rejects(read(f, "sqlite"), code(mode === "view" ? "unsupported_catalog" : "catalog_budget"));
    } finally { await f.close(); }
  });
});

test("sqlite M2 footprint keeps unavailable FK deferrability honest and preserves the changed declaration", async () => {
  const f = await identityFixture("sqlite", 21);
  try {
    await seed(f); const before = await read(f, "sqlite"), oldRows = await rows(f);
    await rebuildSqlite(f, (name, sql) => name === "agent_runner_states"
      ? sql.replace("REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE", "REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED") : sql);
    const after = await read(f, "sqlite");
    assert.equal(after.incomingForeignKeys.find(k => k.table === "agent_runner_states")!.deferrable, null);
    assert.match(after.relations.find(r => r.name === "agent_runner_states")!.createSql!, /DEFERRABLE INITIALLY DEFERRED/);
    assert.notEqual(after.digest, before.digest); assert.deepEqual(await rows(f), oldRows);
  } finally { await f.close(); }
});

test("M2 footprint snapshots query rows once, enforces sentinels and never inspects thrown getters", async () => {
  let queries = 0;
  await assert.rejects(readM2RewriteFootprint({ query: async () => { queries++; return []; } }, "invalid" as Engine), code("invalid_dialect"));
  assert.equal(queries, 0);
  let touched = 0;
  const hostile = new Proxy({}, { getPrototypeOf() { touched++; throw new Error("PRIVATE_DSN"); }, get() { touched++; throw new Error("PRIVATE_DSN"); } });
  await assert.rejects(readM2RewriteFootprint({ query: async () => { throw hostile; } }, "sqlite"), code("catalog_unavailable")); assert.equal(touched, 0);
  const mutable = new M2RewriteFootprintError("unsupported_catalog"); mutable.message = "PRIVATE_DSN";
  Object.defineProperty(mutable, "cause", { get() { touched++; throw new Error("PRIVATE_DSN"); } });
  await assert.rejects(readM2RewriteFootprint({ query: async () => { throw mutable; } }, "sqlite"), code("unsupported_catalog")); assert.equal(touched, 0);
  assert.equal(new M2RewriteFootprintError("PRIVATE_DSN" as never).message, "M2_REWRITE_FOOTPRINT: catalog_unavailable");
  for (const bad of [Array(4097).fill({}), [{ type: "table", name: "x", table_name: "x", definition: "a".repeat(65537) }]]) {
    await assert.rejects(readM2RewriteFootprint({ query: async () => bad as never }, "sqlite"), code("catalog_budget"));
  }
  const f = await identityFixture("sqlite", 21);
  try {
    const calls: { sql: string; params: readonly unknown[]; rows: DbRow[] }[] = [];
    const expected = await f.db.readSnapshot(snapshot => readM2RewriteFootprint({ query: async <T extends DbRow>(sql: string, params: readonly unknown[] = []) => {
      const result = await snapshot.query<T>(sql, params); calls.push({ sql, params, rows: structuredClone(result) }); return result;
    } }, "sqlite"));
    let at = 0, enumerations = 0;
    const repeated = await readM2RewriteFootprint({ query: async <T extends DbRow>(sql: string, params: readonly unknown[] = []) => {
      const recorded = calls[at++]!; assert.equal(sql, recorded.sql); assert.deepEqual(params, recorded.params);
      return recorded.rows.map(row => new Proxy(row, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); }, get() { throw new Error("GETTER_MUST_NOT_RUN"); } })) as T[];
    } }, "sqlite");
    assert.deepEqual(repeated, expected); assert.equal(enumerations, calls.reduce((n, c) => n + c.rows.length, 0));
    const badRow = Object.defineProperty({ type: "table", name: "x", table_name: "x" }, "definition", { enumerable: true, get() { touched++; return "PRIVATE_DSN"; } });
    await assert.rejects(readM2RewriteFootprint({ query: async () => [badRow] as never }, "sqlite"), code("unsupported_catalog")); assert.equal(touched, 0);
    const hidden = { type: "table", name: "x", table_name: "x", definition: "sql" }; Object.defineProperty(hidden, "hidden", { value: true });
    await assert.rejects(readM2RewriteFootprint({ query: async () => [hidden] as never }, "sqlite"), code("unsupported_catalog"));
    const bulky = Array.from({ length: 40 }, (_, i) => ({ type: "table", name: `x${i}`, table_name: `x${i}`, definition: "a".repeat(60000) }));
    await assert.rejects(readM2RewriteFootprint({ query: async () => bulky as never }, "sqlite"), code("catalog_budget"));
    const api = await import("../src/server/identity/m2-rewrite-footprint.ts"); assert.deepEqual(Object.keys(api).sort(), ["M2RewriteFootprintError", "readM2RewriteFootprint"]);
  } finally { await f.close(); }
});

test("postgres M2 footprint binds real tableoid, parsed relation and current namespace across shadowing", { skip: identitySkip("postgres") }, async t => {
  for (const mode of ["positive", "temp-table", "shadow-view", "other-schema", "namespace-fallback", "empty"]) await t.test(mode, async () => {
    const f = await identityFixture("postgres", 21), client = new Client({ connectionString: identityPgUrl }); let other = "";
    try {
      await seed(f); const expected = await read(f, "postgres"), namespace = expected.namespace.name;
      await client.connect(); await client.query(`SET search_path TO ${quote(namespace)}`);
      const migrationOid = String((await client.query("SELECT 'schema_migrations'::regclass::oid::text AS oid")).rows[0].oid);
      if (mode === "temp-table") await client.query(`CREATE TEMP TABLE schema_migrations AS SELECT * FROM ${quote(namespace)}.schema_migrations`);
      if (mode === "shadow-view") await client.query(`CREATE TEMP VIEW schema_migrations AS SELECT version,name,checksum,${Number(migrationOid)}::oid AS tableoid FROM ${quote(namespace)}.schema_migrations`);
      if (mode === "other-schema" || mode === "namespace-fallback") {
        other = `${namespace}_shadow`; await client.query(`CREATE SCHEMA ${quote(other)}`);
        if (mode === "other-schema") await client.query(`CREATE TABLE ${quote(other)}.schema_migrations AS SELECT * FROM ${quote(namespace)}.schema_migrations`);
      }
      if (mode === "empty") await client.query("DELETE FROM schema_migrations");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const statements: string[] = [];
      const snapshot: DbReadSnapshot = { query: async <T extends DbRow>(sql: string, params: readonly unknown[] = []) => {
        statements.push(sql);
        if (sql.includes("FROM schema_migrations AS m")) {
          assert.deepEqual(params, [migrationOid, migrationOid, expected.namespace.oid]);
          if (other) await client.query(`SET LOCAL search_path TO ${quote(other)},${quote(namespace)}`);
        }
        return (await client.query(f.db.dialect.renderParameters(sql), [...params])).rows as T[];
      } };
      if (mode === "positive") assert.deepEqual(await readM2RewriteFootprint(snapshot, "postgres"), expected);
      else await assert.rejects(readM2RewriteFootprint(snapshot, "postgres"), code("migration_baseline_mismatch"));
      assert(statements.length <= 16); assert(statements.every(s => /^SELECT\b/.test(s)));
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      if (other) await client.query(`DROP SCHEMA ${quote(other)} CASCADE`);
      await client.end(); await f.close();
    }
  });
});
