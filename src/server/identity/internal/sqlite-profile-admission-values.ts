import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { AUDIT_LIMITS, AuditRequest, observeDisplaySyntax, record } from "./m2-audit-boundary.ts";
import { F_MIGRATIONS } from "./m2-p0-artifacts-catalog.ts";
import { CONTROLLED_M22 } from "./m2-controlled-migration-contract.ts";
import { M2_PROFILE_WRITER_CONTRACT } from "./m2-profile-writer-contract.ts";
import { SQLITE_PROFILE_READ_TABLES, type SqliteProfileObservationPart,
  type SqliteProfileObservationTable } from "../../storage/internal/sqlite-profile-read-source.ts";

export type SqliteProfileRawCell = readonly ["null"] | readonly ["integer" | "text" | "blob" | "real64be", string];
export type SqliteProfileTextEncoding = "UTF-8" | "UTF-16le" | "UTF-16be";
export interface SqliteProfileRawRow { readonly rowid: string; readonly cells: readonly SqliteProfileRawCell[] }
export interface SqliteProfileRawPart { readonly rows: readonly SqliteProfileRawRow[] }
export interface SqliteProfileAdmissionObservation {
  readonly contract: "sqlite-profile-admission-observation/r1";
  readonly sourceKind: "sqlite";
  readonly textEncoding: { readonly backend: "sqlite"; readonly name: SqliteProfileTextEncoding };
  readonly columns: Readonly<Record<SqliteProfileObservationTable, readonly string[]>>;
  readonly control: SqliteProfileRawPart; readonly authority: SqliteProfileRawPart;
  readonly activationReceipts: SqliteProfileRawPart; readonly migrations: SqliteProfileRawPart;
  readonly clients: SqliteProfileRawPart;
}
type ObjectValue = Record<string, unknown>;
type DecodedRow = Record<string, string | null>;
type DecodedTables = Record<SqliteProfileObservationPart, DecodedRow[]>;
type Control = { databaseInstanceId: string; protocol: "1" | "2"; admission: string;
  fenceEpoch: number; ownerGeneration: number; journalSequence: number;
  root: string | null; mutex: string | null; activeMigrationId: string | null;
  planDigest: string | null; journalRecordRef: string | null; journalDigest: string | null;
  guardDigest: string; terminal: string | null };

function integer(value: unknown, r: AuditRequest): string {
  r.require(typeof value === "string");
  r.require(value.length <= 20); r.text(value.length);
  r.require(/^(?:0|-?[1-9][0-9]*)$/.test(value));
  const number = BigInt(value);
  r.require(number >= -9223372036854775808n && number <= 9223372036854775807n);
  return value;
}
function counter(value: unknown, r: AuditRequest, positive = false): number {
  const decimal = integer(value, r);
  const number = BigInt(decimal);
  r.require(number >= (positive ? 1n : 0n) && number <= 9007199254740991n, "semantic_invariant_failed");
  return Number(number);
}
function nonempty(value: unknown, r: AuditRequest): string {
  r.require(typeof value === "string" && value.length > 0, "semantic_invariant_failed");
  return value;
}
function digest(value: unknown, r: AuditRequest): string {
  r.require(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "semantic_invariant_failed");
  return value;
}
function nullableId(value: unknown, r: AuditRequest): string | null { return value === null ? null : nonempty(value, r); }
function nullableDigest(value: unknown, r: AuditRequest): string | null { return value === null ? null : digest(value, r); }

// Every buffer/decode/copy is reserved on the original request. BOMs remain original text data.
function decodeText(hex: string, encoding: SqliteProfileTextEncoding, r: AuditRequest): string {
  const bytes = hex.length / 2;
  r.require(bytes <= AUDIT_LIMITS.field, "resource_limit");
  r.text(bytes, 10);
  const raw = Buffer.from(hex, "hex");
  if (encoding === "UTF-8") r.require(isUtf8(raw), "source_contract_mismatch");
  else {
    r.require(bytes % 2 === 0, "source_contract_mismatch");
    const read = (index: number): number => encoding === "UTF-16le" ? raw.readUInt16LE(index) : raw.readUInt16BE(index);
    for (let index = 0; index < bytes; index += 2) {
      const code = read(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        index += 2;
        r.require(index < bytes, "source_contract_mismatch");
        const low = read(index); r.require(low >= 0xdc00 && low <= 0xdfff, "source_contract_mismatch");
      } else r.require(code < 0xdc00 || code > 0xdfff, "source_contract_mismatch");
    }
  }
  const value = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(raw);
  const roundtrip = Buffer.from(value, encoding === "UTF-8" ? "utf8" : "utf16le");
  if (encoding === "UTF-16be") roundtrip.swap16();
  r.require(roundtrip.equals(raw), "source_contract_mismatch");
  return value;
}
function raw(value: unknown, r: AuditRequest): { input: SqliteProfileAdmissionObservation; tables: DecodedTables } {
  const input = record(value, ["contract", "sourceKind", "textEncoding", "columns", "control", "authority",
    "activationReceipts", "migrations", "clients"], r);
  r.require(input.contract === "sqlite-profile-admission-observation/r1" && input.sourceKind === "sqlite", "source_contract_mismatch");
  const encoding = record(input.textEncoding, ["backend", "name"], r);
  r.require(encoding.backend === "sqlite" && (encoding.name === "UTF-8" || encoding.name === "UTF-16le" || encoding.name === "UTF-16be"),
    "source_contract_mismatch");
  const columns = record(input.columns, SQLITE_PROFILE_READ_TABLES.map(table => table.table), r);
  r.allocateNodes(1 + SQLITE_PROFILE_READ_TABLES.length);
  const tables = Object.create(null) as DecodedTables;
  for (const table of SQLITE_PROFILE_READ_TABLES) {
    const names = columns[table.table];
    r.require(Array.isArray(names) && names.length === table.columns.length, "source_contract_mismatch");
    r.units(names.length);
    r.require(table.columns.every((column, index) => names[index] === column.name), "source_contract_mismatch");
    const part = record(input[table.inputKey], ["rows"], r);
    r.require(Array.isArray(part.rows), "unsupported_shape");
    r.rowCount(part.rows.length); r.allocateNodes(part.rows.length * (table.columns.length + 1) + 1);
    const decoded: DecodedRow[] = [], rowids = new Set<string>();
    for (const item of part.rows) {
      const row = record(item, ["rowid", "cells"], r), rowid = integer(row.rowid, r);
      r.require(!rowids.has(rowid), "semantic_invariant_failed"); rowids.add(rowid);
      r.require(Array.isArray(row.cells) && row.cells.length === table.columns.length, "source_contract_mismatch");
      const values = Object.create(null) as DecodedRow;
      for (let index = 0; index < table.columns.length; index++) {
        const column = table.columns[index]!, cell: unknown = row.cells[index];
        r.units(1); r.require(Array.isArray(cell), "unsupported_shape");
        const tag: unknown = cell[0];
        r.require((tag === "null" && cell.length === 1) || (cell.length === 2
          && (tag === "integer" || tag === "text" || tag === "blob" || tag === "real64be")), "unsupported_shape");
        let decoded: string | null = null;
        if (tag === "integer") decoded = integer(cell[1], r);
        else if (tag !== "null") {
          const hex = r.hex(cell[1], tag === "real64be" ? 8 : undefined);
          if (tag === "text") decoded = decodeText(hex, encoding.name, r);
        }
        const expected = column.type === "INTEGER" || column.type === "BIGINT" ? "integer" : "text";
        r.require(tag === expected || tag === "null" && column.notnull === 0, "source_contract_mismatch");
        if (column.pk === 1 && column.type === "INTEGER") r.require(decoded === rowid, "semantic_invariant_failed");
        values[column.name] = decoded;
      }
      decoded.push(values);
    }
    tables[table.inputKey] = decoded;
  }
  return { input: input as unknown as SqliteProfileAdmissionObservation, tables };
}
function jsonObject(text: string, r: AuditRequest): ObjectValue {
  r.require(observeDisplaySyntax(text, r) === "object");
  r.text(r.utf8Bytes(text), 2);
  return JSON.parse(text) as ObjectValue;
}
function canonical(value: unknown, r: AuditRequest): string {
  r.units(1);
  if (typeof value === "string") {
    r.text(value.length);
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = value.charCodeAt(++index); r.require(low >= 0xdc00 && low <= 0xdfff);
      } else r.require(code < 0xdc00 || code > 0xdfff);
    }
    return r.stringify(value, AUDIT_LIMITS.field);
  }
  if (value === null || typeof value === "boolean") return r.stringify(value, AUDIT_LIMITS.field);
  if (typeof value === "number") {
    r.require(Number.isSafeInteger(value) && !Object.is(value, -0));
    return r.stringify(value, AUDIT_LIMITS.field);
  }
  // This is only reached after exact fixed-shape validation. No arrays/unknown extension map is allowed.
  r.require(value !== null && typeof value === "object" && !Array.isArray(value), "unsupported_shape");
  const object = value as ObjectValue, keys = Object.keys(object);
  r.allocateNodes(keys.length * 2 + 1);
  // All accepted property names are ASCII, so UTF-16 and codepoint orders coincide here.
  r.require(keys.every(key => /^[a-zA-Z][a-zA-Z0-9]*$/.test(key)), "unsupported_shape");
  const longest = keys.reduce((maximum, key) => Math.max(maximum, key.length), 0);
  r.units(keys.length * Math.ceil(Math.log2(Math.max(2, keys.length))) * Math.max(1, longest));
  keys.sort();
  const pieces: string[] = [];
  let bytes = 2 + Math.max(0, keys.length - 1);
  for (const key of keys) {
    const name = r.stringify(key, AUDIT_LIMITS.field), body = canonical(object[key], r);
    const size = r.utf8Bytes(name) + r.utf8Bytes(body) + 1;
    r.text(size); bytes += size;
    r.require(bytes <= AUDIT_LIMITS.field, "resource_limit");
    pieces.push(`${name}:${body}`);
  }
  r.text(bytes, 2);
  return `{${pieces.join(",")}}`;
}
function canonicalEquals(value: unknown, expected: string | null | undefined, r: AuditRequest): void {
  r.require(canonical(value, r) === expected, "semantic_invariant_failed");
}
function evidence(value: unknown, r: AuditRequest): ObjectValue {
  const ref = record(value, ["artifactId", "digest"], r);
  nonempty(ref.artifactId, r); digest(ref.digest, r);
  return ref;
}
function pair(value: unknown, id: "activationId" | "planId", r: AuditRequest): ObjectValue {
  const ref = record(value, [id, "digest"], r);
  nonempty(ref[id], r); digest(ref.digest, r);
  return ref;
}
function localRoot(state: Control, r: AuditRequest): void {
  r.require(state.root !== null && state.mutex !== null, "semantic_invariant_failed");
  const root = record(jsonObject(state.root, r), ["path", "device", "inode", "hostIdentityDigest"], r);
  const mutex = record(jsonObject(state.mutex, r), ["kind", "path", "device", "inode"], r);
  const path = nonempty(root.path, r);
  r.require(path.startsWith("/") && !path.includes("\0"), "semantic_invariant_failed");
  digest(root.hostIdentityDigest, r);
  for (const value of [root.device, root.inode, mutex.device, mutex.inode]) {
    r.require(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "semantic_invariant_failed");
  }
  r.text(path.length, 2);
  r.require(mutex.kind === "sqlite-operation-mutex" && mutex.path === posix.join(path, "mutex.sqlite"), "semantic_invariant_failed");
  canonicalEquals(root, state.root, r); canonicalEquals(mutex, state.mutex, r);
}
type Receipt = { row: DecodedRow; body: ObjectValue; plan: ObjectValue; physical: ObjectValue; guard: ObjectValue };
function receipts(rows: DecodedRow[], r: AuditRequest): Map<string, Receipt> {
  r.allocateNodes(rows.length * 6 + 1);
  const result = new Map<string, Receipt>();
  for (const row of rows) {
    const id = nonempty(row.id, r); r.require(!result.has(id), "semantic_invariant_failed");
    const body = record(jsonObject(nonempty(row.payload_json, r), r), ["requestId", "planRef", "physicalSourceRef",
      "snapshotReceiptRef", "captureRef", "schemaBeforeDigest", "schemaAfterDigest", "guardTransition", "allowedDeltaManifest",
      "targetRowsDigest", "sourceToTargetManifest", "committedAuthority"], r);
    nonempty(body.requestId, r);
    const plan = pair(body.planRef, "planId", r), physical = evidence(body.physicalSourceRef, r);
    const snapshot = evidence(body.snapshotReceiptRef, r), delta = evidence(body.allowedDeltaManifest, r);
    const manifest = evidence(body.sourceToTargetManifest, r);
    const capture = record(body.captureRef, ["captureId", "sourceDigest", "artifactDigest"], r);
    nonempty(capture.captureId, r); digest(capture.sourceDigest, r); digest(capture.artifactDigest, r);
    digest(body.schemaBeforeDigest, r); digest(body.schemaAfterDigest, r); digest(body.targetRowsDigest, r);
    const guard = record(body.guardTransition, ["protocolBefore", "protocolAfter", "guardBeforeDigest", "guardAfterDigest",
      "schemaBeforeDigest", "schemaAfterDigest", "writerFormat", "writerFormatDigest", "registeredUpgrade"], r);
    r.require(guard.protocolBefore === 1 && guard.protocolAfter === 2 && guard.writerFormat === "s2-profile-config/v1",
      "source_contract_mismatch");
    for (const key of ["guardBeforeDigest", "guardAfterDigest", "schemaBeforeDigest", "schemaAfterDigest", "writerFormatDigest"]) digest(guard[key], r);
    evidence(guard.registeredUpgrade, r);
    r.require(guard.schemaBeforeDigest === body.schemaBeforeDigest && guard.schemaAfterDigest === body.schemaAfterDigest
      && body.committedAuthority === "profile", "semantic_invariant_failed");
    r.require(row.request_id === body.requestId && row.plan_id === plan.planId && row.plan_digest === plan.digest
      && row.capture_id === capture.captureId && row.capture_source_digest === capture.sourceDigest
      && row.capture_artifact_digest === capture.artifactDigest && row.schema_before_digest === body.schemaBeforeDigest
      && row.schema_after_digest === body.schemaAfterDigest && row.target_rows_digest === body.targetRowsDigest, "semantic_invariant_failed");
    canonicalEquals(physical, row.physical_source_ref, r); canonicalEquals(snapshot, row.snapshot_receipt_ref, r);
    canonicalEquals(guard, row.guard_transition_json, r); canonicalEquals(delta, row.allowed_delta_ref, r);
    canonicalEquals(manifest, row.source_to_target_manifest_ref, r); canonicalEquals(body, row.payload_json, r);
    const encoded = nonempty(row.payload_json, r);
    r.text(r.utf8Bytes(encoded));
    r.require(digest(row.payload_digest, r) === createHash("sha256").update(encoded, "utf8").digest("hex"), "semantic_invariant_failed");
    result.set(id, { row, body, plan, physical, guard });
  }
  return result;
}
function authority(rows: DecodedRow[], observedReceipts: Map<string, Receipt>, state: Control, r: AuditRequest): Receipt {
  r.require(rows.length === 1, "semantic_invariant_failed");
  const row = rows[0]!;
  r.require(row.singleton === "1" && row.format_version === "1" && row.owner === "profile", "semantic_invariant_failed");
  const id = nonempty(row.activation_id, r), encoded = nonempty(row.source_binding_ref, r), binding = jsonObject(encoded, r);
  // Imported/layout authority has a different accepted protocol. It is not local-M2 by fallback.
  r.require(binding.kind === "local", "unsupported_shape");
  record(binding, ["contract", "kind", "physicalSourceRef", "activation"], r);
  r.require(binding.contract === "m2-source-binding/r1", "source_contract_mismatch");
  const activation = pair(binding.activation, "activationId", r), physical = evidence(binding.physicalSourceRef, r);
  canonicalEquals(binding, encoded, r);
  const receipt = observedReceipts.get(id);
  r.require(receipt !== undefined && activation.activationId === id && activation.digest === receipt.row.payload_digest,
    "semantic_invariant_failed");
  r.require(physical.artifactId === receipt.physical.artifactId && physical.digest === receipt.physical.digest
    && state.guardDigest === receipt.guard.guardAfterDigest, "semantic_invariant_failed");
  r.require(receipt.guard.writerFormatDigest === M2_PROFILE_WRITER_CONTRACT.profileFormatPair.writerFormatDigest,
    "source_contract_mismatch");
  return receipt;
}
function control(rows: DecodedRow[], r: AuditRequest): Control {
  r.require(rows.length === 1, "semantic_invariant_failed");
  const row = rows[0]!;
  r.require(row.singleton === "1" && (row.protocol_version === "1" || row.protocol_version === "2"), "semantic_invariant_failed");
  r.require(typeof row.database_instance_id === "string" && /^[a-f0-9]{32}$/.test(row.database_instance_id), "semantic_invariant_failed");
  r.require(row.admission === "open" || row.admission === "draining" || row.admission === "sealed", "semantic_invariant_failed");
  r.allocateNodes(18);
  const result: Control = { databaseInstanceId: row.database_instance_id, protocol: row.protocol_version, admission: row.admission,
    fenceEpoch: counter(row.fence_epoch, r), ownerGeneration: counter(row.owner_generation, r), journalSequence: counter(row.journal_sequence, r),
    root: nullableId(row.control_root_json, r), mutex: nullableId(row.mutex_identity_json, r),
    activeMigrationId: nullableId(row.active_migration_id, r), planDigest: nullableDigest(row.plan_digest, r),
    journalRecordRef: nullableId(row.journal_record_ref, r), journalDigest: nullableDigest(row.journal_digest, r),
    guardDigest: digest(row.guard_manifest_digest, r), terminal: nullableId(row.profile_takeover_terminal_json, r) };
  for (const value of [result.root, result.mutex]) if (value !== null) jsonObject(value, r);
  r.require(result.admission === "open" ? result.activeMigrationId === null && result.planDigest === null
    : result.activeMigrationId !== null && result.planDigest !== null && result.root !== null && result.mutex !== null && result.journalRecordRef !== null,
  "semantic_invariant_failed");
  r.require(result.journalSequence === 0 ? result.journalDigest === null && result.journalRecordRef === null
    : result.journalDigest !== null && result.journalRecordRef !== null, "semantic_invariant_failed");
  return result;
}
function migrations(rows: DecodedRow[], profile: "P0" | "P1", r: AuditRequest): void {
  const expectedCount = profile === "P0" ? 21 : 22;
  r.require(rows.length === expectedCount, "semantic_invariant_failed");
  r.allocateNodes(expectedCount);
  const seen = new Set<number>();
  for (const row of rows) {
    const version = counter(row.version, r, true);
    r.require(version <= expectedCount && !seen.has(version), "semantic_invariant_failed"); seen.add(version);
    const expected = version === 22 ? { name: CONTROLLED_M22.name, checksum: CONTROLLED_M22.dialects.sqlite.checksum }
      : F_MIGRATIONS.sqlite[version - 1]!;
    r.require(row.name === expected.name && row.checksum === expected.checksum, "source_contract_mismatch");
    // SQLite datetime output is retained byte-for-byte, never converted through Date.
    nonempty(row.applied_at, r);
  }
}
function timestamp(value: unknown, r: AuditRequest): string {
  const text = nonempty(value, r);
  r.require(text.length === 24, "semantic_invariant_failed");
  r.text(24, 3); r.allocateNodes(1);
  const milliseconds = Date.parse(text);
  r.require(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === text, "semantic_invariant_failed");
  return text;
}
function clients(rows: DecodedRow[], state: Control, r: AuditRequest): void {
  r.allocateNodes(rows.length + 1);
  const ids = new Set<string>();
  for (const row of rows) {
    const id = nonempty(row.client_id, r);
    r.require(!ids.has(id) && row.database_instance_id === state.databaseInstanceId, "semantic_invariant_failed"); ids.add(id);
    r.require(["http", "stdio", "owned-background", "local-management", "maintenance-controller"].includes(nonempty(row.entrypoint, r)),
      "source_contract_mismatch");
    nonempty(row.build_id, r);
    r.require(row.protocol_version === "1" && row.writer_format_digest === null
      || row.protocol_version === "2" && row.writer_format_digest === M2_PROFILE_WRITER_CONTRACT.profileFormatPair.writerFormatDigest,
    "source_contract_mismatch");
    r.require(state.protocol === "2" || row.protocol_version === "1", "semantic_invariant_failed");
    const registered = counter(row.registered_epoch, r), observed = counter(row.observed_epoch, r);
    const drain = row.drain_epoch === null ? null : counter(row.drain_epoch, r);
    r.require(registered <= observed && observed <= state.fenceEpoch
      && (drain === null || registered <= drain && drain <= state.fenceEpoch), "semantic_invariant_failed");
    const drainState = nonempty(row.drain_state, r), receipt = nullableDigest(row.drain_receipt_digest, r);
    r.require(["none", "requested", "draining", "drained", "cancel_pending", "cancelled"].includes(drainState), "source_contract_mismatch");
    r.require(drainState !== "drained" || drain !== null && receipt !== null, "semantic_invariant_failed");
    r.require(drainState !== "none" || drain === null && receipt === null, "semantic_invariant_failed");
    // These are syntax observations only; actual host/process/session ownership and CF facts belong to I04.
    for (const name of ["host_identity_json", "process_identity_json", "db_sessions_json"]) jsonObject(nonempty(row[name], r), r);
    const registeredAt = timestamp(row.registered_at, r), observedAt = timestamp(row.last_observed_at, r);
    r.require(registeredAt <= observedAt, "semantic_invariant_failed");
    if (row.ended_at !== null) {
      const ended = timestamp(row.ended_at, r);
      r.require(registeredAt <= ended && ended <= observedAt, "semantic_invariant_failed");
    }
  }
}

/** Internal fixed DTO consumer. Both native production and the primitive wrapper share their original request. */
export function observeSqliteProfileAdmissionRaw(value: unknown, r: AuditRequest) {
  const observed = raw(value, r), state = control(observed.tables.control, r);
  const profile = state.protocol === "1" ? "P0" : "P1";
  let phase: "p0" | "sealed-awaiting-b" | "terminal-present" = "p0";
  if (profile === "P0") {
    r.require(state.terminal === null && observed.tables.authority.length === 0 && observed.tables.activationReceipts.length === 0,
      "semantic_invariant_failed");
  } else {
    localRoot(state, r);
    authority(observed.tables.authority, receipts(observed.tables.activationReceipts, r), state, r);
    // The separately owned I03 same-request decoder supplies terminal-present observation.
    r.require(state.terminal === null, "unsupported_shape");
    r.require(state.admission === "sealed", "semantic_invariant_failed");
    phase = "sealed-awaiting-b";
  }
  migrations(observed.tables.migrations, profile, r);
  clients(observed.tables.clients, state, r);
  r.allocateNodes(12);
  return { contract: "sqlite-profile-admission-value/r1" as const, scope: "raw-and-metadata-links" as const,
    qualification: "observation-only" as const, profile, phase, terminalClosure: "not_run" as const, nativeSource: "not_run" as const,
    finalSchemaAndGuards: "not_run" as const, clientLifecycle: "not_run" as const, raw: observed.input };
}
