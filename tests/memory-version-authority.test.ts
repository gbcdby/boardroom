import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import type { LayoutMemoryInventoryValue } from "../src/server/storage/maintenance/layout-memory-inventory.ts";
import { LayoutValueError } from "../src/server/storage/maintenance/layout-values.ts";
import { buildMemoryVersionAuthority } from "../src/server/memory/version-authority.ts";

type Inventory = LayoutMemoryInventoryValue;
const storageId = "storage:1";
const at = "2026-11-23T00:00:00.000Z";
const actorId = "agent:writer";
const authorRaw = JSON.stringify({ kind: "agent", actorId, agentId: "agent-1", displayName: "Writer" });
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function objectRef(text: string): Inventory["objects"][number] {
  return { objectFormat: "utf8-sha256-v1", storageId, contentSha256: sha(text), byteLength: Buffer.byteLength(text, "utf8") };
}
function version(documentId: string, number: number, body: string, mutation: string): Inventory["versions"][number] {
  const object = objectRef(body);
  return { versionId: `version-${documentId}-${number}`, documentId, version: number, parentVersion: number - 1,
    object, relativePath: `objects/sha256/${object.contentSha256.slice(0, 2)}/${object.contentSha256}.md`,
    actorId, clientMutationId: mutation, summaryRequestId: null, authorRaw, source: "agent",
    createdAt: at, sourceRowDigest: sha(`version:${documentId}:${number}`) };
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

function reseal(value: Inventory): Inventory {
  const { inventoryDigest: _ignored, ...rest } = value;
  return { ...rest, inventoryDigest: digestJson(rest) };
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

test("MVA-S4: 三层作用域隔离，head/完整父链/对象集合互不串", () => {
  const output = buildMemoryVersionAuthority(inventoryFixture());
  assert.deepEqual(output.layers.map(layer => layer.scope), ["global", "project", "project-agent"]);
  const [global, project, projectAgent] = output.layers;
  assert.ok(global && project && projectAgent);
  assert.equal(output.inventoryDigest, inventoryFixture().inventoryDigest);
  assert.equal(output.storageId, storageId);

  assert.equal(global.heads.length, 1);
  assert.equal(global.chains.length, 1);
  assert.deepEqual(global.heads[0]!.legacyKey, { scope: "global", projectId: null, agentId: "agent-g" });
  assert.deepEqual(global.chains[0]!.versions.map(node => [node.version, node.parentVersion]), [[1, 0], [2, 1]]);
  assert.equal(global.chains[0]!.headVersionId, global.heads[0]!.version.versionId);
  assert.equal(global.heads[0]!.version.version, 2);
  assert.equal(global.heads[0]!.version.object.contentSha256, sha("shared"));
  assert.deepEqual(global.objects.map(ref => ref.contentSha256).sort(compareText), [sha("global-v1"), sha("shared")].sort(compareText));

  assert.equal(project.heads.length, 1);
  assert.equal(project.chains.length, 1);
  assert.deepEqual(project.heads[0]!.legacyKey, { scope: "project", projectId: "project-p", agentId: null });
  assert.deepEqual(project.chains[0]!.versions.map(node => [node.version, node.parentVersion]), [[1, 0]]);
  assert.deepEqual(project.objects.map(ref => ref.contentSha256), [sha("project")]);

  assert.equal(projectAgent.heads.length, 1);
  assert.equal(projectAgent.chains.length, 1);
  assert.deepEqual(projectAgent.heads[0]!.legacyKey, { scope: "project-agent", projectId: "project-p", agentId: "agent-pa" });
  assert.deepEqual(projectAgent.objects.map(ref => ref.contentSha256), [sha("shared")]);

  for (const layer of output.layers) {
    assert.ok(layer.heads.every(head => head.legacyKey.scope === layer.scope));
    assert.ok(layer.chains.every(chain => chain.legacyKey.scope === layer.scope));
    assert.equal(layer.chains.length, layer.heads.length);
  }
  assert.deepEqual(output.unreferencedObjects, []);
});

test("MVA-S4: 输出为稳定规范值，重复调用同字节且不可变", () => {
  const inventory = inventoryFixture();
  const first = buildMemoryVersionAuthority(inventory);
  const second = buildMemoryVersionAuthority(inventory);
  assert.deepEqual(first, second);
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest, digestJson({ contract: "memory-version-authority-value/r1", inventoryDigest: first.inventoryDigest,
    storageId: first.storageId, layers: first.layers, unreferencedObjects: first.unreferencedObjects }));
  const global = first.layers[0]!;
  assert.equal(global.digest, digestJson({ scope: global.scope, heads: global.heads, chains: global.chains, objects: global.objects }));
  const chain = global.chains[0]!;
  assert.equal(chain.digest, digestJson({ documentId: chain.documentId, legacyKey: chain.legacyKey,
    headVersionId: chain.headVersionId, versions: chain.versions }));

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.layers), true);
  assert.equal(Object.isFrozen(global), true);
  assert.equal(Object.isFrozen(global.heads), true);
  assert.equal(Object.isFrozen(global.chains), true);
  assert.equal(Object.isFrozen(global.objects), true);
  assert.equal(Object.isFrozen(global.heads[0]!.version), true);
  assert.equal(Object.isFrozen(chain.versions), true);
  assert.equal(Object.isFrozen(global.heads[0]!.version.object), true);
  assert.equal(Object.isFrozen(inventory), false);
  assert.equal(inventory.versions[1]!.versionId, "version-doc-g-2");
});

test("MVA-S4: 重复 ID/mutation、断链、孤儿对象与错作用域均整体拒绝", () => {
  const base = inventoryFixture();
  const duplicateId = structuredClone(base) as Inventory;
  duplicateId.versions[1]!.versionId = duplicateId.versions[0]!.versionId;
  fails(() => buildMemoryVersionAuthority(reseal(duplicateId)), "inventory_integrity");

  const duplicateMutation = structuredClone(base) as Inventory;
  duplicateMutation.versions[1]!.clientMutationId = duplicateMutation.versions[0]!.clientMutationId;
  fails(() => buildMemoryVersionAuthority(reseal(duplicateMutation)), "inventory_integrity");

  const brokenParent = structuredClone(base) as Inventory;
  brokenParent.versions[1]!.parentVersion = 0;
  fails(() => buildMemoryVersionAuthority(reseal(brokenParent)), "incomplete_inventory");

  const orphan = structuredClone(base) as Inventory;
  orphan.documents = orphan.documents.filter(document => document.documentId !== "doc-p");
  orphan.versions = orphan.versions.filter(item => item.documentId !== "doc-p");
  orphan.tables[0]!.count = String(orphan.documents.length);
  orphan.tables[1]!.count = String(orphan.versions.length);
  fails(() => buildMemoryVersionAuthority(reseal(orphan)), "inventory_integrity");

  const wrongScope = structuredClone(base) as Inventory;
  const wrongLegacyKey: unknown = { scope: "global", projectId: "project-x", agentId: "agent-g" };
  wrongScope.documents[0]!.legacyKey = wrongLegacyKey as Inventory["documents"][number]["legacyKey"];
  fails(() => buildMemoryVersionAuthority(reseal(wrongScope)), "invalid_value");
});

test("MVA-S4: getter/原型污染/预算/非法 ref 反例不执行调用者代码", () => {
  const base = inventoryFixture();
  let reads = 0;
  const hostile = { ...base } as Inventory;
  Object.defineProperty(hostile, "versions", { enumerable: true, configurable: true,
    get() { reads++; return []; } });
  fails(() => buildMemoryVersionAuthority(hostile), "invalid_value");
  assert.equal(reads, 0);

  const polluted = JSON.parse(JSON.stringify(base)) as Inventory;
  Object.defineProperty(polluted, "__proto__", { value: { injected: true }, enumerable: true, writable: true, configurable: true });
  fails(() => buildMemoryVersionAuthority(polluted), "invalid_value");
  assert.equal(Reflect.get({}, "injected"), undefined);

  const oversized = { ...base, extra: "x".repeat(32 * 1_048_576 + 1) } as unknown as Inventory;
  fails(() => buildMemoryVersionAuthority(oversized), "budget_exceeded");

  const badRef = structuredClone(base) as Inventory;
  badRef.objects[0]!.contentSha256 = badRef.objects[0]!.contentSha256.toUpperCase();
  fails(() => buildMemoryVersionAuthority(reseal(badRef)), "invalid_value");
});
