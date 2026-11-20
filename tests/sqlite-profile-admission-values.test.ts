import test from "node:test";
import assert from "node:assert/strict";
import { inspectSqliteProfileAdmissionValue as inspect } from "../src/server/identity/sqlite-profile-admission-values.ts";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";

import { p0, p1, client, text, writerDigest, type Cell } from "./helpers/sqlite-profile-observation-fixture.ts";

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
test("SQ-D02 I02+I03：三编码原terminal同请求严格解码，当前anchor关联通过仍不称closure完成", () => {
  for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"] as const) {
    const input = p1(encoding, true), result = inspect(JSON.stringify(input));
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.phase, "terminal-present"); assert.equal(result.value.terminalClosure, "not_run");
    assert.deepEqual(result.value.raw.control, input.control);
  }
});
test("SQ-D02 I02+I03：坏terminal、别名、receipt/plan/epoch/当前anchor漂移拒绝；后来窗口明确未支持", () => {
  const mutations: ((binding: Record<string, any>) => void)[] = [
    binding => { binding.activationRef = binding.activation; delete binding.activation; },
    binding => { binding.activation.activationId = "another-activation"; },
    binding => { binding.activation.digest = "f".repeat(64); },
    binding => { binding.takeoverPlan.planId = "another-plan"; },
    binding => { binding.takeoverPlan.digest = "f".repeat(64); },
    binding => { binding.epochBefore = 0; binding.epochAfter = 1; },
    binding => { binding.terminal.record.digest = "f".repeat(64); },
    binding => { binding.terminal.record.artifactId = "other-journal"; },
    binding => { binding.extra = true; },
  ];
  for (const mutate of mutations) {
    const input = p1("UTF-8", true), original = input.control.rows[0]!.cells[14]![1]!;
    const binding = JSON.parse(Buffer.from(original, "hex").toString()); mutate(binding);
    input.control.rows[0]!.cells[14] = text(canonicalJson(binding)); rejected(input);
  }
  const later = p1("UTF-8", true); later.control.rows[0]!.cells[11] = ["integer", "5"];
  later.control.rows[0]!.cells[9] = text("journal/later.json"); later.control.rows[0]!.cells[10] = text("f".repeat(64));
  rejected(later, "unsupported_shape");
});
