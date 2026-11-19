import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { digestRowMultiset } from "../src/server/storage/maintenance/manifests.ts";
import { buildLayoutMemoryInventory } from "../src/server/storage/maintenance/layout-memory-inventory.ts";
import { buildLayoutMemoryObjectPayloadValues } from "../src/server/storage/maintenance/layout-memory-payload-values.ts";
import { classifyLayoutRecoveryValue } from "../src/server/storage/maintenance/layout-recovery-classification.ts";
import { LayoutValueError } from "../src/server/storage/maintenance/layout-values.ts";

type Dialect = "sqlite" | "postgres";
type Cell = [string, string | null] | ["null"];
const columns = [
  ["id", "scope", "project_id", "agent_id", "version", "markdown", "byte_length", "updated_at", "updated_by", "source"],
  ["id", "document_id", "version", "parent_version", "markdown", "byte_length", "content_sha256", "author", "actor_id", "source", "client_mutation_id", "summary_request_id", "created_at"],
  ["id", "project_id", "agent_id", "recipient_member_id", "context_group_id", "document_id", "base_version", "revision", "state", "trigger", "trigger_key", "task_id", "completed_task_revision", "message_ids", "source_work_event_id", "retry_of_request_id", "attempt_id", "begin_mutation_id", "result_version", "result_sha256", "error", "evidence", "created_at", "started_at", "finished_at"],
];
const integerColumns = [[4, 6], [2, 3, 5], [6, 7, 12, 18]];
const names = ["memory_documents", "memory_versions", "memory_summary_requests"];
const author = ' { "kind":"agent", "actorId":"agent:1", "agentId":"agent-1", "displayName":"作者" } ';
const updatedBy = '{"displayName":"作者","agentId":"agent-1","actorId":"agent:1","kind":"agent"}';
const at = "2026-11-19T01:02:03.000Z";
const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
const textCell = (value: string | null, dialect: Dialect): Cell => dialect === "postgres" ? ["pg:25", value]
  : value === null ? ["null"] : ["text", Buffer.from(value, "utf8").toString("hex")];
const intCell = (value: string | null, dialect: Dialect): Cell => dialect === "postgres" ? ["pg:23", value]
  : value === null ? ["null"] : ["integer", value];
const vectors = [
  { body: "", bytesHex: "", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", bytes: "0" },
  { body: "same", bytesHex: "73616d65", sha256: "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5", bytes: "4" },
  { body: "\ufeff中文\r\n🙂e\u0301", bytesHex: "efbbbfe4b8ade696870d0af09f998265cc81", sha256: "4c6ae4e2aa0d86311161bfa107c25887b547f61a2400ec32d3060b8be6091f72", bytes: "18" },
  { body: "é", bytesHex: "c3a9", sha256: "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c", bytes: "2" },
  { body: "e\u0301", bytesHex: "65cc81", sha256: "bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6", bytes: "3" },
];
const histories = [["same", "same", vectors[2]!.body, "é"], ["same", "e\u0301", ""]];

function fixture(dialect: Dialect = "sqlite", bodies: readonly (readonly string[])[] = histories) {
  const raw: (string | null)[][][] = [[], [], []];
  for (const [document, versions] of bodies.entries()) {
    const id = `文档-${document}`, latest = versions.at(-1)!;
    raw[0]!.push([id, document === 0 ? "global" : "project-agent", document === 0 ? null : "project-1", "agent-1",
      String(versions.length), latest, String(Buffer.byteLength(latest)), at, updatedBy, "agent"]);
    for (const [position, body] of versions.entries()) raw[1]!.push([`版本-${document}-${position + 1}`, id,
      String(position + 1), String(position), body, String(Buffer.byteLength(body)), sha(body), author, "agent:1", "agent",
      `mutation-${position}`, position === 0 ? "deleted-summary" : null, at]);
  }
  raw[2]!.push(["summary-current", "project-1", "agent-1", "member-1", null, null, "0", "1", "pending", "session_end",
    "session:key", null, null, '[ "message-1" ]', null, null, null, null, null, null, null, '{ "raw":"证据" }', at, null, null]);
  const tables = raw.map((rows, table) => {
    const encoded = rows.map(row => row.map((value, column) => integerColumns[table]!.includes(column)
      ? intCell(value, dialect) : textCell(value, dialect))).reverse();
    const digest = digestRowMultiset(encoded);
    return { name: names[table]!, columns: [...columns[table]!], expectedCount: digest.count, expectedDigest: digest.digest, rows: encoded };
  });
  return { contract: "layout-memory-input/r1", source: { kind: dialect, databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) },
    frozenManifest: { ref: "frozen-private", sha256: "3".repeat(64), bytes: "123" }, storageId: "storage:1", dialect, tables };
}
function reseal(input: ReturnType<typeof fixture>) {
  for (const table of input.tables) {
    const summary = digestRowMultiset(table.rows); table.expectedCount = summary.count; table.expectedDigest = summary.digest;
  }
}
function fails(action: () => unknown, code?: LayoutValueError["code"]): LayoutValueError {
  try { action(); } catch (error) {
    assert.ok(error instanceof LayoutValueError);
    assert.equal(error.name, "LayoutValueError"); assert.equal(error.message, `layout_internal_value:${error.code}`);
    assert.equal(error.cause, undefined);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
  }
  assert.fail("invalid input unexpectedly returned a payload projection");
}

test("E2: both original dialects project every historical body and deduplicate only objects", () => {
  const results = [];
  for (const dialect of ["sqlite", "postgres"] as const) {
    const input = fixture(dialect), output = buildLayoutMemoryObjectPayloadValues(input);
    assert.equal(output.contract, "layout-memory-object-payload-values/r1");
    assert.equal(output.classification, "observation"); assert.equal(output.coverage, "memory-body-projection");
    assert.deepEqual(output.inventory, buildLayoutMemoryInventory(input));
    assert.equal(output.inventory.documents.length, 2); assert.equal(output.inventory.versions.length, 7);
    assert.equal(output.objects.length, 5);
    assert.deepEqual(output.objects.map(entry => entry.object), output.inventory.objects);
    for (const { body: ignored, ...payload } of vectors) {
      const entry = output.objects.find(item => item.object.contentSha256 === payload.sha256);
      assert.ok(entry); assert.deepEqual(entry.payload, payload);
      assert.equal(entry.relativePath, `objects/sha256/${payload.sha256.slice(0, 2)}/${payload.sha256}.md`);
      assert.equal(entry.object.byteLength, Number(payload.bytes));
    }
    assert.equal(output.inventory.versions.filter(version => version.object.contentSha256 === vectors[1]!.sha256).length, 3);
    assert.equal(output.inventory.versions[0]!.authorRaw, author);
    assert.equal(output.inventory.versions[0]!.summaryRequestId, "deleted-summary");
    assert.equal(output.inventory.versions[0]!.parentVersion, 0);
    assert.equal(output.inventory.versions[3]!.parentVersion, 3);
    assert.equal(output.inventory.documents[0]!.updatedByRaw, updatedBy);
    assert.equal(output.inventory.versions[0]!.sourceRowDigest, digestJson(input.tables[1]!.rows.at(-1)!));
    assert.equal(output.inventory.totalVersionBodyBytes, "35");
    assert.equal(output.inventory.uniqueObjectBodyBytes, "27");
    results.push(output.objects);
  }
  assert.deepEqual(results[0], results[1]);
});

test("E2: empty three-table input is valid, and empty markdown remains a present object", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    const input = fixture(dialect);
    for (const table of input.tables) table.rows = [];
    reseal(input);
    const output = buildLayoutMemoryObjectPayloadValues(input);
    assert.deepEqual(output.inventory, buildLayoutMemoryInventory(input));
    assert.deepEqual(output.inventory.documents, []); assert.deepEqual(output.inventory.versions, []);
    assert.deepEqual(output.objects, []);
    const emptyBody = buildLayoutMemoryObjectPayloadValues(fixture(dialect, [[""]]));
    assert.equal(emptyBody.inventory.versions.length, 1); assert.equal(emptyBody.objects.length, 1);
    assert.deepEqual(emptyBody.objects[0]!.payload, { bytesHex: "", sha256: vectors[0]!.sha256, bytes: "0" });
  }
});

test("E2: original recovery classifier consumes every returned body without establishing activation", () => {
  const output = buildLayoutMemoryObjectPayloadValues(fixture());
  const current = { storageId: output.inventory.storageId, layoutVersion: 2, objectFormat: "utf8-sha256-v1",
    formatContract: { ref: "memory-format", sha256: "4".repeat(64), bytes: "1" }, generation: 1,
    activationTerminal: null, gate: "unknown", inventory: output.inventory };
  for (const entry of output.objects) assert.deepEqual(classifyLayoutRecoveryValue({ contract: "layout-recovery-input/r1", current,
    candidate: { kind: "object-bytes", contentHex: entry.payload.bytesHex } }), {
    contract: "layout-recovery-classification/r1", classification: "activation-not-established",
    currentInventoryDigest: output.inventory.inventoryDigest, currentGate: "unknown",
  });
  assert.equal(current.activationTerminal, null); assert.equal(current.gate, "unknown");
});

test("E2: incomplete or changed history, counts, digests and schema retain original builder rejection", () => {
  const mutations: ((input: ReturnType<typeof fixture>) => void)[] = [
    input => { input.tables[1]!.rows.splice(1, 1); reseal(input); },
    input => { input.tables[1]!.rows[0]![4] = textCell("changed", input.dialect); },
    input => { input.tables[1]!.rows[0]![4] = textCell("changed", input.dialect); reseal(input); },
    input => { input.tables[1]!.expectedCount = "8"; },
    input => { input.tables[1]!.expectedDigest = "0".repeat(64); },
    input => { input.tables[1]!.rows[0]![4] = input.dialect === "sqlite" ? ["null"] : ["pg:25", null]; reseal(input); },
    input => { input.tables[1]!.rows[0]![5] = intCell("999", input.dialect); reseal(input); },
    input => { input.tables[1]!.rows[0]![8] = textCell("other-actor", input.dialect); reseal(input); },
    input => { input.tables[0]!.rows[0]![5] = textCell("different head", input.dialect); reseal(input); },
    input => { input.tables[2]!.rows[0]![21] = textCell("changed evidence", input.dialect); },
    input => { Object.assign(input, { future: "field" }); },
    input => { Object.assign(input.tables[1]!, { reader: "field" }); },
    input => { input.tables[1]!.columns.push("future_column"); },
    input => { input.tables.pop(); },
    input => { input.tables[1]!.rows.reverse(); input.tables.reverse(); },
  ];
  for (const dialect of ["sqlite", "postgres"] as const) for (const mutate of mutations) {
    const input = fixture(dialect); mutate(input);
    const expected = fails(() => buildLayoutMemoryInventory(input));
    fails(() => buildLayoutMemoryObjectPayloadValues(input), expected.code);
  }
  for (const cell of [["pg:1043", "body"], ["pg-binary", "626f6479"]] as Cell[]) {
    const input = fixture("postgres"); input.tables[1]!.rows[0]![4] = cell; reseal(input);
    fails(() => buildLayoutMemoryObjectPayloadValues(input), "unsupported_shape");
  }
  const invalidUtf8 = fixture(); invalidUtf8.tables[1]!.rows[0]![4] = ["text", "c080"]; reseal(invalidUtf8);
  fails(() => buildLayoutMemoryObjectPayloadValues(invalidUtf8), "inventory_integrity");
  const surrogate = fixture("postgres"); surrogate.tables[1]!.rows[0]![4] = ["pg:25", "\ud800"];
  fails(() => buildLayoutMemoryObjectPayloadValues(surrogate), "invalid_value");
});

test("E2: one caller snapshot feeds both inventory and payloads, and the whole result is isolated and frozen", () => {
  const input = fixture(), expected = buildLayoutMemoryObjectPayloadValues(input);
  let reads = 0, enumerations = 0;
  const observed = new Proxy(input, {
    get() { reads++; throw new Error("caller properties must not be accessed"); },
    ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
  });
  const output = buildLayoutMemoryObjectPayloadValues(observed);
  assert.equal(reads, 0); assert.equal(enumerations, 1); assert.deepEqual(output, expected);
  assert.equal(Object.isFrozen(input), false); assert.equal(Object.isFrozen(input.tables[1]!.rows[0]!), false);
  input.tables[1]!.rows[0]![4] = textCell("later caller mutation", "sqlite");
  input.source.identityDigest = "5".repeat(64); input.storageId = "later-storage";
  assert.deepEqual(output, expected);
  function checkFrozen(value: unknown) {
    if (value === null || typeof value !== "object") return;
    assert.ok(Object.isFrozen(value));
    for (const nested of Object.values(value)) checkFrozen(nested);
  }
  checkFrozen(output);
  assert.throws(() => { (output.objects[0]!.payload as { bytesHex: string }).bytesHex = "6162"; }, TypeError);
  assert.throws(() => { (output.inventory.versions as unknown[]).pop(); }, TypeError);
});

test("E2: getters, toJSON and hostile thrown values never execute or escape as private exceptions", () => {
  let calls = 0;
  const input = fixture();
  Object.defineProperty(input.tables[1]!.rows[0]!, "4", { enumerable: true, get() { calls++; throw new Error("private-body"); } });
  fails(() => buildLayoutMemoryObjectPayloadValues(input), "invalid_value");
  fails(() => buildLayoutMemoryObjectPayloadValues({ ...fixture(), toJSON() { calls++; throw new Error("private-dsn"); } }), "invalid_value");
  fails(() => buildLayoutMemoryObjectPayloadValues({ get tables() { calls++; return []; } }), "invalid_value");
  assert.equal(calls, 0);
  const hostile = new Proxy({}, { get() { throw new Error("private-thrown-get"); }, getPrototypeOf() { throw new Error("private-thrown-prototype"); } });
  for (const thrown of [new Error("private-dsn"), "private-body", hostile])
    fails(() => buildLayoutMemoryObjectPayloadValues(new Proxy({}, { ownKeys() { throw thrown; } })), "invalid_value");
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  fails(() => buildLayoutMemoryObjectPayloadValues(revoked.proxy), "invalid_value");
});

test("E2: original body, row, node, depth and input-copy budgets remain enforced", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    const maximum = buildLayoutMemoryObjectPayloadValues(fixture(dialect, [["x".repeat(1_048_576)]]));
    assert.equal(maximum.objects[0]!.payload.bytes, "1048576");
    assert.equal(maximum.objects[0]!.payload.bytesHex.length, 2_097_152);
    fails(() => buildLayoutMemoryObjectPayloadValues(fixture(dialect, [["x".repeat(1_048_577)]])), "budget_exceeded");
  }
  const rows = fixture(); rows.tables[0]!.rows = Array.from({ length: 4097 }, () => []); reseal(rows);
  fails(() => buildLayoutMemoryObjectPayloadValues(rows), "budget_exceeded");
  fails(() => buildLayoutMemoryObjectPayloadValues({ ...fixture(), extra: "x".repeat(32 * 1_048_576 + 1) }), "budget_exceeded");
  fails(() => buildLayoutMemoryObjectPayloadValues(Array(250_001).fill(null)), "budget_exceeded");
  let deep: unknown = null; for (let index = 0; index < 66; index++) deep = { deep };
  fails(() => buildLayoutMemoryObjectPayloadValues(deep), "budget_exceeded");
});

test("E2: PostgreSQL hex expansion cannot bypass the existing 32 MiB output-copy budget", () => {
  const input = fixture("postgres", [Array.from({ length: 16 }, (_, index) => String.fromCharCode(65 + index).repeat(1_048_576))]);
  assert.equal(buildLayoutMemoryInventory(input).objects.length, 16);
  fails(() => buildLayoutMemoryObjectPayloadValues(input), "budget_exceeded");
});
