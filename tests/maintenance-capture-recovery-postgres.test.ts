import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import type { QueryResult } from "pg";
import { recoveryFixture } from "./fixtures/maintenance-capture-recovery.ts";
import { errorLeaves, rejected } from "./fixtures/maintenance-backup-lifecycle.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain, verifyRestoreBundleClosure } from "../src/server/storage/maintenance/journal.ts";
import { captureSnapshotMaintenance } from "../src/server/storage/maintenance/capture.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { ContinueRequest, OperationMutex } from "../src/server/storage/maintenance/types.ts";
import type { ControllerOwner } from "../src/server/storage/maintenance/controller-owner.ts";

const supported = process.platform === "linux" && !!process.env.AGENT_STUDIO_PG_TEST_URL;
const nativeTest = supported ? test : test.skip;
before(() => {
  if (!supported) return;
  const build = spawnSync(process.execPath,
    [fileURLToPath(new URL("../scripts/build-maintenance-platform.mjs", import.meta.url)), "--source-files"],
    { encoding: "utf8", timeout: 60_000 });
  assert.equal(build.status, 0, build.stderr);
});

nativeTest("#152 C2 postgres: real commits are externally visible before the next source lock and dump", async () => {
  const f = await recoveryFixture("postgres", { sessions: true, initialGeneration: 3 });
  try {
    const committed: Record<string, unknown>[] = [], beforeCommit: Record<string, unknown>[] = [];
    let backups = 0, backupCompleted = false;
    f.recovery.onLock = (lock, _stage, kind) => {
      if (kind === "control") {
        const anchor = lock.anchor;
        lock.anchor = async change => {
          const before = await f.query("SELECT admission,owner_generation,journal_sequence,journal_digest FROM storage_maintenance");
          await anchor(change);
          const independent = await f.query("SELECT admission,owner_generation,journal_sequence,journal_digest FROM storage_maintenance");
          assert.deepEqual(independent, before, "an independent session cannot see uncommitted CAS state");
          beforeCommit.push(independent[0]!);
        };
      } else {
        const backup = lock.backup;
        lock.backup = async destination => {
          await lock.assertHeld(); backups++;
          const actual = await backup(destination);
          assert.equal((await readFile(destination)).subarray(0, 5).toString(), "PGDMP");
          await lock.assertHeld(); backupCompleted = true; return actual;
        };
      }
    };
    f.recovery.afterSourceClose = async () => {
      committed.push((await f.query("SELECT admission,owner_generation,journal_sequence,journal_digest FROM storage_maintenance"))[0]!);
    };
    const result = await f.captureSnapshot(f.options, f.request);
    assert.equal("kind" in result && result.kind, "unverified-bundle");
    if (!("kind" in result) || result.kind !== "unverified-bundle") throw new Error("unverified bundle required");
    assert.deepEqual(committed.map(row => [row.admission, String(row.owner_generation), String(row.journal_sequence)]),
      [["sealed", "4", "2"], ["sealed", "5", "3"], ["sealed", "5", "4"], ["sealed", "5", "4"]]);
    assert.deepEqual(beforeCommit.map(row => [row.admission, String(row.owner_generation), String(row.journal_sequence)]),
      [["draining", "4", "1"], ["sealed", "4", "2"], ["sealed", "5", "3"]]);
    assert.equal(backups, 1); assert.equal(backupCompleted, true);
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    const closure = await verifyRestoreBundleClosure(store, result.bundle, result.publication);
    assert.deepEqual(closure.chain.nodes.map(n => n.record.event), ["enter", "capture", "takeover", "capture"]);
    assert.deepEqual(closure.bundle.capture, result.ref);
    assert.equal(closure.manifests.controlRows.storage_maintenance[0]!.journal_digest, result.ref.journal.sha256);
    assert.equal(f.events.filter(e => e.event === "owner").length, 1);
    assert.equal(f.events.at(-1)!.event, "adapter-close-end");
    assert.deepEqual(Object.keys(result).sort(), ["kind", "ref", "bundle", "publication"].sort());
    delete f.recovery.onLock; delete f.recovery.afterSourceClose;
    assert.deepEqual(await f.captureSnapshot(f.options, f.request), { kind: "anchored-progress", reached: "recapture", ref: result.ref });
  } finally { await f.close(); }
});

nativeTest("#152 C2 postgres: interrupted first T and Q prefixes are fresh read-only progress", async t => {
  for (const stopped of [1, 2, 3] as const) await t.test("after commit " + stopped, async child => {
    const f = await recoveryFixture("postgres"), failure = new MaintenanceFailure("maintenance_lost", "C2 response loss");
    try {
      f.recovery.afterSourceClose = stage => { if (stage === stopped) throw failure; };
      await assert.rejects(f.captureSnapshot(f.options, f.request), error => error === failure);
      delete f.recovery.afterSourceClose;
      const current = await f.observe(), names = await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId));
      child.mock.method(ArtifactStore.prototype, "putJson", async () => { throw new Error("replay cannot publish"); });
      f.state.events.length = 0;
      const replay = await f.captureSnapshot(f.options, f.request);
      assert("kind" in replay && replay.kind === "anchored-progress");
      assert.equal(replay.reached, stopped === 1 ? "first-capture" : stopped === 2 ? "takeover" : "recapture");
      assert.equal(replay.ref.ownerGeneration, current.state.ownerGeneration);
      assert.equal(replay.ref.journal.sha256, current.state.journalDigest);
      assert.deepEqual(await f.observe(), current); assert.deepEqual(f.state.events, ["live-begin", "live-end"]);
      assert.deepEqual(await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId)), names);
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

nativeTest("#152 C2 postgres: T COMMIT before/after and Q source close failures classify the actual durable head", async t => {
  for (const point of ["commit-before", "commit-after", "source-close"] as const) await t.test(point, async child => {
    const f = await recoveryFixture("postgres"), query = Client.prototype.query, end = Client.prototype.end;
    const targetStage = point === "source-close" ? 3 : 2;
    const failure = new MaintenanceFailure("maintenance_lost", "C2 PG " + point);
    let currentStage = 0, target: Client | undefined, injected = 0, completedFinal = false;
    try {
      f.recovery.onLock = (lock, stage) => {
        currentStage = stage; completedFinal = false;
        const facts = lock.withSourceClientFacts;
        lock.withSourceClientFacts = async (plan, consume) => { const result = await facts(plan, consume); completedFinal = true; return result; };
      };
      child.mock.method(Client.prototype, "query", async function(this: Client, ...args: unknown[]) {
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | null)?.text ?? "";
        const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
        if (database === f.database && currentStage === targetStage && sql.startsWith("UPDATE storage_maintenance SET admission=")) {
          assert(completedFinal); target = this;
        }
        if (this === target && sql === "COMMIT" && point === "commit-before") { injected++; throw failure; }
        const result = await Reflect.apply(query, this, args);
        if (this === target && sql === "COMMIT" && point === "commit-after") { injected++; throw failure; }
        return result;
      } as typeof query);
      child.mock.method(Client.prototype, "end", async function(this: Client) {
        await Reflect.apply(end, this, []);
        if (this === target && point === "source-close") { injected++; throw failure; }
      } as typeof end);
      const outcome = await rejected(f.captureSnapshot(f.options, f.request));
      assert.equal(outcome.failed, true); assert(injected >= 1);
      // Keep the existing endFactsSession safe-error contract distinct from
      // the exact original COMMIT failures and D body/cleanup errors.
      if (point === "source-close") assert(errorLeaves(outcome.error).some(error => error instanceof MaintenanceFailure
        && error.code === "maintenance_lost" && error.message === "storage_maintenance: maintenance_lost (source-client-facts)"));
      else assert(errorLeaves(outcome.error).includes(failure));
      child.mock.restoreAll(); delete f.recovery.onLock;
      const observed = await f.observe(), expectedSequence = point === "commit-before" ? 2 : point === "commit-after" ? 3 : 4;
      assert.equal(observed.state.admission, "sealed"); assert.equal(observed.state.journalSequence, expectedSequence);
      assert.equal(observed.state.ownerGeneration, point === "commit-before" ? 1 : 2);
      assert.equal(f.events.filter(e => e.event === "source-begin").length, targetStage, "no later control or D after the failed actual outer completion");
      const replay = await f.captureSnapshot(f.options, f.request);
      assert("kind" in replay && replay.kind === "anchored-progress");
      assert.equal(replay.ref.journal.sha256, observed.state.journalDigest);
      assert.deepEqual((await f.observe()).state, observed.state);
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

nativeTest("#152 C2 postgres: real dump read failure keeps literal undefined before safeError and its independent undefined close", async t => {
  const f = await recoveryFixture("postgres"), open = fs.promises.open;
  let reads = 0, closes = 0, oldOwner: ControllerOwner | undefined;
  try {
    f.recovery.onOwner = owner => { oldOwner = owner; };
    t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
      const handle = await Reflect.apply(open, fs.promises, args);
      if (typeof args[0] === "string" && args[0].startsWith(f.reference.controlRoot + path.sep)
        && args[0].endsWith(path.sep + "database.dump")) {
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        handle.read = (async (...values: unknown[]) => { await Reflect.apply(read, handle, values); reads++; throw undefined; }) as typeof handle.read;
        handle.close = async () => { closes++; await close(); throw undefined; };
      }
      return handle;
    }); syncBuiltinESMExports();
    const outcome = await rejected(f.captureSnapshot(f.options, f.request));
    assert.equal(outcome.failed, true); assert(reads > 0); assert.equal(closes, 1);
    const errors = errorLeaves(outcome.error); assert.strictEqual(errors[0], undefined);
    assert.equal(errors.filter(value => value === undefined).length, 2, "body and physical close are distinct failed events");
    assert(oldOwner); assert.equal(oldOwner.adapterClosed, false);
    const current = await f.observe(); assert.equal(current.state.journalSequence, 4); assert.equal(current.state.admission, "sealed");
    t.mock.restoreAll(); syncBuiltinESMExports(); delete f.recovery.onOwner;
    const replay = await f.captureSnapshot(f.options, f.request);
    assert("kind" in replay && replay.kind === "anchored-progress");
    assert.equal(oldOwner.adapterClosed, true, "new entry first retires the same original D owner");
    assert.equal(f.events.filter(event => event.owner === oldOwner && event.event === "adapter-close-begin").length, 2);
    assert.deepEqual((await f.observe()).state, current.state);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

nativeTest("#152 C2 postgres: lost actual advisory mutex never grants overlap with the active T source transaction", async t => {
  const f = await recoveryFixture("postgres"), query = Client.prototype.query;
  let reached!: () => void, resume!: () => void;
  const reachedT = new Promise<void>(resolve => { reached = resolve; }), continueT = new Promise<void>(resolve => { resume = resolve; });
  let mutexClient: Client | undefined, held: OperationMutex | undefined;
  let running: ReturnType<typeof f.captureSnapshot> | undefined, other: Awaited<ReturnType<typeof f.createAdapter>> | undefined;
  let otherMutex: OperationMutex | undefined;
  try {
    t.mock.method(Client.prototype, "query", async function(this: Client, ...args: unknown[]) {
      const result = await Reflect.apply(query, this, args) as QueryResult;
      const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
      if (!mutexClient && database === f.database && typeof args[0] === "string"
        && args[0].startsWith("SELECT pg_catalog.pg_try_advisory_lock") && result.rows[0]?.acquired === true) mutexClient = this;
      return result;
    } as typeof query);
    f.recovery.onOwner = owner => {
      const acquire = owner.adapter.acquireMutex.bind(owner.adapter);
      owner.adapter.acquireMutex = async (...args) => held = await acquire(...args);
    };
    f.recovery.onLock = async (_lock, stage) => { if (stage === 2) { reached(); await continueT; } };
    running = f.captureSnapshot(f.options, f.request); void running.catch(() => {});
    await Promise.race([reachedT, running.then(() => { throw new Error("T transaction boundary missing"); })]);
    assert(held && mutexClient); await assert.rejects(held.release(), { code: "maintenance_busy" });
    await mutexClient.query("SELECT pg_catalog.pg_advisory_unlock_all()");
    const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    other = await f.createAdapter(); otherMutex = await other.acquireMutex(store.identity, (await other.observe()).state);
    let entered = false;
    await assert.rejects(other.withSourceLock("control", async () => { entered = true; }), { code: "maintenance_busy" });
    assert.equal(entered, false); await otherMutex.release(); otherMutex = undefined; await other.close(); other = undefined;
    resume(); await assert.rejects(running); running = undefined;
    assert.deepEqual((await f.observe()).state, before.state); assert.equal(before.state.journalSequence, 2);
    delete f.recovery.onLock; delete f.recovery.onOwner; t.mock.restoreAll();
    const replay = await f.captureSnapshot(f.options, f.request);
    assert("kind" in replay && replay.kind === "anchored-progress" && replay.reached === "first-capture");
  } finally {
    resume(); await running?.catch(() => {}); t.mock.restoreAll();
    try { await otherMutex?.release(); } finally { await other?.close(); await f.close(); }
  }
});

for (const encoding of ["LATIN1", "SQL_ASCII"] as const) nativeTest(
  "#152 C2 postgres: actual " + encoding + " raw roster and native typed archive remain bound through all stages", async () => {
    const f = await recoveryFixture("postgres", { postgresEncoding: encoding });
    try {
      assert.equal((await f.query("SHOW server_encoding"))[0]!.server_encoding, encoding);
      const before = await f.observe(), result = await f.captureSnapshot(f.options, f.request);
      assert("kind" in result && result.kind === "unverified-bundle");
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      const closure = await verifyRestoreBundleClosure(store, result.bundle, result.publication);
      const captures = closure.chain.nodes.filter(node => node.record.event === "capture");
      assert.equal(captures.length, 2);
      for (const node of captures) {
        assert(node.record.formatVersion === 2 && node.record.sourceClients);
        assert.deepEqual(node.record.sourceClients.textEncoding, { backend: "postgres", name: encoding });
      }
      assert.deepEqual(captures[1]!.record.frozen, captures[0]!.record.frozen);
      assert.deepEqual(closure.manifests.controlRows.storage_source_clients, before.manifests.controlRows.storage_source_clients);
      assert.deepEqual((await f.observe()).clients, before.clients);
    } finally { await f.close(); }
  });

nativeTest("#152 C2 postgres: production empty registry rejects planned and sealed starts without D or successor Jq", async () => {
  const f = await recoveryFixture("postgres");
  try {
    const planned = await f.observe();
    await assert.rejects(captureSnapshotMaintenance(f.options, f.request), { code: "backup_capability_unavailable" });
    assert.deepEqual(await f.observe(), planned);
    const first = await f.capture(f.options, f.request); assert.equal(first.status, "paused");
    if (first.status !== "paused") throw new Error("actual first capture required");
    const sealed = await f.observe();
    const request: ContinueRequest = { ...f.request, requestId: "production-successor", expectedPhase: "quiesced", expectedJournalDigest: first.ref.journal.sha256 };
    await assert.rejects(captureSnapshotMaintenance(f.options, request), { code: "backup_capability_unavailable" });
    assert.deepEqual(await f.observe(), sealed);
    assert.equal((await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId))).length, 2);
    assert.deepEqual((await readdir(f.reference.controlRoot, { recursive: true })).filter(name =>
      /(^|\/)(database-snapshot\.bin|database\.sqlite|database\.dump|restore-bundle\.json|publication\.json|verification\.json|receipt\.json)$/.test(name)), []);
  } finally { await f.close(); }
});
