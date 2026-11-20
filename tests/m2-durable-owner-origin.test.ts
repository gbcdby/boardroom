import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { m2OriginFixture } from "./helpers/m2-origin-fixture.ts";
import { originCanonical, originRow, originSha } from "./helpers/m2-origin-fixture-store.ts";
import { inspectM2ProfileJournalValue } from "../src/server/identity/profile-terminal-values.ts";
import { validateM2HistoryClosure } from "../src/server/identity/m2-history-closure.ts";
import { decodeJournalValue, JOURNAL_VALUE_MATH, readJournalValues, readSnapshotValues } from "../src/server/storage/maintenance/journal-values.ts";
import type { JournalValueProgram } from "../src/server/storage/maintenance/journal-values.ts";
import { createM2HistoryRequest } from "../src/server/identity/internal/m2-p0-request.ts";
import { withP0Guard, p0State } from "../src/server/identity/internal/m2-p0-budget.ts";
import { beginP0FArtifactPass, endP0FArtifactPass } from "../src/server/identity/internal/m2-p0-artifacts-frame.ts";
import { M2Graph } from "../src/server/identity/internal/m2-durable-graph.ts";
import { selectedM2Control } from "../src/server/identity/internal/m2-durable-controls.ts";
import { checkM2OwnerClients } from "../src/server/identity/internal/m2-durable-clients.ts";
import type { M2ClientRegistration } from "../src/server/identity/internal/m2-durable-clients.ts";
import type { MigrationPlan } from "../src/server/storage/maintenance/types.ts";
import type { OriginChange } from "./helpers/m2-origin-fixture-store.ts";

type Fixture = Awaited<ReturnType<typeof m2OriginFixture>>;
function oldPrefix(f: Fixture) {
  const context = { root: f.store.value("physical").controlRoot.path, identity: f.store.value("physical").controlRoot, math: JOURNAL_VALUE_MATH };
  function run<T>(program: JournalValueProgram<T>): T {
    let step = program.next();
    while (!step.done) {
      const op = step.value, selected = f.store.entries.get(op.reference.ref)?.selected;
      assert(selected, op.reference.ref); assert.deepEqual(selected.artifact, op.reference);
      const bytes = Buffer.from(selected.bytesHex, "hex");
      assert.equal(originSha(bytes), selected.artifact.sha256); assert.equal(String(bytes.length), selected.artifact.bytes);
      step = program.next(op.operation === "decode" ? decodeJournalValue(op.as, bytes) : op.operation === "kind" ? selected.kind : undefined);
    }
    return step.value;
  }
  const chain = run(readJournalValues(context, f.refs.preA!));
  const snapshot = run(readSnapshotValues(context, chain));
  assert.deepEqual(snapshot.receiptRef, f.refs.receipt);
  return chain;
}

test("one complete origin owner succeeds the real old capture, ready bridge and A before B", async () => {
  const options = { pageSize: 512 as const, ownerCount: 1 as const };
  const f = await m2OriginFixture(options);
  const closure = f.store.value("closure");
  const journals = closure.nodes.map((ref: { ref: string }) => f.store.entries.get(ref.ref)!.value);
  assert.deepEqual(journals.map((node: any) => node.event), ["enter", "capture", "ready", "observation", "observation",
    "s2_profile_committed", "s2_profile_owner_acquired", "s2_profile_completed"]);
  assert.deepEqual(journals.slice(-3).map((node: any) => [node.sequence, node.ownerGeneration]), [[6, 7], [7, 8], [8, 8]]);
  const captured = f.before.tables.find(table => table.name === "storage_source_clients")!;
  assert.equal(captured.count, "1");
  assert.equal(originRow(captured).protocol_version, 1n);
  assert.notEqual(originRow(captured).ended_at, null);
  const binary = f.selected.find(item => item.kind === "database-snapshot")!;
  const db = new Database(Buffer.from(binary.bytesHex, "hex"));
  try {
    assert.deepEqual(db.prepare("SELECT rowid, client_id, protocol_version FROM storage_source_clients").get(),
      { rowid: 91, client_id: "historical-旧", protocol_version: 1 });
  } finally { db.close(); }
  assert.equal(f.afterA.tables.find(table => table.name === "storage_source_clients")!.count, "2");
  assert.equal(f.preB.tables.find(table => table.name === "storage_source_clients")!.count, "3");
  assert.equal(originRow(f.preB.tables.find(table => table.name === "storage_maintenance")!).owner_generation, 8n);
  assert.equal(f.completion.terminal.sequence, 8);
});

test("two complete owner successors preserve original births and bind the latest controls, proof and B", async () => {
  const f = await m2OriginFixture({ ownerCount: 2 });
  const prefix = oldPrefix(f);
  assert.deepEqual(prefix.nodes.map(node => node.record.event), ["enter", "capture", "ready", "observation", "observation"]);
  const old = validateM2HistoryClosure(JSON.stringify(f.oldInput)); assert(old.ok, JSON.stringify(old));
  assert.equal(f.before.tables.length, 61); assert.equal(f.before.tables.reduce((sum, table) => sum + table.columns.length, 0), 615);
  assert.equal(f.owners.length, 2);
  const client = (observation: Fixture["afterA"], name: string) => {
    const table = observation.tables.find(t => t.name === "storage_source_clients")!;
    const index = table.rows.findIndex((_, i) => originRow(table, i).client_id === name); assert(index >= 0, name);
    return { row: table.rows[index]!, values: originRow(table, index) };
  };
  const oldCoordinator = client(f.preA, "origin-coordinator"), atA = client(f.afterA, "origin-coordinator");
  assert.equal(atA.row.cells.length, 17); assert.equal(oldCoordinator.row.cells.length, 16);
  for (let i = 0; i < 16; i++) if (i !== 4) assert.deepEqual(atA.row.cells[i], oldCoordinator.row.cells[i]);
  assert.equal(atA.values.protocol_version, 2n);
  assert.equal(atA.values.writer_format_digest, f.receipt.guardTransition.writerFormatDigest);
  for (const step of f.owners) {
    const n = step.ordinal, record = f.store.entries.get(step.journal.ref)!.value;
    const facts = f.store.entries.get(step.facts.ref)!.value, delta = f.store.entries.get(step.delta.ref)!.value;
    const cut = f.store.entries.get(step.runtimeCut.ref)!.value;
    assert.deepEqual(record.previous, n === 1 ? f.refs.J_A : f.owners[n - 2]!.journal);
    assert.equal(record.sequence, 6 + n); assert.equal(record.ownerGeneration, 7 + n);
    assert.equal(record.body.fromGeneration, 6 + n); assert.equal(record.body.toGeneration, 7 + n);
    assert.equal(facts.context.receiptGeneration, 7); assert.deepEqual(facts.context.originCapture, f.refs.capture);
    assert.deepEqual(cut.predecessor, record.previous); assert.deepEqual(cut.tables, step.before.tables.map(({ name, columns, count, rows }) => ({ name, columns, count, rows })));
    assert.equal(facts.observation.runtime.runners.length, 1); assert.equal(facts.observation.runtime.owners.length, 1);
    assert.equal(facts.observation.sessions.matches.length, 1); assert.equal(facts.observation.sessions.ownedResources.length, 1);
    assert.equal(delta.changes.filter((change: any) => change.kind === "maintenance-registration").length, 1);
    const born = client(step.after, "后继-owner-" + n), birth = JSON.parse(String(born.values.db_sessions_json));
    assert.deepEqual(birth.creation, { migrationId: "a12", plan: f.refs.plan, fenceEpoch: "2", ownerGeneration: String(7 + n),
      previousAnchor: record.previous, targetSequence: String(6 + n) });
    assert.deepEqual(birth.writerFormat, { protocolVersion: 2, writerFormatDigest: f.receipt.guardTransition.writerFormatDigest });
    assert.equal(born.row.rowid, String(91 + n));
    if (n === 2) {
      const first = client(step.before, "后继-owner-1"), ended = client(step.after, "后继-owner-1");
      assert.deepEqual(first.row.cells[7], client(f.owners[0]!.after, "后继-owner-1").row.cells[7]);
      for (let i = 0; i < 17; i++) if (i !== 14 && i !== 15) assert.deepEqual(ended.row.cells[i], first.row.cells[i]);
      assert.notEqual(ended.values.ended_at, null);
    }
    const checked = inspectM2ProfileJournalValue(originCanonical(f.store.entries.get(step.journal.ref)!.selected));
    assert(checked.ok, JSON.stringify(checked));
  }
  assert.deepEqual(f.owners[1]!.before, f.owners[0]!.after);
  assert.deepEqual(f.preB, f.owners[1]!.after);
  assert.equal(client(f.preB, "historical-旧").values.protocol_version, 1n);
  assert.equal(client(f.preB, "historical-旧").values.writer_format_digest, null);
  assert.equal(JSON.parse(String(client(f.preB, "origin-coordinator").values.db_sessions_json)).formatVersion, 1);
  assert.equal(f.store.value("proof").ownerGeneration, 9);
  assert.deepEqual(f.store.value("proof").predecessor, { record: { artifactId: f.owners[1]!.journal.ref, digest: f.owners[1]!.journal.sha256 }, sequence: 8 });
  assert.equal(f.store.value("J_B").sequence, 9); assert.equal(f.store.value("J_B").ownerGeneration, 9);
  assert.equal(f.completion.terminal.sequence, 9);
});

test("the default zero-owner branch retains the exact pre-change durable and P-C bytes", async () => {
  const f = await m2OriginFixture({ ownerCount: 0 });
  assert.equal(originSha(f.durableWire), "7883706c02130780e7dbb8c26f879c0a93db1eadb3b77f1b60cede2020ceed71");
  assert.equal(originSha(JSON.stringify(f.pcInput)), "5f06e8b8078928450c1939af0577fe60483e02dc43299851c399b95f7a2c7f45");
  assert.equal(f.owners.length, 0);
});

/** Finite CF consumer check only. The original old journal decoder validates the
 * birth chain first; this separate CF request neither claims a complete origin
 * budget result nor substitutes an injected roster for the selected cut. */
function checkOwnerComponents(f: Fixture) {
  const chain = oldPrefix(f);
  let registrations: ReadonlyMap<string, M2ClientRegistration> = new Map();
  const initial = new Map<string, M2ClientRegistration>();
  for (const node of chain.nodes) {
    if (node.record.formatVersion !== 3) continue;
    const proof = node.record.controlProof;
    if (!proof || proof.kind === "capture-controls") continue;
    for (const change of proof.changes) if (change.kind === "maintenance-registration") {
      const json = JSON.parse(Buffer.from(change.after.db_sessions_json[1], "hex").toString("utf8"));
      initial.set(change.after.client_id[1], { creation: json.creation, actorId: change.actorId });
    }
  }
  registrations = initial;
  const admitted = createM2HistoryRequest(JSON.stringify(f.pcInput)); assert(admitted.ok, JSON.stringify(admitted));
  const request = admitted.value;
  const result = withP0Guard(request, () => {
    const g = new M2Graph(request); beginP0FArtifactPass(g.f, request.original);
    try {
      const frozenHistory = g.observation(request.input.graph.observation);
      for (const step of f.owners) {
        const record = f.store.entries.get(step.journal.ref)!.value;
        const selected = selectedM2Control(g, record.body.controlBefore, f.afterA.source, "p1");
        const checked = checkM2OwnerClients(g, { delta: record.body.clientDelta, source: f.afterA.source,
          plan: f.refs.plan!, actualPlan: f.store.value("plan") as MigrationPlan, migrationId: "a12", previous: record.previous,
          targetSequence: record.sequence, fromGeneration: record.body.fromGeneration, toGeneration: record.body.toGeneration,
          fenceEpoch: record.fenceEpoch, originCapture: f.refs.capture!, receiptGeneration: 7,
          currentFormat: { kind: "m2-profile", activationReceipt: f.refs.activationReceipt!, protocolVersion: 2,
            writerFormatDigest: f.receipt.guardTransition.writerFormatDigest },
          before: selected.clients, beforeControl: selected.control, frozenHistory, knownRegistrations: registrations });
        assert.equal(checked.actorClientId, "后继-owner-" + step.ordinal);
        assert.deepEqual(checked.after, step.after.tables.find(table => table.name === "storage_source_clients"));
        registrations = checked.registrations;
      }
      return { registrations: registrations.size };
    } finally { endP0FArtifactPass(g.f); }
  });
  return { result, usage: { ...p0State(request).usage } };
}

for (const ownerCount of [1, 2] as const) test(`${ownerCount} owner CF consumers use actual selected controls and original replayed births`, async () => {
  const f = await m2OriginFixture({ ownerCount });
  const checked = checkOwnerComponents(f);
  assert(checked.result.ok, JSON.stringify(checked));
  assert.equal(checked.result.value.registrations, 1 + ownerCount);
});

function exactBytes(f: Fixture) {
  for (const selected of [f.durableInput.selectedArtifacts, f.pcInput.artifacts]) {
    assert.equal(new Set(selected.map(item => item.artifact.ref)).size, selected.length);
    assert(selected.length <= 4096); assert(selected.reduce((sum, item) => sum + Number(item.artifact.bytes), 0) <= 8 * 1024 * 1024);
    for (const item of selected) {
      const bytes = Buffer.from(item.bytesHex, "hex");
      assert.equal(originSha(bytes), item.artifact.sha256); assert.equal(String(bytes.length), item.artifact.bytes);
      assert(bytes.length <= 4 * 1024 * 1024);
    }
  }
  assert(Buffer.byteLength(f.durableWire) <= 16 * 1024 * 1024);
  assert(Buffer.byteLength(JSON.stringify(f.pcInput)) <= 16 * 1024 * 1024);
}

test("both owner roots retain every referenced original byte with separate acyclic selections", async () => {
  for (const ownerCount of [1, 2] as const) {
    const f = await m2OriginFixture({ ownerCount }); exactBytes(f);
    assert.deepEqual(f.durableInput.selectedArtifacts, f.store.reachable([f.refs.closure!]));
    const durable = new Set(f.durableInput.selectedArtifacts.map(item => item.artifact.ref));
    assert.deepEqual(f.pcInput.artifacts.filter(item => !durable.has(item.artifact.ref)).map(item => item.kind).sort(), ["pc-typed-row", "profile-origin-history"]);
    for (const step of f.owners) for (const ref of [step.journal, step.facts, step.delta, step.runtimeCut, step.controlBefore]) assert(durable.has(ref.ref));
    const proof = f.store.value("proof");
    for (const field of ["frozenBusinessManifest", "preAnchorControlManifest", "sourceClientsManifest", "fullDataBeforeB"])
      assert.equal(f.store.entries.get(proof[field].artifactId)!.value.history.completeHistoryDigest, f.preBSelection.completeHistoryDigest);
  }
});

const invalidOwners: { name: string; ownerCount: 1 | 2; change: () => OriginChange }[] = [
  { name: "cross-step facts context substitution", ownerCount: 2, change: () => {
    let first: any;
    return (label, value) => { if (label === "owner:1:context") first = structuredClone(value);
      if (label === "owner:2:context") Object.assign(value, first); };
  } },
  { name: "G+1 observation without a new registration", ownerCount: 1, change: () => (label, value) => {
    if (label === "owner:1:changes") value.splice(value.findIndex((change: any) => change.kind === "maintenance-registration"), 1);
  } },
  { name: "second owner reusing the first owner's actor incarnation", ownerCount: 2, change: () => {
    let first: any;
    return (label, value) => { if (label === "owner:1:actor") first = structuredClone(value);
      if (label === "owner:2:actor") Object.assign(value, first); };
  } },
  { name: "facts with a stale owner generation", ownerCount: 2, change: () => (label, value) => {
    if (label === "owner:2:context") value.fromGeneration = 7;
  } },
];
for (const item of invalidOwners) test(`reanchored owner graph rejects ${item.name}`, async () => {
  const f = await m2OriginFixture({ ownerCount: item.ownerCount, change: item.change() }); exactBytes(f);
  for (const step of f.owners) {
    const syntactic = inspectM2ProfileJournalValue(originCanonical(f.store.entries.get(step.journal.ref)!.selected));
    assert(syntactic.ok, JSON.stringify(syntactic));
  }
  const checked = checkOwnerComponents(f);
  assert(!checked.result.ok, JSON.stringify(checked));
  assert.equal(checked.result.error.code, "artifact_semantic_mismatch", JSON.stringify(checked));
});

test("a self-reanchored generation jump is refused by the original strict owner journal codec", async () => {
  const f = await m2OriginFixture({ ownerCount: 2, change: (label, value) => {
    if (label === "owner:2:transition") value.toGeneration = 10;
  } });
  exactBytes(f);
  const second = f.owners[1]!, record = f.store.entries.get(second.journal.ref)!.value;
  assert.equal(record.body.fromGeneration, 8); assert.equal(record.body.toGeneration, 10);
  assert.equal(f.store.value("proof").ownerGeneration, 10); assert.equal(f.store.value("J_B").ownerGeneration, 10);
  const result = inspectM2ProfileJournalValue(originCanonical(f.store.entries.get(second.journal.ref)!.selected));
  assert(!result.ok); assert.notEqual(result.error.code, "resource_limit");
});
