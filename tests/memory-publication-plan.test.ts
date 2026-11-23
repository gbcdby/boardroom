import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import type { LayoutMemoryInventoryValue } from "../src/server/storage/maintenance/layout-memory-inventory.ts";
import { LayoutValueError } from "../src/server/storage/maintenance/layout-values.ts";
import { buildMemoryPublicationPlan } from "../src/server/memory/publication-plan.ts";
import type { MemoryPublicationObjectValue, MemoryPublicationPlanValue } from "../src/server/memory/publication-plan.ts";
import type { MemoryReadSelectorValue } from "../src/server/memory/read-projection.ts";
import type { MemoryVersionAuthorityValue } from "../src/server/memory/version-authority.ts";
import { buildMemoryVersionAuthority } from "../src/server/memory/version-authority.ts";

type Inventory = LayoutMemoryInventoryValue;
type MutableDeep<T> = T extends readonly (infer E)[] ? MutableDeep<E>[]
  : T extends object ? { -readonly [K in keyof T]: MutableDeep<T[K]> } : T;

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
function selector(overrides: Partial<MemoryReadSelectorValue> = {}): MemoryReadSelectorValue {
  return { scope: "global", projectId: null, agentId: "agent-g", documentKind: "note", documentId: "doc-g", ...overrides };
}
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
function fails(action: () => unknown, code?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LayoutValueError);
    assert.equal(error.message, `layout_internal_value:${error.code}`);
    assert.equal(Object.hasOwn(error, "cause"), false);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });
}
function entry(body: string): MemoryPublicationObjectValue {
  const ref = objectRef(body);
  return { relativePath: objectPath(body), refDigest: digestJson(ref), byteLength: ref.byteLength, objectDigest: sha(body) };
}
function expectedAllObjects(): readonly MemoryPublicationObjectValue[] {
  return ["global-v1", "shared", "project"].map(entry).sort((left, right) => compareText(left.relativePath, right.relativePath));
}
function assertPlan(value: MemoryPublicationPlanValue, authorityDigest: string, objects: readonly MemoryPublicationObjectValue[]): void {
  assert.deepEqual(Object.keys(value).sort(), ["authorityDigest", "contract", "digest", "objects"]);
  assert.equal(value.contract, "memory-publication-plan-value/r1");
  assert.equal(value.authorityDigest, authorityDigest);
  assert.deepEqual(value.objects, objects);
  assert.equal(value.digest, digestJson({ contract: value.contract, authorityDigest, objects }));
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.objects), true);
  for (const item of value.objects) assert.equal(Object.isFrozen(item), true);
  assert.equal(JSON.stringify(value).includes("markdown"), false);
  assert.equal(JSON.stringify(value).includes("private"), false);
}

test("MMP-S4: 无 selector 时按三层权威引用生成去重、稳定排序的对象发布计划", () => {
  const authority = authorityFixture();
  const plan = buildMemoryPublicationPlan(authority);
  assertPlan(plan, authority.digest, expectedAllObjects());
  assert.equal(plan.objects.length, 3);
  assert.equal(JSON.stringify(plan), JSON.stringify(buildMemoryPublicationPlan(authority)));
  assert.deepEqual(buildMemoryPublicationPlan(authority), plan);
});

test("MMP-S4: selector 精确收窄到文档所选版本，保留 head 与跨层身份", () => {
  const authority = authorityFixture();
  const global = buildMemoryPublicationPlan(authority, selector());
  assertPlan(global, authority.digest, [entry("shared")]);
  assert.deepEqual(buildMemoryPublicationPlan(authority, selector({ version: 2 })), global);

  const ancestor = buildMemoryPublicationPlan(authority, selector({ version: 1 }));
  assertPlan(ancestor, authority.digest, [entry("global-v1")]);

  const project = buildMemoryPublicationPlan(authority, selector({ scope: "project", projectId: "project-p", agentId: null, documentId: "doc-p" }));
  assertPlan(project, authority.digest, [entry("project")]);

  const projectAgent = buildMemoryPublicationPlan(authority, selector({ scope: "project-agent", projectId: "project-p", agentId: "agent-pa", documentId: "doc-pa" }));
  assertPlan(projectAgent, authority.digest, [entry("shared")]);
  assert.equal(projectAgent.objects[0]!.relativePath, objectPath("shared"));
});

test("MMP-S4: 严格 selector 拒绝额外字段、错类型、getter 与原型污染", () => {
  const authority = authorityFixture();
  for (const extra of ["path", "body", "durable", "permission"]) {
    const hostile = { ...selector(), [extra]: "private" } as unknown as MemoryReadSelectorValue;
    fails(() => buildMemoryPublicationPlan(authority, hostile), "invalid_value");
  }
  const invalid: unknown[] = [null, "doc-g", [], { ...selector(), scope: "workspace" },
    { ...selector(), projectId: "project-p" }, { ...selector(), agentId: null }, { ...selector(), documentKind: "summary" },
    { ...selector(), documentId: "" }, { ...selector(), version: 0 }, { ...selector(), version: 1.5 },
    { ...selector(), version: "1" }, { ...selector(), version: undefined }];
  for (const value of invalid) fails(() => buildMemoryPublicationPlan(authority, value as MemoryReadSelectorValue), "invalid_value");

  let reads = 0;
  const getterField = Object.defineProperty({ ...selector() }, "permission", { enumerable: true, get() { reads++; return "allow"; } });
  const getterDocument = Object.defineProperty({ ...selector() }, "documentId", { enumerable: true, get() { reads++; return "doc-g"; } });
  fails(() => buildMemoryPublicationPlan(authority, getterField as MemoryReadSelectorValue), "invalid_value");
  fails(() => buildMemoryPublicationPlan(authority, getterDocument as MemoryReadSelectorValue), "invalid_value");
  const polluted = Object.defineProperty({ ...selector() }, "__proto__", { value: { injected: true }, enumerable: true });
  fails(() => buildMemoryPublicationPlan(authority, polluted as MemoryReadSelectorValue), "invalid_value");
  assert.equal(reads, 0);
  assert.equal(Reflect.get({}, "injected"), undefined);
});

test("MMP-S4: 跨层文档、越界版本与陈旧/重封 authority 均受控拒绝", () => {
  const authority = authorityFixture();
  fails(() => buildMemoryPublicationPlan(authority, selector({ scope: "project", projectId: "project-p", agentId: null, documentId: "doc-g" })), "value_conflict");
  fails(() => buildMemoryPublicationPlan(authority, selector({ agentId: "other" })), "value_conflict");
  fails(() => buildMemoryPublicationPlan(authority, selector({ documentId: "doc-p" })), "value_conflict");
  fails(() => buildMemoryPublicationPlan(authority, selector({ version: 3 })), "value_conflict");

  const stale = freezeDeep({ ...authority, digest: "0".repeat(64) });
  fails(() => buildMemoryPublicationPlan(stale), "inventory_integrity");

  const brokenLayer = mutable(structuredClone(authority));
  brokenLayer.layers[0]!.digest = "0".repeat(64);
  fails(() => buildMemoryPublicationPlan(freezeDeep(brokenLayer)), "inventory_integrity");

  const brokenChain = mutable(structuredClone(authority));
  brokenChain.layers[0]!.chains[0]!.digest = "0".repeat(64);
  fails(() => buildMemoryPublicationPlan(freezeDeep(brokenChain)), "inventory_integrity");

  const extraField = { ...structuredClone(authority), path: "/private" } as MemoryVersionAuthorityValue & { path: string };
  fails(() => buildMemoryPublicationPlan(freezeDeep(resealAuthority(extraField))), "invalid_value");
  fails(() => buildMemoryPublicationPlan(structuredClone(authority)), "invalid_value");

  let authorityReads = 0;
  const authorityGetter = structuredClone(authority);
  Object.defineProperty(authorityGetter, "layers", { enumerable: true, configurable: true,
    get() { authorityReads++; return []; } });
  fails(() => buildMemoryPublicationPlan(Object.freeze(authorityGetter)), "invalid_value");
  assert.equal(authorityReads, 0);

  const oversized = freezeDeep({ ...authority, extra: "x".repeat(32 * 1_048_576 + 1) }) as unknown as MemoryVersionAuthorityValue;
  fails(() => buildMemoryPublicationPlan(oversized), "budget_exceeded");
});

test("MMP-S4: 对象集合只认本层引用；外部路径、跨层 ref、缺失对象与伪造相对路径拒绝", () => {
  const authority = authorityFixture();

  const foreignObject = mutable(structuredClone(authority));
  foreignObject.layers[0]!.chains[0]!.versions[1]!.object = structuredClone(authority.layers[1]!.objects[0]!);
  fails(() => buildMemoryPublicationPlan(freezeDeep(resealAuthority(foreignObject))), "inventory_integrity");

  const missingObject = mutable(structuredClone(authority));
  missingObject.layers[0]!.objects = missingObject.layers[0]!.objects.filter(ref => ref.contentSha256 !== sha("shared"));
  fails(() => buildMemoryPublicationPlan(freezeDeep(resealAuthority(missingObject))), "inventory_integrity");

  const forgedPath = mutable(structuredClone(authority));
  forgedPath.layers[0]!.chains[0]!.versions[1]!.relativePath = "objects/sha256/../../escape.md";
  fails(() => buildMemoryPublicationPlan(freezeDeep(resealAuthority(forgedPath))), "inventory_integrity");

  const externalRef = mutable(structuredClone(authority));
  const pollutedRef = { ...externalRef.layers[0]!.objects[0]!, path: "/tmp/private.md" };
  externalRef.layers[0]!.objects[0] = pollutedRef as unknown as MemoryVersionAuthorityValue["layers"][number]["objects"][number];
  fails(() => buildMemoryPublicationPlan(freezeDeep(resealAuthority(externalRef))), "inventory_integrity");

  const divergentRef = mutable(JSON.parse(JSON.stringify(authority)) as MemoryVersionAuthorityValue);
  divergentRef.layers[2]!.objects[0]!.byteLength += 1;
  divergentRef.layers[2]!.chains[0]!.versions[0]!.object.byteLength += 1;
  fails(() => buildMemoryPublicationPlan(freezeDeep(resealAuthority(divergentRef))), "value_conflict");
});
