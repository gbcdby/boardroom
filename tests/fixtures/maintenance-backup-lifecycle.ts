import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { runMigrations } from "../../src/server/db/migrate.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { createSqliteMaintenanceAdapter } from "../../src/server/storage/maintenance/sqlite.ts";
import { createPostgresMaintenanceAdapter } from "../../src/server/storage/maintenance/postgres.ts";
import { PostgresDriver } from "../../src/server/db/drivers/postgres.ts";
import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import type { MaintenanceAdapter, OperationMutex } from "../../src/server/storage/maintenance/types.ts";

export async function rejected(operation: Promise<unknown>): Promise<{ failed: boolean; error: unknown }> {
  try { await operation; return { failed: false, error: undefined }; }
  catch (error) { return { failed: true, error }; }
}

export async function postgresBackupFixture(options: { holdDump?: boolean } = {}) {
  const testUrl = process.env.AGENT_STUDIO_PG_TEST_URL;
  if (!testUrl) throw new Error("explicit private PostgreSQL test URL required");
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "br-pg-backup-owner-")));
  const database = `br_d_${randomUUID().replaceAll("-", "")}`, sourceUrl = new URL(testUrl); sourceUrl.pathname = `/${database}`;
  const descriptor = { kind: "postgres" as const, connectionString: sourceUrl.toString() };
  const admin = new Client({ connectionString: testUrl }); admin.on("error", () => {}); await admin.connect();
  let created = false, adapter: MaintenanceAdapter | undefined;
  const dispose = async () => {
    const errors: unknown[] = [];
    if (adapter) { const close = await rejected(adapter.close()); if (close.failed) errors.push(close.error); }
    try {
      if (created) {
        const sessions = await admin.query("SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname=$1", [database]);
        assert.equal(sessions.rows[0].n, "0", "all original source sessions end before dropping the private fixture");
        await admin.query(`DROP DATABASE "${database}"`); created = false;
      }
    } finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
    return errors;
  };
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`); created = true;
    const driver = new PostgresDriver(descriptor);
    try {
      await driver.connect(); await driver.migrate(migrations);
      await driver.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES('d-owner','actual D backup','t','t')");
    } finally { await driver.close(); }
    const held = options.holdDump ? await heldPgDump(directory) : undefined;
    const oldPath = process.env.PATH;
    try {
      // The adapter snapshots its private tool environment during construction.
      if (held) process.env.PATH = `${held.bin}:${oldPath ?? ""}`;
      adapter = await createPostgresMaintenanceAdapter(descriptor, undefined);
    } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
    const initial = await adapter.observe(), store = await ArtifactStore.create(path.join(directory, "control"), initial.source);
    const mutex = await adapter.acquireMutex(store.identity, initial.state);
    await sealBackupFixture(adapter, store, mutex);
    const attempt = await store.createAttempt(1), destination = path.join(attempt, "database.dump");
    return { directory, database, descriptor, adapter, store, mutex, destination, held, dispose };
  } catch (error) { await dispose(); throw error; }
}
export function errorLeaves(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(errorLeaves) : [error];
}

/** Executes the real pg_dump with unchanged argv/stdio, then holds only the owned wrapper's completion. */
export async function heldPgDump(directory: string) {
  const realDump = execFileSync("which", ["pg_dump"], { encoding: "utf8" }).trim();
  assert.ok(realDump.startsWith("/"));
  const bin = path.join(directory, "held-tool"), ready = path.join(directory, "dump-done"), release = path.join(directory, "dump-release");
  await mkdir(bin, { mode: 0o700 });
  const script = `#!/usr/bin/env node
const {spawn}=require('node:child_process');
const {existsSync,writeFileSync}=require('node:fs');
const args=process.argv.slice(2), child=spawn(${JSON.stringify(realDump)},args,{stdio:'inherit'});
let ended=false,stop=false;
process.on('SIGTERM',()=>{stop=true;if(ended)process.exit(0);else child.kill('SIGTERM');});
child.on('error',()=>process.exit(91));
child.on('close',(code,signal)=>{
  ended=true;
  if(code!==0||signal)process.exit(code||92);
  if(args.includes('--version')||stop)process.exit(0);
  writeFileSync(${JSON.stringify(ready)},'real-pg-dump-complete',{mode:0o600});
  setInterval(()=>{if(existsSync(${JSON.stringify(release)}))process.exit(0);},10);
});
`;
  await writeFile(path.join(bin, "pg_dump"), script, { mode: 0o700 });
  return { bin, ready, release };
}

export async function waitForOwnedMarker(file: string) {
  const until = performance.now() + 30_000;
  while (true) {
    try { await access(file); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    assert.ok(performance.now() < until, "the fixed real-tool fixture reached its owned marker");
    await delay(10);
  }
}

export async function waitForOwnedStage(stage: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([stage, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("the fixed real-tool fixture did not reach its owned stage")), 30_000);
    })]);
  } finally { clearTimeout(timeout); }
}

/** Real native anchors for D only. These deliberately do not claim Jq/Fs/profile qualification. */
export async function sealBackupFixture(adapter: MaintenanceAdapter, store: ArtifactStore, mutex: OperationMutex) {
  for (const admission of ["draining", "sealed"] as const) await adapter.withSourceLock("control", async lock => {
    const before = await lock.observe();
    const journal = await store.putJson("journal", { fixture: "native-D-lifecycle", admission,
      migrationId: "backup-lifecycle-fixture", sequence: before.state.journalSequence + 1 });
    await lock.anchor({ expected: before.state, admission,
      fenceEpoch: before.state.fenceEpoch + (admission === "draining" ? 1 : 0),
      ownerGeneration: before.state.ownerGeneration + (admission === "draining" ? 1 : 0),
      activeMigrationId: "backup-lifecycle-fixture", planDigest: "c".repeat(64),
      controlRootIdentity: { ...store.identity }, mutexIdentity: mutex.identity, journal,
      journalSequence: before.state.journalSequence + 1 });
  });
}

export async function sqliteBackupFixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "br-backup-owner-")));
  const file = path.join(directory, "source.sqlite"), bootstrap = new Database(file);
  try { bootstrap.exec("CREATE TABLE extra_values(value)"); runMigrations(bootstrap, migrations); bootstrap.pragma("journal_mode=WAL"); }
  finally { bootstrap.close(); }
  const writer = new Database(file); writer.pragma("wal_checkpoint(TRUNCATE)");
  writer.exec("INSERT INTO extra_values VALUES(9223372036854775807),(x'00ff'),('same'),('same')");
  const identity = await stat(file, { bigint: true });
  const descriptor = { kind: "sqlite" as const, dataDir: directory, sourcePath: file, sqlitePath: file,
    identity: { device: String(identity.dev), inode: String(identity.ino) } };
  const adapter = await createSqliteMaintenanceAdapter(descriptor);
  const initial = await adapter.observe(), store = await ArtifactStore.create(path.join(directory, "control"), initial.source);
  const mutex = await adapter.acquireMutex(store.identity, initial.state);
  await sealBackupFixture(adapter, store, mutex);
  const attempt = await store.createAttempt(1), destination = path.join(attempt, "database.sqlite");
  assert.ok((await stat(file + "-wal")).size > 0, "the real backup source includes committed WAL");
  return { directory, file, descriptor, adapter, store, mutex, destination,
    async dispose() {
      const cleanup = await rejected(adapter.close());
      if (writer.open) writer.close();
      await rm(directory, { recursive: true, force: true });
      return cleanup;
    } };
}
