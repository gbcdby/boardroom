import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { assertPostgresGuardCoverage } from "../src/server/storage/schema-guards.ts";

const url=process.env["AGENT_STUDIO_PG_TEST_URL"];
const pgTest=url?test:test.skip;
pgTest("#152 PG16 persistent guards, RR stale view, transaction admission, TRUNCATE and future catalog",async()=>{
  const schema=`maintenance_${randomUUID().replaceAll("-","")}`;
  const admin=new Pool({connectionString:url});
  const driver=new PostgresDriver({connectionString:url!,schema});
  let pool: Pool|undefined;
  try {
    await driver.connect();await driver.migrate(migrations);
    pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
    const controller=await pool.connect(), old=await pool.connect();
    try {
      const initial=await assertPostgresGuardCoverage(controller);
      await driver.migrate([...migrations,{version:19,name:"fixture_future_domain",up:"CREATE TABLE future_domain(id BIGINT PRIMARY KEY,value TEXT); INSERT INTO future_domain VALUES(1,'v');"}]);
      assert.notEqual(await assertPostgresGuardCoverage(controller),initial);
      await driver.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','before','t','t')");
      const seal=`UPDATE storage_maintenance SET admission=$1,fence_epoch=1,active_migration_id='fixture',plan_digest=$2,
        control_root_json='{}',mutex_identity_json='{}',journal_record_ref='fixture',journal_digest=$3,journal_sequence=1 WHERE singleton=1`;
      const args=["draining","a".repeat(64),"b".repeat(64)];
      await driver.transaction(async tx=>{
        await controller.query("BEGIN");await controller.query("SET LOCAL lock_timeout='25ms'");
        await assert.rejects(controller.query(seal,args),(error:unknown)=>(error as {code:string}).code==="55P03");
        await controller.query("ROLLBACK");
        await tx.exec("UPDATE projects SET name='admitted' WHERE id='p'");
      });
      await old.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      assert.equal((await old.query("SELECT admission FROM storage_maintenance")).rows[0].admission,"open");
      await controller.query(seal,["sealed",...args.slice(1)]);
      await assert.rejects(old.query("UPDATE projects SET name='rr-late'"),(error:unknown)=>["40001","55000"].includes((error as {code:string}).code));
      await old.query("ROLLBACK");
      await assert.rejects(old.query("TRUNCATE projects CASCADE"),/BOARDROOM_STORAGE_MAINTENANCE/);
      await assert.rejects(old.query("UPDATE future_domain SET value='late'"),/BOARDROOM_STORAGE_MAINTENANCE/);
      await assert.rejects(driver.exec("UPDATE projects SET name='new'"),/storage_maintenance/);
      await assert.rejects(driver.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES('q','n','t','t') RETURNING id"),/storage_maintenance/);
      // A failed admission rolled back the pooled transaction: no aborted/locked session leaks.
      await assert.rejects(driver.transaction(async()=>{}),/storage_maintenance/);
      await controller.query("UPDATE storage_maintenance SET admission='open',active_migration_id=NULL,plan_digest=NULL,fence_epoch=2");
      await assert.rejects(driver.exec("UPDATE projects SET name='stale-epoch'"),/epoch_changed/);
      assert.equal((await controller.query("SELECT name FROM projects WHERE id='p'")).rows[0].name,"admitted");
    } finally {controller.release();old.release();}
  } finally {
    await driver.close();await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
  }
});
