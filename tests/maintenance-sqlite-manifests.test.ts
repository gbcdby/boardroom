import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { readSqliteManifests } from "../src/server/storage/maintenance/sqlite-manifests.ts";

test("#152 full SQLite catalog and typed multiset capture include unknown-to-old-lists ordinary tables without integer/text/blob loss", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE added_domain(v); INSERT INTO added_domain VALUES(9223372036854775807),(-9223372036854775808),(1.25),(NULL),('1'),(x'00FF'),(CAST(x'80' AS TEXT)),('same'),('same')");
    runMigrations(db, migrations);
    const initial = readSqliteManifests(db);
    const table = initial.tables.find(t => t.name === "added_domain")!;
    assert.equal(table.count, "9");
    assert.ok(initial.tables.some(t => t.name === "policy_document_versions"));
    assert.ok(initial.tables.some(t => t.name === "storage_source_clients"));
    assert.equal(initial.controlRows.storage_maintenance[0]!.singleton, "1");
    assert.match(initial.schemaManifestDigest, /^[a-f0-9]{64}$/);
    db.exec("UPDATE added_domain SET v=9223372036854775806 WHERE typeof(v)='integer' AND v>0");
    const changed = readSqliteManifests(db);
    assert.notEqual(changed.frozenBusinessManifestDigest, initial.frozenBusinessManifestDigest);
    assert.notEqual(changed.tables.find(t => t.name === "added_domain")!.digest, table.digest);
    db.exec("UPDATE storage_maintenance SET owner_generation=1");
    const control = readSqliteManifests(db);
    assert.equal(control.frozenBusinessManifestDigest, changed.frozenBusinessManifestDigest);
    assert.notEqual(control.fullDataManifestDigest, changed.fullDataManifestDigest);
    assert.notEqual(control.capturedControlManifestDigest, changed.capturedControlManifestDigest);
    db.exec("DELETE FROM added_domain WHERE rowid=(SELECT max(rowid) FROM added_domain)");
    assert.notEqual(readSqliteManifests(db).tables.find(t => t.name === "added_domain")!.digest, changed.tables.find(t => t.name === "added_domain")!.digest);
  } finally { db.close(); }
});

test("#152 missing guards or changed migration checksums block manifest capture rather than narrowing coverage", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db, migrations);
    db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=1");
    assert.throws(() => readSqliteManifests(db), /schema_guard_incomplete/);
  } finally { db.close(); }
});
