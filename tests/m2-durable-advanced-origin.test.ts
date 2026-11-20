import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import { verifyM2DurableClosure } from "../src/server/identity/m2-durable-closure.ts";
import { validateM2HistoryClosure } from "../src/server/identity/m2-history-closure.ts";
import { m2OriginFixture } from "./helpers/m2-origin-fixture.ts";
import { originRow, originDigest, originSha } from "./helpers/m2-origin-fixture-store.ts";

const fixture = m2OriginFixture({ advancedWorkspace: true });
test("R15: the complete captured advanced-equivalence and three mapped slots pass both real origin consumers", async () => {
  const f = await fixture;
  assert.equal(f.before.tables.find(t => t.name === "project_workspace_versions")!.count, "1");
  assert.equal(f.preB.tables.find(t => t.name === "config_workspace_mappings")!.count, "3");
  assert.equal(f.business.binding.content.currentAdvanced.state, "selected");
  assert.equal(f.business.map.bindings[0]!.advancedRule, "legacy-equivalence");
  const snapshots = f.snapshots as any[];
  const selected = snapshots.find(s => s.origin.legacyRef.kind === "requestedSnapshot")!;
  const effective = snapshots.find(s => s.origin.legacyRef.kind === "effective")!;
  assert.equal(selected.advancedBasis.legacy.mappedValidity, "equivalent");
  assert.equal(effective.advancedBasis.legacy.mappedValidity, "migration_reconfirmation_required");
  assert.notEqual(selected.ref.snapshotId, effective.ref.snapshotId);
  assert.equal(selected.semanticDigest, effective.semanticDigest, "separate slots survive equal original semantic values");
  const raw = originRow(f.before.tables.find(t => t.name === "agent_runtime_bindings")!);
  assert.equal(selected.origin.raw.rawAdvancedJson, raw.advanced_json);
  assert(String(raw.advanced_json).endsWith("\n"));
  const p0 = validateM2HistoryClosure(JSON.stringify(f.oldInput)); assert(p0.ok, JSON.stringify(p0));
  const eg = verifyM2DurableClosure(f.durableWire); assert(eg.ok, JSON.stringify(eg));
  assert.deepEqual(eg.value.originCompletion, f.completion);
  const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  for (const observation of [f.preB, f.afterB]) {
    const input = { ...f.pcInput, graph: { ...f.pcInput.graph, observation } };
    const result = validateM2HistoryClosure(JSON.stringify(input)); assert(result.ok, JSON.stringify(result));
    assert.equal(result.value.inputDigest, digest(["m2-pc-closure-input/r2", input]));
    assert.equal(result.value.tables.length, 72);
    for (const table of observation.tables) {
      const frames = table.rows.map(row => canonicalJson([row.rowid, row.cells]))
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      assert.equal(result.value.tables.find(t => t.table === table.name)!.rowMultisetDigest,
        digest(["m2-pc-table-rows/r1", observation.backend, table.name, table.columnContractValueDigest, table.count, frames]), table.name);
    }
  }
});

for (const [name, change] of [
  ["selected snapshot discards its equivalence binding", (label: string, value: any) => {
    if (label === "advanced:snapshot:requestedSnapshot") {
      value.advancedBasis.legacy.mappedValidity = "migration_reconfirmation_required";
      value.advancedBasis.legacy.equivalenceEvidenceDigest = null;
    }
  }],
  ["same claimed permission scope belongs to a later membership revision", (label: string, value: any) => {
    if (label === "advanced:binding") {
      const basis = value.content.currentAdvanced.basis; basis.existingScope.membershipRevision++;
      basis.existingPermissionScopeDigest = originDigest(basis.existingScope);
    }
  }],
  ["equivalence claims another original advanced raw digest", (label: string, value: any) => {
    if (label === "advanced:equivalence") value.legacyAdvancedRawDigest = "a".repeat(64);
  }],
  ["equivalence claims different captured ordinary values", (label: string, value: any) => {
    if (label === "advanced:equivalence") value.ordinaryConfigDigest = "a".repeat(64);
  }],
  ["equivalence claims another old compatibility revision", (label: string, value: any) => {
    if (label === "advanced:equivalence") value.compatibilityBasis.bindingRevision++;
  }],
  ["mapped workspace selects a different native catalog root value", (label: string, value: any) => {
    if (label === "advanced:mapping:requestedSnapshot") value.canonicalRoot = "/different-root";
  }],
  ["requested mapping borrows the applied root observation", (label: string, value: any) => {
    if (label === "sourceToTarget") value.bindings[0].requested.workspace.workspaceObservation = value.bindings[0].applied.workspace.workspaceObservation;
  }],
  ["unselected applied source borrows requested equivalence", (label: string, value: any) => {
    if (label === "advanced:snapshot:requestedSnapshot") borrowedEquivalence = value.advancedBasis.legacy.equivalenceEvidenceDigest;
    if (label === "advanced:snapshot:applied") {
      value.advancedBasis.legacy.mappedValidity = "equivalent";
      value.advancedBasis.legacy.equivalenceEvidenceDigest = borrowedEquivalence;
    }
  }],
] as const) test(`R15 rejects the fully reanchored graph when ${name}`, async () => {
  const f = await m2OriginFixture({ advancedWorkspace: true, change });
  // Each mutation happens before content addressing, then all downstream
  // targets, receipt, A/B, proof and root references are rebuilt. Independently
  // verify actual raw selected bytes so a semantic refusal cannot be an old SHA.
  for (const selected of f.selected) {
    const bytes = Buffer.from(selected.bytesHex, "hex");
    assert.equal(String(bytes.length), selected.artifact.bytes);
    assert.equal(originSha(bytes), selected.artifact.sha256);
  }
  const durable = verifyM2DurableClosure(f.durableWire);
  assert(!durable.ok, name); assert.equal(durable.error.code, "value_conflict", JSON.stringify(durable));
  const history = validateM2HistoryClosure(JSON.stringify(f.pcInput));
  assert(!history.ok, name); assert.equal(history.error.code, "artifact_semantic_mismatch", JSON.stringify(history));
});

let borrowedEquivalence: string | null = null;
test("the optional advanced fixture leaves all default 0/1/2 owner wire bytes unchanged", async () => {
  const hashes = [
    ["7883706c02130780e7dbb8c26f879c0a93db1eadb3b77f1b60cede2020ceed71", "5f06e8b8078928450c1939af0577fe60483e02dc43299851c399b95f7a2c7f45"],
    ["e7d958c95203f3f069b05eb7c4bf3c0a9cc40534afecae1bbef98821bebebb6b", "a36dd7354ac1b57bae55cc94c7dcb2e480af93855c803049837fc51728e900f2"],
    ["27dee04321f0574abcefb68a6f94ce218972b5614fc143ac94ee0e23185ddab3", "9d2d327e9bac77ec55e6b30ad4a840cc01515781c594629365cf0c2117ade183"],
  ];
  for (const ownerCount of [0, 1, 2] as const) {
    const f = await m2OriginFixture({ ownerCount });
    assert.equal(originSha(f.durableWire), hashes[ownerCount]![0]);
    assert.equal(originSha(JSON.stringify(f.pcInput)), hashes[ownerCount]![1]);
  }
});
