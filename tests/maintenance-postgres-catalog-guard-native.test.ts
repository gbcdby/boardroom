import test from "node:test";
import assert from "node:assert/strict";
import type { Client, QueryResult } from "pg";
import { PG_CATALOG_GUARD_MODULE, PG_CATALOG_GUARD_SQL } from "../src/server/storage/maintenance/postgres-catalog-guard/fixed-module.ts";
import { parsePgCatalogGuardModuleObservation } from "../src/server/storage/maintenance/postgres-catalog-guard/observation-values.ts";
import { h04Roles, openCatalogGuardTestCluster } from "./fixtures/postgres-catalog-guard-cluster.ts";
import { readFixtureCatalogGuardModule } from "./fixtures/postgres-catalog-guard-observation.ts";

const toolsDirectory = process.env["AGENT_STUDIO_PG_RESTART_BIN"];
const share = 'SELECT "boardroom_catalog_guard_v1"."acquire_share"() AS guard';
const sre = 'SELECT "boardroom_catalog_guard_v1"."acquire_sre"() AS guard';
const assertVoid = (result: QueryResult) => {
  assert.equal(result.command, "SELECT"); assert.equal(result.rowCount, 1);
  assert.deepEqual(result.fields.map(field => ({ name: field.name, oid: field.dataTypeID })), [{ name: "guard", oid: 2278 }]);
  assert.deepEqual(result.rows, [{ guard: "" }]);
};

test("H04 fixed helpers: exact owned PG 16.15 parse, real roles, catalog locks, mode rejection and retirement mechanisms",
  { skip: toolsDirectory === undefined, timeout: 150_000 }, async t => {
    const cluster = await openCatalogGuardTestCluster(toolsDirectory!);
    const clients: Client[] = [];
    const connect = async (database: "postgres" | "h04_source" | "h04_verification", user: string = h04Roles.administrator) => {
      const client = await cluster.connect(database, user); clients.push(client);
      await client.query("SET statement_timeout='5s'"); return client;
    };
    try {
      const setup = await connect("postgres");
      // These are newly created roles in this verified private child, never existing service roles.
      for (const name of [h04Roles.control, h04Roles.business, h04Roles.verification])
        await setup.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      for (const database of ["h04_source", "h04_verification"] as const)
        await setup.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
      const source = await connect("h04_source"), target = await connect("h04_verification");
      const install = async (client: Client, purpose: "source-control" | "verification-only") => {
        const caller = purpose === "source-control" ? h04Roles.control : h04Roles.verification;
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
        try {
          await client.query(`CREATE SCHEMA "boardroom_catalog_guard_v1" AUTHORIZATION "${h04Roles.administrator}"`);
          await client.query('REVOKE ALL PRIVILEGES ON SCHEMA "boardroom_catalog_guard_v1" FROM PUBLIC');
          await client.query(PG_CATALOG_GUARD_SQL.acquire_share.create);
          await client.query(PG_CATALOG_GUARD_SQL.acquire_sre.create);
          for (const name of ["acquire_share", "acquire_sre"])
            await client.query(`REVOKE ALL PRIVILEGES ON FUNCTION "boardroom_catalog_guard_v1"."${name}"() FROM PUBLIC`);
          await client.query(`GRANT USAGE ON SCHEMA "boardroom_catalog_guard_v1" TO "${caller}"`);
          await client.query(`GRANT EXECUTE ON FUNCTION "boardroom_catalog_guard_v1"."acquire_share"() TO "${caller}"`);
          if (purpose === "source-control")
            await client.query(`GRANT EXECUTE ON FUNCTION "boardroom_catalog_guard_v1"."acquire_sre"() TO "${caller}"`);
          const value = await readFixtureCatalogGuardModule(client, purpose);
          assert.equal(parsePgCatalogGuardModuleObservation(JSON.stringify(value)).ok, true,
            "real installed pg_proc/body/namespace/ACL values must match the fixed module before fixture COMMIT");
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      };
      await t.test("fixed CREATE statements parse and exact real catalogs match both purpose manifests", async () => {
        await install(source, "source-control"); await install(target, "verification-only");
      });
      const control = await connect("h04_source", h04Roles.control), business = await connect("h04_source", h04Roles.business);
      const verification = await connect("h04_verification", h04Roles.verification);
      const pid = Number((await control.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const locks = async (mode: "ShareLock" | "ShareRowExclusiveLock") => (await source.query(`
        SELECT c.relname,c.oid::text AS oid,c.relisshared,l.database::text AS database
        FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
        WHERE l.pid=$1 AND l.locktype='relation' AND l.granted AND l.mode=$2
          AND c.relnamespace='pg_catalog'::regnamespace ORDER BY c.relname COLLATE "C"`, [pid, mode])).rows;
      const expectedLocks = PG_CATALOG_GUARD_MODULE.catalogRelations.map(({ relname, oid, relisshared }) => ({ relname, oid, relisshared }));
      const allLocks = async (mode: "ShareLock" | "ShareRowExclusiveLock") => {
        const rows = await locks(mode);
        assert.deepEqual(rows.map(({ relname, oid, relisshared }) => ({ relname, oid, relisshared })), expectedLocks);
        assert.equal(rows.filter(row => row.database === "0" && row.relisshared).length, 11);
      };
      await t.test("non-superuser C direct and C-owned catalog LOCK remain denied; B has no helper access", async () => {
        const identity = (await control.query("SELECT current_user,session_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS su")).rows[0];
        assert.deepEqual(identity, { current_user: h04Roles.control, session_user: h04Roles.control, su: false });
        await control.query("BEGIN");
        await assert.rejects(control.query('LOCK TABLE ONLY "pg_catalog"."pg_authid" IN SHARE MODE NOWAIT'), { code: "42501" });
        await control.query("ROLLBACK");
        await source.query(`CREATE FUNCTION public.h04_control_owned() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
          AS $$BEGIN LOCK TABLE ONLY pg_catalog.pg_authid IN SHARE MODE NOWAIT; RETURN; END$$`);
        await source.query(`ALTER FUNCTION public.h04_control_owned() OWNER TO "${h04Roles.control}"`);
        await assert.rejects(control.query("SELECT public.h04_control_owned()"), { code: "42501" });
        await source.query("DROP FUNCTION public.h04_control_owned()");
        await assert.rejects(business.query(share), { code: "42501" });
        await assert.rejects(business.query(sre), { code: "42501" });
      });
      for (const [begin, helper, mode] of [
        ["BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE", share, "ShareLock"],
        ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", share, "ShareLock"],
        ["BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE", sre, "ShareRowExclusiveLock"],
      ] as const) await t.test(`${begin}: void return and all 64 actual locks survive the function until native ROLLBACK`, async () => {
        await control.query("SET lock_timeout='200ms'"); await control.query("SET statement_timeout='200ms'");
        await control.query(begin);
        try {
          assertVoid(await control.query(helper)); // First query of this actual transaction.
          await allLocks(mode);
          const identity = (await control.query("SELECT current_user,session_user,current_setting('transaction_read_only') AS ro,pg_current_xact_id_if_assigned()::text AS xid")).rows[0];
          assert.equal(identity.current_user, h04Roles.control); assert.equal(identity.session_user, h04Roles.control);
          if (begin.includes("READ ONLY")) { assert.equal(identity.ro, "on"); assert.equal(identity.xid, null); }
        } finally { await control.query("ROLLBACK"); }
        assert.deepEqual(await locks(mode), []);
      });
      await t.test("wrong modes fail with 25000 and target V cannot execute SRE", async () => {
        for (const [begin, helper] of [
          ["BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY", share],
          ["BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE", share],
          ["BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY", share],
          ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", sre],
        ]) {
          await control.query(begin!);
          await assert.rejects(control.query(helper!), { code: "25000" }); await control.query("ROLLBACK");
        }
        assertVoid(await verification.query(share));
        await assert.rejects(verification.query(sre), { code: "42501" });
      });
      await t.test("first/middle/last catalog conflicts return original NOWAIT error and leave no locks after rollback", async () => {
        for (const index of [0, 31, 63]) {
          const relation = PG_CATALOG_GUARD_MODULE.catalogRelations[index]!.relname;
          await source.query("BEGIN");
          try {
            await source.query(`LOCK TABLE ONLY "pg_catalog"."${relation}" IN ROW EXCLUSIVE MODE NOWAIT`);
            await control.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
            try { await assert.rejects(control.query(share), { code: "55P03" }); }
            finally { await control.query("ROLLBACK"); }
            assert.deepEqual(await locks("ShareLock"), []);
          } finally { await source.query("ROLLBACK"); }
        }
      });
      await t.test("ROLLBACK TO SAVEPOINT actually releases the helper's subsequently acquired catalog locks", async () => {
        await control.query("BEGIN");
        try {
          await control.query("SAVEPOINT before_helper"); assertVoid(await control.query(share)); await allLocks("ShareLock");
          await control.query("ROLLBACK TO SAVEPOINT before_helper"); assert.deepEqual(await locks("ShareLock"), []);
        } finally { await control.query("ROLLBACK"); }
      });
      t.diagnostic(JSON.stringify({ scope: "owned PG16.15 helper mechanisms only", systemIdentifier: cluster.systemIdentifier,
        serverEpochQualification: "NOT_RUN", completeCap01PdO04: "NOT_RUN", fullRestoreR2: "NOT_RUN", productionRegistry: "UNCHANGED_EMPTY" }));
    } finally {
      for (const client of clients.reverse()) await client.end();
      await cluster.close();
    }
  });
