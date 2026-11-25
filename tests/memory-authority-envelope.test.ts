import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { canonicalJson, digestJson } from "../src/server/storage/maintenance/canonical.ts";
import type { DbReadSnapshot, DbRow } from "../src/server/db/driver.ts";
import { DATABASE_FILE_NAME } from "../src/server/db/database.ts";
import type { MemoryCollectionObservation } from "../src/server/storage/maintenance/layout-memory-collector.ts";
import { collectLayoutMemoryInventory } from "../src/server/storage/maintenance/layout-memory-collector.ts";
import { digestRowMultiset } from "../src/server/storage/maintenance/manifests.ts";
import { readSqliteManifests } from "../src/server/storage/maintenance/sqlite-manifests.ts";
import { identityFixture } from "./helpers/identity-fixture.ts";
import { buildLayoutMemoryInventory } from "../src/server/storage/maintenance/layout-memory-inventory.ts";
import { buildLayoutMemoryObjectPayloadValues } from "../src/server/storage/maintenance/layout-memory-payload-values.ts";
import type { ReadonlyDeep } from "../src/server/storage/maintenance/layout-values.ts";
import { LayoutValueError } from "../src/server/storage/maintenance/layout-values.ts";
import { buildMemoryAuthorityEnvelope } from "../src/server/memory/authority-envelope.ts";
import type { MemoryAuthorityEnvelopeValue } from "../src/server/memory/authority-envelope.ts";
import { buildMemoryPublicationPlan } from "../src/server/memory/publication-plan.ts";
import { projectMemoryRead } from "../src/server/memory/read-projection.ts";
import type { MemoryReadSelectorValue } from "../src/server/memory/read-projection.ts";
import { reportUnreferencedObjects } from "../src/server/memory/unreferenced-report.ts";
import { buildMemoryVersionAuthority } from "../src/server/memory/version-authority.ts";

type ErrorCode = LayoutValueError["code"];
type Observation = ReadonlyDeep<MemoryCollectionObservation>;
type Cell = ["text", string] | ["integer", string] | ["null"];
type MutableRecord = Record<string, unknown>;

const columns = [
  ["id", "scope", "project_id", "agent_id", "version", "markdown", "byte_length", "updated_at", "updated_by", "source"],
  ["id", "document_id", "version", "parent_version", "markdown", "byte_length", "content_sha256", "author", "actor_id", "source", "client_mutation_id", "summary_request_id", "created_at"],
  ["id", "project_id", "agent_id", "recipient_member_id", "context_group_id", "document_id", "base_version", "revision", "state", "trigger", "trigger_key", "task_id", "completed_task_revision", "message_ids", "source_work_event_id", "retry_of_request_id", "attempt_id", "begin_mutation_id", "result_version", "result_sha256", "error", "evidence", "created_at", "started_at", "finished_at"],
] as const;
const integerColumns = [[4, 6], [2, 3, 5], [6, 7, 12, 18]] as const;
const tableNames = ["memory_documents", "memory_versions", "memory_summary_requests"] as const;
const at = "2026-11-19T01:02:03.000Z";
const author = '{"kind":"agent","actorId":"agent:1","agentId":"agent-1","displayName":"作者"}';
const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
const shaBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const histories = [["same", "same", "\ufeff中文\r\n🙂e\u0301"], ["same", "é"]] as const;

function textCell(value: string | null): Cell {
  return value === null ? ["null"] : ["text", Buffer.from(value, "utf8").toString("hex")];
}
function intCell(value: string | null): Cell {
  return value === null ? ["null"] : ["integer", value];
}
function rawInput(bodies: readonly (readonly string[])[]): (string | null)[][][] {
  const raw: (string | null)[][][] = [[], [], []];
  for (const [document, versions] of bodies.entries()) {
    const id = `document-${document}`, latest = versions.at(-1)!;
    raw[0]!.push([id, document === 0 ? "global" : "project-agent", document === 0 ? null : "project-1", "agent-1",
      String(versions.length), latest, String(Buffer.byteLength(latest)), at, author, "agent"]);
    for (const [position, body] of versions.entries()) raw[1]!.push([`version-${document}-${position + 1}`, id,
      String(position + 1), String(position), body, String(Buffer.byteLength(body)), sha(body), author, "agent:1", "agent",
      `mutation-${position}`, position === 0 ? "deleted-summary" : null, at]);
  }
  return raw;
}
function frozenInput(bodies: readonly (readonly string[])[]): MutableRecord {
  const tables = rawInput(bodies).map((rows, table) => {
    const integer = integerColumns[table] as readonly number[];
    const encoded = rows.map(row => row.map((value, column) => integer.includes(column)
      ? intCell(value) : textCell(value))).reverse();
    const digest = digestRowMultiset(encoded);
    return { name: tableNames[table]!, columns: [...columns[table]!], expectedCount: digest.count, expectedDigest: digest.digest, rows: encoded };
  });
  return { contract: "layout-memory-input/r1", source: { kind: "sqlite", databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) },
    frozenManifest: { ref: "frozen/manifest/r1", sha256: "3".repeat(64), bytes: "123" },
    storageId: "storage:1", dialect: "sqlite", tables };
}

/** Collector-shaped records: null prototypes and complete deep freezing. */
function freezeNull(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeNull));
  const result = Object.create(null) as MutableRecord;
  for (const [key, item] of Object.entries(value as MutableRecord))
    Object.defineProperty(result, key, { value: freezeNull(item), enumerable: true });
  return Object.freeze(result);
}
function observation(bodies: readonly (readonly string[])[] = histories): Observation {
  const input = frozenInput(bodies);
  const inventory = buildLayoutMemoryInventory(input);
  return freezeNull({ contract: "layout-memory-collection-observation/r1", authority: "observation-only", input, inventory }) as Observation;
}
function mutable(value: unknown): MutableRecord { return JSON.parse(JSON.stringify(value)) as MutableRecord; }
function reseal(value: MutableRecord): Observation { return freezeNull(value) as Observation; }
function resealTable(value: MutableRecord, index: number): void {
  const frozenTable = (value["input"] as MutableRecord)["tables"] as MutableRecord[];
  const target = frozenTable[index]!;
  const summary = digestRowMultiset(target["rows"] as never);
  target["expectedCount"] = summary.count;
  target["expectedDigest"] = summary.digest;
}
function selector(overrides: Partial<MemoryReadSelectorValue> = {}): MemoryReadSelectorValue {
  return { scope: "global", projectId: null, agentId: "agent-1", documentKind: "note", documentId: "document-0", ...overrides };
}
function fails(action: () => unknown, code?: ErrorCode, label?: string): void {
  const context = label === undefined ? "" : ` (${label})`;
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LayoutValueError, `expected LayoutValueError${context}`);
    assert.equal(error.name, "LayoutValueError", context);
    assert.equal(error.message, `layout_internal_value:${error.code}`, context);
    assert.equal(Object.hasOwn(error, "cause"), false, context);
    if (code !== undefined) assert.equal(error.code, code, context);
    return true;
  });
}
function assertDeepFrozen(value: unknown): void {
  assert.equal(Object.isFrozen(value), true);
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value as Record<string, unknown>)) assertDeepFrozen(child);
}
function envelopeKeys(): readonly string[] {
  return ["authorityDigest", "authorityLabel", "contract", "counts", "digest", "inventoryDigest", "objects",
    "observationContract", "observationDigest", "payloadDigest", "planDigest", "readDigest", "reportDigest",
    "selectedObjectDigest", "storageId"].sort(compareText);
}

test("MMP-S4-T3: 真实 collector 冻结的 observation 可直接装配", async () => {
  const fixture = await identityFixture("sqlite");
  try {
  const agent = await fixture.repos.agents.create({ displayName: "envelope collector", hostType: "codex-cli" });
  const collectedAuthor = JSON.stringify({ kind: "agent", actorId: `agent:${agent.id}`, agentId: agent.id, displayName: "envelope collector" });
  await fixture.db.transaction(async tx => {
      await tx.exec("INSERT INTO memory_documents VALUES(?,?,?,?,?,?,?,?,?,?)",
        ["document-0", "global", null, agent.id, 1, "same", 4, at, collectedAuthor, "agent"]);
      await tx.exec("INSERT INTO memory_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ["version-0-1", "document-0", 1, 0, "same", 4, sha("same"), collectedAuthor, `agent:${agent.id}`, "agent", "mutation-0", null, at]);
    });
    const db = new Database(path.join(fixture.dir, DATABASE_FILE_NAME), { readonly: true, fileMustExist: true });
    try {
      db.pragma("query_only=ON");
      db.exec("BEGIN");
      const manifests = readSqliteManifests(db);
      const bytes = Buffer.from(canonicalJson(manifests));
      const manifestDigest = shaBytes(bytes);
      const request = { contract: "layout-memory-collection-request/r1",
        source: { kind: "sqlite" as const, databaseInstanceId: manifests.controlRows.storage_maintenance[0]!.database_instance_id,
          identityDigest: "a".repeat(64) },
        frozenManifest: { ref: `snapshots/${manifestDigest}/database-manifests.json`, sha256: manifestDigest, bytes: String(bytes.length) },
        storageId: "storage:1", invocationStartedAtNs: process.hrtime.bigint().toString() };
      const snapshot = { query: (sql: string, params: readonly unknown[] = []) =>
        Promise.resolve(db.prepare(sql).all(...params) as DbRow[]) } as DbReadSnapshot;
      const observed: Observation = await collectLayoutMemoryInventory(snapshot, request, bytes);
      db.exec("COMMIT");
      assert.equal(observed.contract, "layout-memory-collection-observation/r1");
      assert.equal(observed.authority, "observation-only");
      const envelope = buildMemoryAuthorityEnvelope(observed);
      assert.equal(envelope.authorityLabel, "observation-only");
      assert.equal(envelope.observationDigest, digestJson(observed));
      assert.equal(envelope.counts.payloadObjects, 1);
      assert.equal(JSON.stringify(envelope), JSON.stringify(buildMemoryAuthorityEnvelope(observed)));
      assertDeepFrozen(envelope);
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
  } finally {
    await fixture.close();
  }
});

test("MMP-S4-T3: collector 形状冻结 observation 装配出完整、可重复的权威信封", () => {
  const observed = observation();
  const payload = buildLayoutMemoryObjectPayloadValues(observed.input);
  const authority = buildMemoryVersionAuthority(payload.inventory);
  const envelope = buildMemoryAuthorityEnvelope(observed);
  const repeated = buildMemoryAuthorityEnvelope(observed);

  assert.deepEqual(Object.keys(envelope).sort(compareText), envelopeKeys());
  assert.equal(envelope.contract, "memory-authority-envelope-value/r1");
  assert.equal(envelope.observationContract, "layout-memory-collection-observation/r1");
  assert.equal(envelope.authorityLabel, "observation-only");
  assert.equal(envelope.observationDigest, digestJson(observed));
  assert.equal(envelope.storageId, "storage:1");
  assert.equal(envelope.inventoryDigest, payload.inventory.inventoryDigest);
  assert.equal(envelope.payloadDigest, digestJson(payload));
  assert.equal(envelope.authorityDigest, authority.digest);
  assert.equal(envelope.planDigest, buildMemoryPublicationPlan(authority).digest);
  assert.equal(envelope.reportDigest, reportUnreferencedObjects(authority).digest);
  assert.equal(envelope.readDigest, null);
  assert.equal(envelope.selectedObjectDigest, null);
  const { digest: _ignored, ...body } = envelope;
  assert.equal(envelope.digest, digestJson(body));
  assert.equal(JSON.stringify(envelope), JSON.stringify(repeated));
  assert.deepEqual(repeated, envelope);
  assertDeepFrozen(envelope);
  const text = canonicalJson(envelope);
  assert.equal(text.includes("same"), false);
  assert.equal(text.includes("中文"), false);
  assert.equal(text.includes("frozen/manifest"), false);
});

test("MMP-S4-T3: 多版本共享正文只出一个对象，五向 digest 逐项对应", () => {
  const observed = observation();
  const payload = buildLayoutMemoryObjectPayloadValues(observed.input);
  const authority = buildMemoryVersionAuthority(payload.inventory);
  const plan = buildMemoryPublicationPlan(authority);
  const report = reportUnreferencedObjects(authority);
  const envelope = buildMemoryAuthorityEnvelope(observed);
  const digests = [...new Set(payload.objects.map(entry => entry.object.contentSha256))].sort(compareText);

  assert.equal(digests.length, 3);
  assert.equal(payload.inventory.versions.filter(version => version.object.contentSha256 === sha("same")).length >= 2, true);
  assert.equal(envelope.counts.payloadObjects, digests.length);
  assert.equal(envelope.counts.authorityRefs, digests.length);
  assert.equal(envelope.counts.planObjects, digests.length);
  assert.equal(envelope.counts.reportObjects, 0);
  assert.deepEqual(envelope.objects.map(item => item.objectDigest), digests);
  assert.equal(new Set(envelope.objects.map(item => item.objectDigest)).size, digests.length);
  assert.equal(new Set(envelope.objects.map(item => item.relativePath)).size, digests.length);
  for (const item of envelope.objects) {
    const payloadEntry = payload.objects.find(entry => entry.object.contentSha256 === item.objectDigest)!;
    const planEntry = plan.objects.find(entry => entry.objectDigest === item.objectDigest)!;
    assert.equal(item.payloadEntryDigest, digestJson(payloadEntry));
    assert.equal(item.payloadBytesDigest, shaBytes(Buffer.from(payloadEntry.payload.bytesHex, "hex")));
    assert.equal(item.refDigest, digestJson(payloadEntry.object));
    assert.equal(item.authorityRefDigest, item.refDigest);
    assert.equal(item.planEntryDigest, digestJson(planEntry));
    assert.equal(item.reportEntryDigest, null);
    assert.equal(item.selectedByRead, false);
    assert.equal(item.relativePath, payloadEntry.relativePath);
    assert.equal(item.byteLength, payloadEntry.object.byteLength);
    for (const scope of item.authorityScopes) {
      const layer = authority.layers.find(candidate => candidate.scope === scope);
      assert.ok(layer);
      assert.equal(item.authorityLayerDigests.includes(layer.digest), true);
    }
  }
  assert.equal(report.objects.length, 0);
});

test("MMP-S4-T3: 空 inventory 产生结构完整的空信封", () => {
  const observed = observation([]);
  const envelope = buildMemoryAuthorityEnvelope(observed);
  assert.deepEqual(Object.keys(envelope).sort(compareText), envelopeKeys());
  assert.deepEqual(envelope.counts, { payloadObjects: 0, authorityRefs: 0, planObjects: 0, reportObjects: 0 });
  assert.deepEqual(envelope.objects, []);
  assert.equal(envelope.digest, digestJson((({ digest: _ignored, ...body }) => body)(envelope)));
  assert.equal(envelope.reportDigest, reportUnreferencedObjects(buildMemoryVersionAuthority(buildLayoutMemoryObjectPayloadValues(observed.input).inventory)).digest);
  assertDeepFrozen(envelope);
});

test("MMP-S4-T3: 可选 selector 只附加读投影，不改变全量对象对应", () => {
  const observed = observation();
  const full = buildMemoryAuthorityEnvelope(observed);
  const selected = buildMemoryAuthorityEnvelope(observed, selector({ version: 2 }));
  assert.equal(selected.digest === full.digest, false);
  assert.equal(selected.objects.length, full.objects.length);
  assert.equal(selected.planDigest, full.planDigest);
  assert.equal(selected.readDigest !== null, true);
  assert.equal(selected.selectedObjectDigest, sha("same"));
  assert.deepEqual(selected.objects.filter(item => item.selectedByRead).map(item => item.objectDigest), [sha("same")]);
  const authority = buildMemoryVersionAuthority(buildLayoutMemoryObjectPayloadValues(observed.input).inventory);
  const projection = projectMemoryRead(authority, selector({ version: 2 }));
  assert.equal(selected.readDigest, projection.digest);
});

test("MMP-S4-T3: contract/authority 标签与外层自身字段受控拒绝", () => {
  const base = observation();
  const before = canonicalJson(base);
  const wrongContract = mutable(base);
  wrongContract["contract"] = "layout-memory-collection-observation/r2";
  fails(() => buildMemoryAuthorityEnvelope(reseal(wrongContract)), "unsupported_shape");

  for (const authority of ["publication-authority", null]) {
    const wrong = mutable(base);
    wrong["authority"] = authority;
    fails(() => buildMemoryAuthorityEnvelope(reseal(wrong)), "unsupported_shape");
  }
  const undefinedAuthority = mutable(base);
  undefinedAuthority["authority"] = undefined;
  fails(() => buildMemoryAuthorityEnvelope(reseal(undefinedAuthority)), "invalid_value");
  const extra = mutable(base);
  extra["path"] = "/private";
  fails(() => buildMemoryAuthorityEnvelope(reseal(extra)), "invalid_value");
  const missing = mutable(base);
  delete missing["inventory"];
  fails(() => buildMemoryAuthorityEnvelope(reseal(missing)), "invalid_value");
  assert.equal(canonicalJson(base), before);
});

test("MMP-S4-T3: storageId/source/frozenManifest 绑定不符与陈旧 inventory 摘要整体拒绝", () => {
  const base = observation();
  const before = canonicalJson(base);
  for (const [field, value] of [["storageId", "storage:other"], ["source", { kind: "sqlite", databaseInstanceId: "4".repeat(32), identityDigest: "2".repeat(64) }]] as const) {
    const wrong = mutable(base);
    (wrong["input"] as MutableRecord)[field] = value;
    fails(() => buildMemoryAuthorityEnvelope(reseal(wrong)), "inventory_integrity");
  }
  const manifest = mutable(base);
  ((manifest["input"] as MutableRecord)["frozenManifest"] as MutableRecord)["sha256"] = "5".repeat(64);
  fails(() => buildMemoryAuthorityEnvelope(reseal(manifest)), "inventory_integrity");

  const stale = mutable(base);
  ((stale["inventory"] as MutableRecord)["versions"] as MutableRecord[])[0]!["createdAt"] = "2026-11-20T01:02:03.000Z";
  fails(() => buildMemoryAuthorityEnvelope(reseal(stale)), "inventory_integrity");
  assert.equal(canonicalJson(base), before);
});

test("MMP-S4-T3: payload 缺对象、正文多一字节与非法 selector 均无部分输出", () => {
  const base = observation();
  const before = canonicalJson(base);
  const missing = mutable(base);
  const mutableTable = ((missing["input"] as MutableRecord)["tables"] as MutableRecord[])[1]!;
  (mutableTable["rows"] as unknown[]).pop();
  resealTable(missing, 1);
  fails(() => buildMemoryAuthorityEnvelope(reseal(missing)), "incomplete_inventory");

  const extraByte = mutable(base);
  const versionTable = ((extraByte["input"] as MutableRecord)["tables"] as MutableRecord[])[1]!;
  const firstVersion = (versionTable["rows"] as MutableRecord[])[0]!;
  const markdown = firstVersion["4"] as ["text", string];
  firstVersion["4"] = textCell(Buffer.from(markdown[1], "hex").toString("utf8") + "x");
  resealTable(extraByte, 1);
  fails(() => buildMemoryAuthorityEnvelope(reseal(extraByte)));

  const badSelector = { ...selector(), version: 4 };
  fails(() => buildMemoryAuthorityEnvelope(base, badSelector), "value_conflict");
  assert.equal(canonicalJson(base), before);
});

test("MMP-S4-T3: getter、非冻结对象与原型污染从不执行调用者代码", () => {
  const base = observation();
  const before = canonicalJson(base);
  let reads = 0;
  const hostile = { ...base } as MutableRecord;
  Object.defineProperty(hostile, "inventory", { enumerable: true, configurable: true,
    get() { reads++; return base.inventory; } });
  fails(() => buildMemoryAuthorityEnvelope(Object.freeze(hostile) as Observation), "invalid_value");
  assert.equal(reads, 0);

  const unfrozen = mutable(base);
  fails(() => buildMemoryAuthorityEnvelope(unfrozen as Observation), "invalid_value");
  const nestedInput = Object.create(null) as MutableRecord;
  for (const [key, value] of Object.entries(base.input as MutableRecord))
    Object.defineProperty(nestedInput, key, { value, enumerable: true, configurable: true });
  Object.defineProperty(nestedInput, "storageId", { enumerable: true, configurable: true,
    get() { reads++; return "storage:1"; } });
  Object.freeze(nestedInput);
  const nestedObservation = Object.create(null) as MutableRecord;
  for (const [key, value] of Object.entries(base as MutableRecord))
    Object.defineProperty(nestedObservation, key, { value: key === "input" ? nestedInput : value, enumerable: true });
  Object.freeze(nestedObservation);
  fails(() => buildMemoryAuthorityEnvelope(nestedObservation as Observation), "invalid_value");
  assert.equal(reads, 0);

  const polluted = mutable(base);
  Object.defineProperty(polluted, "__proto__", { value: { injected: true }, enumerable: true, writable: true, configurable: true });
  fails(() => buildMemoryAuthorityEnvelope(freezeNull(polluted) as Observation), "invalid_value");
  assert.equal(Reflect.get({}, "injected"), undefined);
  assert.equal(canonicalJson(base), before);
});

test("MMP-S4-T3: BigInt、Symbol 键/值与恶意 Proxy 边界均受控拒绝", () => {
  const base = observation();
  const before = canonicalJson(base);
  const valid = buildMemoryAuthorityEnvelope(base);

  const bigIntCases: readonly (readonly [string, (copy: MutableRecord) => void])[] = [
    ["inventory 数值字段", copy => {
      ((copy["inventory"] as MutableRecord)["versions"] as MutableRecord[])[0]!["version"] = 1n;
    }],
    ["input 编码数值单元", copy => {
      const documents = ((copy["input"] as MutableRecord)["tables"] as MutableRecord[])[0]!;
      const firstRow = (documents["rows"] as unknown[])[0] as unknown[];
      firstRow[6] = 1n;
    }],
  ];
  for (const [label, mutate] of bigIntCases) {
    const copy = mutable(base);
    mutate(copy);
    fails(() => buildMemoryAuthorityEnvelope(freezeNull(copy) as Observation), "invalid_value", label);
  }

  const symbolValue = mutable(base);
  ((symbolValue["inventory"] as MutableRecord)["versions"] as MutableRecord[])[0]!["version"] = Symbol("version");
  fails(() => buildMemoryAuthorityEnvelope(freezeNull(symbolValue) as Observation), "invalid_value");

  const symbolKey = Symbol("injected");
  const withSymbolKey = mutable(base);
  Object.defineProperty(withSymbolKey, symbolKey, { value: "private", enumerable: true, configurable: true });
  const hostileKey = Object.create(null) as MutableRecord;
  for (const key of Reflect.ownKeys(withSymbolKey))
    Object.defineProperty(hostileKey, key, { value: Reflect.get(withSymbolKey, key), enumerable: true, configurable: true });
  Object.freeze(hostileKey);
  fails(() => buildMemoryAuthorityEnvelope(hostileKey as Observation), "invalid_value");

  let prototypeTraps = 0;
  const hostileInput = new Proxy(base.input as object, {
    getPrototypeOf() { prototypeTraps++; throw new Error("hostile getPrototypeOf"); },
  });
  const hostileProxy = Object.create(null) as MutableRecord;
  for (const [key, value] of Object.entries(base as MutableRecord))
    Object.defineProperty(hostileProxy, key, { value: key === "input" ? hostileInput : value, enumerable: true, configurable: true });
  Object.freeze(hostileProxy);
  fails(() => buildMemoryAuthorityEnvelope(hostileProxy as Observation), "invalid_value");
  assert.equal(prototypeTraps > 0, true);

  assert.equal(canonicalJson(base), before);
  assert.deepEqual(buildMemoryAuthorityEnvelope(base), valid);
});
