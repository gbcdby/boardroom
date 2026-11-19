import { z } from "zod";
import { M2_HISTORY_TABLES } from "./m2-history-contracts.ts";
import { CONTROLLED_M22 } from "./internal/m2-controlled-migration-contract.ts";
import { M2_PROFILE_WRITER_CONTRACT } from "./internal/m2-profile-writer-contract.ts";
import { boundary, record } from "./internal/m2-audit-boundary.ts";
import type { AuditCode, AuditRequest } from "./internal/m2-audit-boundary.ts";
import type { ArtifactRef, ReadonlyDeep, SourceRef } from "./m2-value-contracts.ts";
import type { RawCell } from "./m2-history-contracts.ts";

type Backend = "sqlite" | "postgres";
export type M22MigrationEntry = Readonly<{
  contract: "m2-migration22-entry/r1"; backend: Backend; version: 22;
  name: "profile_configuration_authority"; checksum: string; appliedAt: string;
  rowid: "22" | null; registeredMigration: ArtifactRef;
}>;
export type M22MigrationValues = ReadonlyDeep<{
  scope: "fixed-controlled-m22-entry-and-typed-row";
  checksumDomain: "m2-fixed-phase-source/v1";
  entry: M22MigrationEntry;
  row: { table: "schema_migrations"; columns: ["version", "name", "checksum", "applied_at"];
    rowid: "22" | null; cells: RawCell[] };
  unverified: readonly string[];
}>;
export type M22MigrationResult = ReadonlyDeep<{ ok: true; value: M22MigrationValues }
  | { ok: false; error: { code: AuditCode | "semantic_unsupported" } }>;
export type M22ProfileValues = ReadonlyDeep<{
  scope: "fixed-m22-entry-and-profile-format-pair"; migration: M22MigrationValues;
  profileFormatPair: { protocolVersion: 2; writerFormatDigest: string }; writerFormat: "s2-profile-config/v1";
  writerFormatDescriptor: ArtifactRef; sourceClientFormatContract: ArtifactRef;
  unverified: readonly ["activation-receipt-binding-and-complete-profile-current-format", "cf03-05-and-current-native-writer"];
}>;
export type M22ProfileResult = ReadonlyDeep<{ ok: true; value: M22ProfileValues }
  | { ok: false; error: { code: AuditCode | "semantic_unsupported" } }>;

const TIMESTAMP = z.string().max(64).datetime({ offset: true });
const OLD_TABLES = Object.freeze(M2_HISTORY_TABLES.filter(t => t.columnsP0.length).map(t => t.name));
const UNVERIFIED = Object.freeze(["seed-artifact-closure-and-old-row-coverage", "source-existence-and-native-window",
  "production-registration", "controlled-a-transaction-and-sequence-preservation", "g1-receipt-authority-and-full-p1"]);
const PROFILE_KEYS = Object.freeze(["backend", "seed", "profileFormatPair"]);
const PAIR_KEYS = Object.freeze(["protocolVersion", "writerFormatDigest"]);
const PROFILE_UNVERIFIED = Object.freeze(["activation-receipt-binding-and-complete-profile-current-format", "cf03-05-and-current-native-writer"] as const);
const DEFINITION_COMPARE_BYTES = CONTROLLED_M22.definitionRef.ref.length + CONTROLLED_M22.definitionRef.sha256.length + CONTROLLED_M22.definitionRef.bytes.length
  + M2_PROFILE_WRITER_CONTRACT.expectedM22Definition.ref.length + M2_PROFILE_WRITER_CONTRACT.expectedM22Definition.sha256.length
  + M2_PROFILE_WRITER_CONTRACT.expectedM22Definition.bytes.length;

function string(value: unknown, r: AuditRequest, max = 1048576, min = 1): string {
  r.require(typeof value === "string");
  r.text(value.length * 3);
  r.require(value.length >= min && value.length <= max);
  return value;
}
function digest(value: unknown, r: AuditRequest): void {
  r.require(/^[0-9a-f]{64}$/.test(string(value, r, 64)));
}
function decimal(value: unknown, r: AuditRequest): string {
  const result = string(value, r, 20); r.require(/^(0|[1-9][0-9]*)$/.test(result)); return result;
}
function artifact(value: unknown, r: AuditRequest): void {
  const v = record(value, ["ref", "sha256", "bytes"], r);
  r.require(!string(v.ref, r, 4096).includes("\u0000")); digest(v.sha256, r); decimal(v.bytes, r);
}
function source(value: unknown, r: AuditRequest): SourceRef {
  const v = record(value, ["kind", "databaseInstanceId", "identityDigest"], r);
  r.require(v.kind === "sqlite" || v.kind === "postgres", "unsupported_shape");
  r.require(/^[0-9a-f]{32}$/.test(string(v.databaseInstanceId, r, 32))); digest(v.identityDigest, r);
  return v as unknown as SourceRef;
}
function utf8Compare(a: string, b: string, r: AuditRequest): number {
  r.text((a.length + b.length) * 3, 2); r.units(1);
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
function unique(value: string, seen: Set<string>, r: AuditRequest): void {
  r.text(value.length * 3, 2); r.units(2);
  r.require(!seen.has(value), "semantic_invariant_failed"); seen.add(value);
}
function slot(value: unknown, ids: Set<string>, r: AuditRequest): void {
  if (value === null) return;
  const v = record(value, ["snapshotId", "mappingId"], r);
  unique(string(v.snapshotId, r), ids, r);
  if (v.mappingId !== null) unique(string(v.mappingId, r), ids, r);
}

// Validate the entire selected seed's exact value shape and locally decidable
// consistency. References stay opaque; this never claims their bytes or old rows exist.
function selectedSeed(value: unknown, backend: Backend, r: AuditRequest): string {
  const v = record(value, ["contract", "source", "migrationId", "s4Plan", "requestId", "planId", "activationId",
    "captureId", "before", "createdAt", "actor", "agents", "bindings"], r);
  r.require(v.contract === "m2-takeover-seed/r1", "unsupported_shape");
  const selectedSource = source(v.source, r);
  r.require(selectedSource.kind === backend, "source_contract_mismatch");
  r.require(/^[A-Za-z0-9_-]+$/.test(string(v.migrationId, r, 100)));
  artifact(v.s4Plan, r); string(v.requestId, r); string(v.planId, r);
  const newIds = new Set<string>();
  unique(string(v.activationId, r), newIds, r); unique(string(v.captureId, r), newIds, r);
  const before = record(v.before, ["contract", "source", "backend", "phase", "observation", "completeHistoryDigest", "tables"], r);
  r.require(before.contract === "m2-pc-typed-selection/r1" && before.phase === "p0", "unsupported_shape");
  const beforeSource = source(before.source, r);
  r.require(before.backend === backend && beforeSource.kind === backend
    && beforeSource.databaseInstanceId === selectedSource.databaseInstanceId
    && beforeSource.identityDigest === selectedSource.identityDigest, "source_contract_mismatch");
  artifact(before.observation, r); digest(before.completeHistoryDigest, r);
  r.require(Array.isArray(before.tables) && before.tables.length === OLD_TABLES.length, "unsupported_shape");
  let agentCount = "";
  for (let i = 0; i < OLD_TABLES.length; i++) {
    const table = record(before.tables[i], ["table", "columnContract", "columnContractValueDigest", "typedRows", "count", "rowMultisetDigest"], r);
    r.require(table.table === OLD_TABLES[i], "source_contract_mismatch");
    artifact(table.columnContract, r); digest(table.columnContractValueDigest, r); artifact(table.typedRows, r);
    decimal(table.count, r); digest(table.rowMultisetDigest, r);
    if (table.table === "agents") agentCount = table.count as string;
    if (table.table === "schema_migrations") r.require(table.count === "21", "source_contract_mismatch");
  }
  const createdAt = string(v.createdAt, r, 64);
  r.require(TIMESTAMP.safeParse(createdAt).success);
  const offset = /([+-])(\d{2}):?(\d{2})$/.exec(createdAt);
  if (offset) r.require(Number(offset[2]) <= 23 && Number(offset[3]) <= 59);
  const actor = record(v.actor, ["kind", "name", "memberId"], r);
  r.require(actor.kind === "human" && actor.memberId === null, "unsupported_shape"); string(actor.name, r, 1048576, 0);
  r.require(Array.isArray(v.agents) && v.agents.length <= 100000);
  r.require(agentCount === String(v.agents.length), "source_contract_mismatch"); r.rowCount(v.agents.length);
  let previousAgent: string | null = null;
  for (const item of v.agents) {
    const agent = record(item, ["agentId", "profileRevision", "auditId"], r), id = string(agent.agentId, r);
    r.require(agent.profileRevision === 1);
    if (previousAgent !== null) r.require(utf8Compare(previousAgent, id, r) < 0, "semantic_invariant_failed");
    previousAgent = id; unique(string(agent.auditId, r), newIds, r);
  }
  r.require(Array.isArray(v.bindings) && v.bindings.length <= 100000); r.rowCount(v.bindings.length);
  const bindings = new Set<string>();
  let previousBinding: [string, string] | null = null;
  for (const item of v.bindings) {
    const binding = record(item, ["memberId", "groupId", "groupBindingId", "bindingRevision", "legacyExecutionId", "effective", "requested", "applied"], r);
    const memberId = string(binding.memberId, r), groupId = string(binding.groupId, r), bindingId = string(binding.groupBindingId, r);
    r.require(binding.bindingRevision === 1); unique(bindingId, bindings, r);
    if (previousBinding !== null) {
      const first = utf8Compare(previousBinding[0], memberId, r);
      r.require(first < 0 || first === 0 && utf8Compare(previousBinding[1], groupId, r) < 0, "semantic_invariant_failed");
    }
    previousBinding = [memberId, groupId];
    if (binding.legacyExecutionId === null) {
      unique(bindingId, newIds, r);
      r.require(binding.effective === null && binding.requested === null && binding.applied === null, "semantic_invariant_failed");
    } else {
      r.require(string(binding.legacyExecutionId, r) === bindingId && binding.effective !== null, "semantic_invariant_failed");
    }
    slot(binding.effective, newIds, r); slot(binding.requested, newIds, r); slot(binding.applied, newIds, r);
  }
  return createdAt;
}

// PG timestamptz binary is signed int64 microseconds since 2000-01-01 UTC.
// Calendar arithmetic is integer-only. No Date parsing or millisecond truncation.
function postgresTime(createdAt: string): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(createdAt);
  if (!parts || parts[1] === "0000") return null;
  const fraction = parts[7] ?? "";
  if (/[1-9]/.test(fraction.slice(6))) return null;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const daysBeforeYear = (y: number) => 365 * (y - 1) + Math.floor((y - 1) / 4) - Math.floor((y - 1) / 100) + Math.floor((y - 1) / 400);
  const monthDays = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let days = daysBeforeYear(year) - daysBeforeYear(2000) + day - 1;
  for (let m = 1; m < month; m++) days += monthDays[m - 1]!;
  const offset = parts[8] === "Z" ? 0 : (parts[9] === "+" ? 1 : -1) * (Number(parts[10]) * 60 + Number(parts[11]));
  const seconds = BigInt(days) * 86400n + BigInt(Number(parts[4]) * 3600 + Number(parts[5]) * 60 + Number(parts[6]) - offset * 60);
  const micros = seconds * 1000000n + BigInt(fraction.slice(0, 6).padEnd(6, "0"));
  const bytes = Buffer.alloc(8); bytes.writeBigInt64BE(micros); return bytes.toString("hex");
}

// Same-module kernel only: one caller-owned boundary request, never a second public boundary.
function produceM22(backendInput: unknown, selectedSeedInput: unknown, r: AuditRequest): M22MigrationValues | null {
    r.require(backendInput === "sqlite" || backendInput === "postgres", "unsupported_shape");
    const backend = backendInput, appliedAt = selectedSeed(selectedSeedInput, backend, r);
    // Prepay the fixed time/hex producer before its first allocation or conversion.
    // Every produced string is fixed or a <=64-character Timestamp.
    r.text(2048);
    const pgTime = backend === "postgres" ? postgresTime(appliedAt) : null;
    if (backend === "postgres" && pgTime === null) return null;
    const fixed = CONTROLLED_M22, checksum = fixed.dialects[backend].checksum;
    const entry: M22MigrationEntry = { contract: "m2-migration22-entry/r1", backend, version: fixed.version, name: fixed.name,
      checksum, appliedAt, rowid: backend === "sqlite" ? "22" : null, registeredMigration: { ...fixed.definitionRef } };
    const text = (value: string): RawCell => backend === "sqlite" ? ["text", Buffer.from(value, "utf8").toString("hex")]
      : ["pg-binary", "25", Buffer.from(value, "utf8").toString("hex")];
    const cells: RawCell[] = [backend === "sqlite" ? ["integer", "22"] : ["pg-binary", "23", "00000016"], text(entry.name), text(checksum),
      backend === "sqlite" ? text(appliedAt) : ["pg-binary", "1184", pgTime!]];
    return { scope: "fixed-controlled-m22-entry-and-typed-row", checksumDomain: fixed.checksumDomain, entry,
      row: { table: "schema_migrations", columns: ["version", "name", "checksum", "applied_at"], rowid: entry.rowid, cells }, unverified: UNVERIFIED };
}

/** Pure selected-seed value mapping only. No reference IO, registry write, SQL or native permission. */
export function buildM2Migration22Values(input: unknown): M22MigrationResult {
  // Reuse C2's existing strict primitive-string parser and one enclosing budget,
  // including duplicate keys, exact numeric tokens, Unicode and unknown throws.
  const result = boundary(input, (parsed: unknown, r: AuditRequest): M22MigrationValues | null => {
    const request = record(parsed, ["backend", "seed"], r);
    return produceM22(request.backend, request.seed, r);
  });
  if (!result.ok) return Object.freeze({ ok: false, error: Object.freeze({ code: result.error.code }) });
  if (result.value === null) return Object.freeze({ ok: false, error: Object.freeze({ code: "semantic_unsupported" }) });
  return Object.freeze({ ok: true, value: result.value });
}

/** Fixed entry + writer pair only; activation receipt, CF facts and native writer remain unverified. */
export function buildM2Migration22ProfileValues(input: unknown): M22ProfileResult {
  const result = boundary(input, (parsed: unknown, r: AuditRequest): M22ProfileValues | null => {
    const request = record(parsed, PROFILE_KEYS, r);
    r.require(request.backend === "sqlite" || request.backend === "postgres", "unsupported_shape");
    const pair = record(request.profileFormatPair, PAIR_KEYS, r);
    r.require(typeof pair.protocolVersion === "number" && Number.isSafeInteger(pair.protocolVersion));
    r.units(1); r.require(pair.protocolVersion === 2, "source_contract_mismatch");
    digest(pair.writerFormatDigest, r);
    // Both digest operands are exactly 64 ASCII characters; pay before comparison.
    r.text(128); r.require(pair.writerFormatDigest === M2_PROFILE_WRITER_CONTRACT.profileFormatPair.writerFormatDigest, "source_contract_mismatch");
    r.text(DEFINITION_COMPARE_BYTES);
    const expected = M2_PROFILE_WRITER_CONTRACT.expectedM22Definition, actual = CONTROLLED_M22.definitionRef;
    r.require(actual.ref === expected.ref && actual.sha256 === expected.sha256 && actual.bytes === expected.bytes, "source_contract_mismatch");
    const migration = produceM22(request.backend, request.seed, r);
    if (migration === null) return null;
    // Only this seven-field record is new. Fixed metadata is shared; the enclosing
    // boundary measures and freezes the complete result, including the migration graph.
    r.allocateNodes(1); r.units(7);
    return { scope: "fixed-m22-entry-and-profile-format-pair", migration,
      profileFormatPair: M2_PROFILE_WRITER_CONTRACT.profileFormatPair, writerFormat: M2_PROFILE_WRITER_CONTRACT.writerFormat,
      writerFormatDescriptor: M2_PROFILE_WRITER_CONTRACT.writerFormatDescriptor,
      sourceClientFormatContract: M2_PROFILE_WRITER_CONTRACT.sourceClientFormatContract, unverified: PROFILE_UNVERIFIED };
  });
  if (!result.ok) return Object.freeze({ ok: false, error: Object.freeze({ code: result.error.code }) });
  if (result.value === null) return Object.freeze({ ok: false, error: Object.freeze({ code: "semantic_unsupported" }) });
  // Reuse the enclosing boundary's frozen success envelope; no second output producer.
  return result as M22ProfileResult;
}
