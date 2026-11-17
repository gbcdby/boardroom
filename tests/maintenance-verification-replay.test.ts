import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { parsePlan, parseVerificationJournal } from "../src/server/storage/maintenance/parse.ts";
import { replayVerificationControls } from "../src/server/storage/maintenance/control-candidate/replay-core.ts";
import { reconstructControlCandidates } from "../src/server/storage/maintenance/control-candidate/replay.ts";
import { controlVector, successorVector } from "./fixtures/maintenance-control-candidate.ts";
import type { ArtifactRef } from "../src/server/storage/maintenance/types.ts";

const node = (f: ReturnType<typeof controlVector>, value: unknown) => ({ reference: f.pack("journal", value), record: parseVerificationJournal(value) });
const replay = (f: ReturnType<typeof controlVector>, values: readonly unknown[]) => replayVerificationControls(parsePlan(f.plan), values.map(value => node(f, value)),
  { controlRoot: f.root, mutexIdentity: f.mutex });

for (const initialVersion of [1, 2, 3] as const) test(`#248 replay: planned v${initialVersion} prefix roots at the first v3 capture-controls`, () => {
  const f = controlVector({ initialVersion });
  const first = node(f, f.captured), successor = successorVector(f, { origin: first.reference, previous: first.reference,
    sequence: 3, before: [], after: [], clients: [], changes: [], event: "takeover", toGeneration: 8 });
  const result = replay(f, [f.enter, f.captured, successor]);
  assert.equal(result.kind, "untrusted-verification-controls"); assert.deepEqual(result.originalRoster.rows, []);
  assert.deepEqual(result.expectedRows, []); assert.deepEqual(result.unresolvedEncoding, []);
  assert.deepEqual(result.originCapture, first.reference); assert.equal(result.captures.size, 1);
});

test("#248 replay: complete context binding is required even when every final row is unchanged", async t => {
  const f = controlVector(), capture = node(f, f.captured), other: ArtifactRef = { ...capture.reference, sha256: "9".repeat(64) };
  const base = successorVector(f, { origin: capture.reference, previous: capture.reference, sequence: 3, before: [], after: [], clients: [], changes: [] });
  replay(f, [f.enter, f.captured, base]);
  for (const [name, patch] of [
    ["origin capture", { originCapture: other }], ["origin roster", { originSourceClientsDigest: "9".repeat(64) }],
    ["source", { source: { ...f.source, databaseInstanceId: "2".repeat(32) } }], ["plan", { plan: { ...f.planRef, sha256: "9".repeat(64) } }],
    ["migration", { migrationId: "other" }], ["fence", { fenceEpoch: "3" }], ["receipt generation", { receiptGeneration: "8" }],
    ["encoding", { textEncoding: { backend: "sqlite", name: "UTF-16le" } }], ["previous anchor", { previousAnchor: other }],
    ["from generation", { fromGeneration: "8" }], ["to generation", { toGeneration: "8" }], ["target sequence", { targetSequence: "4" }],
    ["before digest", { beforeRowsDigest: "9".repeat(64) }], ["after digest", { afterRowsDigest: "9".repeat(64) }],
    ["fact row count", { facts: { ...base.controlProof.facts, beforeCount: "1" } }],
    ["fact row digest", { facts: { ...base.controlProof.facts, beforeRowsDigest: "9".repeat(64) } }],
  ] as const) await t.test(name, () => assert.throws(() => replay(f, [f.enter, f.captured,
    { ...base, controlProof: { ...base.controlProof, ...patch } }]), /journal_invalid/));
});

test("#248 replay: root invariants bind the actual control root and mutex before any successor", async t => {
  const f = controlVector();
  for (const [name, patch] of [
    ["database", { databaseInstanceId: "2".repeat(32) }], ["fence", { fenceEpoch: "3" }],
    ["migration", { activeMigrationId: "other" }], ["plan", { planDigest: "9".repeat(64) }], ["guard", { guardManifestDigest: "9".repeat(64) }],
    ["root", { controlRootJson: canonicalJson({ ...f.root, inode: "99" }) }],
    ["mutex", { mutexIdentityJson: canonicalJson({ fixture: "other-owner" }) }],
  ] as const) await t.test(name, () => assert.throws(() => replay(f, [f.enter, { ...f.captured,
    controlProof: { ...f.captured.controlProof, maintenanceInvariant: { ...f.invariant, ...patch } } }]), /journal_invalid/));
  assert.throws(() => replay(f, [f.enter, { ...f.captured,
    controlProof: { ...f.captured.controlProof, facts: { ...f.facts, beforeCount: "1" } } }]), /journal_invalid/);
});

test("#248 replay: original roster stays fixed while every later capture has its own replay state", () => {
  const f = controlVector(), origin = node(f, f.captured);
  const first = successorVector(f, { origin: origin.reference, previous: origin.reference, sequence: 3, before: [], after: [], clients: [], changes: [] });
  const firstRef = node(f, first).reference;
  const recapture = { ...successorVector(f, { origin: origin.reference, previous: firstRef, sequence: 4, before: [], after: [], clients: [], changes: [] }),
    event: "capture", sourceClients: f.roster, frozen: f.captured.frozen };
  const result = replay(f, [f.enter, f.captured, first, recapture]);
  assert.equal(result.captures.size, 2); assert.equal(digestJson(result.originalRoster), f.captured.frozen.sourceClientsDigest);
  const selected = node(f, recapture);
  assert.deepEqual(result.captures.get(selected.reference.ref)?.rows, []);
  const candidate = reconstructControlCandidates({ head: selected.reference, objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex });
  assert.equal(candidate.kind, "untrusted-control-reconstruction");
  if (candidate.kind === "untrusted-control-reconstruction") assert.deepEqual(candidate.expectedRows, result.expectedRows);
  assert.throws(() => replay(f, [f.enter, f.captured, first, { ...recapture, controlProof: f.captured.controlProof }]), /journal_invalid/);
});

test("#248 replay: planned takeovers and ready bridges do not become a quiesced V root", () => {
  const f = controlVector({ initialVersion: 2 });
  const takeover = { ...f.enter, sequence: 2, previous: f.enterRef, event: "takeover", ownerGeneration: 8, requestId: "planned-takeover" };
  assert.throws(() => replay(f, [f.enter, takeover, { ...f.captured, previous: node(f, takeover).reference, sequence: 3, ownerGeneration: 8 }]), /journal_invalid/);
});
