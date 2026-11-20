import { createHash } from "node:crypto";
import { AUDIT_LIMITS, parseAuditJsonText } from "./m2-audit-boundary.ts";
import type { AuditRequest } from "./m2-audit-boundary.ts";
import type { M2ProfileJournalRecord, M2ProfileJournalValue, ProfileArtifactRef, ProfileCompletionBinding } from "../profile-terminal-contracts.ts";

// SQ-D02 TERMINAL-FIXED-SOURCE.json, exact effective ProfileCompletionBinding.
// This finite value codec neither resolves references nor replays a durable graph.
function exact(value: unknown, keys: readonly string[], r: AuditRequest): Record<string, unknown> {
  r.units(1);
  r.require(value !== null && typeof value === "object" && !Array.isArray(value), "unsupported_shape");
  let count = 0;
  for (const key in value) {
    r.units(1); r.text(key.length * 2);
    r.require(++count <= keys.length && Object.hasOwn(value, key), "unsupported_shape");
  }
  r.units(keys.length);
  r.require(count === keys.length, "unsupported_shape");
  for (const key of keys) { r.text(key.length * 2); r.require(Object.hasOwn(value, key), "unsupported_shape"); }
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, r: AuditRequest, pattern?: RegExp): string {
  r.require(typeof value === "string");
  r.require(value.length >= 1 && value.length <= maximum);
  if (value.length > AUDIT_LIMITS.field || r.utf8Bytes(value) > AUDIT_LIMITS.field) r.fail("resource_limit");
  r.text(value.length * 2);
  if (pattern) r.require(pattern.test(value));
  return value;
}
function digest(value: unknown, r: AuditRequest): string { return text(value, 64, r, /^[0-9a-f]{64}$/); }
function counter(value: unknown, r: AuditRequest, positive = false): number {
  r.units(1); r.require(typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)
    && value >= (positive ? 1 : 0));
  return value;
}
function literal(value: unknown, expected: string | number | null, r: AuditRequest): void {
  r.units(1);
  if (typeof value === "string" && typeof expected === "string" && value.length === expected.length) r.text(value.length * 2, 2);
  r.require(value === expected, "unsupported_shape");
}
function sameText(left: string, right: string, r: AuditRequest): void {
  r.text((left.length + right.length) * 2); r.require(left === right, "semantic_invariant_failed");
}
function activation(value: unknown, r: AuditRequest): void {
  const v = exact(value, ["activationId", "digest"], r);
  text(v.activationId, 1_048_576, r); digest(v.digest, r);
}
function takeoverPlan(value: unknown, r: AuditRequest): void {
  const v = exact(value, ["planId", "digest"], r);
  text(v.planId, 1_048_576, r); digest(v.digest, r);
}
function evidence(value: unknown, r: AuditRequest): void {
  const v = exact(value, ["artifactId", "digest"], r);
  text(v.artifactId, 4096, r); digest(v.digest, r);
}
function anchor(value: unknown, r: AuditRequest): void {
  const v = exact(value, ["record", "sequence"], r);
  evidence(v.record, r); counter(v.sequence, r, true);
}
function reference(value: unknown, r: AuditRequest): ProfileArtifactRef {
  const v = exact(value, ["ref", "sha256", "bytes"], r);
  text(v.ref, 4096, r, /^[^\u0000]+$/); digest(v.sha256, r); text(v.bytes, 20, r, /^(0|[1-9][0-9]*)$/);
  return value as ProfileArtifactRef;
}
function source(value: unknown, r: AuditRequest): void {
  const v = exact(value, ["kind", "databaseInstanceId", "identityDigest"], r);
  r.require(v.kind === "sqlite" || v.kind === "postgres", "unsupported_shape");
  text(v.databaseInstanceId, 32, r, /^[0-9a-f]{32}$/); digest(v.identityDigest, r);
}
function guardTransition(value: unknown, r: AuditRequest): void {
  const v = exact(value, ["protocolBefore", "protocolAfter", "guardBeforeDigest", "guardAfterDigest", "schemaBeforeDigest",
    "schemaAfterDigest", "writerFormat", "writerFormatDigest", "registeredUpgrade"], r);
  literal(v.protocolBefore, 1, r); literal(v.protocolAfter, 2, r); literal(v.writerFormat, "s2-profile-config/v1", r);
  for (const key of ["guardBeforeDigest", "guardAfterDigest", "schemaBeforeDigest", "schemaAfterDigest", "writerFormatDigest"])
    digest(v[key], r);
  evidence(v.registeredUpgrade, r);
}
function binding(value: unknown, r: AuditRequest): ProfileCompletionBinding {
  const v = exact(value, ["activation", "takeoverPlan", "migrationId", "s4PlanDigest", "sourceIdentityDigest",
    "epochBefore", "epochAfter", "terminal"], r);
  activation(v.activation, r); takeoverPlan(v.takeoverPlan, r);
  text(v.migrationId, 100, r, /^[A-Za-z0-9_-]+$/); digest(v.s4PlanDigest, r); digest(v.sourceIdentityDigest, r);
  const before = counter(v.epochBefore, r), after = counter(v.epochAfter, r);
  r.require(before < Number.MAX_SAFE_INTEGER && after === before + 1, "semantic_invariant_failed");
  anchor(v.terminal, r);
  return value as ProfileCompletionBinding;
}
// Only validated fixed records (at most 17 keys) reach this private C-S4 writer.
// Emit tokens directly, so nested objects do not repeatedly copy whole subtrees.
function canonicalTokens(value: unknown, r: AuditRequest, emit: (token: string) => void): void {
  const string = (v: string): void => {
    const bytes = r.quotedBytes(v);
    r.text(v.length * 2 + bytes * 2); r.allocateNodes(1); // stringify source + UTF-16 result.
    emit(JSON.stringify(v));
  };
  const visit = (v: unknown): void => {
    r.units(1);
    if (typeof v === "string") { string(v); return; }
    if (v === null) { emit("null"); return; }
    if (typeof v === "number") {
      r.text(64); r.allocateNodes(1); // Safe counters have at most 16 decimal characters.
      emit(String(v)); return;
    }
    // Key array and finite sort workspace, charged before Object.keys/sort.
    r.allocateNodes(36); r.units(18);
    const keys = Object.keys(v as object);
    keys.sort((a, b) => { r.text((a.length + b.length) * 2, 2); r.units(1); return a < b ? -1 : a > b ? 1 : 0; });
    emit("{");
    for (let i = 0; i < keys.length; i++) {
      r.units(1); if (i) emit(",");
      const key = keys[i]!; string(key); emit(":");
      r.text(key.length * 2); // Dynamic property lookup is a separate key read.
      visit((v as Record<string, unknown>)[key]);
    }
    emit("}"); r.units(1); Object.freeze(v);
  };
  visit(value);
}
function canonical<T>(value: T, input: string, r: AuditRequest): T {
  let position = 0;
  canonicalTokens(value, r, token => {
    r.text(token.length * 2, 2); // Both UTF-16 sides of the exact comparison, no substring copy.
    r.require(input.startsWith(token, position)); position += token.length;
  });
  r.require(position === input.length); return value;
}
function canonicalHash(value: unknown, r: AuditRequest): string {
  r.allocateNodes(4); r.units(128);
  const hash = createHash("sha256");
  canonicalTokens(value, r, token => {
    // UTF-16 source scan, UTF-8 conversion allocation and hash traversal.
    r.text(token.length * 3, 3); hash.update(token, "utf8");
  });
  r.text(256); r.allocateNodes(1); return hash.digest("hex");
}
function journalPath(migrationId: string, sequence: number, sha256: string, r: AuditRequest): string {
  r.text(64); r.allocateNodes(1); const seq = String(sequence);
  const length = 16 + migrationId.length + seq.length + sha256.length;
  r.text(length * 2, 2); r.allocateNodes(1);
  return `journals/${migrationId}/${seq}-${sha256}.json`;
}
function journalBody(value: unknown, event: M2ProfileJournalRecord["event"], r: AuditRequest): void {
  r.allocateNodes(48); // Fixed per-event key lists, before allocating them.
  const common = ["activation", "takeoverPlan", "physicalSource"];
  const commitCompletion = ["formatVersion", "eventKind", "phase", ...common, "migrationId", "s4PlanDigest",
    "requestDigest", "predecessor", "ownerGeneration"];
  const keys = event === "s2_profile_owner_acquired" ? ["contract", ...common, "fromGeneration", "toGeneration", "controlBefore", "clientDelta", "after"]
    : event === "s2_profile_committed" ? [...commitCompletion, "fenceEpoch", "guardTransition", "exactAllowedDelta", "plannedTargetManifest", "after"]
      : [...commitCompletion, "fenceEpochBefore", "sealedProof", "after"];
  const v = exact(value, keys, r);
  activation(v.activation, r); takeoverPlan(v.takeoverPlan, r); evidence(v.physicalSource, r);
  if (event === "s2_profile_owner_acquired") {
    literal(v.contract, "m2-profile-owner-acquired/r2", r);
    const from = counter(v.fromGeneration, r, true), to = counter(v.toGeneration, r, true);
    r.require(from < Number.MAX_SAFE_INTEGER && to === from + 1, "semantic_invariant_failed");
    evidence(v.controlBefore, r); evidence(v.clientDelta, r);
    const after = exact(v.after, ["admission", "protocolVersion", "journal", "terminal"], r);
    literal(after.admission, "sealed", r); literal(after.protocolVersion, 2, r); literal(after.journal, "SELF", r); literal(after.terminal, null, r);
    return;
  }
  literal(v.formatVersion, 1, r); literal(v.eventKind, event, r); literal(v.phase, event, r);
  text(v.migrationId, 100, r, /^[A-Za-z0-9_-]+$/); digest(v.s4PlanDigest, r); digest(v.requestDigest, r);
  anchor(v.predecessor, r); counter(v.ownerGeneration, r, true);
  if (event === "s2_profile_committed") {
    counter(v.fenceEpoch, r, true); guardTransition(v.guardTransition, r);
    evidence(v.exactAllowedDelta, r); evidence(v.plannedTargetManifest, r);
    const after = exact(v.after, ["admission", "journal", "terminal"], r);
    literal(after.admission, "sealed", r); literal(after.journal, "SELF", r); literal(after.terminal, null, r);
  } else {
    counter(v.fenceEpochBefore, r, true); evidence(v.sealedProof, r);
    const after = exact(v.after, ["admission", "fenceEpoch", "activeMigrationId", "planDigest", "ownerGeneration",
      "protocolVersion", "guardDigest", "journal", "completionBinding"], r);
    literal(after.admission, "open", r); counter(after.fenceEpoch, r, true); counter(after.ownerGeneration, r, true);
    literal(after.activeMigrationId, null, r); literal(after.planDigest, null, r); literal(after.protocolVersion, 2, r);
    digest(after.guardDigest, r); literal(after.journal, "SELF", r); literal(after.completionBinding, "SELF_BINDING", r);
  }
}
function journalValue(value: unknown, r: AuditRequest): M2ProfileJournalRecord {
  r.allocateNodes(256); // All fixed grammar key arrays and scalar-consumer lists below.
  const v = exact(value, ["formatVersion", "kind", "migrationId", "sequence", "previous", "source", "plan", "requestId",
    "requestDigest", "fenceEpoch", "ownerGeneration", "event", "phase", "body", "bindings"], r);
  literal(v.formatVersion, 4, r); literal(v.kind, "journal", r);
  r.require(v.event === "s2_profile_committed" || v.event === "s2_profile_owner_acquired" || v.event === "s2_profile_completed", "unsupported_shape");
  literal(v.phase, v.event === "s2_profile_completed" ? "s2_profile_completed" : "s2_profile_committed", r);
  text(v.migrationId, 100, r, /^[A-Za-z0-9_-]+$/); counter(v.sequence, r, true); source(v.source, r); reference(v.plan, r);
  text(v.requestId, 1_048_576, r); digest(v.requestDigest, r); counter(v.fenceEpoch, r, true); counter(v.ownerGeneration, r, true);
  // All three M2 events follow an existing cursor; none is a new chain genesis.
  r.require(v.previous !== null && (v.sequence as number) > 1, "semantic_invariant_failed");
  reference(v.previous, r);
  const bindings = exact(v.bindings, ["activationReceipt", "takeoverPlan"], r);
  reference(bindings.activationReceipt, r); reference(bindings.takeoverPlan, r);
  journalBody(v.body, v.event, r);
  const j = value as M2ProfileJournalRecord;
  sameText(j.previous.ref, journalPath(j.migrationId, j.sequence - 1, j.previous.sha256, r), r);
  if (j.event === "s2_profile_owner_acquired") {
    r.require(j.ownerGeneration === j.body.toGeneration, "semantic_invariant_failed");
  } else {
    const b = j.body;
    sameText(j.migrationId, b.migrationId, r); sameText(j.plan.sha256, b.s4PlanDigest, r);
    sameText(j.requestDigest, b.requestDigest, r);
    r.require(j.ownerGeneration === b.ownerGeneration && b.predecessor.sequence === j.sequence - 1, "semantic_invariant_failed");
    sameText(j.previous.ref, b.predecessor.record.artifactId, r); sameText(j.previous.sha256, b.predecessor.record.digest, r);
    r.allocateNodes(8); // Fixed request-digest input record, allocated before construction.
    if (j.event === "s2_profile_committed") {
      r.require(j.fenceEpoch === j.body.fenceEpoch, "semantic_invariant_failed");
      sameText(j.requestDigest, canonicalHash({ operation: "commit-profile-takeover", source: j.source,
        takeoverPlan: j.body.takeoverPlan, requestId: j.requestId }, r), r);
    } else {
      r.require(j.fenceEpoch === j.body.fenceEpochBefore && j.fenceEpoch < Number.MAX_SAFE_INTEGER
        && j.body.after.fenceEpoch === j.fenceEpoch + 1 && j.body.after.ownerGeneration === j.ownerGeneration, "semantic_invariant_failed");
      sameText(j.requestDigest, canonicalHash({ operation: "finish-profile-takeover", source: j.source, activation: j.body.activation,
        takeoverPlan: j.body.takeoverPlan, migrationId: j.migrationId, s4PlanDigest: j.body.s4PlanDigest }, r), r);
    }
  }
  return j;
}
/** Decode one selected record's exact bytes. Unselected references are not resolved here. */
export function profileJournalValueParsed(value: unknown, input: string, r: AuditRequest): M2ProfileJournalValue {
  r.allocateNodes(32); // Selected-byte grammar key arrays, before constructing them.
  const v = exact(value, ["artifact", "kind", "bytesHex"], r);
  literal(v.kind, "journal", r); const ref = reference(v.artifact, r), hex = r.hex(v.bytesHex);
  canonical(value, input, r);
  const bytes = hex.length / 2;
  r.text(64); r.allocateNodes(1); sameText(ref.bytes, String(bytes), r);
  r.text(bytes, 4); // Additional decoded/round-trip copy costs on the same C2 request.
  const raw = r.decodeText(hex);
  r.text(raw.length * 2 + bytes * 2); r.allocateNodes(4); r.units(128);
  const hash = createHash("sha256").update(raw, "utf8"); r.text(256); r.allocateNodes(1);
  const actualDigest = hash.digest("hex"); r.text((actualDigest.length + ref.sha256.length) * 2);
  r.require(actualDigest === ref.sha256, "source_contract_mismatch");
  const record = canonical(journalValue(parseAuditJsonText(raw, r), r), raw, r);
  sameText(ref.ref, journalPath(record.migrationId, record.sequence, ref.sha256, r), r);
  r.allocateNodes(32); r.units(32); // Detached SELF records and their fixed properties.
  const journalAnchor = { record: { artifactId: ref.ref, digest: ref.sha256 }, sequence: record.sequence };
  const completion: ProfileCompletionBinding | null = record.event === "s2_profile_completed" ? {
    activation: record.body.activation, takeoverPlan: record.body.takeoverPlan,
    migrationId: record.migrationId, s4PlanDigest: record.body.s4PlanDigest, sourceIdentityDigest: record.source.identityDigest,
    epochBefore: record.fenceEpoch, epochAfter: record.body.after.fenceEpoch, terminal: journalAnchor,
  } : null;
  return { scope: "terminal-value-only", record, journalAnchor, completion };
}
/** The value has already passed the enclosing primitive-string boundary's strict scan. */
export function profileCompletionBindingParsed(value: unknown, input: string, r: AuditRequest): ProfileCompletionBinding {
  r.allocateNodes(128); // All fixed binding grammar key arrays, before their consumers.
  return canonical(binding(value, r), input, r);
}
/** I02's decoded terminal TEXT is charged to exactly the supplied AuditRequest. */
export function parseProfileCompletionBindingText(input: string, r: AuditRequest): ProfileCompletionBinding {
  return profileCompletionBindingParsed(parseAuditJsonText(input, r), input, r);
}
