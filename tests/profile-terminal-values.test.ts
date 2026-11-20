import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseProfileCompletionBinding, inspectM2ProfileJournalValue } from "../src/server/identity/profile-terminal-values.ts";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import { AUDIT_LIMITS, boundary } from "../src/server/identity/internal/m2-audit-boundary.ts";
import { parseProfileCompletionBindingText } from "../src/server/identity/internal/profile-terminal-values.ts";
import { parseJournal } from "../src/server/storage/maintenance/parse.ts";

const digest = (character: string) => character.repeat(64);
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const evidence = (artifactId: string, character = "a") => ({ artifactId, digest: digest(character) });
const artifact = (ref: string, character = "a") => ({ ref, sha256: digest(character), bytes: "100" });
type Event = "s2_profile_committed" | "s2_profile_owner_acquired" | "s2_profile_completed";
function binding() {
  return {
    activation: { activationId: "activation-one", digest: digest("a") },
    takeoverPlan: { planId: "takeover-one", digest: digest("b") },
    migrationId: "migration-one", s4PlanDigest: digest("c"), sourceIdentityDigest: digest("d"),
    epochBefore: 4, epochAfter: 5,
    terminal: { record: { artifactId: "journal/terminal", digest: digest("e") }, sequence: 9 },
  };
}
function journal(event: Event) {
  const source = { kind: "sqlite", databaseInstanceId: "1".repeat(32), identityDigest: digest("d") };
  const activation = binding().activation, takeoverPlan = binding().takeoverPlan;
  const migrationId = "migration-one", s4PlanDigest = digest("c");
  const predecessor = { record: evidence(`journals/${migrationId}/8-${digest("f")}.json`, "f"), sequence: 8 };
  const previous = artifact(predecessor.record.artifactId, "f");
  const phase = event === "s2_profile_completed" ? "s2_profile_completed" : "s2_profile_committed";
  const requestId = event === "s2_profile_completed" ? "请求/one:finish" : "请求/one";
  const requestDigest = event === "s2_profile_completed"
    ? hash({ operation: "finish-profile-takeover", source, activation, takeoverPlan, migrationId, s4PlanDigest })
    : event === "s2_profile_committed" ? hash({ operation: "commit-profile-takeover", source, takeoverPlan, requestId }) : digest("1");
  const common = { activation, takeoverPlan, physicalSource: evidence("m2/physical-source"), migrationId, s4PlanDigest,
    requestDigest, predecessor, ownerGeneration: 7 };
  const body: Record<string, unknown> = event === "s2_profile_committed" ? {
    formatVersion: 1, eventKind: event, phase, ...common, fenceEpoch: 4,
    guardTransition: { protocolBefore: 1, protocolAfter: 2, guardBeforeDigest: digest("0"), guardAfterDigest: digest("1"),
      schemaBeforeDigest: digest("2"), schemaAfterDigest: digest("3"), writerFormat: "s2-profile-config/v1",
      writerFormatDigest: digest("4"), registeredUpgrade: evidence("m2/upgrade") },
    exactAllowedDelta: evidence("m2/allowed-delta"), plannedTargetManifest: evidence("m2/target-rows"),
    after: { admission: "sealed", journal: "SELF", terminal: null },
  } : event === "s2_profile_owner_acquired" ? {
    contract: "m2-profile-owner-acquired/r2", activation, takeoverPlan, physicalSource: common.physicalSource,
    fromGeneration: 6, toGeneration: 7, controlBefore: evidence("m2/control-before"), clientDelta: evidence("m2/client-delta"),
    after: { admission: "sealed", protocolVersion: 2, journal: "SELF", terminal: null },
  } : {
    formatVersion: 1, eventKind: event, phase, ...common, fenceEpochBefore: 4, sealedProof: evidence("m2/sealed-proof"),
    after: { admission: "open", fenceEpoch: 5, activeMigrationId: null, planDigest: null, ownerGeneration: 7,
      protocolVersion: 2, guardDigest: digest("1"), journal: "SELF", completionBinding: "SELF_BINDING" },
  };
  return { formatVersion: 4, kind: "journal", migrationId, sequence: 9, previous, source,
    plan: artifact(`plans/${s4PlanDigest}.json`, "c"), requestId, requestDigest, fenceEpoch: 4, ownerGeneration: 7,
    event, phase, body, bindings: { activationReceipt: artifact("m2/receipt"), takeoverPlan: artifact("m2/plan") } };
}
function selected(record: ReturnType<typeof journal>) {
  return selectedBytes(record, Buffer.from(canonicalJson(record)));
}
function selectedBytes(record: ReturnType<typeof journal>, bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { artifact: { ref: `journals/${record.migrationId}/${record.sequence}-${sha256}.json`, sha256, bytes: String(bytes.length) },
    kind: "journal", bytesHex: bytes.toString("hex") };
}

test("the canonical original completion binding decodes to a detached deeply frozen value", () => {
  const expected = binding(), input = canonicalJson(expected), result = parseProfileCompletionBinding(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw Error("expected finite terminal value");
  assert.deepEqual(result.value, expected);
  assert.ok(Object.isFrozen(result.value)); assert.ok(Object.isFrozen(result.value.terminal.record));
  assert.equal(canonicalJson(result.value), input);
  assert.equal(Object.hasOwn(result.value, "admitted"), false);
});

function rejected(result: ReturnType<typeof parseProfileCompletionBinding> | ReturnType<typeof inspectM2ProfileJournalValue>, code?: string) {
  assert.equal(result.ok, false, "unexpected value-only success");
  if (result.ok) throw Error("expected refusal");
  if (code) assert.equal(result.error.code, code);
  assert.ok(Object.isFrozen(result.error)); assert.equal(result.error.moreConflicts, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048);
}

test("binding uses the exact original keys, counters and scalar domains", () => {
  const b = binding();
  for (const value of [null, [], { ...b, future: true }, { ...b, activation: { activationId: "a", digest: digest("a"), future: 1 } },
    { ...b, activation: { activationRef: "a", digest: digest("a") } }, { ...b, terminal: { terminalRecordRef: b.terminal.record, sequence: 9 } },
    { ...b, epochBefore: -2, epochAfter: -1 }, { ...b, epochBefore: 4, epochAfter: 6 },
    { ...b, epochBefore: Number.MAX_SAFE_INTEGER, epochAfter: Number.MAX_SAFE_INTEGER },
    { ...b, terminal: { ...b.terminal, sequence: 0 } }, { ...b, migrationId: "m:finish" },
    { ...b, sourceIdentityDigest: digest("A") }, { ...b, activation: { ...b.activation, activationId: "" } },
    { ...b, takeoverPlan: { ...b.takeoverPlan, planId: "" } },
    { ...b, terminal: { record: { artifactId: "x".repeat(4097), digest: digest("e") }, sequence: 9 } }]) {
    rejected(parseProfileCompletionBinding(canonicalJson(value)));
  }
  for (const missing of Object.keys(b)) {
    const partial: Record<string, unknown> = { ...b }; delete partial[missing];
    rejected(parseProfileCompletionBinding(canonicalJson(partial)), "unsupported_shape");
  }
  for (const [before, after] of [[0, 1], [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]]) {
    const result = parseProfileCompletionBinding(canonicalJson({ ...b, epochBefore: before, epochAfter: after }));
    assert.equal(result.ok, true, JSON.stringify(result));
  }
});

test("canonical input rejects duplicate keys, alternate lexemes, BOM, whitespace and malformed Unicode", () => {
  const input = canonicalJson(binding());
  for (const raw of [` ${input}`, `${input}\n`, `\ufeff${input}`, JSON.stringify(binding()),
    input.replace('"epochBefore":4', '"epochBefore":4.0'), input.replace('"epochBefore":4', '"epochBefore":4e0'),
    input.replace('"epochBefore":4', '"epochBefore":4.00000000000000001'),
    input.replace('"epochBefore":4', '"epochBefore":-0'), input.replace('"epochBefore":4', '"epochBefore":9007199254740992'),
    input.replace('"epochBefore":4', '"epochBefore":4,"epochBefore":4'),
    input.replace('"epochBefore":4', '"epochBefore":4,"epochBefor\\u0065":4'),
    input.replace("activation-one", "\\ud800"), input.replace("activation-one", "\\u0061ctivation-one")]) {
    rejected(parseProfileCompletionBinding(raw), "invalid_value");
  }
  const unicode = binding(); unicode.activation.activationId = "激活/😀"; unicode.takeoverPlan.planId = "计划 α";
  assert.equal(parseProfileCompletionBinding(canonicalJson(unicode)).ok, true);
});

test("public primitive boundary never invokes caller object, getter or Proxy behavior", () => {
  let effects = 0;
  const hostile = new Proxy({}, { get() { effects++; throw Error("private"); }, ownKeys() { effects++; throw Error("private"); },
    getPrototypeOf() { effects++; throw Error("private"); } });
  for (const value of [hostile, new String(canonicalJson(binding())), Symbol("private"), () => {},
    { get activation() { effects++; return {}; }, toJSON() { effects++; return binding(); } }]) {
    rejected(parseProfileCompletionBinding(value), "unsupported_shape"); rejected(inspectM2ProfileJournalValue(value), "unsupported_shape");
  }
  assert.equal(effects, 0);
});

test("I02 nested terminal parsing preserves the enclosing request budget and failure reserve", () => {
  const input = canonicalJson(binding());
  const first = boundary("null", (_value, r) => parseProfileCompletionBindingText(input, r));
  assert.equal(first.ok, true);
  const exhausted = boundary("null", (_value, r) => {
    r.text(AUDIT_LIMITS.characters - 10_000);
    return parseProfileCompletionBindingText(input, r);
  });
  rejected(exhausted, "resource_limit");
  const separate = parseProfileCompletionBinding(input); assert.equal(separate.ok, true);
  const oversize = binding(); oversize.activation.activationId = "x".repeat(AUDIT_LIMITS.field + 1);
  rejected(parseProfileCompletionBinding(canonicalJson(oversize)), "resource_limit");
});

test("the three selected M2 v4 event values decode with exact original envelopes and bodies", () => {
  for (const event of ["s2_profile_committed", "s2_profile_owner_acquired", "s2_profile_completed"] as const) {
    const record = journal(event), result = inspectM2ProfileJournalValue(canonicalJson(selected(record)));
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) throw Error("expected selected terminal event value");
    assert.equal(result.value.scope, "terminal-value-only");
    assert.deepEqual(result.value.record, record); assert.ok(Object.isFrozen(result.value.record.body));
    assert.equal(Object.hasOwn(result.value, "closure"), false); assert.equal(Object.hasOwn(result.value, "admitted"), false);
  }
});

test("SELF and SELF_BINDING expand from the selected canonical bytes without entering their own digest domain", () => {
  for (const event of ["s2_profile_committed", "s2_profile_owner_acquired", "s2_profile_completed"] as const) {
    const record = journal(event), selection = selected(record), result = inspectM2ProfileJournalValue(canonicalJson(selection));
    assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw Error("expected SELF value expansion");
    const expectedAnchor = { record: { artifactId: selection.artifact.ref, digest: selection.artifact.sha256 }, sequence: 9 };
    assert.deepEqual(result.value.journalAnchor, expectedAnchor);
    assert.deepEqual(result.value.completion, event === "s2_profile_completed" ? { ...binding(), terminal: expectedAnchor } : null);
    assert.equal(result.value.record.body.after.journal, "SELF");
    assert.equal(hash(result.value.record), selection.artifact.sha256);
    if (event === "s2_profile_completed") {
      const completion = parseProfileCompletionBinding(canonicalJson(result.value.completion));
      assert.equal(completion.ok, true);
      if (completion.ok) assert.deepEqual(completion.value, result.value.completion);
    }
  }
});

function changed(record: ReturnType<typeof journal>, path: readonly string[], value: unknown) {
  const copy = structuredClone(record); let target: Record<string, unknown> = copy;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[path.at(-1)!] = value; return copy;
}
function objectPaths(value: unknown, path: string[] = []): string[][] {
  if (value === null || typeof value !== "object") return [];
  return [path, ...Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...path, key]))];
}
test("every journal envelope, body, ref and after object rejects missing and extra keys", () => {
  for (const event of ["s2_profile_committed", "s2_profile_owner_acquired", "s2_profile_completed"] as const) {
    const record = journal(event);
    for (const path of objectPaths(record)) {
      const copy = structuredClone(record); let target: Record<string, unknown> = copy;
      for (const key of path) target = target[key] as Record<string, unknown>;
      const firstKey = Object.keys(target)[0]!; delete target[firstKey];
      rejected(inspectM2ProfileJournalValue(canonicalJson(selected(copy))), "unsupported_shape");
      const extra = changed(record, [...path, "unexpected"], "not-allowed");
      rejected(inspectM2ProfileJournalValue(canonicalJson(selected(extra))), "unsupported_shape");
    }
  }
});

test("strict event alternatives and fixed SELF literals cannot become caller supplied state", () => {
  const paths: [Event, string[], unknown][] = [
    ["s2_profile_committed", ["formatVersion"], 3], ["s2_profile_committed", ["event"], "enter"],
    ["s2_profile_committed", ["body", "formatVersion"], 2], ["s2_profile_committed", ["body", "eventKind"], "s2_profile_completed"],
    ["s2_profile_committed", ["body", "after", "admission"], "open"], ["s2_profile_committed", ["body", "after", "terminal"], binding()],
    ["s2_profile_committed", ["body", "guardTransition", "writerFormat"], "future-profile"],
    ["s2_profile_committed", ["body", "guardTransition", "protocolBefore"], 2],
    ["s2_profile_owner_acquired", ["phase"], "s2_profile_owner_acquired"],
    ["s2_profile_owner_acquired", ["body", "contract"], "m2-profile-owner-acquired/r1"],
    ["s2_profile_owner_acquired", ["body", "after", "protocolVersion"], 1],
    ["s2_profile_owner_acquired", ["body", "after", "journal"], binding().terminal],
    ["s2_profile_completed", ["phase"], "s2_profile_committed"],
    ["s2_profile_completed", ["body", "after", "completionBinding"], binding()],
    ["s2_profile_completed", ["body", "after", "journal"], "SELF_BINDING"],
    ["s2_profile_completed", ["body", "after", "activeMigrationId"], "migration-one"],
    ["s2_profile_completed", ["body", "after", "planDigest"], digest("c")],
  ];
  for (const [event, path, value] of paths)
    rejected(inspectM2ProfileJournalValue(canonicalJson(selected(changed(journal(event), path, value)))), "unsupported_shape");
  for (const event of ["s2_profile_committed", "s2_profile_owner_acquired", "s2_profile_completed"] as const)
    assert.throws(() => parseJournal(journal(event))); // The old v1–v3 decoder remains unchanged.
});

test("local sequence, previous, owner, epoch, request and plan equalities are checked in both layers", () => {
  const paths: [Event, string[], unknown][] = [
    ["s2_profile_committed", ["sequence"], 10], ["s2_profile_committed", ["previous"], null],
    ["s2_profile_committed", ["body", "predecessor", "sequence"], 7],
    ["s2_profile_committed", ["body", "predecessor", "record", "artifactId"], "another-ref"],
    ["s2_profile_committed", ["body", "predecessor", "record", "digest"], digest("1")],
    ["s2_profile_committed", ["body", "migrationId"], "another-migration"],
    ["s2_profile_committed", ["body", "s4PlanDigest"], digest("1")],
    ["s2_profile_committed", ["body", "requestDigest"], digest("1")],
    ["s2_profile_committed", ["body", "ownerGeneration"], 8],
    ["s2_profile_committed", ["body", "fenceEpoch"], 5],
    ["s2_profile_owner_acquired", ["body", "fromGeneration"], 5],
    ["s2_profile_owner_acquired", ["body", "toGeneration"], 8],
    ["s2_profile_owner_acquired", ["ownerGeneration"], 6],
    ["s2_profile_completed", ["body", "fenceEpochBefore"], 5],
    ["s2_profile_completed", ["body", "after", "fenceEpoch"], 4],
    ["s2_profile_completed", ["body", "after", "ownerGeneration"], 8],
  ];
  for (const [event, path, value] of paths)
    rejected(inspectM2ProfileJournalValue(canonicalJson(selected(changed(journal(event), path, value)))), "semantic_invariant_failed");
  for (const event of ["s2_profile_committed", "s2_profile_completed"] as const) {
    const record = journal(event); record.requestDigest = digest("9"); record.body.requestDigest = digest("9");
    rejected(inspectM2ProfileJournalValue(canonicalJson(selected(record))), "semantic_invariant_failed");
  }
  const overflow = journal("s2_profile_completed"); overflow.fenceEpoch = Number.MAX_SAFE_INTEGER;
  overflow.body.fenceEpochBefore = Number.MAX_SAFE_INTEGER;
  (overflow.body.after as Record<string, unknown>).fenceEpoch = Number.MAX_SAFE_INTEGER;
  rejected(inspectM2ProfileJournalValue(canonicalJson(selected(overflow))), "semantic_invariant_failed");
});

test("selected byte identity, fixed journal path and both canonical domains are mandatory before SELF", () => {
  const record = journal("s2_profile_completed"), original = selected(record);
  for (const input of [{ ...original, artifact: { ...original.artifact, sha256: digest("0") } },
    { ...original, artifact: { ...original.artifact, bytes: "1" } },
    ...["/tmp/terminal.json", "../terminal.json", original.artifact.ref.replace("/9-", "/8-"),
      original.artifact.ref.replace("migration-one", "other")].map(ref => ({ ...original, artifact: { ...original.artifact, ref } })),
    { ...original, kind: "profile-journal-closure" }, { ...original, bytesHex: original.bytesHex.toUpperCase() },
    { ...original, bytesHex: "0" }, { ...original, arbitrary: true }]) {
    rejected(inspectM2ProfileJournalValue(canonicalJson(input)));
  }
  const text = canonicalJson(record);
  for (const raw of [` ${text}`, `${text}\n`, `\ufeff${text}`, JSON.stringify(record),
    text.replace('"sequence":9', '"sequence":9e0'), text.replace('"sequence":9', '"sequence":9,"sequence":9'),
    text.replace('"sequence":9', '"sequence":9007199254740993'), text.replace("activation-one", "\\ud800")]) {
    rejected(inspectM2ProfileJournalValue(canonicalJson(selectedBytes(record, Buffer.from(raw)))), "invalid_value");
  }
  rejected(inspectM2ProfileJournalValue(canonicalJson(selectedBytes(record, Buffer.from([0xff])))), "source_contract_mismatch");
  rejected(inspectM2ProfileJournalValue(` ${canonicalJson(original)}`), "invalid_value");
});

test("finite counter boundaries and shared node/text limits retain their exact failure boundary", () => {
  const max = binding(); max.activation.activationId = "x".repeat(AUDIT_LIMITS.field);
  assert.equal(parseProfileCompletionBinding(canonicalJson(max)).ok, true);
  const nested = `${"[".repeat(65)}0${"]".repeat(65)}`;
  rejected(parseProfileCompletionBinding(nested), "resource_limit");
  const text = canonicalJson(binding());
  const many = boundary("null", (_value, r) => {
    for (let i = 0; i < 1000; i++) parseProfileCompletionBindingText(text, r);
    return binding();
  });
  rejected(many, "resource_limit");
  const maxEpoch = journal("s2_profile_completed"); maxEpoch.fenceEpoch = Number.MAX_SAFE_INTEGER - 1;
  maxEpoch.body.fenceEpochBefore = Number.MAX_SAFE_INTEGER - 1;
  (maxEpoch.body.after as Record<string, unknown>).fenceEpoch = Number.MAX_SAFE_INTEGER;
  assert.equal(inspectM2ProfileJournalValue(canonicalJson(selected(maxEpoch))).ok, true);
});

test("unknown failures remain finite and never inspect an attacker thrown object", t => {
  let effects = 0;
  const thrown = new Proxy({}, { get() { effects++; throw Error("private"); }, getPrototypeOf() { effects++; throw Error("private"); } });
  const text = canonicalJson(binding()), selectedText = canonicalJson(selected(journal("s2_profile_completed")));
  const mock = t.mock.method(Buffer, "byteLength", () => { throw thrown; });
  try {
    for (const result of [parseProfileCompletionBinding(text), inspectM2ProfileJournalValue(selectedText)]) {
      assert.equal(result.ok, false); if (result.ok) throw Error("expected unknown failure");
      assert.equal(result.error.code, "invalid_value"); assert.equal(result.error.location, null); assert.equal(result.error.rule, null);
      assert.deepEqual(result.error.conflicts, []);
    }
  } finally { mock.mock.restore(); }
  assert.equal(effects, 0);
});

test("the complete nested parse and detached output consume the same final byte of the enclosing budget", () => {
  const text = canonicalJson(binding());
  const run = (prepaid: number) => boundary("null", (_value, r) => {
    r.text(prepaid); return parseProfileCompletionBindingText(text, r);
  });
  let low = 0, high = AUDIT_LIMITS.characters;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (run(mid).ok) low = mid; else high = mid;
  }
  const success = run(low); assert.equal(success.ok, true);
  if (success.ok) assert.deepEqual(success.value, binding());
  rejected(run(low + 1), "resource_limit");
  assert.ok(low > AUDIT_LIMITS.characters - 100_000);
});

test("UTF-8 field limits count non-ASCII bytes before canonical production", () => {
  const edge = binding(); edge.activation.activationId = "界".repeat(Math.floor(AUDIT_LIMITS.field / 3)) + "xx";
  assert.equal(Buffer.byteLength(edge.activation.activationId), AUDIT_LIMITS.field);
  assert.equal(parseProfileCompletionBinding(canonicalJson(edge)).ok, true);
  edge.activation.activationId += "x";
  rejected(parseProfileCompletionBinding(canonicalJson(edge)), "resource_limit");
});
