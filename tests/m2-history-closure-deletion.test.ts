import assert from "node:assert/strict";
import test from "node:test";
import { validateM2HistoryClosure } from "../src/server/identity/m2-history-closure.ts";
import type { ClosureResult } from "../src/server/identity/m2-history-closure.ts";
import { M2_HISTORY_TABLES } from "../src/server/identity/m2-history-contracts.ts";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import type { ArtifactRef, SourceClientRawRow } from "../src/server/storage/maintenance/types.ts";
import { p0ArtifactFixture } from "./helpers/m2-p0-f-fixture.ts";
import { controlVector, currentClient, historicalClient } from "./fixtures/maintenance-control-candidate.ts";

type Input = ReturnType<typeof p0ArtifactFixture>;
function success(result: ClosureResult) {
  assert(result.ok, JSON.stringify(result)); return result.value;
}
function failure(result: ClosureResult, code: string) {
  assert(!result.ok, JSON.stringify(result)); assert.equal(result.error.code, code); return result.error;
}
function selector(input: Input, name = "storage_source_clients") {
  const table = input.graph.observation.tables.find(table => table.name === name)!;
  const fixed = M2_HISTORY_TABLES.find(table => table.name === name)!;
  const row = table.rows[0]!;
  return { table: name, key: fixed.primaryKey.map(column => row.cells[table.columns.indexOf(column)]!), rowid: row.rowid };
}
function deleted(input: Input, rows = [selector(input)]) {
  return validateM2HistoryClosure(JSON.stringify({ ...input, proposedDeletion: { rows } }));
}
function oldController(f: ReturnType<typeof controlVector>, mismatchedSource = false) {
  const old = historicalClient(f, "old-controller");
  const profile = { formatVersion: 1, kind: "maintenance-controller-registration",
    source: mismatchedSource ? { ...f.source, identityDigest: "0".repeat(64) } : f.source,
    sourceIdentityDigest: f.source.identityDigest,
    creation: { migrationId: "older", plan: { ref: `plans/${"9".repeat(64)}.json`, sha256: "9".repeat(64), bytes: "13" },
      fenceEpoch: "1", ownerGeneration: "5", previousAnchor: { ref: `journals/older/1-${"8".repeat(64)}.json`, sha256: "8".repeat(64), bytes: "13" }, targetSequence: "2" },
    sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null };
  const row: SourceClientRawRow = { ...old.row, entrypoint: f.text("maintenance-controller"), build_id: f.text("boardroom-maintenance-control-v1"),
    host_identity_json: f.text(canonicalJson(old.fact.host)), process_identity_json: f.text(canonicalJson(old.fact.process)),
    db_sessions_json: f.text(canonicalJson(profile)), registered_epoch: ["integer", "1"], observed_epoch: ["integer", "1"], ended_at: ["null"] };
  return { row, fact: { kind: "maintenance-controller", subject: row.client_id, rowDigest: f.rowDigest(row), host: old.fact.host,
    process: old.fact.process, processCheck: old.fact.processCheck, classification: "exited-actor", registration: "R0-historical" } };
}

test("DEL01 rejects current original clients through the full facade for v3 and legacy v2", () => {
  for (const journalVersion of [3, 2] as const) for (const native of [false, true]) {
    const input = p0ArtifactFixture({ journalVersion, client: f => currentClient(f, native) });
    const original = success(validateM2HistoryClosure(JSON.stringify(input)));
    assert.equal(original.remaining.find(entry => entry.check === "current_authorization")!.status, "unproven");
    success(deleted(input, []));
    const error = failure(deleted(input), "retained_reference_conflict");
    assert.equal(error.rule, "PC1B-DEL01"); assert.equal(error.phase, "retained-graph");
    assert.equal(error.location!.table, "storage_source_clients"); assert.equal(error.location!.rowOrdinal, 0);
    assert.equal(error.location!.columnOrdinal, null); assert.equal(error.location!.pathId, "PC1B-DEL01.P01");
    assert.equal(error.conflicts[0]!.condition, "negative-invariant"); assert.equal(error.conflicts[0]!.target, null);
    assert.equal(JSON.stringify(error).includes("current-client"), false);
  }
});

test("DEL01 permits historical and exited value deletions while preserving all retained obligations", () => {
  for (const journalVersion of [3, 2] as const) for (const client of [historicalClient, oldController]) {
    const input = p0ArtifactFixture({ journalVersion, client });
    const original = success(validateM2HistoryClosure(JSON.stringify(input))), value = success(deleted(input));
    assert(value.deletion); assert.equal(value.deletion.retainedCounts.find(table => table.table === "storage_source_clients")!.rows, "0");
    assert.equal(value.completeHistoryDigest, original.completeHistoryDigest);
    assert.deepEqual(value.selectedArtifacts, original.selectedArtifacts);
    assert.equal(value.ruleCoverage.filter(entry => entry.status === "verified").length, 44);
    assert.equal(value.checks.retainedReferenceClosure, "verified");
    assert.equal(value.remaining.find(entry => entry.check === "current_authorization")!.status, "unproven");
  }
});

test("DEL01 reports unresolved v2 controller semantics only when the exact original row is selected", () => {
  const input = p0ArtifactFixture({ journalVersion: 2, client: f => oldController(f, true) });
  success(validateM2HistoryClosure(JSON.stringify(input))); success(deleted(input, []));
  const unrelated = failure(deleted(input, [selector(input, "schema_migrations")]), "retained_reference_conflict");
  assert.equal(unrelated.location!.table, "schema_migrations"); assert.equal(unrelated.conflicts[0]!.condition, "negative-invariant");
  const exact = selector(input), wrongStorage = { ...exact, key: [["blob", exact.key[0]![1]] as const] };
  const missing = failure(validateM2HistoryClosure(JSON.stringify({ ...input, proposedDeletion: { rows: [wrongStorage] } })), "invalid_value");
  assert.equal(missing.conflicts[0]!.condition, "missing-target");
  const error = failure(deleted(input), "semantic_unsupported");
  assert.equal(error.rule, "PC1B-DEL01"); assert.equal(error.phase, "retained-graph");
  assert.equal(error.location!.table, "storage_source_clients"); assert.equal(error.location!.rowOrdinal, 0);
  assert.equal(error.location!.columnOrdinal, null); assert.equal(error.location!.pathId, "PC1B-DEL01.P01");
  assert.equal(error.conflicts[0]!.condition, "unsupported-value"); assert.equal(error.conflicts[0]!.target, null);
  assert.equal(JSON.stringify(error).includes("old-controller"), false);
});

test("DEL01 never launders a failed v3 original proof into the legacy controller profile branch", () => {
  const input = p0ArtifactFixture({ client: f => {
    const client = oldController(f); client.fact.classification = "active-actor"; return client;
  } });
  const original = validateM2HistoryClosure(JSON.stringify(input)); assert(!original.ok);
  assert.deepEqual(deleted(input), original);
});

test("DEL01 retains the original exact capture journal and full source scope before any client deletion", () => {
  let enter: ArtifactRef | undefined;
  const wrongCapture = p0ArtifactFixture({ client: f => { enter = f.enterRef; return historicalClient(f); },
    change(kind, value) { if (kind === "receipt") value.capture = { ...value.capture, journal: enter }; } });
  const wrongSource = p0ArtifactFixture({ sourceClient: true });
  // Keep databaseInstanceId and all row bytes: a source identifier alone must
  // not allow the receipt's independently bound full SourceRef to be reused.
  wrongSource.graph.observation.source = { ...wrongSource.graph.observation.source, identityDigest: "e".repeat(64) };
  for (const input of [wrongCapture, wrongSource]) {
    const original = validateM2HistoryClosure(JSON.stringify(input));
    failure(original, "artifact_semantic_mismatch"); assert.deepEqual(deleted(input), original);
  }
});
