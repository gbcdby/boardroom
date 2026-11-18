import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { digestRowMultiset } from "../src/server/storage/maintenance/manifests.ts";
import { LayoutValueError } from "../src/server/storage/maintenance/layout-values.ts";
import { buildLayoutMemoryInventory, parseLayoutMemoryInventoryValue } from "../src/server/storage/maintenance/layout-memory-inventory.ts";

type Dialect = "sqlite" | "postgres";
type Cell = [string, string | null] | ["null"];
type Row = Cell[];
const columns = [
  ["id", "scope", "project_id", "agent_id", "version", "markdown", "byte_length", "updated_at", "updated_by", "source"],
  ["id", "document_id", "version", "parent_version", "markdown", "byte_length", "content_sha256", "author", "actor_id", "source", "client_mutation_id", "summary_request_id", "created_at"],
  ["id", "project_id", "agent_id", "recipient_member_id", "context_group_id", "document_id", "base_version", "revision", "state", "trigger", "trigger_key", "task_id", "completed_task_revision", "message_ids", "source_work_event_id", "retry_of_request_id", "attempt_id", "begin_mutation_id", "result_version", "result_sha256", "error", "evidence", "created_at", "started_at", "finished_at"],
];
const integerColumns = [[4, 6], [2, 3, 5], [6, 7, 12, 18]];
const names = ["memory_documents", "memory_versions", "memory_summary_requests"];
const author = '{ "kind":"agent", "actorId":"agent:1", "agentId":"agent-1", "displayName":"Agent" }';
const updatedBy = '{"displayName":"Agent","agentId":"agent-1","actorId":"agent:1","kind":"agent"}';
const at = "2026-11-18T01:02:03.000Z";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const textCell = (value: string | null, dialect: Dialect): Cell => dialect === "postgres" ? ["pg:25", value]
  : value === null ? ["null"] : ["text", Buffer.from(value, "utf8").toString("hex")];
const intCell = (value: string | null, dialect: Dialect): Cell => dialect === "postgres" ? ["pg:23", value]
  : value === null ? ["null"] : ["integer", value];

function fixture(dialect: Dialect = "sqlite") {
  const bodies = [["same", "same", "\ufeffhello\r\n🙂e\u0301"], ["same", "other", ""]];
  const raw: (string | null)[][][] = [[], [], []];
  for (const [index, list] of bodies.entries()) {
    const documentId = `document-${index}`;
    const latest = list[2]!;
    raw[0]!.push([documentId, index === 0 ? "global" : "project-agent", index === 0 ? null : "project-1", "agent-1",
      "3", latest, String(Buffer.byteLength(latest)), at, updatedBy, "agent"]);
    for (const [position, markdown] of list.entries()) raw[1]!.push([`version-${index}-${position + 1}`, documentId,
      String(position + 1), String(position), markdown, String(Buffer.byteLength(markdown)), sha(markdown), author,
      "agent:1", "agent", `mutation-${position}`, position === 0 ? "deleted-request" : "request-current", at]);
  }
  raw[2]!.push(["request-current", "project-1", "agent-1", "member-1", null, "document-1", "2", "2", "completed",
    "session_end", "session:key", null, null, '[ "message-1" ]', null, null, "attempt-1", "begin-1", "3", sha(""),
    null, '{ "provenance":"agent-declared" }', at, at, at]);
  const tables = raw.map((rows, table) => {
    const encoded: Row[] = rows.map(row => row.map((value, column) => integerColumns[table]!.includes(column) ? intCell(value, dialect) : textCell(value, dialect)));
    const digest = digestRowMultiset(encoded);
    return { name: names[table]!, columns: columns[table]!, expectedCount: digest.count, expectedDigest: digest.digest, rows: encoded };
  });
  return { contract: "layout-memory-input/r1", source: { kind: dialect, databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) },
    frozenManifest: { ref: "frozen-private", sha256: "3".repeat(64), bytes: "123" }, storageId: "storage:1", dialect, tables };
}
function reseal(input: ReturnType<typeof fixture>) {
  for (const table of input.tables) {
    const summary = digestRowMultiset(table.rows); table.expectedCount = summary.count; table.expectedDigest = summary.digest;
  }
}
function fails(action: () => unknown, code?: string) {
  assert.throws(action, (error: unknown) => error instanceof LayoutValueError && (code === undefined || error.code === code)
    && error.message === `layout_internal_value:${error.code}`);
}
function replaceCurrentBody(input: ReturnType<typeof fixture>, body: string) {
  const document = input.tables[0]!.rows[0]!;
  const version = input.tables[1]!.rows[2]!;
  document[5] = textCell(body, input.dialect); document[6] = intCell(String(Buffer.byteLength(body)), input.dialect);
  version[4] = textCell(body, input.dialect); version[5] = intCell(String(Buffer.byteLength(body)), input.dialect);
  version[6] = textCell(sha(body), input.dialect); reseal(input);
}

test("LV-AC05/08: both dialects retain all versions and raw metadata while deduplicating only objects", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    const input = fixture(dialect);
    const output = buildLayoutMemoryInventory(input);
    assert.equal(output.documents.length, 2); assert.equal(output.versions.length, 6); assert.equal(output.objects.length, 4);
    assert.equal(output.versions[0]!.summaryRequestId, "deleted-request");
    assert.equal(output.versions[0]!.authorRaw, author); assert.equal(output.versions[0]!.actorId, "agent:1");
    assert.equal(output.versions[0]!.clientMutationId, "mutation-0"); assert.equal(output.versions[0]!.createdAt, at);
    assert.equal(output.documents[0]!.updatedByRaw, updatedBy);
    assert.deepEqual(output.documents[0]!.legacyKey, { scope: "global", projectId: null, agentId: "agent-1" });
    assert.equal(output.versions[2]!.object.contentSha256, sha("\ufeffhello\r\n🙂e\u0301"));
    assert.equal(output.versions[2]!.relativePath, `objects/sha256/${sha("\ufeffhello\r\n🙂e\u0301").slice(0, 2)}/${sha("\ufeffhello\r\n🙂e\u0301")}.md`);
    assert.equal(output.totalVersionBodyBytes, String(3 * 4 + 5 + Buffer.byteLength("\ufeffhello\r\n🙂e\u0301")));
    assert.equal(output.uniqueObjectBodyBytes, String(4 + 5 + Buffer.byteLength("\ufeffhello\r\n🙂e\u0301")));
    assert.equal(output.versions[0]!.sourceRowDigest, digestJson(input.tables[1]!.rows[0]));
    assert.ok(Object.isFrozen(output.versions[0]!.object)); assert.equal(Object.isFrozen(input), false);
    assert.deepEqual(parseLayoutMemoryInventoryValue(output), output);
    for (const table of input.tables) table.rows.reverse();
    assert.deepEqual(buildLayoutMemoryInventory(input), output);
  }
});

test("LV-AC06: partial, replaced, duplicate, orphan or mismatched history never returns a partial inventory", () => {
  const mutations: ((input: ReturnType<typeof fixture>) => void)[] = [
    input => { input.tables[1]!.rows.splice(1, 1); },
    input => { input.tables[1]!.rows[1] = structuredClone(input.tables[1]!.rows[0]!); },
    input => { input.tables[1]!.rows[0]![1] = textCell("missing-document", input.dialect); },
    input => { input.tables[1]!.rows[0]![3] = intCell("9", input.dialect); },
    input => { input.tables[0]!.rows[0]![5] = textCell("wrong head", input.dialect); },
    input => { input.tables[1]!.rows[0]![8] = textCell("wrong actor", input.dialect); },
    input => { input.tables[1]!.rows[1]![10] = textCell("mutation-0", input.dialect); },
    input => { input.tables[0]!.rows[0]![1] = textCell("organization", input.dialect); },
  ];
  for (const dialect of ["sqlite", "postgres"] as const) for (const mutate of mutations) {
    const input = fixture(dialect); mutate(input); reseal(input); fails(() => buildLayoutMemoryInventory(input));
  }
  const count = fixture(); count.tables[1]!.expectedCount = "7";
  fails(() => buildLayoutMemoryInventory(count), "incomplete_inventory");
  const digest = fixture(); digest.tables[1]!.expectedDigest = "0".repeat(64);
  fails(() => buildLayoutMemoryInventory(digest), "inventory_integrity");
  const missing = fixture(); missing.tables.pop(); fails(() => buildLayoutMemoryInventory(missing), "incomplete_inventory");
});

test("LV-AC06/08: exact schema, original cell types, all summary columns and nullable boundaries", () => {
  const extra = fixture(); extra.tables[0]!.columns = [...extra.tables[0]!.columns, "future_column"];
  fails(() => buildLayoutMemoryInventory(extra), "unsupported_shape");
  const wrongOid = fixture("postgres"); wrongOid.tables[0]!.rows[0]![0] = ["pg:1043", "document-0"]; reseal(wrongOid);
  fails(() => buildLayoutMemoryInventory(wrongOid), "unsupported_shape");
  const nonText = fixture("postgres"); nonText.tables[0]!.rows[0]![0] = ["pg:25", 3] as unknown as Cell;
  fails(() => buildLayoutMemoryInventory(nonText));
  const nullRequired = fixture(); nullRequired.tables[1]!.rows[0]![10] = ["null"]; reseal(nullRequired);
  fails(() => buildLayoutMemoryInventory(nullRequired));
  for (let column = 0; column < 25; column++) {
    const input = fixture(); input.tables[2]!.rows[0]![column] = textCell(`changed-${column}`, "sqlite");
    fails(() => buildLayoutMemoryInventory(input));
  }
  const invalid = fixture(); invalid.tables[1]!.rows[0]![4] = ["text", "c080"]; reseal(invalid);
  fails(() => buildLayoutMemoryInventory(invalid), "inventory_integrity");
});

test("LV-AC07: exact UTF-8 bytes including empty, BOM, CRLF, emoji and combining marks", () => {
  for (const body of ["", "\ufeff", "a\r\nb", "🙂", "e\u0301", "x".repeat(1_048_576)]) {
    const input = fixture(); replaceCurrentBody(input, body);
    const output = buildLayoutMemoryInventory(input);
    assert.equal(output.versions[2]!.object.byteLength, Buffer.byteLength(body));
    assert.equal(output.versions[2]!.object.contentSha256, sha(body));
  }
  const tooLarge = fixture(); replaceCurrentBody(tooLarge, "x".repeat(1_048_577));
  fails(() => buildLayoutMemoryInventory(tooLarge), "budget_exceeded");
  const wrongLength = fixture(); wrongLength.tables[1]!.rows[0]![5] = intCell("999", "sqlite"); reseal(wrongLength);
  fails(() => buildLayoutMemoryInventory(wrongLength), "inventory_integrity");
  const wrongHash = fixture(); wrongHash.tables[1]!.rows[0]![6] = textCell("0".repeat(64), "sqlite"); reseal(wrongHash);
  fails(() => buildLayoutMemoryInventory(wrongHash), "inventory_integrity");
  const surrogate = fixture("postgres"); surrogate.tables[1]!.rows[0]![4] = ["pg:25", "\ud800"];
  fails(() => buildLayoutMemoryInventory(surrogate), "invalid_value");
});

test("LV-AC01/06: inventory parser checks its own digest, order, closure, totals and object mapping", () => {
  const output = buildLayoutMemoryInventory(fixture());
  fails(() => parseLayoutMemoryInventoryValue({ ...output, inventoryDigest: "0".repeat(64) }), "inventory_integrity");
  for (const mutate of [
    (value: ReturnType<typeof structuredClone<typeof output>>) => { (value.versions as unknown[]).pop(); },
    (value: ReturnType<typeof structuredClone<typeof output>>) => { (value.versions as unknown[]).reverse(); },
    (value: ReturnType<typeof structuredClone<typeof output>>) => { (value.objects as unknown[]).pop(); },
  ]) {
    const value = structuredClone(output); mutate(value);
    const { inventoryDigest: ignored, ...withoutDigest } = value;
    fails(() => parseLayoutMemoryInventoryValue({ ...withoutDigest, inventoryDigest: digestJson(withoutDigest) }));
  }
  let calls = 0;
  fails(() => buildLayoutMemoryInventory({ get tables() { calls++; return []; } }), "invalid_value");
  assert.equal(calls, 0);
});

test("LV-AC01/05/06: empty inventories are data only and fixed row/byte limits reject the whole input", () => {
  const empty = fixture(); for (const table of empty.tables) table.rows = []; reseal(empty);
  const output = buildLayoutMemoryInventory(empty);
  assert.deepEqual(output.versions, []); assert.deepEqual(output.objects, []);
  assert.equal(output.totalVersionBodyBytes, "0");
  const excess = fixture(); excess.tables[0]!.rows = Array.from({ length: 4097 }, () => []); reseal(excess);
  fails(() => buildLayoutMemoryInventory(excess), "budget_exceeded");
  fails(() => buildLayoutMemoryInventory({ ...empty, extra: "x".repeat(32 * 1_048_576 + 1) }), "budget_exceeded");
  fails(() => buildLayoutMemoryInventory({ ...empty, contract: "layout-memory-input/future" }), "unsupported_shape");
  fails(() => parseLayoutMemoryInventoryValue({ ...output, contract: "layout-memory-inventory-value/future" }), "unsupported_shape");
});
