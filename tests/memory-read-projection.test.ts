import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import type { LayoutMemoryInventoryValue } from "../src/server/storage/maintenance/layout-memory-inventory.ts";
import { LayoutValueError } from "../src/server/storage/maintenance/layout-values.ts";
import { projectMemoryRead } from "../src/server/memory/read-projection.ts";
import type { MemoryReadSelectorValue } from "../src/server/memory/read-projection.ts";
import type { MemoryVersionAuthorityValue } from "../src/server/memory/version-authority.ts";
import { buildMemoryVersionAuthority } from "../src/server/memory/version-authority.ts";

type Inventory = LayoutMemoryInventoryValue;
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

function authorityFixture(): MemoryVersionAuthorityValue {
  return buildMemoryVersionAuthority(inventoryFixture());
}
function selector(overrides: Partial<MemoryReadSelectorValue> = {}): MemoryReadSelectorValue {
  return { scope: "global", projectId: null, agentId: "agent-g", documentKind: "note", documentId: "doc-g", ...overrides };
}
type MutableDeep<T> = T extends readonly (infer E)[] ? MutableDeep<E>[]
  : T extends object ? { -readonly [K in keyof T]: MutableDeep<T[K]> } : T;
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

test("MRP-S4: 三层 selector 只读当前头，精确 legacyKey/对象且不携带正文或权限", () => {
  const authority = authorityFixture();
  const global = projectMemoryRead(authority, selector());
  const project = projectMemoryRead(authority, selector({ scope: "project", projectId: "project-p", agentId: null, documentId: "doc-p" }));
  const projectAgent = projectMemoryRead(authority, selector({ scope: "project-agent", projectId: "project-p", agentId: "agent-pa", documentId: "doc-pa" }));

  assert.deepEqual(Object.keys(global).sort(), ["authorityDigest", "contract", "digest", "documentId", "documentKind",
    "headVersion", "legacyKey", "object", "parentVersion", "relativePath", "selectedVersion"].sort());
  assert.equal(global.contract, "memory-read-projection-value/r1");
  assert.equal(global.authorityDigest, authority.digest);
  assert.deepEqual(global.legacyKey, { scope: "global", projectId: null, agentId: "agent-g" });
  assert.equal(global.documentKind, "note");
  assert.equal(global.documentId, "doc-g");
  assert.deepEqual([global.headVersion, global.selectedVersion, global.parentVersion], [2, 2, 1]);
  assert.deepEqual(global.object, objectRef("shared"));
  assert.equal(global.relativePath, objectPath("shared"));

  assert.deepEqual(project.legacyKey, { scope: "project", projectId: "project-p", agentId: null });
  assert.deepEqual([project.headVersion, project.selectedVersion, project.parentVersion], [1, 1, 0]);
  assert.deepEqual(project.object, objectRef("project"));
  assert.equal(project.relativePath, objectPath("project"));

  assert.deepEqual(projectAgent.legacyKey, { scope: "project-agent", projectId: "project-p", agentId: "agent-pa" });
  assert.deepEqual([projectAgent.headVersion, projectAgent.selectedVersion, projectAgent.parentVersion], [1, 1, 0]);
  assert.deepEqual(projectAgent.object, objectRef("shared"));
  assert.equal(projectAgent.relativePath, objectPath("shared"));
  assert.equal(projectAgent.documentId, "doc-pa");

  for (const output of [global, project, projectAgent]) {
    assert.equal(Object.isFrozen(output), true);
    assert.equal(Object.isFrozen(output.legacyKey), true);
    assert.equal(Object.isFrozen(output.object), true);
    assert.equal(JSON.stringify(output).includes("markdown"), false);
  }
});

test("MRP-S4: 祖先版本投影保持头与父链，重复调用同字节且 digest 可独立重算", () => {
  const authority = authorityFixture();
  const first = projectMemoryRead(authority, selector({ version: 1 }));
  const second = projectMemoryRead(authority, selector({ version: 1 }));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual([first.headVersion, first.selectedVersion, first.parentVersion], [2, 1, 0]);
  assert.deepEqual(first.object, objectRef("global-v1"));
  assert.equal(first.relativePath, objectPath("global-v1"));
  assert.equal(first.digest, digestJson({ contract: "memory-read-projection-value/r1", authorityDigest: authority.digest,
    legacyKey: { scope: "global", projectId: null, agentId: "agent-g" }, documentKind: "note", documentId: "doc-g",
    headVersion: 2, selectedVersion: 1, parentVersion: 0, object: objectRef("global-v1"), relativePath: objectPath("global-v1") }));

  const head = projectMemoryRead(authority, selector({ version: 2 }));
  assert.deepEqual(head, projectMemoryRead(authority, selector()));
  assert.equal(head.digest, projectMemoryRead(authority, selector()).digest);
});

test("MRP-S4: 严格 selector 拒绝额外字段、错误类型和 getter，不执行调用者代码", () => {
  const authority = authorityFixture();
  for (const extra of ["path", "body", "durable", "permission"]) {
    const hostile = { ...selector(), [extra]: "private" } as unknown as MemoryReadSelectorValue;
    fails(() => projectMemoryRead(authority, hostile), "invalid_value");
  }
  const invalid: unknown[] = [null, undefined, "doc-g", [], { ...selector(), scope: "workspace" },
    { ...selector(), projectId: "project-p" }, { ...selector(), agentId: null }, { ...selector(), documentKind: "summary" },
    { ...selector(), documentId: "" }, { ...selector(), version: 0 }, { ...selector(), version: 1.5 },
    { ...selector(), version: "1" }, { ...selector(), version: undefined }];
  for (const value of invalid) fails(() => projectMemoryRead(authority, value as MemoryReadSelectorValue), "invalid_value");

  let reads = 0;
  const getterField = Object.defineProperty({ ...selector() }, "permission", {
    enumerable: true, get() { reads++; return "allow"; },
  }) as unknown as MemoryReadSelectorValue;
  const getterVersion = Object.defineProperty({ ...selector() }, "documentId", {
    enumerable: true, get() { reads++; return "doc-g"; },
  }) as unknown as MemoryReadSelectorValue;
  fails(() => projectMemoryRead(authority, getterField), "invalid_value");
  fails(() => projectMemoryRead(authority, getterVersion), "invalid_value");
  assert.equal(reads, 0);
});

test("MRP-S4: scope/owner/kind/documentId 精确匹配，跨层文档与链外版本都拒绝", () => {
  const authority = authorityFixture();
  fails(() => projectMemoryRead(authority, selector({ scope: "project", projectId: "project-p", agentId: null, documentId: "doc-g" })), "value_conflict");
  fails(() => projectMemoryRead(authority, selector({ agentId: "other" })), "value_conflict");
  fails(() => projectMemoryRead(authority, selector({ documentKind: "summary" as "note" })), "invalid_value");
  fails(() => projectMemoryRead(authority, selector({ documentId: "doc-p" })), "value_conflict");
  fails(() => projectMemoryRead(authority, selector({ scope: "project-agent", projectId: "other", agentId: "agent-pa", documentId: "doc-pa" })), "value_conflict");
  fails(() => projectMemoryRead(authority, selector({ scope: "project", projectId: "project-p", agentId: "agent-pa" })), "invalid_value");
  fails(() => projectMemoryRead(authority, selector({ scope: "project-agent", projectId: "project-p", agentId: "agent-pa", documentId: "doc-g" })), "value_conflict");
  fails(() => projectMemoryRead(authority, selector({ version: 3 })), "value_conflict");
});

test("MRP-S4: authority/层/链 digest 与非本层对象引用在重封后仍被拒绝", () => {
  const authority = authorityFixture();

  const stale = freezeDeep({ ...authority, digest: "0".repeat(64) });
  fails(() => projectMemoryRead(stale, selector()), "inventory_integrity");

  const brokenLayer = mutable(structuredClone(authority));
  brokenLayer.layers[0]!.digest = "0".repeat(64);
  freezeDeep(brokenLayer);
  fails(() => projectMemoryRead(brokenLayer, selector()), "inventory_integrity");

  const brokenChain = mutable(structuredClone(authority));
  brokenChain.layers[0]!.chains[0]!.digest = "0".repeat(64);
  freezeDeep(brokenChain);
  fails(() => projectMemoryRead(brokenChain, selector()), "inventory_integrity");

  const foreignObject = mutable(structuredClone(authority));
  foreignObject.layers[0]!.chains[0]!.versions[1]!.object = structuredClone(authority.layers[1]!.objects[0]!);
  const resealedForeign = freezeDeep(resealAuthority(foreignObject));
  fails(() => projectMemoryRead(resealedForeign, selector()), "inventory_integrity");

  const extraAuthorityField = { ...structuredClone(authority), path: "/private" } as MemoryVersionAuthorityValue;
  const resealedExtra = freezeDeep(resealAuthority(extraAuthorityField) as MemoryVersionAuthorityValue & { path: string });
  fails(() => projectMemoryRead(resealedExtra, selector()), "invalid_value");

  const unfrozen = structuredClone(authority);
  fails(() => projectMemoryRead(unfrozen, selector()), "invalid_value");
});
