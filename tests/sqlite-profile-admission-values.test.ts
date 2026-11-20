import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectSqliteProfileAdmissionValue as inspect } from "../src/server/identity/sqlite-profile-admission-values.ts";
import { F_MIGRATIONS } from "../src/server/identity/internal/m2-p0-artifacts-catalog.ts";
import { encodeM2RowValue } from "../src/server/identity/m2-row-codecs.ts";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";

type Cell = ["null"] | ["integer" | "text" | "blob" | "real64be", string];
type Encoding = "UTF-8" | "UTF-16le" | "UTF-16be";
type Row = { rowid: string; cells: Cell[] };
type Part = { rows: Row[] };
const columns = {
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
function text(value: string, encoding: Encoding = "UTF-8"): Cell {
  const buffer = Buffer.from(value, encoding === "UTF-8" ? "utf8" : "utf16le");
  if (encoding === "UTF-16be") buffer.swap16();
  return ["text", buffer.toString("hex")];
}
function row(values: (string | number | null)[], rowid = "1", encoding: Encoding = "UTF-8"): Row {
  return { rowid, cells: values.map(v => v === null ? ["null"] : typeof v === "number" ? ["integer", String(v)] : text(v, encoding)) };
}
function p0(encoding: Encoding = "UTF-8") {
  return {
    contract: "sqlite-profile-admission-observation/r1", sourceKind: "sqlite", textEncoding: { backend: "sqlite", name: encoding },
    columns: structuredClone(columns),
    control: { rows: [row([1, "a".repeat(32), null, null, 0, "open", null, null, 0, null, null, 0, 1, "b".repeat(64), null], "1", encoding)] },
    authority: { rows: [] } as Part, activationReceipts: { rows: [] } as Part,
    migrations: { rows: F_MIGRATIONS.sqlite.map(m => row([m.version, m.name, m.checksum, "2026-11-20 00:00:00"], String(m.version), encoding)) },
    clients: { rows: [] } as Part,
  };
}
const writerDigest = "c94dfbd3199953af3740188aff54566578708e0ee6267440aa27c71db51fac03";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function p1(encoding: Encoding = "UTF-8", terminal = false) {
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
function client(encoding: Encoding = "UTF-8", protocol = 1, id = "client-1", rowid = "1") {
  return row([id, "a".repeat(32), "http", "boardroom-storage-drain-v1", protocol,
    canonicalJson({ hostname: "主机🦊", platform: "linux" }), canonicalJson({ pid: 7, instanceId: "process-1" }),
    canonicalJson({ formatVersion: 1, sourceIdentity: { kind: "sqlite" }, sessions: [
      { kind: "sqlite", owner: "local-driver" }, { kind: "sqlite", owner: "client-control" }], drainReceipt: null }),
    0, 0, null, "none", null, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:01.000Z", null,
    protocol === 1 ? null : writerDigest], rowid, encoding);
}
test("SQ-D02 I02：primitive raw P0 仅返回冻结观察，保留原始日期字节和完整账本", () => {
  const input = p0(), result = inspect(JSON.stringify(input));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.scope, "raw-and-metadata-links");
  assert.equal(result.value.profile, "P0");
  assert.equal(result.value.terminalClosure, "not_run");
  assert.equal(result.value.nativeSource, "not_run");
  assert.equal(result.value.finalSchemaAndGuards, "not_run");
  assert.equal(Object.hasOwn(result.value, "admitted"), false);
  assert.deepEqual(result.value.raw, input);
  assert.equal(Object.isFrozen(result.value.raw.control.rows[0]?.cells), true);
});
test("SQ-D02 I02：非 primitive 输入在 getter/Proxy 触发前拒绝", () => {
  let effects = 0;
  const trap = () => { effects++; throw new Error("must not execute"); };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  for (const input of [proxy, new String(JSON.stringify(p0())), {}, [], null, undefined, 1, () => trap()]) {
    const result = inspect(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "unsupported_shape");
  }
  assert.equal(effects, 0);
});
test("SQ-D02 I02：sealed P1 terminal NULL 仅观察等待 B；完整17格receipt来自既有独立row codec", () => {
  const input = p1(), result = inspect(JSON.stringify(input));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.profile, "P1");
  assert.equal(result.value.phase, "sealed-awaiting-b");
  assert.equal(result.value.terminalClosure, "not_run");
  assert.deepEqual(result.value.raw.activationReceipts, input.activationReceipts);
});
test("SQ-D02 I02：client17保留两个int64端点rowid、NULL与非ASCII日期原字节，不称native lifecycle通过", () => {
  const input = p0();
  input.clients.rows = [client("UTF-8", 1, "first", "-9223372036854775808"), client("UTF-8", 1, "last", "9223372036854775807")];
  const result = inspect(JSON.stringify(input));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value.raw.clients, input.clients);
  assert.equal(result.value.clientLifecycle, "not_run");
});
for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"] as const) {
  test(`SQ-D02 I02：${encoding} 的P0/P1原始字节精确往返，非ASCII activation不被重编码`, () => {
    for (const input of [p0(encoding), p1(encoding)]) {
      input.clients.rows.push(client(encoding, input.control.rows[0]!.cells[12]![1] === "1" ? 1 : 2));
      const result = inspect(JSON.stringify(input));
      assert.equal(result.ok, true, JSON.stringify(result));
      if (result.ok) assert.deepEqual(result.value.raw, input);
    }
  });
}
function rejected(input: unknown, code?: string): void {
  const result = inspect(typeof input === "string" ? input : JSON.stringify(input));
  assert.equal(result.ok, false);
  if (!result.ok && code !== undefined) assert.equal(result.error.code, code);
}
test("SQ-D02 I02：INTEGER PRIMARY KEY 的 rowid 必须与原 singleton/version 格一致", () => {
  for (const part of ["control", "migrations"] as const) {
    const input = p0(); input[part].rows[0]!.rowid = "-9223372036854775808"; rejected(input);
  }
  const input = p1(); input.authority.rows[0]!.rowid = "2"; rejected(input);
});
test("SQ-D02 I02：目录、typed cell、唯一singleton及完整1–21/22账本拒绝静默归一化", () => {
  const mutations: ((input: ReturnType<typeof p0>) => void)[] = [
    input => input.columns.storage_maintenance.push("caller_extension"),
    input => input.columns.storage_maintenance.reverse(),
    input => { input.control.rows[0]!.cells.pop(); },
    input => { input.control.rows.push(structuredClone(input.control.rows[0]!)); },
    input => { input.control.rows = []; },
    input => { input.control.rows[0]!.cells[0] = ["null"]; },
    input => { input.control.rows[0]!.cells[4] = text("0"); },
    input => { input.control.rows[0]!.cells[4] = ["integer", "9007199254740992"]; },
    input => { input.control.rows[0]!.cells[4] = ["integer", "-0"]; },
    input => { input.control.rows[0]!.cells[4] = ["integer", "9223372036854775808"]; },
    input => { input.control.rows[0]!.cells[1] = ["blob", "aa"]; },
    input => { input.control.rows[0]!.cells[1] = ["real64be", "3ff0000000000000"]; },
    input => { input.control.rows[0]!.cells[1] = ["text", "FF"]; },
    input => { input.control.rows[0]!.cells[1] = ["text", "ff"]; },
    input => { input.control.rows[0]!.cells[1] = ["text", "edb080"]; },
    input => { input.control.rows[0]!.cells[6] = text("unexpected-active"); },
    input => { input.control.rows[0]!.cells[11] = ["integer", "1"]; },
    input => { input.migrations.rows[1]!.cells[1] = text("same-max-wrong-name"); },
    input => { input.migrations.rows[1]!.cells[2] = text("same-max-wrong-checksum"); },
    input => { input.migrations.rows[1]!.cells[0] = ["integer", "1"]; },
    input => { input.migrations.rows.splice(0, 1); },
  ];
  for (const mutate of mutations) { const input = p0(); mutate(input); rejected(input); }
  const input = p1(); input.migrations.rows[21]!.cells[2] = text("0000000000000000"); rejected(input, "source_contract_mismatch");
});
test("SQ-D02 I02：UTF16奇数byte、孤立surrogate及encoding不符明确拒绝", () => {
  for (const [encoding, hex] of [["UTF-16le", "00"], ["UTF-16le", "00d8"], ["UTF-16be", "dc00"]] as const) {
    const input = p0(encoding); input.control.rows[0]!.cells[1] = ["text", hex]; rejected(input, "source_contract_mismatch");
  }
  const input = p0(); input.textEncoding.name = "UTF-16le"; rejected(input);
});
test("SQ-D02 I02：receipt17任一冗余格漂移、authority链接/当前guard不符均拒绝", () => {
  for (let column = 0; column < 17; column++) {
    const input = p1(); input.activationReceipts.rows[0]!.cells[column] = text("tampered"); rejected(input);
  }
  for (const [part, column, value] of [["authority", 1, "2"], ["authority", 3, "another-activation"],
    ["control", 13, "b".repeat(64)], ["control", 3, canonicalJson({ kind: "sqlite-operation-mutex", path: "/other/mutex.sqlite", device: "42", inode: "456" })]] as const) {
    const input = p1(); input[part].rows[0]!.cells[column] = part === "authority" && column === 1 ? ["integer", value] : text(value);
    rejected(input);
  }
  const input = p1(); input.authority.rows[0]!.cells[4] = text(canonicalJson({ contract: "m2-source-binding/r1", kind: "imported" }));
  rejected(input, "unsupported_shape");
});
test("SQ-D02 I02：open P1+NULL、假别名与重复内层payload key不能退回P0", () => {
  const input = p1(); input.control.rows[0]!.cells[5] = text("open"); input.control.rows[0]!.cells[6] = ["null"];
  input.control.rows[0]!.cells[7] = ["null"]; rejected(input, "semantic_invariant_failed");
  const duplicate = p1(), cell = duplicate.activationReceipts.rows[0]!.cells[15]!;
  const payload = Buffer.from(cell[1]!, "hex").toString();
  duplicate.activationReceipts.rows[0]!.cells[15] = text(payload.replace("{", '{"requestId":"req-1",'));
  rejected(duplicate);
  rejected(JSON.stringify(p0()).replace('"sourceKind":"sqlite"', '"sourceKind":"sqlite","sourceKind":"sqlite"'), "invalid_value");
});
test("SQ-D02 I02：client原source、counter、writer17与重复身份不能被其他格掩盖", () => {
  for (const [column, cell] of [[1, text("b".repeat(32))], [8, ["integer", "1"]], [16, text(writerDigest)],
    [14, text("2026-99-20T00:00:01.000Z")], [7, text("[]")]] as [number, Cell][]) {
    const input = p0(); input.clients.rows = [client()]; input.clients.rows[0]!.cells[column] = cell; rejected(input);
  }
  const duplicate = p0(); duplicate.clients.rows = [client(), client("UTF-8", 1, "client-1", "2")]; rejected(duplicate);
});
test("SQ-D02 I02：原field/input/output预算失败不泄露原始payload", () => {
  const input = p0(); input.control.rows[0]!.cells[2] = text("secret-" + "x".repeat(32 * 1024));
  rejected(input, "resource_limit");
  const result = inspect(JSON.stringify(input)); assert.equal(JSON.stringify(result).includes("secret-"), false);
  rejected(" ".repeat(16 * 1024 * 1024 + 1), "resource_limit");
  const many = p0(); many.clients.rows = Array.from({ length: 1100 }, (_, index) => client("UTF-8", 1, `client-${index}`, String(index + 1)));
  assert.ok(Buffer.byteLength(JSON.stringify(many)) > 1024 * 1024);
  rejected(many, "resource_limit");
});
