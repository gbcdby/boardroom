import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import type { LayoutMemoryInventoryValue } from "../src/server/storage/maintenance/layout-memory-inventory.ts";
import { LayoutValueError } from "../src/server/storage/maintenance/layout-values.ts";
import { memoryObjectRelativeKey } from "../src/server/memory/object-ref.ts";
import type { MemoryUnreferencedObjectValue, MemoryUnreferencedReportValue } from "../src/server/memory/unreferenced-report.ts";
import { reportUnreferencedObjects } from "../src/server/memory/unreferenced-report.ts";
import type { MemoryVersionAuthorityValue } from "../src/server/memory/version-authority.ts";
import { buildMemoryVersionAuthority } from "../src/server/memory/version-authority.ts";

type Inventory = LayoutMemoryInventoryValue;
type MutableDeep<T> = T extends readonly (infer E)[] ? MutableDeep<E>[]
  : T extends object ? { -readonly [K in keyof T]: MutableDeep<T[K]> } : T;
type AuthorityRef = MemoryVersionAuthorityValue["unreferencedObjects"][number];

const storageId = "storage:1";
const at = "2026-11-23T00:00:00.000Z";
const actorId = "agent:writer";
const authorRaw = JSON.stringify({ kind: "agent", actorId, agentId: "agent-1", displayName: "Writer" });
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const objectPath = (text: string) => `objects/sha256/${sha(text).slice(0, 2)}/${sha(text)}.md`;
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function objectRef(text: string): Inventory["objects"][number] {
  return { objectFormat: "utf8-sha256-v1", storageId, contentSha256: sha(text), byteLength: Buffer.byteLength(text, "utf8") };
}
function authorityRef(text: string): AuthorityRef { return objectRef(text) as AuthorityRef; }
function version(documentId: string, number: number, body: string, mutation: string): Inventory["versions"][number] {
  const object = objectRef(body);
  return { versionId: `version-${documentId}-${number}`, documentId, version: number, parentVersion: number - 1,
    object, relativePath: objectPath(body), actorId, clientMutationId: mutation, summaryRequestId: null, authorRaw,
    source: "agent", createdAt: at, sourceRowDigest: sha(`version:${documentId}:${number}`) };
}
function inventoryFixture(): Inventory {
  const documents: Inventory["documents"] = [
    { documentId: "doc-g", legacyKey: { scope: "global", projectId: null, agentId: "agent-g" }, documentKind: "note",
      currentVersion: 2, updatedAt: at, updatedByRaw: authorRaw, source: "agent", sourceRowDigest: sha("row:doc-g") },
    { documentId: "doc-p", legacyKey: { scope: "project", projectId: "project-p", agentId: null }, documentKind: "note",
      currentVersion: 1, updatedAt: at, updatedByRaw: authorRaw, source: "agent", sourceRowDigest: sha("row:doc-p") },
    { documentId: "doc-pa", legacyKey: { scope: "project-agent", projectId: "project-p", agentId: "agent-pa" }, documentKind: "note",
      currentVersion: 1, updatedAt: at, updatedByRaw: authorRaw, source: "agent", sourceRowDigest: sha("row:doc-pa") },
  ];
  const versions: Inventory["versions"] = [
    version("doc-g", 1, "global-v1", "mutation-g-1"),
    version("doc-g", 2, "shared", "mutation-g-2"),
    version("doc-p", 1, "project", "mutation-p-1"),
    version("doc-pa", 1, "shared", "mutation-pa-1"),
  ];
  const objects: Inventory["objects"] = [...new Map(["global-v1", "shared", "project"].map(body => {
    const ref = objectRef(body);
    return [ref.contentSha256, ref] as const;
  })).values()].sort((left, right) => compareText(left.contentSha256, right.contentSha256)
    || left.byteLength - right.byteLength);
  const tables: Inventory["tables"] = [
    { name: "memory_documents", count: String(documents.length), digest: "a".repeat(64) },
    { name: "memory_versions", count: String(versions.length), digest: "b".repeat(64) },
    { name: "memory_summary_requests", count: "0", digest: "c".repeat(64) },
  ];
  const payload = {
    contract: "layout-memory-inventory-value/r1" as const,
    source: { kind: "sqlite" as const, databaseInstanceId: "a".repeat(32), identityDigest: "b".repeat(64) },
    frozenManifest: { ref: "frozen/memory", sha256: "c".repeat(64), bytes: "1" },
    storageId, tables, documents, versions, objects,
    totalVersionBodyBytes: versions.reduce((sum, item) => sum + BigInt(item.object.byteLength), 0n).toString(),
    uniqueObjectBodyBytes: objects.reduce((sum, item) => sum + BigInt(item.byteLength), 0n).toString(),
  } satisfies Omit<Inventory, "inventoryDigest">;
  return { ...payload, inventoryDigest: digestJson(payload) };
}
function authorityFixture(): MemoryVersionAuthorityValue { return buildMemoryVersionAuthority(inventoryFixture()); }
function mutable<T>(value: T): MutableDeep<T> { return value as MutableDeep<T>; }
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) freezeDeep(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}
function resealAuthority(value: MemoryVersionAuthorityValue): MemoryVersionAuthorityValue {
  const layers = value.layers.map(layer => {
    const chains = layer.chains.map(chain => {
      const { digest: _ignored, ...payload } = chain;
      return { ...payload, digest: digestJson(payload) };
    });
    const { digest: _ignored, ...payload } = layer;
    return { ...payload, chains, digest: digestJson({ ...payload, chains }) };
  });
  const { digest: _ignored, ...payload } = value;
  return { ...payload, layers, digest: digestJson({ ...payload, layers }) };
}
function withUnreferenced(bodies: readonly string[]): MemoryVersionAuthorityValue {
  const value = mutable(structuredClone(authorityFixture()));
  value.unreferencedObjects = [...value.unreferencedObjects, ...bodies.map(authorityRef)]
    .sort((left, right) => compareText(left.contentSha256, right.contentSha256)
      || left.byteLength - right.byteLength);
  return freezeDeep(resealAuthority(value)) as MemoryVersionAuthorityValue;
}
function fails(action: () => unknown, code?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LayoutValueError);
    assert.equal(error.message, `layout_internal_value:${error.code}`);
    assert.equal(Object.hasOwn(error, "cause"), false);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });
}
function expectedEntry(body: string): MemoryUnreferencedObjectValue {
  const ref = authorityRef(body);
  return { relativePath: memoryObjectRelativeKey(ref), refDigest: digestJson(ref), objectDigest: ref.contentSha256 };
}
function assertReport(value: MemoryUnreferencedReportValue, authorityDigest: string,
  objects: readonly MemoryUnreferencedObjectValue[]): void {
  assert.deepEqual(Object.keys(value).sort(), ["authorityDigest", "contract", "digest", "objects"]);
  assert.equal(value.contract, "memory-unreferenced-report-value/r1");
  assert.equal(value.authorityDigest, authorityDigest);
  assert.deepEqual(value.objects, objects);
  assert.equal(value.digest, digestJson({ contract: value.contract, authorityDigest, objects }));
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.objects), true);
  for (const item of value.objects) assert.equal(Object.isFrozen(item), true);
  assert.equal(JSON.stringify(value).includes("markdown"), false);
  assert.equal(JSON.stringify(value).includes("private"), false);
}

test("MUR-S4: 冻结权威下空集报告稳定、不可变且不携带正文或权限", () => {
  const authority = authorityFixture();
  const report = reportUnreferencedObjects(authority);
  assertReport(report, authority.digest, []);
  assert.equal(report.objects.length, 0);
  assert.equal(JSON.stringify(report), JSON.stringify(reportUnreferencedObjects(authority)));
  assert.deepEqual(reportUnreferencedObjects(authority), report);
});

test("MUR-S4: 构造未引用对象仅按 ref 派生规范路径与摘要，稳定排序且重复同字节", () => {
  const authority = withUnreferenced(["orphan-b", "orphan-a"]);
  const report = reportUnreferencedObjects(authority);
  const expected = [expectedEntry("orphan-a"), expectedEntry("orphan-b")]
    .sort((left, right) => compareText(left.relativePath, right.relativePath));
  assertReport(report, authority.digest, expected);
  assert.equal(report.objects[0]!.relativePath, objectPath("orphan-a"));
  assert.equal(report.objects[1]!.relativePath, objectPath("orphan-b"));
  assert.equal(JSON.stringify(report), JSON.stringify(reportUnreferencedObjects(authority)));
  assert.deepEqual(reportUnreferencedObjects(authority), report);
});

test("MUR-S4: 拒绝 caller getter、额外字段、原型污染与预算超限", () => {
  const authority = authorityFixture();
  for (const extra of ["path", "body", "durable", "permission"]) {
    const hostile = { ...structuredClone(authority), [extra]: "private" } as MemoryVersionAuthorityValue;
    fails(() => reportUnreferencedObjects(freezeDeep(resealAuthority(hostile))), "invalid_value");
  }

  let reads = 0;
  const getter = structuredClone(authority);
  Object.defineProperty(getter, "layers", { enumerable: true, configurable: true,
    get() { reads++; return []; } });
  fails(() => reportUnreferencedObjects(Object.freeze(getter)), "invalid_value");
  assert.equal(reads, 0);

  const polluted = structuredClone(authority);
  Object.defineProperty(polluted, "__proto__", { value: { injected: true }, enumerable: true, writable: true, configurable: true });
  fails(() => reportUnreferencedObjects(freezeDeep(polluted)), "invalid_value");
  assert.equal(Reflect.get({}, "injected"), undefined);

  const oversized = freezeDeep({ ...authority, extra: "x".repeat(32 * 1_048_576 + 1) }) as unknown as MemoryVersionAuthorityValue;
  fails(() => reportUnreferencedObjects(oversized), "budget_exceeded");
});

test("MUR-S4: 陈旧 authority/layer/chain digest 与伪造相对路径受控拒绝", () => {
  const authority = authorityFixture();
  const stale = freezeDeep({ ...authority, digest: "0".repeat(64) });
  fails(() => reportUnreferencedObjects(stale), "inventory_integrity");

  const brokenLayer = mutable(structuredClone(authority));
  brokenLayer.layers[0]!.digest = "0".repeat(64);
  fails(() => reportUnreferencedObjects(freezeDeep(brokenLayer)), "inventory_integrity");

  const brokenChain = mutable(structuredClone(authority));
  brokenChain.layers[0]!.chains[0]!.digest = "0".repeat(64);
  fails(() => reportUnreferencedObjects(freezeDeep(brokenChain)), "inventory_integrity");

  const forgedPath = mutable(structuredClone(authority));
  forgedPath.layers[0]!.chains[0]!.versions[0]!.relativePath = "objects/sha256/../../escape.md";
  fails(() => reportUnreferencedObjects(freezeDeep(resealAuthority(forgedPath))), "inventory_integrity");
});

test("MUR-S4: 外部/重叠/跨层/缺失 ref 均拒绝，报告不执行任何生命周期动作", () => {
  const authority = authorityFixture();

  const externalField = mutable(structuredClone(authority));
  externalField.unreferencedObjects = [{ ...objectRef("outside"), path: "/tmp/private.md" } as unknown as AuthorityRef];
  fails(() => reportUnreferencedObjects(freezeDeep(resealAuthority(externalField))), "inventory_integrity");

  const externalStorage = mutable(structuredClone(authority));
  externalStorage.unreferencedObjects = [{ ...objectRef("outside"), storageId: "other:1" } as AuthorityRef];
  fails(() => reportUnreferencedObjects(freezeDeep(resealAuthority(externalStorage))), "inventory_integrity");

  const overlap = mutable(structuredClone(authority));
  overlap.unreferencedObjects = [structuredClone(authority.layers[0]!.objects[0]!)];
  fails(() => reportUnreferencedObjects(freezeDeep(resealAuthority(overlap))), "inventory_integrity");

  const crossLayer = mutable(structuredClone(authority));
  crossLayer.layers[0]!.chains[0]!.versions[1]!.object = structuredClone(authority.layers[1]!.objects[0]!);
  fails(() => reportUnreferencedObjects(freezeDeep(resealAuthority(crossLayer))), "inventory_integrity");

  const missing = mutable(structuredClone(authority));
  missing.layers[0]!.objects = missing.layers[0]!.objects.filter(ref => ref.contentSha256 !== sha("shared"));
  fails(() => reportUnreferencedObjects(freezeDeep(resealAuthority(missing))), "inventory_integrity");

  const divergent = mutable(JSON.parse(JSON.stringify(authority)) as MemoryVersionAuthorityValue);
  divergent.layers[2]!.objects[0]!.byteLength += 1;
  divergent.layers[2]!.chains[0]!.versions[0]!.object.byteLength += 1;
  fails(() => reportUnreferencedObjects(freezeDeep(resealAuthority(divergent))), "value_conflict");
});
