import assert from "node:assert/strict";
import test from "node:test";
import { m2OriginP0Fixture } from "./helpers/m2-origin-fixture-p0.ts";
import { validateM2HistoryClosure } from "../src/server/identity/m2-history-closure.ts";
import { decodeJournalValue, JOURNAL_VALUE_MATH, readJournalValues, readSnapshotValues } from "../src/server/storage/maintenance/journal-values.ts";
import type { JournalValueProgram } from "../src/server/storage/maintenance/journal-values.ts";
import { sha256 } from "../src/server/storage/maintenance/canonical.ts";
import { m2OriginFixture, reanchorM2OriginFixture } from "./helpers/m2-origin-fixture.ts";
import { parseM2HistoryObservation, compareM2HistoryPreservation } from "../src/server/identity/m2-history-values.ts";
import { decodeM2RowValue } from "../src/server/identity/m2-row-codecs.ts";
import { inspectM2ProfileJournalValue, parseProfileCompletionBinding } from "../src/server/identity/profile-terminal-values.ts";
import { originCanonical, originRow, originSha } from "./helpers/m2-origin-fixture-store.ts";

test("origin fixture supplies a real nonempty 61-table old source accepted by the full original P0 checker", async () => {
  const f = await m2OriginP0Fixture();
  const checked = validateM2HistoryClosure(JSON.stringify(f.oldInput));
  assert(checked.ok, JSON.stringify(checked));
  assert.equal(f.before.tables.length, 61);
  assert.equal(f.before.tables.reduce((n, t) => n + t.columns.length, 0), 615);
  for (const name of ["agents", "agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "agent_runtime_members", "group_participants", "agent_legacy_aliases"])
    assert.equal(f.before.tables.find(t => t.name === name)!.rows.length, 1, name);
  assert.equal(f.legacyCapture.persistedAliases, true);
  assert.equal(f.before.physicalSourceRef.artifactId, f.refs.physical.ref);
  assert.equal(f.before.snapshotReceiptRef.artifactId, f.refs.receipt.ref);
});

test("origin fixture constructs nonempty managed legacy sources, full A/B typed history and original strict journal values", async () => {
  const f = await m2OriginFixture();
  for (const observation of [f.afterA, f.preB, f.afterB]) {
    const checked = parseM2HistoryObservation(originCanonical(observation));
    assert(checked.ok, JSON.stringify(checked));
    assert.equal(observation.tables.length, 72);
    assert.equal(observation.tables.reduce((n, t) => n + t.columns.length, 0), 763);
  }
  const preserved = compareM2HistoryPreservation(originCanonical({ contract: "m2-history-comparison-input/r1",
    mode: "legacy-a-preservation", before: f.before, after: f.afterA, delta: { kind: "legacy-domain-only" } }));
  assert(preserved.ok, JSON.stringify(preserved));
  for (const projection of f.projections) assert(decodeM2RowValue(projection).ok, projection.table);
  assert.equal(f.snapshots.length, 3);
  assert.deepEqual(f.snapshots.map(s => s.origin.legacyRef.kind).sort(), ["applied", "effective", "requestedSnapshot"]);
  for (const label of ["J_A", "J_B"]) {
    const raw = f.selected.find(item => item.artifact.ref === f.refs[label]!.ref)!;
    const checked = inspectM2ProfileJournalValue(originCanonical(raw));
    assert(checked.ok, JSON.stringify(checked));
  }
  const terminal = parseProfileCompletionBinding(originCanonical(f.completion));
  assert(terminal.ok, JSON.stringify(terminal));
  const migrations = f.afterB.tables.find(t => t.name === "schema_migrations")!;
  assert.equal(migrations.count, "22");
  assert.equal(f.afterB.tables.find(t => t.name === "config_authority")!.count, "1");
  assert.equal(f.afterB.tables.find(t => t.name === "config_snapshots")!.count, "3");
  const slots = new Map(f.snapshots.map(s => [s.origin.legacyRef.kind, s]));
  assert.deepEqual(slots.get("requestedSnapshot")!.origin.legacyRef.versions, { runtimeRevision: 2, bindingRevision: 2 });
  assert.deepEqual(slots.get("applied")!.origin.legacyRef.versions, { runtimeRevision: 1, bindingRevision: 1 });
  assert.deepEqual(slots.get("effective")!.origin.legacyRef.versions, { runtimeRevision: 3, bindingRevision: 3 });
  const execution = originRow(f.before.tables.find(t => t.name === "agent_runtime_bindings")!);
  assert.equal(slots.get("requestedSnapshot")!.origin.raw.rawJson, execution.requested_snapshot_json);
  assert.equal(slots.get("effective")!.origin.raw.rawJson, null);
  assert.equal(f.business.profile.content.instructions, "old prompt\r\n");
  assert.equal(f.business.map.bindings[0]!.selectedKind, "requestedSnapshot");
  for (const name of ["requested", "applied", "effective"] as const)
    assert.deepEqual(f.business.map.bindings[0]![name].workspace, { state: "blocked", reasons: ["workspace_reference_missing"] });
});

test("two origin roots select exact separate reproducible graphs within the original budgets", async () => {
  const f = await m2OriginFixture(), again = await m2OriginFixture();
  assert.equal(f.durableWire, again.durableWire);
  assert.equal(JSON.stringify(f.pcInput), JSON.stringify(again.pcInput));
  for (const selected of [f.durableInput.selectedArtifacts, f.pcInput.artifacts]) {
    assert(selected.length <= 4096);
    assert.equal(new Set(selected.map(item => item.artifact.ref)).size, selected.length);
    assert(selected.reduce((n, item) => n + Number(item.artifact.bytes), 0) <= 8 * 1024 * 1024);
    for (const item of selected) {
      const bytes = Buffer.from(item.bytesHex, "hex");
      assert.equal(String(bytes.length), item.artifact.bytes); assert.equal(originSha(bytes), item.artifact.sha256);
      assert(bytes.length <= 4 * 1024 * 1024);
    }
  }
  assert(Buffer.byteLength(f.durableWire) <= 16 * 1024 * 1024);
  assert(Buffer.byteLength(JSON.stringify(f.pcInput)) <= 16 * 1024 * 1024);
  const durable = new Set(f.durableInput.selectedArtifacts.map(item => item.artifact.ref));
  assert.deepEqual(f.pcInput.artifacts.filter(item => !durable.has(item.artifact.ref)).map(item => item.kind).sort(), ["pc-typed-row", "profile-origin-history"]);
  assert.equal(f.store.value("closure").originHistory, null);
  assert.equal(f.sources.length, 6);
  assert.equal(f.sources.reduce((n, item) => n + Number(item.artifact.bytes), 0), 1_319_090);
});

test("compact real SQLite pages retain all captured rows and keep the default-page resource case reproducible", async () => {
  const compact = await m2OriginFixture({ pageSize: 512 }), large = await m2OriginFixture({ pageSize: 4096 });
  const dbBytes = (f: Awaited<ReturnType<typeof m2OriginFixture>>) => Buffer.from(f.selected.find(s => s.kind === "database-snapshot")!.bytesHex, "hex");
  assert.equal(dbBytes(compact).readUInt16BE(16), 512);
  assert.equal(dbBytes(large).readUInt16BE(16), 4096);
  assert(dbBytes(compact).length < dbBytes(large).length);
  assert.deepEqual(compact.before.tables, large.before.tables);
  for (const f of [compact, large]) {
    const checked = validateM2HistoryClosure(JSON.stringify(f.oldInput)); assert(checked.ok, JSON.stringify(checked));
  }
});

test("producer mutations reanchor A and B while preserving the intentionally false target claim", async () => {
  const clean = await m2OriginFixture();
  const mutated = await reanchorM2OriginFixture((label, value) => { if (label === "target") value.targetRowsDigest = "f".repeat(64); });
  assert.equal(mutated.store.value("target").targetRowsDigest, "f".repeat(64));
  for (const label of ["target", "J_A", "proof", "J_B", "closure", "history"]) assert.notDeepEqual(clean.refs[label], mutated.refs[label], label);
  for (const label of ["J_A", "J_B"]) {
    const selected = mutated.selected.find(item => item.artifact.ref === mutated.refs[label]!.ref)!;
    const checked = inspectM2ProfileJournalValue(originCanonical(selected)); assert(checked.ok, JSON.stringify(checked));
  }
  // A byte-valid graph is still subject to the complete consumer's target/receipt/row equations.
  assert.notEqual(mutated.receipt.targetRowsDigest, mutated.store.value("target").targetRowsDigest);
  assert.equal(mutated.completion.terminal.record.digest, mutated.refs.J_B!.sha256);
});

test("origin fixture keeps snapshot controls distinct from the complete real old ready and coordinator bridge", async () => {
  const f = await m2OriginP0Fixture();
  const context = { root: f.controlRoot.path, identity: f.controlRoot, math: JOURNAL_VALUE_MATH };
  const run = <T>(program: JournalValueProgram<T>): T => {
    let step = program.next();
    while (!step.done) {
      const op = step.value, selected = f.selected.find(x => x.artifact.ref === op.reference.ref);
      assert(selected, op.reference.ref); assert.deepEqual(selected.artifact, op.reference);
      const bytes = Buffer.from(selected.bytesHex, "hex");
      assert.equal(sha256(bytes), selected.artifact.sha256); assert.equal(String(bytes.length), selected.artifact.bytes);
      step = program.next(op.operation === "decode" ? decodeJournalValue(op.as, bytes) : op.operation === "kind" ? selected.kind : undefined);
    }
    return step.value;
  };
  const chain = run(readJournalValues(context, f.refs.preA));
  assert.deepEqual(chain.nodes.map(n => n.record.event), ["enter", "capture", "ready", "observation", "observation"]);
  const snapshot = run(readSnapshotValues(context, chain));
  assert.deepEqual(snapshot.receiptRef, f.refs.receipt);
  assert.equal(f.before.tables.find(t => t.name === "storage_source_clients")!.rows.length, 0);
  assert.equal(f.preA.tables.find(t => t.name === "storage_source_clients")!.rows.length, 1);
  assert.notDeepEqual(f.before.tables.find(t => t.name === "storage_maintenance")!.rows, f.preA.tables.find(t => t.name === "storage_maintenance")!.rows);
});
