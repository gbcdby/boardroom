import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Client } from "pg";
import type { QueryResult } from "pg";
import { captureFixture } from "./fixtures/maintenance-capture.ts";
import { withSqliteSourceInventoryDiagnostics } from "./fixtures/maintenance-source-inventory-diagnostic.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain, verifySnapshotClosure } from "../src/server/storage/maintenance/journal.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { enterMaintenance } from "./fixtures/maintenance-preview-graph.ts";
import { captureMaintenance } from "../src/server/storage/maintenance/capture.ts";
import type { ContinueRequest, OperationMutex } from "../src/server/storage/maintenance/types.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { readSourceFiles } from "../src/server/storage/maintenance/parse.ts";
import { publishSnapshotBundle } from "../src/server/storage/maintenance/snapshot-bundle.ts";
import { verifyRestoreBundle } from "../src/server/storage/maintenance/verify-bundle.ts";
import { stageSnapshotReady } from "../src/server/storage/maintenance/snapshot-ready.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import { finishControllerOwner } from "./fixtures/maintenance-capture.ts";
import type { ControllerOwner } from "../src/server/storage/maintenance/controller-owner.ts";

// Coverage: postgres core (raw roster / replay / lost mutex / actual artifacts / next entry / extra owner).
// The positive S fixture uses the actual Linux ordinary source-FD bridge. It is
// explicit engineering evidence, not a Darwin or qualified-profile positive.
const supported = process.platform === "linux";
const uncertainFixtureCleanup: (() => Promise<void>)[] = [];
after(async () => {
  const errors: unknown[] = [];
  for (const close of uncertainFixtureCleanup) try { await close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "private unknown-close fixture cleanup failed");
});
before(() => {
  if (!supported) return;
  const built = spawnSync(process.execPath,
    [fileURLToPath(new URL("../scripts/build-maintenance-platform.mjs", import.meta.url)), "--source-files"],
    { encoding: "utf8", timeout: 60_000 });
  assert.equal(built.status, 0, built.stderr);
});
for (const kind of ["postgres"] as ("sqlite" | "postgres")[]) {
  const nativeTest = supported && (kind === "sqlite" || process.env.AGENT_STUDIO_PG_TEST_URL) ? test : test.skip;
  nativeTest("#152 C1 " + kind + ": real raw roster and five frozen domain changes reject without publication", async t => {
    for (const point of ["row-delete", "same-count-replacement", "bad-receipt-generation", "r0", "business", "schema"] as const)
      await t.test(point, async () => {
        const f = await captureFixture(kind);
        try {
          if (["row-delete", "same-count-replacement", "business"].includes(point))
            assert.equal((await f.capture(f.options, f.request)).status, "paused");
          if (point === "row-delete") await f.exec("DELETE FROM storage_source_clients");
          if (point === "same-count-replacement") await f.exec("UPDATE storage_source_clients SET client_id='different-client'");
          if (point === "bad-receipt-generation") {
            const row = (await f.query("SELECT db_sessions_json FROM storage_source_clients"))[0]!;
            const envelope = JSON.parse(String(row.db_sessions_json)); envelope.drainReceipt.ownerGeneration++;
            await f.exec("UPDATE storage_source_clients SET db_sessions_json='" + JSON.stringify(envelope).replaceAll("'", "''") + "'");
          }
          if (point === "r0") await f.exec("UPDATE storage_source_clients SET entrypoint='maintenance-controller'");
          if (point === "business") {
            // Explicit private corruption input. Restore every control field in
            // the same real transaction before C observes the changed business row.
            const state = (await f.observe()).state;
            await f.exec("BEGIN; UPDATE storage_maintenance SET admission='open',active_migration_id=NULL,plan_digest=NULL; "
              + "UPDATE enter_observation SET value='changed after capture'; UPDATE storage_maintenance SET admission='sealed',"
              + "active_migration_id='" + state.activeMigrationId + "',plan_digest='" + state.planDigest + "'; COMMIT;");
          }
          if (point === "schema") await f.exec("CREATE TABLE unexpected_c1_table(value TEXT)");
          const before = await f.query("SELECT * FROM storage_maintenance"); f.state.events.length = 0;
          await assert.rejects(f.capture(f.options, f.request));
          assert.deepEqual(await f.query("SELECT * FROM storage_maintenance"), before); assert.deepEqual(f.state.events, []);
        } finally { await f.close(); }
      });
  });
  nativeTest("#152 C1 " + kind + ": replay requires every old Fs and payload byte", async t => {
    for (const point of ["missing-Fs", "missing-payload", "changed-payload"] as const) await t.test(point, async () => {
      const f = await captureFixture(kind);
      try {
        const first = await f.capture(f.options, f.request); assert.equal(first.status, "paused");
        if (first.status !== "paused") throw new Error("paused required");
        const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
        const chain = await verifyJournalChain(store, first.ref.journal), record = chain.nodes.at(-1)!.record; assert(record.frozen);
        const files = await readSourceFiles(store, record.frozen.sourceFilesManifest);
        const payload = files.entries.find(entry => entry.payload)!.payload!;
        const file = store.pathFor(point === "missing-Fs" ? record.frozen.sourceFilesManifest : payload);
        const bytes = await readFile(file), before = await f.observe(); f.state.events.length = 0;
        if (point === "changed-payload") await writeFile(file, Buffer.concat([bytes, Buffer.from("corruption")]));
        else await rename(file, file + ".held");
        assert.equal((await f.capture(f.options, f.request)).status, "recovery_required");
        assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
        if (point !== "changed-payload") await rename(file + ".held", file);
      } finally { await f.close(); }
    });
  });


  nativeTest("#152 C1 " + kind + ": lost mutex never releases the still-active source transaction", async t => {
    const f = await captureFixture(kind);
    let other: Awaited<ReturnType<typeof f.createAdapter>> | undefined;
    let otherMutex: OperationMutex | undefined, pgMutexClient: Client | undefined;
    let held!: OperationMutex, release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { reached = resolve; });
    let running: ReturnType<typeof f.capture> | undefined;
    try {
      const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      f.state.onOwner = owner => {
        const acquire = owner.adapter.acquireMutex.bind(owner.adapter);
        owner.adapter.acquireMutex = async (...args) => held = await acquire(...args);
      };
      f.state.hook = async stage => { if (stage === "capture-begin") { reached(); await gate; } };
      if (kind === "postgres") {
        const query = Client.prototype.query;
        t.mock.method(Client.prototype, "query", async function(this: Client, ...args: unknown[]) {
          const result = await Reflect.apply(query, this, args) as QueryResult;
          const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
          if (!pgMutexClient && database === f.database && typeof args[0] === "string"
            && args[0].startsWith("SELECT pg_catalog.pg_try_advisory_lock") && result.rows[0]?.acquired === true)
            pgMutexClient = this;
          return result;
        } as typeof query);
      }
      running = f.capture(f.options, f.request);
      await Promise.race([started, running.then(() => { throw new Error("C did not retain its source transaction"); })]);
      if (kind === "sqlite") await held.release();
      else {
        // The PG API correctly forbids normal release during its source callback.
        // Lose only the genuine original advisory lock, on its actual private session.
        await assert.rejects(held.release(), { code: "maintenance_busy" });
        assert(pgMutexClient); await pgMutexClient.query("SELECT pg_catalog.pg_advisory_unlock_all()");
      }
      other = await f.createAdapter();
      if (kind === "sqlite") {
        // SQLite's mutex bind first requires the actual source write lock, so the
        // retained original transaction blocks this earlier boundary already.
        await assert.rejects(other.acquireMutex(store.identity, (await other.observe()).state), { code: "maintenance_busy" });
      } else {
        otherMutex = await other.acquireMutex(store.identity, (await other.observe()).state);
        let entered = false;
        await assert.rejects(other.withSourceLock("control", async () => { entered = true; }), { code: "maintenance_busy" });
        assert.equal(entered, false, "a new advisory mutex cannot overlap the old real source critical section");
        await otherMutex.release(); otherMutex = undefined;
      }
      await other.close(); other = undefined;
      release(); await assert.rejects(running, error => {
        const first = error instanceof AggregateError ? error.errors[0] : error;
        return first instanceof MaintenanceFailure && first.code === "maintenance_lost";
      }); running = undefined;
      assert.deepEqual(await f.observe(), before);
      delete f.state.onOwner; f.state.hook = () => {};
      assert.equal((await f.capture(f.options, f.request)).status, "paused");
    } finally {
      release(); await running?.catch(() => {}); t.mock.restoreAll();
      try { await otherMutex?.release(); } finally { await other?.close(); await f.close(); }
    }
  });
  nativeTest("#152 C1 " + kind + ": actual v2 C artifacts feed existing D B V R Jr without widening default readers", async () => {
    const f = await captureFixture(kind, { sessions: true });
    let admin: Client | undefined, targetName: string | undefined, targetUrl: string | undefined;
    let adapter: Awaited<ReturnType<typeof f.createAdapter>> | undefined, mutex: OperationMutex | undefined;
    try {
      const captured = await f.capture(f.options, f.request); assert.equal(captured.status, "paused");
      if (captured.status !== "paused") throw new Error("paused required");
      const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      if (kind === "postgres") {
        assert(process.env.AGENT_STUDIO_PG_TEST_URL);
        admin = new Client({ connectionString: process.env.AGENT_STUDIO_PG_TEST_URL }); admin.on("error", () => {}); await admin.connect();
        targetName = "br_c1_verify_" + randomUUID().replaceAll("-", "");
        await admin.query('CREATE DATABASE "' + targetName + '" TEMPLATE template0 ENCODING \'UTF8\' LC_COLLATE \'C\' LC_CTYPE \'C\'');
        const url = new URL(process.env.AGENT_STUDIO_PG_TEST_URL); url.pathname = "/" + targetName; targetUrl = url.toString();
        assert(f.descriptor.kind === "postgres");
        adapter = await createPostgresMaintenanceAdapter(f.descriptor, { kind: "postgres", connectionString: targetUrl });
      } else adapter = await f.createAdapter();
      mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
      const actual = adapter;
      const input = await adapter.withSourceLock("snapshot", async lock => {
        const refs = await publishSnapshotBundle(store, lock);
        const verification = await verifyRestoreBundle(store, actual, lock, refs.bundle, refs.publication);
        return { ...refs, verification };
      });
      const held = mutex;
      const ready = await adapter.withSourceLock("control", lock => stageSnapshotReady(store, lock, held, input,
        { ...f.request, expectedPhase: "quiesced", expectedJournalDigest: captured.ref.journal.sha256, requestId: "c1-ready" }));
      const closure = await verifySnapshotClosure(store, ready.journal);
      assert.deepEqual(closure.receipt.capture, captured.ref);
      assert.equal(closure.chain.nodes.at(-1)!.record.formatVersion, 2);
      const after = await adapter.observe();
      assert.equal(after.state.ownerGeneration, before.state.ownerGeneration);
      assert.equal(after.state.journalSequence, 3);
      assert.equal(after.manifests.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
      await mutex.release(); mutex = undefined; await adapter.close(); adapter = undefined;
      await assert.rejects(f.capture(f.options, f.request), { code: "phase_conflict" });
    } finally {
      try { await mutex?.release(); await adapter?.close(); }
      finally {
        try { if (admin && targetName) await admin.query('DROP DATABASE "' + targetName + '"'); }
        finally { await admin?.end(); await f.close(); }
      }
    }
  });


  nativeTest("#152 C1 " + kind + ": next entry awaits the same actual owner while post-release cleanup is in flight", async t => {
    for (const fail of [false, true]) await t.test(fail ? "same close rejection" : "successful completion", async () => {
    const f = await captureFixture(kind);
    const failure = new MaintenanceFailure("maintenance_lost", "c1-concurrent-close"); let closeCalls = 0;
    let released!: () => void, resume!: () => void, newOwner!: () => void;
    const atRelease = new Promise<void>(resolve => { released = resolve; });
    const finishRelease = new Promise<void>(resolve => { resume = resolve; });
    const secondOwner = new Promise<void>(resolve => { newOwner = resolve; });
    let first: ReturnType<typeof f.capture> | undefined, second: ReturnType<typeof f.capture> | undefined;
    try {
      f.state.onOwner = owner => {
        const close = owner.adapter.close.bind(owner.adapter);
        owner.adapter.close = async () => { await close(); closeCalls++; if (fail && closeCalls === 1) throw failure; };
        const acquire = owner.adapter.acquireMutex.bind(owner.adapter);
        owner.adapter.acquireMutex = async (...args) => {
          const mutex = await acquire(...args), release = mutex.release.bind(mutex);
          mutex.release = async () => { await release(); released(); await finishRelease; };
          return mutex;
        };
      };
      first = f.capture(f.options, f.request); void first.catch(() => {});
      await Promise.race([atRelease, first.then(() => { throw new Error("missing actual release boundary"); })]);
      f.state.onOwner = () => { newOwner(); };
      second = f.capture(f.options, f.request); void second.catch(() => {});
      const overlapped = await Promise.race([secondOwner.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 500))]);
      assert.equal(overlapped, false, "creating a fresh owner before prior cleanup ends bypasses its unknown-close barrier");
      resume();
      if (fail) {
        await assert.rejects(second, error => error === failure);
        await assert.rejects(first, error => error === failure);
        assert.equal(closeCalls, 1, "waiting callers cannot replace the shared failed close with another cleanup");
        delete f.state.onOwner;
        assert.equal((await f.capture(f.options, f.request)).status, "paused");
        assert.equal(closeCalls, 2, "a later explicit call may finish the retained original cleanup");
      } else assert.deepEqual(await second, await first);
    } finally { resume(); await first?.catch(() => {}); await second?.catch(() => {}); await f.close(); }
    });
  });


  nativeTest("#152 C1 " + kind + ": a real extra source owner cannot be mistaken for a drained diagnostic parent", async () => {
    const f = await captureFixture(kind), other = kind === "sqlite" ? await f.createAdapter() : undefined;
    const backend = kind === "postgres" ? await f.connect() : undefined;
    try {
      const before = await f.observe();
      await assert.rejects(f.capture(f.options, f.request), { code: "source_writer_unknown" });
      assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
      await other?.close(); if (backend) await f.closeClient(backend);
      assert.equal((await f.capture(f.options, f.request)).status, "paused");
    } finally { await other?.close(); await f.close(); }
  });
}
