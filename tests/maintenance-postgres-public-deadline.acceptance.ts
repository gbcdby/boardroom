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
import { maintenanceHostIdentityDigest } from "../src/server/storage/maintenance/host.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import type { MaintenanceAdapter, OperationMutex } from "../src/server/storage/maintenance/types.ts";

const url = process.env["AGENT_STUDIO_PG_TEST_URL"];
const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function tool(name: string) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const path = resolve(directory, name); try { await access(path, constants.X_OK); return path; } catch { /* next configured path */ }
  }
  throw new Error("the real PostgreSQL 16 tools are required");
}

// Deliberately outside the fast npm-test glob: this acceptance consumes the actual 300-second
// contract once, without changing any production timeout or claiming a shortened clock is real.
test("#152 public restore shares the actual 300-second deadline across rendering and native transaction execution",
  { skip: url === undefined, timeout: 340_000 }, async () => {
    const id = randomUUID().replaceAll("-", ""), sourceName = `br_deadline_source_${id}`, targetName = `br_deadline_target_${id}`;
    const directory = await mkdtemp(join(tmpdir(), "br-public-deadline-")); await chmod(directory, 0o700);
    const info = await lstat(directory, { bigint: true });
    const root = { path: directory, device: String(info.dev), inode: String(info.ino), hostIdentityDigest: await maintenanceHostIdentityDigest() };
    const descriptor = (name: string) => { const connection = new URL(url!); connection.pathname = `/${name}`; return { kind: "postgres" as const, connectionString: connection.toString(), schema: "public" }; };
    const admin = new Client({ connectionString: url }); admin.on("error", () => {}); await admin.connect();
    const created: { name: string; oid: string }[] = [];
    let adapter: MaintenanceAdapter | undefined, mutex: OperationMutex | undefined;
    const namespaceState = async () => {
      const client = new Client({ connectionString: descriptor(targetName).connectionString }); await client.connect();
      try { return (await client.query(`SELECT oid::text,nspowner::text,nspacl::text,pg_catalog.obj_description(oid,'pg_namespace') AS comment,
        (SELECT count(*)::text FROM pg_catalog.pg_class WHERE relnamespace=n.oid) AS relations FROM pg_catalog.pg_namespace n WHERE nspname='public'`)).rows; }
      finally { await client.end(); }
    };
    try {
      for (const name of [sourceName, targetName]) {
        await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`);
        const oid = (await admin.query("SELECT oid::text FROM pg_catalog.pg_database WHERE datname=$1", [name])).rows[0].oid;
        created.push({ name, oid });
      }
      const driver = new PostgresDriver({ connectionString: descriptor(sourceName).connectionString, schema: "public" });
      try { await driver.connect(); await driver.migrate(migrations); } finally { await driver.close(); }
      const realRestore = await tool("pg_restore"), realPsql = await tool("psql"), tools = join(directory, "tools"), marker = join(directory, "psql-pid");
      await mkdir(tools, { mode: 0o700 });
      // Two ten-second pre-exec holds in the real native render stages expose an incorrect
      // per-child reset: that implementation would finish cancellation near 320s, not 300s.
      await writeFile(join(tools, "pg_restore"), `#!/bin/sh\nfor arg in "$@"; do case "$arg" in --use-list=*) /bin/sleep 10 ;; esac; done\nexec ${shellQuote(realRestore)} "$@"\n`, { mode: 0o700 });
      const hold = "SELECT pg_sleep(CASE WHEN current_setting('statement_timeout')='0' THEN 310 ELSE 0 END)";
      await writeFile(join(tools, "psql"), `#!/bin/sh\nif [ "$1" = --version ]; then exec ${shellQuote(realPsql)} "$@"; fi\nprintf '%s' "$$" > ${shellQuote(marker)}\nexec ${shellQuote(realPsql)} "$@" -c ${shellQuote(hold)}\n`, { mode: 0o700 });
      const oldPath = process.env.PATH;
      try { process.env.PATH = `${tools}:${oldPath ?? ""}`; adapter = await createPostgresMaintenanceAdapter(descriptor(sourceName), descriptor(targetName)); }
      finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
      const before = await namespaceState();
      mutex = await adapter.acquireMutex(root, (await adapter.observe()).state);
      for (const admission of ["draining", "sealed"] as const) await adapter.withSourceLock("control", async lock => {
        const observed = await lock.observe();
        await lock.anchor({ expected: observed.state, admission, fenceEpoch: observed.state.fenceEpoch + (admission === "draining" ? 1 : 0),
          ownerGeneration: observed.state.ownerGeneration + (admission === "draining" ? 1 : 0), activeMigrationId: "deadline-fixture", planDigest: "a".repeat(64),
          controlRootIdentity: root, mutexIdentity: mutex!.identity, journalSequence: observed.state.journalSequence + 1,
          journal: { ref: `deadline-${admission}`, sha256: "b".repeat(64), bytes: "1" } });
      });
      let started = 0, elapsed = 0;
      const operation = adapter.withSourceLock("snapshot", async lock => {
        const archive = join(directory, "deadline.dump"), backup = await lock.backup(archive);
        started = performance.now();
        try { return await adapter!.verifyDatabase(archive, backup.manifests, directory); }
        finally { elapsed = performance.now() - started; }
      }).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
      let backend: { pid: number; backend_start: string } | undefined, nativeStartedAfter = 0;
      const observationLimit = performance.now() + 60_000;
      while (performance.now() < observationLimit) {
        backend = (await admin.query(`SELECT pid,backend_start::text FROM pg_catalog.pg_stat_activity WHERE datname=$1
          AND application_name LIKE 'boardroom-public-restore:%' AND state='active' AND query=$2`, [targetName, hold])).rows[0];
        if (backend) { nativeStartedAfter = performance.now() - started; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(backend, "the actual native backend must enter its transaction with native statement_timeout cleared");
      assert.ok(nativeStartedAfter >= 20_000, "both native render stages must spend their real prefix time");
      const outcome = await operation;
      assert.match(String(outcome.error), /restore_verification_unavailable/);
      assert.ok(elapsed >= 300_000 && elapsed < 305_000, `whole-pipeline duration ${elapsed}ms must use the unchanged 300s budget`);
      assert.deepEqual(await namespaceState(), before);
      assert.equal((await admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz",
        [backend.pid, backend.backend_start])).rows[0].count, "0");
      const nativePid = Number(await readFile(marker, "utf8")); assert.ok(Number.isSafeInteger(nativePid) && nativePid > 1);
      assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
      assert.equal((await adapter.observe()).state.admission, "sealed");
      const evidenceDirectory = resolve(".agent-output/public-native-r2"); await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(evidenceDirectory, "deadline-acceptance.json"), JSON.stringify({ profile: "pg16-public-native-segments-v1",
        nativePrefixMilliseconds: nativeStartedAfter, totalRestoreMilliseconds: elapsed, contractMilliseconds: 300_000,
        nativeStatementTimeoutWasZero: true, targetExactPrestatePreserved: true, nativeChildExited: true, ownedBackendExited: true,
        sourceAdmission: "sealed", fault: "owned real renderer prefix plus native psql in-transaction sleep" }, null, 2) + "\n", { mode: 0o600 });
      await mutex.release(); mutex = undefined;
    } finally {
      await adapter?.close();
      for (const owned of created.reverse()) {
        assert.equal((await admin.query("SELECT oid::text FROM pg_database WHERE datname=$1", [owned.name])).rows[0]?.oid, owned.oid);
        await admin.query(`DROP DATABASE ${quote(owned.name)}`);
      }
      await admin.end(); await rm(directory, { recursive: true, force: true });
    }
  });
