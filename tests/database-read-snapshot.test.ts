import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { identityEngines, identityFixture, identitySkip, identityPgUrl } from "./helpers/identity-fixture.ts";

for (const engine of identityEngines) {
  test(`${engine} readonly snapshot fixes isolation before admission and preserves one real view`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const project = await f.repos.projects.create({ name: "before" });
      let independent: Database.Database | Pool;
      if (engine === "sqlite") independent = new Database((f.db as SqliteDriver).file, { fileMustExist: true });
      else independent = new Pool({ connectionString: identityPgUrl });
      try {
        const value = await f.db.readSnapshot(async tx => {
          assert.equal("exec" in tx, false);
          if (engine === "postgres") {
            assert.equal((await tx.query("SHOW transaction_isolation"))[0]?.transaction_isolation, "repeatable read");
            assert.equal((await tx.query("SHOW transaction_read_only"))[0]?.transaction_read_only, "on");
          }
          const first = await tx.query("SELECT name FROM projects WHERE id = ?", [project.id]);
          if (independent instanceof Database) independent.prepare("UPDATE projects SET name='after' WHERE id=?").run(project.id);
          else {
            const schema = (await tx.query("SELECT current_schema() AS name"))[0]!.name;
            assert.match(String(schema), /^[A-Za-z_][A-Za-z0-9_]*$/);
            await independent.query(`UPDATE "${String(schema)}".projects SET name='after' WHERE id=$1`, [project.id]);
          }
          // Repository calls via db.query must stay on the same snapshot, too.
          assert.deepEqual(await f.db.query("SELECT name FROM projects WHERE id = ?", [project.id]), first);
          return first;
        });
        assert.equal(value[0]?.name, "before");
        assert.equal((await f.db.query("SELECT name FROM projects WHERE id = ?", [project.id]))[0]?.name, "after");
      } finally { if (independent instanceof Database) independent.close(); else await independent.end(); }
    } finally { await f.close(); }
  });

  test(`${engine} readonly snapshot rejects real writes and refuses an inherited transaction`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const project = await f.repos.projects.create({ name: "stable" });
      await assert.rejects(f.db.readSnapshot(async tx => {
        await tx.query("UPDATE projects SET name='forbidden' WHERE id=? RETURNING id", [project.id]);
      }), /read.?only/i);
      await assert.rejects(f.db.readSnapshot(async () => {
        await f.db.exec("UPDATE projects SET name='also-forbidden' WHERE id=?", [project.id]);
      }), /read.?only/i);
      await f.db.transaction(async () => {
        await assert.rejects(f.db.readSnapshot(async () => undefined), /read_snapshot_requires_own_transaction/);
      });
      assert.equal((await f.db.query("SELECT name FROM projects WHERE id=?", [project.id]))[0]?.name, "stable");
      // Neither failed reader poisons the normal write connection or its gate.
      await f.db.exec("UPDATE projects SET name='allowed' WHERE id=?", [project.id]);
    } finally { await f.close(); }
  });

  test(`${engine} readonly snapshot observes its opening epoch but cannot authorize a later write`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    let sqlite: Database.Database | undefined;
    let postgres: Pool | undefined;
    try {
      const seal = "UPDATE storage_maintenance SET admission='sealed',fence_epoch=1,active_migration_id='snapshot-fixture',"
        + `plan_digest='${"a".repeat(64)}',control_root_json='{}',mutex_identity_json='{}',journal_record_ref='fixture',`
        + `journal_digest='${"b".repeat(64)}',journal_sequence=1 WHERE singleton=1`;
      if (engine === "sqlite") sqlite = new Database((f.db as SqliteDriver).file, { fileMustExist: true });
      else {
        const schema = String((await f.db.query("SELECT current_schema() AS name"))[0]!.name);
        assert.match(schema, /^[A-Za-z_][A-Za-z0-9_]*$/);
        postgres = new Pool({ connectionString: identityPgUrl, options: `-c search_path=${schema}` });
      }
      await f.db.readSnapshot(async tx => {
        assert.equal((await tx.query("SELECT admission FROM storage_maintenance"))[0]!.admission, "open");
        if (sqlite) sqlite.exec(seal); else await postgres!.query(seal);
        assert.equal((await tx.query("SELECT admission FROM storage_maintenance"))[0]!.admission, "open");
      });
      await assert.rejects(f.db.readSnapshot(async () => undefined), /storage_maintenance/);
      await assert.rejects(f.db.exec("UPDATE projects SET name='forbidden'"), /storage_maintenance/);
      const cancel = "UPDATE storage_maintenance SET admission='open',fence_epoch=2,active_migration_id=NULL,plan_digest=NULL";
      if (sqlite) sqlite.exec(cancel); else await postgres!.query(cancel);
      await assert.rejects(f.db.readSnapshot(async () => undefined), /epoch_changed/);
    } finally { sqlite?.close(); await postgres?.end(); await f.close(); }
  });
}
