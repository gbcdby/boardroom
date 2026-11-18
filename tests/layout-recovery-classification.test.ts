import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { LayoutValueError } from "../src/server/storage/maintenance/layout-values.ts";
import { classifyLayoutRecoveryValue } from "../src/server/storage/maintenance/layout-recovery-classification.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ref = (digit: string) => ({ ref: `private-${digit}`, sha256: digit.repeat(64), bytes: "1" });
const authorRaw = '{"kind":"human","actorId":"human:1","agentId":null,"displayName":"Human"}';
const bodies = ["\ufeffold", "current", "head"];
function inventory(storageId = "storage:1") {
  const versions = bodies.map((body, index) => ({ versionId: `version-${index + 1}`, documentId: "document-1", version: index + 1,
    parentVersion: index, object: { objectFormat: "utf8-sha256-v1", storageId, contentSha256: sha(body), byteLength: Buffer.byteLength(body) },
    relativePath: `objects/sha256/${sha(body).slice(0, 2)}/${sha(body)}.md`, actorId: "human:1", clientMutationId: `mutation-${index}`,
    summaryRequestId: index === 0 ? "deleted-request" : null, authorRaw, source: "human", createdAt: "2026-11-18T00:00:00Z", sourceRowDigest: "4".repeat(64) }));
  const output = { contract: "layout-memory-inventory-value/r1", source: { kind: "sqlite", databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) },
    frozenManifest: ref("3"), storageId,
    tables: ["memory_documents", "memory_versions", "memory_summary_requests"].map((name, index) => ({ name, count: ["1", "3", "0"][index]!, digest: "4".repeat(64) })),
    documents: [{ documentId: "document-1", legacyKey: { scope: "global", projectId: null, agentId: "agent-1" }, documentKind: "note",
      currentVersion: 3, updatedAt: "2026-11-18T00:00:00Z", updatedByRaw: authorRaw, source: "human", sourceRowDigest: "5".repeat(64) }],
    versions, objects: versions.map(version => version.object).sort((left, right) => left.contentSha256 < right.contentSha256 ? -1 : 1),
    totalVersionBodyBytes: String(bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0)),
    uniqueObjectBodyBytes: String(bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0)) };
  return { ...output, inventoryDigest: digestJson(output) };
}
function current() {
  return { storageId: "storage:1", layoutVersion: 2, objectFormat: "utf8-sha256-v1", formatContract: ref("6"), generation: 3,
    activationTerminal: ref("7") as ReturnType<typeof ref> | null, gate: "sealed", inventory: inventory() };
}
function candidate(storageId = "storage:1") {
  return { kind: "database-bundle", storageId, layoutVersion: 2, objectFormat: "utf8-sha256-v1", formatContract: ref("6"),
    generation: 3, databaseSnapshot: ref("8"), inventory: inventory(storageId), consistencyEvidence: null as ReturnType<typeof ref> | null };
}
function classify(proposal: unknown, active = current()) {
  return classifyLayoutRecoveryValue({ contract: "layout-recovery-input/r1", current: active, candidate: proposal });
}
function resign(value: ReturnType<typeof inventory>) {
  const { inventoryDigest: ignored, ...rest } = value;
  value.inventoryDigest = digestJson(rest);
}
function fails(action: () => unknown, code?: string) {
  assert.throws(action, (error: unknown) => error instanceof LayoutValueError && (!code || error.code === code)
    && error.message === `layout_internal_value:${error.code}`);
}

test("LV-AC09: every historical object ref is a repair candidate and never implies a gate change", () => {
  for (const body of bodies) {
    const output = classify({ kind: "object-bytes", contentHex: Buffer.from(body).toString("hex") });
    assert.deepEqual(output, { contract: "layout-recovery-classification/r1", classification: "current-reference-repair-candidate",
      currentInventoryDigest: inventory().inventoryDigest, currentGate: "sealed" });
    assert.ok(Object.isFrozen(output));
  }
  assert.equal(classify({ kind: "object-bytes", contentHex: Buffer.from("unreferenced").toString("hex") }).classification, "unreferenced-object-candidate");
});

test("LV-AC09: missing activation, storage/format mismatches and generations have fixed precedence", () => {
  const active = current(); active.activationTerminal = null;
  const old = candidate(); old.generation = 2;
  assert.equal(classify(old, active).classification, "activation-not-established");
  assert.equal(classify(candidate("storage:2")).classification, "storage-conflict");
  const format = candidate(); format.formatContract = ref("9"); format.generation = 2;
  assert.equal(classify(format).classification, "format-conflict");
  assert.equal(classify(old).classification, "historical-overwrite-prohibited");
  const future = candidate(); future.generation = 4;
  assert.equal(classify(future).classification, "future-generation-conflict");
});

test("LV-AC09: historical IDs, receipts and complete document facts must be covered", () => {
  for (const change of [
    (value: ReturnType<typeof candidate>) => { value.inventory.versions[0]!.versionId = "replacement-old-version"; },
    (value: ReturnType<typeof candidate>) => { value.inventory.versions[0]!.clientMutationId = "replacement-mutation"; },
    (value: ReturnType<typeof candidate>) => { value.inventory.versions[0]!.summaryRequestId = "different-request"; },
    (value: ReturnType<typeof candidate>) => { value.inventory.documents[0]!.updatedAt = "2026-11-17T00:00:00Z"; },
  ]) {
    const value = candidate(); change(value); resign(value.inventory);
    assert.equal(classify(value).classification, "current-facts-not-covered");
  }
  const missing = candidate(); missing.inventory.versions.pop(); missing.inventory.documents[0]!.currentVersion = 2;
  missing.inventory.tables[1]!.count = "2";
  missing.inventory.objects = missing.inventory.versions.map(version => version.object).sort((left, right) => left.contentSha256 < right.contentSha256 ? -1 : 1);
  missing.inventory.totalVersionBodyBytes = missing.inventory.uniqueObjectBodyBytes = String(Buffer.byteLength(bodies[0]!) + Buffer.byteLength(bodies[1]!));
  resign(missing.inventory);
  assert.equal(classify(missing).classification, "current-facts-not-covered");
  for (const evidence of [null, ref("a")]) {
    const value = candidate(); value.consistencyEvidence = evidence;
    value.inventory.versions[0]!.sourceRowDigest = "a".repeat(64); value.inventory.documents[0]!.sourceRowDigest = "b".repeat(64);
    resign(value.inventory);
    assert.equal(classify(value).classification, "consistent-restore-review-required");
  }
});

test("LV-AC01/09: classifier rejects claimed bytes, malformed Unicode, bad inventories and unbounded input", () => {
  for (const contentHex of ["f", "AA", "ff", "c080"]) fails(() => classify({ kind: "object-bytes", contentHex }));
  fails(() => classify({ kind: "object-bytes", contentHex: "", claimedDigest: sha("") }), "invalid_value");
  fails(() => classify({ kind: "object-bytes", contentHex: "00".repeat(1_048_577) }), "budget_exceeded");
  const broken = candidate(); broken.inventory.inventoryDigest = "0".repeat(64);
  fails(() => classify(broken), "inventory_integrity");
  const wrongStorage = candidate(); wrongStorage.inventory.storageId = "storage:other";
  fails(() => classify(wrongStorage));
  let calls = 0;
  fails(() => classifyLayoutRecoveryValue({ get current() { calls++; return current(); } }), "invalid_value");
  assert.equal(calls, 0);
  fails(() => classifyLayoutRecoveryValue({ contract: "layout-recovery-input/future", current: current(), candidate: candidate() }), "unsupported_shape");
});
