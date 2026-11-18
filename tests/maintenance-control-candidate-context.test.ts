import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { parseControlJournalCandidate } from "../src/server/storage/maintenance/control-candidate/codec.ts";
import { reconstructControlCandidates } from "../src/server/storage/maintenance/control-candidate/replay.ts";
import { controlVector, historicalClient, successorVector, legacyVector } from "./fixtures/maintenance-control-candidate.ts";

const invalid = (error: unknown) => error instanceof MaintenanceFailure && error.code === "journal_invalid";

test("C3 AC16/36 / A12 STD-001: shared decoder preserves exact event/phase/proof branches", () => {
  const f = controlVector(), capture = f.pack("journal", f.captured), legacy = legacyVector();
  const successor = successorVector(f, { origin: capture, previous: capture, sequence: 3, before: [], after: [], clients: [], changes: [] });
  const cases = [
    f.enter,
    { ...f.enter, event: "observation", sequence: 2, previous: f.enterRef },
    f.captured,
    { ...f.captured, controlProof: successor.controlProof },
    successor,
    { ...successor, phase: "snapshot_ready" },
    { ...successor, event: "takeover" },
    { ...successor, event: "takeover", phase: "snapshot_ready" },
    { ...successor, event: "ready", phase: "snapshot_ready", snapshot: legacy.receiptRef },
    legacy.bridge,
    ...["quiesced", "snapshot_ready"].flatMap(phase => [
      { ...successor, event: "cancel_intent", phase },
      { ...successor, event: "cancelled", phase, fenceEpoch: 3, controlProof: {
        formatVersion: 1, kind: "cancel-terminal-controls", originCapture: capture, originSourceClientsDigest: f.captured.frozen.sourceClientsDigest,
        source: f.source, plan: f.planRef, migrationId: "a12", epochBefore: "2", epochAfter: "3", receiptGeneration: "7", textEncoding: f.encoding,
        previousAnchor: capture, ownerGeneration: "7", targetSequence: "3", beforeRowsDigest: f.rowsDigest([]), afterRowsDigest: f.rowsDigest([]),
        changes: [], facts: f.facts, successorRule: "open-next-epoch-clear-active-v1" } },
    ]),
  ];
  for (const value of cases) assert.doesNotThrow(() => parseControlJournalCandidate(value), `${value.event}/${value.phase}`);
  // The old untrusted null placeholder is explicitly superseded by the accepted C3 proof.
  const cancelled = { ...successor, event: "cancel_intent", controlProof: null };
  assert.throws(() => reconstructControlCandidates({ head: f.pack("journal", cancelled), objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex }), invalid);
});

test("A12 STD-001: private decoder rejects locally impossible event/phase/proof combinations before replay", () => {
  const f = controlVector(), capture = f.pack("journal", f.captured), legacy = legacyVector();
  const successor = successorVector(f, { origin: capture, previous: capture, sequence: 3, before: [], after: [], clients: [], changes: [] });
  const cases = [
    { ...f.captured, phase: "planned", controlProof: null },
    { ...f.captured, phase: "planned" },
    { ...f.captured, phase: "snapshot_ready" },
    { ...f.captured, controlProof: null },
    { ...successor, event: "enter" },
    { ...successor, event: "enter", phase: "snapshot_ready" },
    { ...successor, event: "ready", snapshot: legacy.receiptRef },
    { ...successor, event: "ready", phase: "planned", snapshot: legacy.receiptRef, controlProof: null },
    { ...f.enter, event: "takeover" },
    { ...successor, phase: "planned" },
    { ...successor, controlProof: null },
    { ...successor, event: "cancel_intent", controlProof: null },
    { ...successor, event: "cancel_intent", phase: "planned" },
    { ...successor, event: "cancelled" },
    ...["planned", "quiesced", "snapshot_ready"].flatMap(phase => ["cancel_intent", "cancelled"].map(event => ({ ...f.enter, event, phase }))),
    { ...successor, controlProof: f.captured.controlProof },
    { ...legacy.bridge, phase: "quiesced" },
  ];
  for (const value of cases) assert.throws(() => parseControlJournalCandidate(value), invalid, `${value.event}/${value.phase}`);
});

// A complete synthetic R0/profile closes the row bindings, so rejection cannot be
// attributed to a bad digest, missing registration field, or a real native read.
function oldControllerCapture(f: ReturnType<typeof controlVector>, process: unknown, processCheck: unknown) {
  const old = historicalClient(f, "old-controller");
  const profile = { formatVersion: 1, kind: "maintenance-controller-registration", source: f.source, sourceIdentityDigest: f.source.identityDigest,
    creation: { migrationId: "older", plan: { ref: `plans/${"9".repeat(64)}.json`, sha256: "9".repeat(64), bytes: "13" }, fenceEpoch: "1", ownerGeneration: "5",
      previousAnchor: { ref: `journals/older/1-${"8".repeat(64)}.json`, sha256: "8".repeat(64), bytes: "13" }, targetSequence: "2" },
    sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null };
  const row = { ...old.row, entrypoint: f.text("maintenance-controller"), build_id: f.text("boardroom-maintenance-control-v1"),
    host_identity_json: f.text(canonicalJson(f.facts.actor.host)), process_identity_json: f.text(canonicalJson(process)), db_sessions_json: f.text(canonicalJson(profile)),
    registered_epoch: ["integer", "1"] as const, observed_epoch: ["integer", "1"] as const, ended_at: ["null"] as const };
  const sourceClients = { ...f.roster, rows: [row] };
  const fact = { kind: "maintenance-controller", subject: row.client_id, rowDigest: f.rowDigest(row), host: f.facts.actor.host, process, processCheck,
    classification: "exited-actor", registration: "R0-historical" };
  return { ...f.captured, sourceClients, frozen: { ...f.captured.frozen, sourceClientsDigest: digestJson(sourceClients) },
    controlProof: { ...f.captured.controlProof, facts: { ...f.facts, beforeCount: "1", beforeRowsDigest: f.rowsDigest([row]), clients: [fact] } } };
}

for (const backend of ["sqlite", "postgres"] as const) for (const platform of ["linux", "darwin"] as const) {
  test(`A12 REQ-001: ${backend}/${platform} distinguishes logical actors from native incarnations`, () => {
    const f = controlVector({ backend, platform });
    const process = { ...f.facts.actor.process, instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    const absent = (pid: number) => platform === "linux"
      ? { kind: "linux-absent", observerUid: 1000, kernelBootId: process.kernelBootId, pidNamespace: process.pidNamespace, pid, stage: "proc-open", errno: "ENOENT" }
      : { kind: "darwin-absent", result: { version: 1, pid, bootSessionUuid: process.bootSessionUuid, status: "absent" } };
    const replaced = platform === "linux"
      ? { kind: "linux-replaced", observerUid: 1000, kernelBootId: process.kernelBootId, pidNamespace: process.pidNamespace, pid: process.pid,
        observedUid: 1000, observedStartTicks: "100" }
      : { kind: "darwin-present", result: structuredClone(f.facts.actor.processCheck.result) };
    const replay = (value: unknown) => reconstructControlCandidates({ head: f.pack("journal", value), objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex });
    const reused = platform === "linux" ? { ...process, startTicks: "99" } : { ...process, startSeconds: "9" };
    assert.equal(replay(oldControllerCapture(f, reused, replaced)).kind, "untrusted-control-reconstruction", "same PID with a different old start remains a valid replaced shape");
    assert.equal(replay(oldControllerCapture(f, { ...process, pid: 124 }, absent(124))).kind, "untrusted-control-reconstruction", "a distinct absent process is not the current actor");
    if (platform === "darwin") {
      assert.equal(replay(oldControllerCapture(f, { ...process, startMicroseconds: "19" }, replaced)).kind, "untrusted-control-reconstruction", "Darwin start microseconds are part of the incarnation");
    }
    const same = oldControllerCapture(f, process, absent(process.pid));
    assert.throws(() => parseControlJournalCandidate(same), invalid, "a new logical UUID cannot make the actor's native incarnation absent");
    assert.throws(() => replay(same), invalid);
    const equalNumericIdentity = platform === "linux" ? { ...process, startTicks: "0100" }
      : { ...process, startSeconds: "010", startMicroseconds: "020" };
    assert.throws(() => replay(oldControllerCapture(f, equalNumericIdentity, absent(process.pid))), invalid, "decimal spelling cannot create a new native incarnation");
    const contradictoryReplacement = platform === "linux" ? { ...replaced, observedStartTicks: "101" }
      : { kind: "darwin-present", result: { ...f.facts.actor.processCheck.result, startMicroseconds: "21" } };
    assert.throws(() => replay(oldControllerCapture(f, process, contradictoryReplacement)), invalid, "the actor's exact incarnation cannot simultaneously be replaced");
  });
}
