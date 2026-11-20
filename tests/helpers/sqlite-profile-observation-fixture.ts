import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { F_MIGRATIONS } from "../../src/server/identity/internal/m2-p0-artifacts-catalog.ts";
import { encodeM2RowValue } from "../../src/server/identity/m2-row-codecs.ts";
import { canonicalJson } from "../../src/server/storage/maintenance/canonical.ts";

export type Cell = ["null"] | ["integer" | "text" | "blob" | "real64be", string];
export type Encoding = "UTF-8" | "UTF-16le" | "UTF-16be";
export type Row = { rowid: string; cells: Cell[] };
export type Part = { rows: Row[] };
export const columns = {
  storage_maintenance: ["singleton", "database_instance_id", "control_root_json", "mutex_identity_json", "fence_epoch", "admission",
    "active_migration_id", "plan_digest", "owner_generation", "journal_record_ref", "journal_digest", "journal_sequence",
    "protocol_version", "guard_manifest_digest", "profile_takeover_terminal_json"],
  storage_source_clients: ["client_id", "database_instance_id", "entrypoint", "build_id", "protocol_version", "host_identity_json",
    "process_identity_json", "db_sessions_json", "registered_epoch", "observed_epoch", "drain_epoch", "drain_state",
    "drain_receipt_digest", "registered_at", "last_observed_at", "ended_at", "writer_format_digest"],
  config_authority: ["singleton", "format_version", "owner", "activation_id", "source_binding_ref"],
  config_activation_receipts: ["id", "request_id", "plan_id", "plan_digest", "physical_source_ref", "snapshot_receipt_ref", "capture_id",
    "capture_source_digest", "capture_artifact_digest", "schema_before_digest", "schema_after_digest", "guard_transition_json",
    "allowed_delta_ref", "target_rows_digest", "source_to_target_manifest_ref", "payload_json", "payload_digest"],
  schema_migrations: ["version", "name", "checksum", "applied_at"],
};
export function text(value: string, encoding: Encoding = "UTF-8"): Cell {
  const buffer = Buffer.from(value, encoding === "UTF-8" ? "utf8" : "utf16le");
  if (encoding === "UTF-16be") buffer.swap16();
  return ["text", buffer.toString("hex")];
}
function row(values: (string | number | null)[], rowid = "1", encoding: Encoding = "UTF-8"): Row {
  return { rowid, cells: values.map(v => v === null ? ["null"] : typeof v === "number" ? ["integer", String(v)] : text(v, encoding)) };
}
export function p0(encoding: Encoding = "UTF-8") {
  return {
    contract: "sqlite-profile-admission-observation/r1", sourceKind: "sqlite", textEncoding: { backend: "sqlite", name: encoding },
    columns: structuredClone(columns),
    control: { rows: [row([1, "a".repeat(32), null, null, 0, "open", null, null, 0, null, null, 0, 1, "b".repeat(64), null], "1", encoding)] },
    authority: { rows: [] } as Part, activationReceipts: { rows: [] } as Part,
    migrations: { rows: F_MIGRATIONS.sqlite.map(m => row([m.version, m.name, m.checksum, "2026-11-20 00:00:00"], String(m.version), encoding)) },
    clients: { rows: [] } as Part,
  };
}
export const writerDigest = "c94dfbd3199953af3740188aff54566578708e0ee6267440aa27c71db51fac03";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function p1(encoding: Encoding = "UTF-8", terminal = false) {
  const input = p0(encoding);
  const evidence = (artifactId: string) => ({ artifactId, digest: hash(artifactId) });
  const body = { requestId: "req-1", planRef: { planId: "takeover-1", digest: "1".repeat(64) },
    physicalSourceRef: evidence("physical-1"), snapshotReceiptRef: evidence("snapshot-1"),
    captureRef: { captureId: "capture-1", sourceDigest: "2".repeat(64), artifactDigest: "3".repeat(64) },
    schemaBeforeDigest: "4".repeat(64), schemaAfterDigest: "5".repeat(64),
    guardTransition: { protocolBefore: 1 as const, protocolAfter: 2 as const, guardBeforeDigest: "6".repeat(64),
      guardAfterDigest: "7".repeat(64), schemaBeforeDigest: "4".repeat(64), schemaAfterDigest: "5".repeat(64),
      writerFormat: "s2-profile-config/v1" as const, writerFormatDigest: writerDigest, registeredUpgrade: evidence("upgrade-1") },
    allowedDeltaManifest: evidence("delta-1"), targetRowsDigest: "8".repeat(64),
    sourceToTargetManifest: evidence("source-to-target-1"), committedAuthority: "profile" as const };
  const activation = { activationId: "activation-中文🦊", digest: hash(canonicalJson(body)) };
  function projection(table: "config_activation_receipts" | "config_authority", value: unknown): Row {
    const encoded = encodeM2RowValue({ table, value });
    assert.equal(encoded.ok, true, JSON.stringify(encoded));
    if (!encoded.ok || encoded.value.contract !== "m2-row-projection/r1") throw new Error("invalid fixture projection");
    return { rowid: "1", cells: columns[table].map(column => {
      const cell = encoded.value.cells[column]!;
      return cell.kind === "null" ? ["null"] : cell.kind === "integer" ? ["integer", cell.decimal] : text(cell.value, encoding);
    }) };
  }
  input.authority.rows = [projection("config_authority", { singleton: 1, formatVersion: 1, owner: "profile",
    activationId: activation.activationId, sourceBinding: { contract: "m2-source-binding/r1", kind: "local",
      physicalSourceRef: body.physicalSourceRef, activation } })];
  input.activationReceipts.rows = [projection("config_activation_receipts", { ref: activation, ...body })];
  input.migrations.rows.push(row([22, "profile_configuration_authority", "41d93b6d6ad261c5", "2026-11-20 00:00:01"], "22", encoding));
  const completion = { activation, takeoverPlan: body.planRef, migrationId: "migration-1", s4PlanDigest: "9".repeat(64),
    sourceIdentityDigest: "c".repeat(64), epochBefore: 1, epochAfter: 2,
    terminal: { record: evidence("journal/jb.json"), sequence: 4 } };
  input.control.rows = [row([1, "a".repeat(32), canonicalJson({ path: "/tmp/control", device: "42", inode: "123", hostIdentityDigest: "d".repeat(64) }),
    canonicalJson({ kind: "sqlite-operation-mutex", path: "/tmp/control/mutex.sqlite", device: "42", inode: "456" }),
    terminal ? 2 : 1, terminal ? "open" : "sealed", terminal ? null : "migration-1", terminal ? null : "9".repeat(64), 1,
    terminal ? "journal/jb.json" : "journal/ja.json", terminal ? completion.terminal.record.digest : "e".repeat(64), terminal ? 4 : 3,
    2, body.guardTransition.guardAfterDigest, terminal ? canonicalJson(completion) : null], "1", encoding)];
  return input;
}
export function client(encoding: Encoding = "UTF-8", protocol = 1, id = "client-1", rowid = "1") {
  return row([id, "a".repeat(32), "http", "boardroom-storage-drain-v1", protocol,
    canonicalJson({ hostname: "主机🦊", platform: "linux" }), canonicalJson({ pid: 7, instanceId: "process-1" }),
    canonicalJson({ formatVersion: 1, sourceIdentity: { kind: "sqlite" }, sessions: [
      { kind: "sqlite", owner: "local-driver" }, { kind: "sqlite", owner: "client-control" }], drainReceipt: null }),
    0, 0, null, "none", null, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:01.000Z", null,
    protocol === 1 ? null : writerDigest], rowid, encoding);
}
