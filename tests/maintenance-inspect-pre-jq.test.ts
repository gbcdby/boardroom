import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectPreJq } from "../src/server/storage/maintenance/inspect-pre-jq.ts";
import { verifyJournalChain } from "../src/server/storage/maintenance/journal.ts";
import { createSqliteMaintenanceAdapter } from "../src/server/storage/maintenance/sqlite.ts";
import { appendPlanned, appendStructuralCapture, artifactInventory, changeReceiptGeneration, inspectRequest, postgresInspectFixture, sqliteInspectFixture } from "./fixtures/maintenance-inspect-pre-jq.ts";
import type { JournalRecordV2, MaintenanceResult, PersistedPlanRef, SourceClientFactsWindow, SourceLock } from "../src/server/storage/maintenance/types.ts";

function blocked(result: MaintenanceResult, code: string) {
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") assert.fail("blocked result required");
  assert.deepEqual(result.blockers.map(item => item.code), [code]);
}

test("pre-Jq reads the real SQLite current-generation planned prefix without changing authority or artifacts", async () => {
  const f = await sqliteInspectFixture();
  try {
    const before = await f.adapter.observe(), files = await artifactInventory(f.store);
    const result = await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f)));
    assert.equal(result.status, "paused");
    if (result.status !== "paused") assert.fail("planned prefix must be usable");
    assert.equal(result.phase, "planned"); assert.deepEqual(result.ref.journal, f.head);
    assert.equal(result.ref.ownerGeneration, 1); assert.equal(result.ref.fenceEpoch, before.state.fenceEpoch);
    assert.deepEqual(await f.adapter.observe(), before); assert.deepEqual(await artifactInventory(f.store), files);
    await f.mutex.assertHeld();
    const replay = await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, f.enterRequest));
    assert.deepEqual(replay, result, "the original persisted enter input can be classified without replaying entry");
  } finally { await f.close(); }
});

test("pre-Jq uses exact new-request expectations and the original persisted enter digest", async () => {
  const f = await sqliteInspectFixture();
  try {
    const before = await f.adapter.observe();
    for (const request of [
      { ...inspectRequest(f), expectedJournalDigest: "0".repeat(64) },
      { ...inspectRequest(f), expectedPhase: null },
      { ...inspectRequest(f), requestId: f.enterRequest.requestId },
    ]) {
      const result = await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, request));
      blocked(result, request.requestId === f.enterRequest.requestId ? "request_conflict" : "phase_conflict");
    }
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { await f.close(); }
});

test("pre-Jq accepts observation-only continuity at original g and rejects any earlier planned takeover", async () => {
  const f = await sqliteInspectFixture();
  try {
    const observed = await appendPlanned(f, "observation");
    const read = () => f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock,
      { ...inspectRequest(f), expectedJournalDigest: observed.sha256 }));
    assert.equal((await read()).status, "paused");
    blocked(await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock,
      { ...inspectRequest(f), expectedJournalDigest: observed.sha256, requestId: "fixture-observation" })), "request_conflict");
    await appendPlanned(f, "takeover");
    const before = await f.adapter.observe();
    blocked(await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock,
      { ...inspectRequest(f), expectedJournalDigest: before.state.journalDigest })), "phase_conflict");
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { await f.close(); }
});

test("pre-Jq classifies actual committed and rolled-back enter outcomes without replay or orphan selection", async t => {
  for (const point of ["before", "after"] as const) await t.test(point, async () => {
    const f = await sqliteInspectFixture(point);
    try {
      assert.equal(f.commitFailed, true);
      const before = await f.adapter.observe(), files = await artifactInventory(f.store);
      assert.equal(before.state.admission, point === "after" ? "draining" : "open");
      const result = await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, f.enterRequest));
      if (point === "after") assert.equal(result.status, "paused");
      else blocked(result, "phase_conflict");
      assert.deepEqual(await f.adapter.observe(), before); assert.deepEqual(await artifactInventory(f.store), files);
    } finally { await f.close(); }
  });
});

test("pre-Jq PostgreSQL uses actual current-generation drained receipts and borrowed locks", { skip: !process.env.AGENT_STUDIO_PG_TEST_URL }, async () => {
  const f = await postgresInspectFixture();
  try {
    const before = await f.adapter.observe(), files = await artifactInventory(f.store);
    const result = await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f)));
    assert.equal(result.status, "paused");
    if (result.status !== "paused") assert.fail("real PG planned result");
    assert.deepEqual(result.ref.journal, f.head); assert.equal(result.ref.ownerGeneration, 1);
    assert.deepEqual(await f.adapter.observe(), before); assert.deepEqual(await artifactInventory(f.store), files);
    await f.mutex.assertHeld();
  } finally { await f.close(); }
});

test("pre-Jq blocks a live unowned SQLite writer and a valid-but-old drain receipt without repairing either", async t => {
  await t.test("actual writable FD", async () => {
    const f = await sqliteInspectFixture(); const writer = await open(f.file, "r+");
    try {
      const before = await f.adapter.observe();
      blocked(await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f))), "source_writer_unknown");
      assert.deepEqual(await f.adapter.observe(), before);
      assert((await writer.stat()).isFile(), "inspection does not close an external resource");
    } finally { await writer.close(); await f.close(); }
  });
  await t.test("older nonzero generation", async () => {
    const f = await sqliteInspectFixture(undefined, 2);
    try {
      changeReceiptGeneration(f.file, 1);
      const before = await f.adapter.observe();
      assert.equal(before.state.ownerGeneration, 2);
      blocked(await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f))), "drain_incomplete");
      assert.deepEqual(await f.adapter.observe(), before);
    } finally { await f.close(); }
  });
});

test("pre-Jq rejects captured and cancel prefixes even if a damaged DB claims draining", async t => {
  for (const cancel of [false, true]) await t.test(cancel ? "cancel_intent" : "capture", async () => {
    const f = await sqliteInspectFixture();
    try {
      const head = await appendStructuralCapture(f, cancel);
      assert.equal((await verifyJournalChain(f.store, head)).nodes.at(-1)!.record.event, cancel ? "cancel_intent" : "capture");
      const db = new Database(f.file);
      try { db.prepare("UPDATE storage_maintenance SET admission='draining'").run(); } finally { db.close(); }
      const before = await f.adapter.observe(), files = await artifactInventory(f.store);
      blocked(await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock,
        { ...inspectRequest(f), expectedJournalDigest: head.sha256 })), "phase_conflict");
      assert.deepEqual(await f.adapter.observe(), before); assert.deepEqual(await artifactInventory(f.store), files);
    } finally { await f.close(); }
  });
});

test("pre-Jq never substitutes an orphan for a missing, corrupt or mismatched DB-exact journal", async t => {
  for (const damage of ["missing", "corrupt", "sequence"] as const) await t.test(damage, async () => {
    const f = await sqliteInspectFixture(), file = path.join(f.store.root, f.head.ref);
    const bytes = await readFile(file);
    try {
      if (damage === "missing") await rename(file, `${file}.held`);
      else if (damage === "corrupt") await writeFile(file, Buffer.alloc(bytes.length, 120));
      else {
        const db = new Database(f.file);
        try { db.prepare("UPDATE storage_maintenance SET journal_sequence=2").run(); } finally { db.close(); }
      }
      const before = await f.adapter.observe(), files = await artifactInventory(f.store);
      const result = await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f)));
      assert.equal(result.status, "recovery_required");
      if (result.status !== "recovery_required") assert.fail("exact broken anchor requires recovery");
      assert.deepEqual(result.blockers.map(item => item.code), ["journal_invalid"]);
      assert.deepEqual(await f.adapter.observe(), before); assert.deepEqual(await artifactInventory(f.store), files);
    } finally {
      if (damage === "missing") await rename(`${file}.held`, file);
      else if (damage === "corrupt") await writeFile(file, bytes);
      await f.close();
    }
  });
});

test("pre-Jq revalidates source selection, config, root identity and strict request shape", async t => {
  const f = await sqliteInspectFixture();
  try {
    const before = await f.adapter.observe();
    const call = (options = f.options, request = inspectRequest(f)) => f.adapter.withSourceLock("control",
      lock => inspectPreJq(options, f.adapter, f.mutex, lock, request));
    blocked(await call({ ...f.options, expectedSourceId: "another-source" }), "source_changed");
    const config = await readFile(f.configFile);
    try { await writeFile(f.configFile, Buffer.concat([config, Buffer.from(" \n")])); blocked(await call(), "plan_stale"); }
    finally { await writeFile(f.configFile, config); }
    // A root locator substitution is rejected before it can select another plan or directory.
    blocked(await call(f.options, { ...inspectRequest(f), plan: { ...f.reference, controlRoot: f.directory } }), "control_root_mismatch");
    blocked(await call(f.options, { ...inspectRequest(f), callerVerified: true } as never), "request_conflict");
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { await f.close(); }
});

test("pre-Jq rejects full raw-roster drift during native collection and a lock past its actual lifetime", async t => {
  const f = await sqliteInspectFixture(); let escaped: SourceLock | undefined;
  try {
    const before = await f.adapter.observe();
    await f.adapter.withSourceLock("control", async lock => {
      escaped = lock; const original = lock.observeSourceClients.bind(lock); let calls = 0;
      const changed = t.mock.method(lock, "observeSourceClients", async () => {
        const value = await original(); calls++;
        // Controlled original-byte projection drift, not a claimed concurrent source write.
        if (calls >= 4) return { ...value, rows: value.rows.map(row => ({ ...row,
          last_observed_at: ["text", Buffer.from("changed raw observation").toString("hex")] as const })) };
        return value;
      });
      try {
        blocked(await inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f)), "source_changed");
        assert(calls >= 4);
      } finally { changed.mock.restore(); }
    });
    blocked(await inspectPreJq(f.options, f.adapter, f.mutex, escaped!, inspectRequest(f)), "maintenance_lost");
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { await f.close(); }
});

test("pre-Jq cannot combine a native source lock with a different actual source and mutex", async () => {
  const f = await sqliteInspectFixture(), other = await sqliteInspectFixture();
  try {
    const before = await f.adapter.observe(), otherBefore = await other.adapter.observe();
    blocked(await other.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f))), "source_changed");
    blocked(await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, other.mutex, lock, inspectRequest(f))), "control_root_mismatch");
    assert.deepEqual(await f.adapter.observe(), before); assert.deepEqual(await other.adapter.observe(), otherBefore);
  } finally { await other.close(); await f.close(); }
});

test("pre-Jq final classification rechecks config and exact journal after the native facts window closes", async t => {
  for (const changed of ["config", "journal"] as const) await t.test(changed, async () => {
    const f = await sqliteInspectFixture();
    const file = changed === "config" ? f.configFile : path.join(f.store.root, f.head.ref), bytes = await readFile(file);
    try {
      const before = await f.adapter.observe();
      await f.adapter.withSourceLock("control", async lock => {
        const original = lock.withSourceClientFacts.bind(lock);
        const patched = t.mock.method(lock, "withSourceClientFacts", async <T>(plan: PersistedPlanRef, consume: (window: SourceClientFactsWindow) => Promise<T>) => {
          const result = await original(plan, consume);
          await writeFile(file, changed === "config" ? Buffer.concat([bytes, Buffer.from(" \n")]) : Buffer.alloc(bytes.length, 120));
          return result;
        });
        try {
          const result = await inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f));
          if (changed === "config") blocked(result, "plan_stale");
          else assert.equal(result.status, "recovery_required", "a now-unreadable anchored journal cannot be reported as planned");
        } finally { patched.mock.restore(); }
      });
      assert.deepEqual(await f.adapter.observe(), before);
    } finally { await writeFile(file, bytes); await f.close(); }
  });
});

test("pre-Jq actual mutex loss after observed facts cannot return a successful paused result", async t => {
  const f = await sqliteInspectFixture(); let result: MaintenanceResult | undefined;
  try {
    const before = await f.adapter.observe();
    await assert.rejects(f.adapter.withSourceLock("control", async lock => {
      const original = lock.withSourceClientFacts.bind(lock);
      const patched = t.mock.method(lock, "withSourceClientFacts", async <T>(plan: PersistedPlanRef, consume: (window: SourceClientFactsWindow) => Promise<T>) => original(plan, async window => {
        const value = await consume(window); await f.mutex.release(); return value;
      }));
      try { result = await inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f)); return result; }
      finally { patched.mock.restore(); }
    }), { code: "maintenance_lost" });
    assert(result); blocked(result, "maintenance_lost");
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { await f.close(); }
});

test("pre-Jq PostgreSQL refuses an actual extra backend and a self-consistent wrong-generation receipt", { skip: !process.env.AGENT_STUDIO_PG_TEST_URL }, async () => {
  const f = await postgresInspectFixture();
  try {
    const foreign = await f.connect();
    try {
      const before = await f.adapter.observe();
      blocked(await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f))), "source_writer_unknown");
      assert.deepEqual(await f.adapter.observe(), before);
    } finally { await f.closeClient(foreign); }
    const connection = await f.connect();
    try {
      const row = (await connection.query("SELECT client_id,db_sessions_json FROM storage_source_clients")).rows[0];
      const envelope = JSON.parse(row.db_sessions_json); envelope.drainReceipt.ownerGeneration++;
      const { storageReceiptDigest } = await import("../src/server/storage/source-client.ts");
      await connection.query("UPDATE storage_source_clients SET db_sessions_json=$1,drain_receipt_digest=$2 WHERE client_id=$3",
        [JSON.stringify(envelope), storageReceiptDigest(envelope.drainReceipt), row.client_id]);
    } finally { await f.closeClient(connection); }
    const before = await f.adapter.observe(), files = await artifactInventory(f.store);
    blocked(await f.adapter.withSourceLock("control", lock => inspectPreJq(f.options, f.adapter, f.mutex, lock, inspectRequest(f))), "drain_incomplete");
    assert.deepEqual(await f.adapter.observe(), before); assert.deepEqual(await artifactInventory(f.store), files);
  } finally { await f.close(); }
});

test("pre-Jq a fresh native controller reads original g after actual prior release and ignores a valid orphan", async () => {
  const f = await sqliteInspectFixture();
  const fresh = await createSqliteMaintenanceAdapter(f.options.environment.databaseDescriptor as never);
  try {
    await assert.rejects(fresh.acquireMutex(f.store.identity, (await fresh.observe()).state), { code: "maintenance_busy" });
    await f.mutex.release(); await f.adapter.close();
    const mutex = await fresh.acquireMutex(f.store.identity, (await fresh.observe()).state);
    try {
      const entered = await f.store.readJson(f.head, "journal") as JournalRecordV2;
      const orphan = await f.store.putJson("journal", { ...entered, previous: f.head, sequence: 2,
        event: "takeover", ownerGeneration: entered.ownerGeneration + 1, requestId: "valid-but-unanchored" });
      assert.equal((await verifyJournalChain(f.store, orphan)).nodes.length, 2);
      const before = await fresh.observe(), files = await artifactInventory(f.store);
      const result = await fresh.withSourceLock("control", lock => inspectPreJq(f.options, fresh, mutex, lock, inspectRequest(f)));
      assert.equal(result.status, "paused");
      if (result.status !== "paused") assert.fail("new native controller must read the actual original planned generation");
      assert.equal(result.ref.ownerGeneration, 1); assert.deepEqual(result.ref.journal, f.head);
      assert.deepEqual(await fresh.observe(), before); assert.deepEqual(await artifactInventory(f.store), files);
    } finally { await mutex.release(); }
  } finally { await fresh.close(); await f.close(); }
});
