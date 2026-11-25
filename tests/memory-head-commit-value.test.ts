import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson, digestJson } from "../src/server/storage/maintenance/canonical.ts";
import type { LayoutMemoryInventoryValue } from "../src/server/storage/maintenance/layout-memory-inventory.ts";
import { LayoutValueError } from "../src/server/storage/maintenance/layout-values.ts";
import { decideHeadCommit } from "../src/server/memory/head-commit-value.ts";
import type {
  ErrorCode, MemoryHeadCommitDecisionCode, MemoryHeadCommitDecisionValue, MemoryHeadCommitHeadValue,
  MemoryHeadCommitInputValue, MemoryHeadCommitMutationValue,
} from "../src/server/memory/head-commit-value.ts";
import { buildMemoryPublicationPlan } from "../src/server/memory/publication-plan.ts";
import type { MemoryPublicationPlanValue } from "../src/server/memory/publication-plan.ts";
import { buildMemoryVersionAuthority } from "../src/server/memory/version-authority.ts";

type MutableRecord = Record<string, unknown>;
type Inventory = LayoutMemoryInventoryValue;
type MutableDeep<T> = T extends readonly (infer E)[] ? MutableDeep<E>[]
  : T extends object ? { -readonly [K in keyof T]: MutableDeep<T[K]> } : T;

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const storageId = "storage:1";
const at = "2026-11-25T00:00:00.000Z";
const authorRaw = JSON.stringify({ kind: "agent", actorId: "agent:writer", agentId: "agent-1", displayName: "Writer" });
const objectPath = (digest: string) => `objects/sha256/${digest.slice(0, 2)}/${digest}.md`;
const compared = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

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
function clone<T>(value: T): MutableDeep<T> { return structuredClone(value) as MutableDeep<T>; }
function reseal(value: MutableRecord): MemoryHeadCommitInputValue { return freezeDeep(value) as unknown as MemoryHeadCommitInputValue; }
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
function assertFrozen(value: unknown): void {
  assert.equal(Object.isFrozen(value), true);
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value as Record<string, unknown>)) assertFrozen(child);
}
function assertDecision(value: MemoryHeadCommitDecisionValue): void {
  const { digest: _ignored, ...body } = value;
  assert.equal(value.digest, digestJson(body));
  assertFrozen(value);
}

function planFixture(bodies: readonly string[]): Readonly<MemoryPublicationPlanValue> {
  const objects = Object.freeze(bodies.map(body => Object.freeze({
    relativePath: objectPath(sha(body)), refDigest: sha(`ref:${body}`),
    byteLength: Buffer.byteLength(body, "utf8"), objectDigest: sha(body),
  })));
  const payload = { contract: "memory-publication-plan-value/r1", authorityDigest: sha("authority-fixture"), objects };
  return Object.freeze({ ...payload, digest: digestJson(payload) }) as Readonly<MemoryPublicationPlanValue>;
}
function head(version: number, seed: string, mutationKey: string, contentDigest: string): Readonly<MemoryHeadCommitHeadValue> {
  return Object.freeze({ version, receipt: sha(`receipt:${seed}`), digest: sha(`head:${seed}`), mutationKey, contentDigest });
}
function mutation(key: string, contentDigest: string): Readonly<MemoryHeadCommitMutationValue> {
  return Object.freeze({ key, contentDigest });
}
function inputFixture(overrides: Partial<MemoryHeadCommitInputValue> = {}): Readonly<MemoryHeadCommitInputValue> {
  const plan = planFixture(["secret-body-a", "secret-body-b"]);
  const contentDigest = sha("secret-body-a");
  const expectedHead = head(1, "v1", "mutation-1", contentDigest);
  return Object.freeze({
    contract: "memory-head-commit-input/r1", plan,
    durableObjectDigests: Object.freeze(plan.objects.map(item => item.objectDigest)),
    currentHead: expectedHead, expectedHead,
    targetHead: head(2, "v2", "mutation-1", contentDigest),
    mutation: mutation("mutation-1", contentDigest), ...overrides,
  }) as Readonly<MemoryHeadCommitInputValue>;
}
function rejects(input: Readonly<MemoryHeadCommitInputValue>, code: MemoryHeadCommitDecisionCode): void {
  const decision = decideHeadCommit(input);
  assert.equal(decision.outcome, "rejected");
  if (decision.outcome !== "rejected") return;
  assert.equal(decision.code, code);
  assertDecision(decision);
}
function realPlanFixture(): Readonly<MemoryPublicationPlanValue> {
  const body = "secret-body-a";
  const object = { objectFormat: "utf8-sha256-v1" as const, storageId, contentSha256: sha(body), byteLength: Buffer.byteLength(body, "utf8") };
  const version = { versionId: "version-1", documentId: "document-1", version: 1, parentVersion: 0, object,
    relativePath: objectPath(object.contentSha256), actorId: "agent:writer", clientMutationId: "mutation-1",
    summaryRequestId: null, authorRaw, source: "agent" as const, createdAt: at, sourceRowDigest: sha("row:version-1") };
  const documents = [{ documentId: "document-1", legacyKey: { scope: "global" as const, projectId: null, agentId: "agent-1" },
    documentKind: "note" as const, currentVersion: 1, updatedAt: at, updatedByRaw: authorRaw,
    source: "agent" as const, sourceRowDigest: sha("row:document-1") }];
  const payload = {
    contract: "layout-memory-inventory-value/r1" as const,
    source: { kind: "sqlite" as const, databaseInstanceId: "a".repeat(32), identityDigest: "b".repeat(64) },
    frozenManifest: { ref: "frozen/memory", sha256: "c".repeat(64), bytes: "1" }, storageId,
    tables: [{ name: "memory_documents", count: "1", digest: "a".repeat(64) },
      { name: "memory_versions", count: "1", digest: "b".repeat(64) },
      { name: "memory_summary_requests", count: "0", digest: "c".repeat(64) }],
    documents, versions: [version], objects: [object],
    totalVersionBodyBytes: String(Buffer.byteLength(body)), uniqueObjectBodyBytes: String(Buffer.byteLength(body)),
  };
  const inventory = { ...payload, inventoryDigest: digestJson(payload) } as unknown as Inventory;
  return buildMemoryPublicationPlan(buildMemoryVersionAuthority(inventory));
}

test("HEADCOMMIT-S4-T3: 全部对象耐久且 CAS 成立时允许 head 前进", () => {
  const input = inputFixture();
  const decision = decideHeadCommit(input);
  assert.equal(decision.outcome, "commit-allowed");
  assert.equal(decision.contract, "memory-head-commit-decision/r1");
  if (decision.outcome !== "commit-allowed") return;
  assert.deepEqual(decision.head, input.targetHead);
  assert.deepEqual(decision.objectDigests, [sha("secret-body-b"), sha("secret-body-a")]);
  assert.deepEqual(decideHeadCommit(input), decision);
  assertDecision(decision);
  assert.equal(canonicalJson(decision).includes("secret-body"), false);
});

test("HEADCOMMIT-S4-T3: 真实发布计划可直接作为一致性输入", () => {
  const plan = realPlanFixture();
  const input = inputFixture({ plan, durableObjectDigests: Object.freeze(plan.objects.map(item => item.objectDigest)) });
  const decision = decideHeadCommit(input);
  assert.equal(decision.outcome, "commit-allowed");
  if (decision.outcome !== "commit-allowed") return;
  assert.deepEqual(decision.objectDigests, plan.objects.map(item => item.objectDigest));
  assertDecision(decision);
});

test("HEADCOMMIT-S4-T3: 缺任一对象或发布半途失败均拒绝，head 不领先耐久正文", () => {
  const plan = planFixture(["secret-body-a", "secret-body-b"]);
  const contentDigest = sha("secret-body-a");
  const shared = { plan, durableObjectDigests: Object.freeze([sha("secret-body-a")]) };
  const input = inputFixture(shared);
  rejects(input, "incomplete_durability");

  const reversed = inputFixture({ ...shared, durableObjectDigests: Object.freeze([sha("secret-body-b")]) });
  rejects(reversed, "incomplete_durability");
  assert.equal(contentDigest, sha("secret-body-a"));
});

test("HEADCOMMIT-S4-T3: 当前 head 与预期不符（CAS 冲突）拒绝", () => {
  const input = inputFixture();
  const stale = head(1, "stale", "mutation-1", sha("secret-body-a"));
  rejects(inputFixture({ currentHead: stale }), "head_conflict");
  rejects(inputFixture({ targetHead: head(3, "v3", "mutation-1", sha("secret-body-a")) }), "head_conflict");
  rejects(inputFixture({ targetHead: Object.freeze({ ...input.targetHead, receipt: input.expectedHead.receipt }) }), "head_conflict");
});

test("HEADCOMMIT-S4-T3: 当前 head 的版本/正文相同但 receipt 不同则拒绝", () => {
  const input = inputFixture();
  const wrongReceipt = Object.freeze({ ...input.expectedHead, receipt: sha("receipt:wrong") });
  rejects(inputFixture({ currentHead: wrongReceipt }), "receipt_mismatch");
});

test("HEADCOMMIT-S4-T3: 同 mutation 同内容重复提交明确 already-committed", () => {
  const input = inputFixture();
  const repeated = inputFixture({ currentHead: input.targetHead });
  const decision = decideHeadCommit(repeated);
  assert.equal(decision.outcome, "already-committed");
  if (decision.outcome !== "already-committed") return;
  assert.deepEqual(decision.head, input.targetHead);
  assertDecision(decision);
  rejects(inputFixture({ currentHead: input.targetHead,
    durableObjectDigests: Object.freeze([sha("secret-body-a")]) }), "incomplete_durability");
});

test("HEADCOMMIT-S4-T3: 同 mutation 异内容拒绝，计划外正文按 incomplete_durability 拒绝", () => {
  const changed = sha("secret-body-changed");
  rejects(inputFixture({ mutation: mutation("mutation-1", changed) }), "mutation_conflict");
  rejects(inputFixture({ targetHead: head(2, "v2-changed", "mutation-1", changed),
    mutation: mutation("mutation-1", changed) }), "incomplete_durability");
});

test("HEADCOMMIT-S4-T3: target 正文不在计划内时拒绝（含 mutation 绕开与 already-committed）", () => {
  const outside = sha("secret-body-outside");
  const durable = Object.freeze(["secret-body-a", "secret-body-b"].map(sha));
  const oldHead = head(1, "v1-old", "old-key", sha("secret-body-a"));
  const outsideTarget = head(2, "v2-outside", "new-key", outside);
  const bypass = inputFixture({ currentHead: oldHead, expectedHead: oldHead, targetHead: outsideTarget,
    mutation: mutation("new-key", outside), durableObjectDigests: durable });
  rejects(bypass, "incomplete_durability");
  rejects(inputFixture({ currentHead: outsideTarget, expectedHead: oldHead, targetHead: outsideTarget,
    mutation: mutation("new-key", outside), durableObjectDigests: durable }), "incomplete_durability");
});

test("HEADCOMMIT-S4-T3: 空对象计划与空耐久证据拒绝 head 前进", () => {
  const emptyPlan = planFixture([]);
  const base = inputFixture();
  rejects(inputFixture({ plan: emptyPlan, durableObjectDigests: Object.freeze([]) }), "incomplete_durability");
  rejects(inputFixture({ plan: emptyPlan, durableObjectDigests: Object.freeze([]), currentHead: base.targetHead }),
    "incomplete_durability");
});

test("HEADCOMMIT-S4-T3: 外层冻结、原型洁净与 descriptor-only 校验拒绝恶意输入", () => {
  const base = inputFixture();
  const before = canonicalJson(base);

  const wrongContract = clone(base);
  (wrongContract as MutableRecord)["contract"] = "memory-head-commit-input/r2";
  fails(() => decideHeadCommit(reseal(wrongContract)), "unsupported_shape");
  const extra = clone(base);
  (extra as MutableRecord)["path"] = "/private";
  fails(() => decideHeadCommit(reseal(extra)), "invalid_value");
  const missing = clone(base);
  delete (missing as MutableRecord)["mutation"];
  fails(() => decideHeadCommit(reseal(missing)), "invalid_value");
  fails(() => decideHeadCommit(clone(base) as unknown as MemoryHeadCommitInputValue), "invalid_value");

  let reads = 0;
  const getterHostile = clone(base);
  Object.defineProperty(getterHostile, "durableObjectDigests", { enumerable: true, configurable: true,
    get() { reads++; return base.durableObjectDigests; } });
  fails(() => decideHeadCommit(Object.freeze(getterHostile) as unknown as MemoryHeadCommitInputValue), "invalid_value");
  assert.equal(reads, 0);

  const nestedGetterHostile = clone(base);
  Object.defineProperty(nestedGetterHostile["targetHead"] as MutableRecord, "receipt", { enumerable: true, configurable: true,
    get() { reads++; return base.targetHead.receipt; } });
  fails(() => decideHeadCommit(reseal(nestedGetterHostile)), "invalid_value");
  assert.equal(reads, 0);

  const polluted = clone(base);
  Object.defineProperty(polluted, "__proto__", { value: { injected: true }, enumerable: true, writable: true, configurable: true });
  fails(() => decideHeadCommit(reseal(polluted)), "invalid_value");
  assert.equal(Reflect.get({}, "injected"), undefined);

  const symbolKey = Symbol("injected");
  const withSymbol = clone(base);
  Object.defineProperty(withSymbol, symbolKey, { value: "private", enumerable: true, configurable: true });
  fails(() => decideHeadCommit(reseal(withSymbol)), "invalid_value");

  const bigInt = clone(base);
  ((bigInt["targetHead"] as MutableRecord)["version"] as unknown) = 1n;
  fails(() => decideHeadCommit(reseal(bigInt)), "invalid_value");

  let traps = 0;
  const hostileHead = new Proxy(base.currentHead as object, {
    getPrototypeOf() { traps++; throw new Error("hostile getPrototypeOf"); },
  });
  fails(() => decideHeadCommit(Object.freeze({ ...base, currentHead: hostileHead }) as MemoryHeadCommitInputValue), "invalid_value");
  assert.equal(traps > 0, true);
  assert.equal(canonicalJson(base), before);
});

test("HEADCOMMIT-S4-T3: 计划摘要、证据集合与头字段异常均受控拒绝", () => {
  const base = inputFixture();
  const stalePlan = clone(base);
  (stalePlan["plan"] as MutableRecord)["digest"] = sha("stale-plan");
  fails(() => decideHeadCommit(reseal(stalePlan)), "inventory_integrity");

  const duplicateEvidence = inputFixture({ durableObjectDigests: Object.freeze([sha("secret-body-a"), sha("secret-body-a")]) });
  fails(() => decideHeadCommit(duplicateEvidence), "inventory_integrity");

  const badHash = clone(base);
  (badHash["durableObjectDigests"] as unknown[])[0] = "not-a-digest";
  fails(() => decideHeadCommit(reseal(badHash)), "invalid_value");

  const badVersion = clone(base);
  (badVersion["expectedHead"] as MutableRecord)["version"] = 0;
  fails(() => decideHeadCommit(reseal(badVersion)), "inventory_integrity");

  const oversizedKey = clone(base);
  (oversizedKey["mutation"] as MutableRecord)["key"] = "x".repeat(4097);
  fails(() => decideHeadCommit(reseal(oversizedKey)), "inventory_integrity");

  assert.equal(decideHeadCommit(base).outcome, "commit-allowed");
});

test("HEADCOMMIT-S4-T3: 对象集合按摘要排序不依赖插入顺序，错误码集合保持固定", () => {
  const plan = planFixture(["secret-body-a", "secret-body-b"]);
  const input = inputFixture({ plan,
    durableObjectDigests: Object.freeze([sha("secret-body-a"), sha("secret-body-b")]) });
  const decision = decideHeadCommit(input);
  assert.equal(decision.outcome, "commit-allowed");
  if (decision.outcome !== "commit-allowed") return;
  assert.deepEqual(decision.objectDigests, [sha("secret-body-b"), sha("secret-body-a")]);
  const codes: readonly MemoryHeadCommitDecisionCode[] =
    ["incomplete_durability", "head_conflict", "mutation_conflict", "receipt_mismatch"];
  assert.deepEqual([...codes].sort(compared), ["head_conflict", "incomplete_durability", "mutation_conflict", "receipt_mismatch"]);
});

test("HEADCOMMIT-S4-T3: 预算与深度上限与 authority-envelope 一致（32MiB/250k/128）", () => {
  const base = inputFixture();

  const oversized = clone(base);
  (oversized["mutation"] as MutableRecord)["key"] = "x".repeat(32 * 1_048_576 + 1);
  fails(() => decideHeadCommit(reseal(oversized)), "budget_exceeded", "32MiB");

  const tooManyNodes = clone(base);
  (tooManyNodes as MutableRecord)["durableObjectDigests"] =
    Object.freeze(Array.from({ length: 250_000 }, () => null)) as unknown as readonly string[];
  fails(() => decideHeadCommit(reseal(tooManyNodes)), "budget_exceeded", "250k");

  let deep: unknown = Object.freeze({ leaf: true });
  for (let index = 0; index < 200; index++) deep = Object.freeze({ child: deep });
  const tooDeep = clone(base);
  (tooDeep as MutableRecord)["targetHead"] = deep as MemoryHeadCommitHeadValue;
  fails(() => decideHeadCommit(reseal(tooDeep)), "budget_exceeded", "128");

  assert.equal(decideHeadCommit(base).outcome, "commit-allowed");
});
