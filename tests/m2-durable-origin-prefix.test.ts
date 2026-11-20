import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import type { ArtifactRef, MigrationPlan, ControlRootIdentity } from "../src/server/storage/maintenance/types.ts";
import { createP0Request, withP0Guard } from "../src/server/identity/internal/m2-p0.ts";
import { fState } from "../src/server/identity/internal/m2-p0-artifacts-common.ts";
import { beginP0FArtifactPass, endP0FArtifactPass } from "../src/server/identity/internal/m2-p0-artifacts-frame.ts";
import { runP0ReadyJournal } from "../src/server/identity/internal/m2-p0-artifacts-math.ts";
import { p0ArtifactFixture } from "./helpers/m2-p0-f-fixture.ts";

// The existing complete P0 fixture supplies real old parser/manifests relationships.
// This test extends its exact capture prefix by an original v2 ready record.
// The snapshot binary is a value fixture; it is not native restore evidence.
function prefix(options: { missingReceipt?: boolean } = {}) {
  const input = p0ArtifactFixture({ journalVersion: 2 });
  const selected = (kind: string) => input.artifacts.find(a => a.kind === kind)!;
  const parsed = (kind: string) => JSON.parse(Buffer.from(selected(kind).bytesHex, "hex").toString("utf8"));
  const receipt = parsed("receipt"), plan = parsed("plan") as MigrationPlan;
  const captured = input.artifacts.find(a => a.kind === "journal" && a.artifact.ref === receipt.capture.journal.ref)!;
  const capture = JSON.parse(Buffer.from(captured.bytesHex, "hex").toString("utf8"));
  const absentHash = "f".repeat(64);
  const ready = { ...capture, event: "ready", phase: "snapshot_ready", previous: captured.artifact,
    sequence: capture.sequence + 1, frozen: null, sourceClients: null, requestId: "ready",
    snapshot: options.missingReceipt
      ? { ...selected("receipt").artifact, ref: `snapshots/${absentHash}/receipt.json`, sha256: absentHash }
      : selected("receipt").artifact };
  const bytes = Buffer.from(canonicalJson(ready)), sha256 = createHash("sha256").update(bytes).digest("hex");
  const reference: ArtifactRef = { ref: `journals/${ready.migrationId}/${ready.sequence}-${sha256}.json`, sha256, bytes: String(bytes.length) };
  input.artifacts.push({ kind: "journal", artifact: reference, bytesHex: bytes.toString("hex") });
  const admitted = createP0Request(JSON.stringify(input)); assert(admitted.ok, JSON.stringify(admitted));
  const f = fState(admitted.value);
  const root = parsed("m2-physical-source").payload.controlRoot as ControlRootIdentity;
  return { input, request: admitted.value, f, planRef: selected("plan").artifact, root, reference, capture: captured.artifact,
    receipt: selected("receipt").artifact, originalPlan: plan };
}
function execute(p: ReturnType<typeof prefix>, anchor: ArtifactRef) {
  return withP0Guard(p.request, () => {
    beginP0FArtifactPass(p.f, p.request.original);
    try { return runP0ReadyJournal(p.f, p.f.decode(p.planRef, "plan"), p.root, anchor); }
    finally { endP0FArtifactPass(p.f); }
  });
}

test("M2 origin precursor consumes the complete old ready tail and its exact receipt", () => {
  const p = prefix();
  const result = execute(p, p.reference);
  assert(result.ok, JSON.stringify(result));
  assert.equal(result.value.chain.nodes.length, 3);
  assert.deepEqual(result.value.chain.nodes.at(-1)!.reference, p.reference);
  assert.equal(result.value.chain.nodes.at(-1)!.record.event, "ready");
  assert.deepEqual(result.value.receiptRef, p.receipt);
  assert.deepEqual(result.value.chain.plan, p.originalPlan);
});

test("M2 origin precursor rejects a valid capture closure that has no ready tail", () => {
  const p = prefix();
  const result = execute(p, p.capture);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "artifact_semantic_mismatch");
});

test("M2 origin precursor rejects a byte-valid ready with a missing exact snapshot receipt", () => {
  const p = prefix({ missingReceipt: true });
  const result = execute(p, p.reference);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "artifact_missing");
});
