import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Client, type QueryResult } from "pg";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { enterFixture } from "./fixtures/maintenance-enter.ts";
import { enterMaintenance } from "../src/server/storage/maintenance/enter.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain } from "../src/server/storage/maintenance/journal.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { openNativeManagementSource } from "../src/server/storage/native-management-admission.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { persistMigrationPlan, planMigration } from "../src/server/storage/maintenance/plan.ts";
import type { ContinueRequest } from "../src/server/storage/maintenance/types.ts";

const supported = ["linux", "darwin"].includes(process.platform);
for (const kind of ["sqlite", "postgres"] as const) {
  const nativeTest = supported && (kind === "sqlite" || process.env.AGENT_STUDIO_PG_TEST_URL) ? test : test.skip;
  nativeTest(`#152 internal enter ${kind}: real saved P becomes exactly one planned/draining anchor and gates new work`, async () => {
    const f = await enterFixture(kind);
    try {
      const result = await enterMaintenance(f.options, f.request);
      assert.equal(result.status, "paused"); if (result.status !== "paused") throw new Error("paused required");
      assert.equal(result.phase, "planned");
      const current = await f.observe();
      assert.equal(current.state.admission, "draining"); assert.equal(current.state.fenceEpoch, f.initial.state.fenceEpoch + 1);
      assert.equal(current.state.ownerGeneration, f.initial.state.ownerGeneration + 1);
      assert.equal(current.state.journalRecordRef, result.ref.journal.ref); assert.equal(current.state.journalSequence, 1);
      assert.equal(current.state.journalDigest, result.ref.journal.sha256); assert.equal(current.state.planDigest, f.reference.planDigest);
      assert.equal(current.manifests.frozenBusinessManifestDigest, f.initial.manifests.frozenBusinessManifestDigest);
      assert.deepEqual(current.clients, f.initial.clients);
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source), chain = await verifyJournalChain(store, result.ref.journal);
      assert.equal(chain.nodes.length, 1); const record = chain.nodes[0]!.record;
      assert.equal(record.formatVersion, 2); assert.equal(record.event, "enter"); assert.equal(record.previous, null);
      assert.equal(record.snapshot, null); assert.equal(record.frozen, null);
      if (record.formatVersion === 2) assert.equal(record.sourceClients, null);
      assert.deepEqual(record.plan, f.reference.immutablePlan);
      const driver = f.descriptor.kind === "sqlite" ? new SqliteDriver({ dataDir: f.dataDir, sqlitePath: f.file, sqliteSource: f.descriptor })
        : new PostgresDriver({ connectionString: f.descriptor.connectionString });
      try { await assert.rejects(driver.connect(), /storage_maintenance/); } finally { await driver.close(); }
      if (f.descriptor.kind === "sqlite") await assert.rejects(openNativeManagementSource({ source: f.descriptor, mode: "write" }), /storage_maintenance/);
    } finally { await f.close(); }
  });
  nativeTest(`#152 internal enter ${kind}: same request replay selects the exact head without another journal or generation`, async () => {
    const f = await enterFixture(kind);
    try {
      const first = await enterMaintenance(f.options, f.request), before = await f.observe();
      const names = await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId));
      assert.deepEqual(await enterMaintenance(f.options, f.request), first);
      assert.deepEqual((await f.observe()).state, before.state);
      assert.deepEqual(await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId)), names);
    } finally { await f.close(); }
  });
  nativeTest(`#152 internal enter ${kind}: actual old counters and post-preview business changes are authoritative`, async () => {
    const f = await enterFixture(kind);
    try {
      await f.exec("UPDATE storage_maintenance SET fence_epoch=5,owner_generation=9; INSERT INTO enter_observation VALUES('work after preview')");
      const before = await f.observe(), result = await enterMaintenance(f.options, f.request);
      assert.equal(result.status, "paused"); const current = await f.observe();
      assert.equal(current.state.fenceEpoch, 6); assert.equal(current.state.ownerGeneration, 10);
      assert.equal(current.manifests.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
      assert.equal((await f.query("SELECT * FROM enter_observation")).length, 2);
    } finally { await f.close(); }
  });
  nativeTest(`#152 internal enter ${kind}: strict request and replay digest conflicts never advance the anchor`, async () => {
    const f = await enterFixture(kind);
    try {
      for (const input of [
        { ...f.request, adapter: {} }, { ...f.request, plan: { ...f.reference, verified: true } },
        { ...f.request, requestId: "../bad" }, { ...f.request, expectedPhase: undefined },
        { ...f.request, expectedSource: { ...f.plan.source, identityDigest: "bad" } },
        { ...f.request, plan: { ...f.reference, immutablePlan: { ...f.reference.immutablePlan, bytes: "01" } } },
      ]) await assert.rejects(enterMaintenance(f.options, input as ContinueRequest), { code: "request_conflict" });
      assert.deepEqual((await f.observe()).state, f.initial.state);
      await assert.rejects(enterMaintenance(f.options, { ...f.request, expectedPhase: "planned" }), { code: "phase_conflict" });
      const first = await enterMaintenance(f.options, f.request); assert.equal(first.status, "paused");
      if (first.status !== "paused") throw new Error("paused required");
      const before = (await f.observe()).state;
      for (const patch of [{ expectedPhase: "planned" as const }, { expectedJournalDigest: first.ref.journal.sha256 },
        { requestId: "different-request", expectedPhase: "planned" as const, expectedJournalDigest: first.ref.journal.sha256 }])
        await assert.rejects(enterMaintenance(f.options, { ...f.request, ...patch }), { code: "request_conflict" });
      assert.deepEqual((await f.observe()).state, before);
    } finally { await f.close(); }
  });
  nativeTest(`#152 internal enter ${kind}: saved P, config, schema, cwd, target and source selection drift are rejected`, async () => {
    const f = await enterFixture(kind);
    try {
      const planPath = path.join(f.reference.controlRoot, f.reference.immutablePlan.ref), bytes = await readFile(planPath);
      await writeFile(planPath, Buffer.concat([bytes, Buffer.from(" ")]));
      await assert.rejects(enterMaintenance(f.options, f.request), /snapshot_invalid/); await writeFile(planPath, bytes);
      await rename(planPath, `${planPath}.missing`);
      await assert.rejects(enterMaintenance(f.options, f.request), { code: "ENOENT" }); await rename(`${planPath}.missing`, planPath);
      const config = await readFile(f.configFile); await writeFile(f.configFile, Buffer.concat([config, Buffer.from(" ")]));
      await assert.rejects(enterMaintenance(f.options, f.request), { code: "plan_stale" }); await writeFile(f.configFile, config);
      await f.exec("CREATE VIEW changed_enter_schema AS SELECT value FROM enter_observation");
      await assert.rejects(enterMaintenance(f.options, f.request), { code: "plan_stale" }); await f.exec("DROP VIEW changed_enter_schema");
      await mkdir(f.options.targetRoot);
      await assert.rejects(enterMaintenance(f.options, f.request), { code: "plan_stale" }); await rm(f.options.targetRoot, { recursive: true });
      await assert.rejects(enterMaintenance({ ...f.options, originalCwd: f.dataDir }, f.request), { code: "plan_stale" });
      await assert.rejects(enterMaintenance({ ...f.options, expectedSourceId: "another-source" }, f.request), { code: "source_changed" });
      assert.deepEqual((await f.observe()).state, f.initial.state);
    } finally { await f.close(); }
  });
  nativeTest(`#152 internal enter ${kind}: damaged exact head requires recovery and never selects an orphan`, async () => {
    const f = await enterFixture(kind);
    try {
      const first = await enterMaintenance(f.options, f.request); assert.equal(first.status, "paused");
      if (first.status !== "paused") throw new Error("paused required");
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source), before = (await f.observe()).state;
      const record = await store.readJson(first.ref.journal, "journal") as Record<string, unknown>;
      const orphan = await store.putJson("journal", { ...record, requestId: "orphan", requestDigest: "f".repeat(64) });
      const file = store.pathFor(first.ref.journal), bytes = await readFile(file);
      for (const mode of ["missing", "bytes", "sequence", "generation"] as const) {
        if (mode === "missing") await rename(file, `${file}.saved`);
        if (mode === "bytes") await writeFile(file, Buffer.alloc(bytes.length, 32));
        if (mode === "sequence") await f.exec("UPDATE storage_maintenance SET journal_sequence=2");
        if (mode === "generation") await f.exec("UPDATE storage_maintenance SET owner_generation=9");
        const observed = (await f.observe()).state, result = await enterMaintenance(f.options, f.request);
        assert.equal(result.status, "recovery_required"); assert.deepEqual((await f.observe()).state, observed);
        assert.notEqual(observed.journalRecordRef, orphan.ref);
        if (mode === "missing") await rename(`${file}.saved`, file);
        if (mode === "bytes") await writeFile(file, bytes);
        if (mode === "sequence") await f.exec(`UPDATE storage_maintenance SET journal_sequence=${before.journalSequence}`);
        if (mode === "generation") await f.exec(`UPDATE storage_maintenance SET owner_generation=${before.ownerGeneration}`);
      }
      assert.deepEqual(await enterMaintenance(f.options, f.request), first);
    } finally { await f.close(); }
  });
  nativeTest(`#152 internal enter ${kind}: publication failures leave only unanchored files and require a new explicit call`, async t => {
    for (const point of ["temp_written", "file_synced", "renamed", "directory_synced"] as const) await t.test(point, async child => {
      const f = await enterFixture(kind), open = ArtifactStore.open, failure = new MaintenanceFailure("maintenance_lost", point);
      let hits = 0;
      try {
        child.mock.method(ArtifactStore, "open", async function (...args: Parameters<typeof ArtifactStore.open>) {
          const [root, source, options] = args;
          return open.call(ArtifactStore, root, source, options?.assertCurrent ? { ...options, after: async stage => {
            if (stage === point) { hits++; throw failure; }
          } } : options);
        });
        await assert.rejects(enterMaintenance(f.options, f.request), error => error === failure);
        assert.equal(hits, 1); const after = await f.observe();
        assert.equal(after.state.admission, "open"); assert.equal(after.state.journalSequence, 0);
        assert.equal(after.state.journalRecordRef, null); assert.equal(after.manifests.frozenBusinessManifestDigest, f.initial.manifests.frozenBusinessManifestDigest);
        child.mock.restoreAll();
        const result = await enterMaintenance(f.options, f.request); assert.equal(result.status, "paused");
        assert.equal((await f.observe()).state.ownerGeneration, f.initial.state.ownerGeneration + 1);
      } finally { child.mock.restoreAll(); await f.close(); }
    });
  });
  nativeTest(`#152 internal enter ${kind}: a real same-source holder excludes another controller while an independent source progresses`, async t => {
    const f = await enterFixture(kind), other = await enterFixture(kind), put = ArtifactStore.prototype.putJson;
    let resume!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { reached = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
    let running: ReturnType<typeof enterMaintenance> | undefined;
    try {
      t.mock.method(ArtifactStore.prototype, "putJson", async function (this: ArtifactStore, ...args: Parameters<ArtifactStore["putJson"]>) {
        if (this.root === f.reference.controlRoot && args[0] === "journal") { reached(); await release; }
        return Reflect.apply(put, this, args);
      });
      running = enterMaintenance(f.options, f.request);
      await Promise.race([held, running.then(() => { throw new Error("entry did not hold a publication window"); })]);
      await assert.rejects(enterMaintenance(f.options, f.request), { code: "maintenance_busy" });
      assert.equal((await enterMaintenance(other.options, other.request)).status, "paused");
      resume(); assert.equal((await running).status, "paused");
    } finally { resume(); await running?.catch(() => {}); t.mock.restoreAll(); await other.close(); await f.close(); }
  });
  nativeTest(`#152 internal enter ${kind}: actual transaction failures never retry and a fresh controller classifies COMMIT or rollback`, async t => {
    for (const point of ["anchor-before", "commit-before", "commit-after", "source-close", "close-undefined"] as const) await t.test(point, async child => {
      const f = await enterFixture(kind), exec = Database.prototype.exec, prepare = Database.prototype.prepare, close = Database.prototype.close;
      const query = Client.prototype.query, end = Client.prototype.end;
      const failure = point === "close-undefined" ? undefined : new MaintenanceFailure("maintenance_lost", point);
      let sqliteWriter: Database.Database | undefined, pgWriter: Client | undefined, anchors = 0, injected = 0, rejected = false, rejection: unknown;
      try {
        if (kind === "sqlite") {
          child.mock.method(Database.prototype, "prepare", function (this: Database.Database, sql: string) {
            if (this.name === f.file && sql.startsWith("UPDATE storage_maintenance SET admission=")) {
              sqliteWriter = this; anchors++;
              if (point === "anchor-before") { injected++; throw failure; }
            }
            return prepare.call(this, sql);
          });
          child.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
            if (this === sqliteWriter && sql === "COMMIT" && point === "commit-before") { injected++; throw failure; }
            const result = exec.call(this, sql);
            if (this === sqliteWriter && sql === "COMMIT" && point === "commit-after") { injected++; throw failure; }
            return result;
          });
          child.mock.method(Database.prototype, "close", function (this: Database.Database) {
            const result = close.call(this);
            if (this === sqliteWriter && ["source-close", "close-undefined"].includes(point)) { injected++; throw failure; }
            return result;
          });
        } else {
          child.mock.method(Client.prototype, "query", async function (this: Client, ...args: unknown[]) {
            const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | null)?.text ?? "";
            const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
            if (database === f.database && sql.startsWith("UPDATE storage_maintenance SET admission=")) {
              pgWriter = this; anchors++;
              if (point === "anchor-before") { injected++; throw failure; }
            }
            if (this === pgWriter && sql === "COMMIT" && point === "commit-before") { injected++; throw failure; }
            const result = await Reflect.apply(query, this, args) as QueryResult;
            if (this === pgWriter && sql === "COMMIT" && point === "commit-after") { injected++; throw failure; }
            return result;
          } as typeof query);
          child.mock.method(Client.prototype, "end", async function (this: Client) {
            await Reflect.apply(end, this, []);
            if (this === pgWriter && ["source-close", "close-undefined"].includes(point)) { injected++; throw failure; }
          } as typeof end);
        }
        try { await enterMaintenance(f.options, f.request); } catch (error) { rejected = true; rejection = error; }
        assert.equal(rejected, true); assert.equal(rejection, failure); assert.equal(anchors, 1); assert(injected >= 1);
        child.mock.restoreAll();
        const committed = ["commit-after", "source-close", "close-undefined"].includes(point);
        const actual = await f.observe();
        assert.equal(actual.state.admission, committed ? "draining" : "open");
        assert.equal(actual.state.journalSequence, committed ? 1 : 0);
        assert.equal(actual.manifests.frozenBusinessManifestDigest, f.initial.manifests.frozenBusinessManifestDigest);
        const result = await enterMaintenance(f.options, f.request); assert.equal(result.status, "paused");
        const recovered = await f.observe();
        assert.equal(recovered.state.ownerGeneration, f.initial.state.ownerGeneration + 1);
        assert.equal(recovered.state.journalSequence, 1);
        if (committed) assert.deepEqual(recovered.state, actual.state, "committed-but-unknown is read, never applied again");
      } finally { child.mock.restoreAll(); await f.close(); }
    });
  });
  nativeTest(`#152 internal enter ${kind}: an existing real write transaction must end before entry can acquire source control`, async () => {
    const f = await enterFixture(kind);
    const sqlite = kind === "sqlite" ? new Database(f.file, { fileMustExist: true }) : undefined;
    const postgres = kind === "postgres" ? await f.connect() : undefined;
    try {
      if (sqlite) sqlite.exec("BEGIN IMMEDIATE; INSERT INTO enter_observation VALUES('admitted transaction')");
      if (postgres) {
        await postgres.query("BEGIN"); await postgres.query("SELECT * FROM storage_maintenance FOR SHARE");
        await postgres.query("INSERT INTO enter_observation VALUES('admitted transaction')");
      }
      await assert.rejects(enterMaintenance(f.options, f.request), { code: "maintenance_busy" });
      assert.equal((await f.observe()).state.admission, "open");
      if (sqlite) sqlite.exec("COMMIT"); if (postgres) await postgres.query("COMMIT");
      assert.equal((await enterMaintenance(f.options, f.request)).status, "paused");
      assert.equal((await f.query("SELECT * FROM enter_observation")).length, 2);
    } finally {
      if (sqlite?.open) sqlite.close(); if (postgres) await f.closeClient(postgres); await f.close();
    }
  });
}

(process.platform === "linux" ? test : test.skip)("#152 internal enter rejects an actual unsupported tmpfs publication root before changing DB state", async t => {
  let directory: string;
  try { directory = await realpath(await mkdtemp("/dev/shm/br-enter-fs-")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("this Linux environment has no private tmpfs test location"); return; } throw error; }
  const f = await enterFixture(), adapter = await f.createAdapter();
  try {
    assert.equal((await statfs(directory)).type, 0x01021994, "the negative control uses a real tmpfs, not a supplied success flag");
    const options = { ...f.options, controlRoot: path.join(directory, "control") };
    const plan = await planMigration(options, adapter), reference = await persistMigrationPlan(plan, options, adapter);
    await assert.rejects(enterMaintenance(options, { ...f.request, plan: reference }), { code: "unsupported_durability" });
    assert.deepEqual((await f.observe()).state, f.initial.state);
  } finally { await adapter.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});
