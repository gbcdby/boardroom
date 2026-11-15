import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createPostgresMaintenanceAdapter } from "../../src/server/storage/maintenance/postgres.ts";
import { publishSnapshotBundle } from "../../src/server/storage/maintenance/snapshot-bundle.ts";
import type { SourceLock } from "../../src/server/storage/maintenance/types.ts";
import { snapshotBundleFixture } from "./maintenance-snapshot-bundle.ts";

/** Reuses D's exact real source/capture fixture. Its Fs incarnation bytes remain
 * explicit protocol fixtures, not provider or source-preservation qualification. */
export async function verificationBundleFixture(kind: "sqlite" | "postgres" = "sqlite") {
  const f = await snapshotBundleFixture(kind);
  let adapter = f.adapter, mutex = f.mutex, admin: Client | undefined, targetName: string | undefined, targetUrl: string | undefined;
  const close = async () => {
    try { await mutex.release(); await adapter.close(); }
    finally {
      try { if (admin && targetName) await admin.query(`DROP DATABASE "${targetName}"`); }
      finally { try { await admin?.end(); } finally { await f.close(); } }
    }
  };
  try {
    if (kind === "postgres") {
      assert(process.env.AGENT_STUDIO_PG_TEST_URL);
      admin = new Client({ connectionString: process.env.AGENT_STUDIO_PG_TEST_URL }); admin.on("error", () => {}); await admin.connect();
      const name = `br_verify_bundle_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`); targetName = name;
      const url = new URL(process.env.AGENT_STUDIO_PG_TEST_URL); url.pathname = `/${name}`; targetUrl = url.toString();
      await mutex.release(); await adapter.close();
      assert(f.descriptor.kind === "postgres");
      adapter = await createPostgresMaintenanceAdapter(f.descriptor, { kind: "postgres", connectionString: targetUrl });
      mutex = await adapter.acquireMutex(f.store.identity, (await adapter.observe()).state);
    }
    const run = <T>(consume: (lock: SourceLock) => Promise<T>): Promise<T> => adapter.withSourceLock("snapshot", consume);
    const publish = (lock: SourceLock) => publishSnapshotBundle(f.store, lock);
    const readTarget = async (sql: string) => {
      assert(targetUrl); const client = new Client({ connectionString: targetUrl }); await client.connect();
      try { return (await client.query(sql)).rows; } finally { await client.end(); }
    };
    return { ...f, adapter, mutex, targetName, admin, run, publish, readTarget, close };
  } catch (error) { await close(); throw error; }
}
