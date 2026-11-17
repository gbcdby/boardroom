import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import * as parsing from "../src/server/storage/maintenance/parse.ts";
import * as journal from "../src/server/storage/maintenance/journal.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { controlVector, successorVector } from "./fixtures/maintenance-control-candidate.ts";

test("C3 AC16 / #248 parser: default and V share strict v3 decoding with unchanged legacy values", () => {
  const f = controlVector();
  assert.deepEqual(parsing.parseJournal(f.captured), f.captured);
  assert.deepEqual(parsing.parseVerificationJournal(f.captured), f.captured);
  const legacy = controlVector({ initialVersion: 2 });
  assert.deepEqual(parsing.parseVerificationJournal(legacy.enter), parsing.parseJournal(legacy.enter));
  for (const value of [{ ...f.captured, extra: true }, { ...f.captured, controlProof: null },
    { ...f.captured, controlProof: { ...f.captured.controlProof, extra: true } }, { ...f.captured, formatVersion: 4 }])
    assert.throws(() => parsing.parseVerificationJournal(value), /journal_invalid/);
});

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
nativeTest("C3 AC16 / #248 journal: default and V read exact v3 captures and keep strict legacy edges", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "maintenance-v3-journal-test-"));
  try {
    const seed = controlVector(), store = await ArtifactStore.create(path.join(directory, "control"), seed.source);
    const f = controlVector({ mechanism: { databaseInstanceId: seed.source.databaseInstanceId, sourceIdentity: seed.sourceIdentity,
      root: store.identity, mutex: seed.mutex, schemaManifestDigest: seed.plan.schemaManifestDigest, guardManifestDigest: seed.plan.guardManifestDigest } });
    for (const item of f.objects) await store.putJson(store.kindFor(item.reference) as "plan" | "journal" | "source-files", JSON.parse(item.bytes.toString("utf8")));
    const capture = await store.putJson("journal", f.captured);
    assert.deepEqual((await journal.verifyJournalChain(store, capture)).nodes.map(node => node.reference), [f.enterRef, capture]);
    const chain = await journal.verifyVerificationJournalChain(store, capture);
    assert.deepEqual(chain.nodes.map(node => node.reference), [f.enterRef, capture]);
    const successor = successorVector(f, { origin: capture, previous: capture, sequence: 3, before: [], after: [], clients: [], changes: [] });
    const head = await store.putJson("journal", successor);
    assert.equal((await journal.verifyVerificationJournalChain(store, head)).nodes.at(-1)!.record.formatVersion, 3);
    const intent = await store.putJson("journal", { ...successor, event: "cancel_intent" });
    assert.equal((await journal.verifyJournalChain(store, intent)).nodes.at(-1)!.record.event, "cancel_intent");
    await assert.rejects(journal.verifyVerificationJournalChain(store, intent), /journal_invalid/);
    const { controlProof: _proof, ...plain } = successor;
    await assert.rejects(journal.verifyVerificationJournalChain(store, await store.putJson("journal", { ...plain, formatVersion: 2 })), /journal_invalid/);
    const legacy = controlVector({ initialVersion: 2, mechanism: { databaseInstanceId: seed.source.databaseInstanceId, sourceIdentity: seed.sourceIdentity,
      root: store.identity, mutex: seed.mutex, schemaManifestDigest: seed.plan.schemaManifestDigest, guardManifestDigest: seed.plan.guardManifestDigest } });
    await store.putJson("journal", legacy.enter);
    const { controlProof: _captureProof, ...legacyBody } = legacy.captured;
    const legacyCapture = await store.putJson("journal", { ...legacyBody, formatVersion: 2 });
    assert.equal((await journal.verifyJournalChain(store, legacyCapture)).nodes.at(-1)!.record.formatVersion, 2);
    await assert.rejects(journal.verifyVerificationJournalChain(store, await store.putJson("journal", { ...successor, previous: legacyCapture,
      controlProof: { ...successor.controlProof, previousAnchor: legacyCapture, originCapture: legacyCapture } })), /journal_invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
