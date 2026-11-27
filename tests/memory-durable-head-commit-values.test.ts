import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { decideHeadCommit } from "../src/server/memory/head-commit-value.ts";
import type { MemoryHeadCommitDecisionCode } from "../src/server/memory/head-commit-value.ts";
import { parseMemoryObjectRef } from "../src/server/memory/object-ref.ts";
import {
  durableGateErrorReason, durableHeadReceipt, durableHeadValue, durableWritePlan, virtualZeroDurableHead,
} from "../src/server/memory/durable-head-commit.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const documentId = "doc-values";
const actorId = "actor:values";
const clientMutationId = "mutation-values";
const body = "# 中文耐久正文\n";
const ref = parseMemoryObjectRef({
  objectFormat: "utf8-sha256-v1", storageId: "storage:values",
  contentSha256: sha(body), byteLength: Buffer.byteLength(body, "utf8"),
});
const mutationKey = digestJson({ actorId, clientMutationId });

function headAt(dbVersion: number, contentDigest = ref.contentSha256) {
  return durableHeadValue({ documentId, dbVersion, actorId: dbVersion === 0 ? "memory-durable-virtual-zero" : actorId,
    clientMutationId: dbVersion === 0 ? "memory-durable-virtual-zero" : clientMutationId, contentSha256: contentDigest });
}
function gateInput(expectedHead: ReturnType<typeof headAt>, targetHead: ReturnType<typeof headAt>,
  durableObjectDigests: readonly string[], contentDigest = ref.contentSha256,
  currentHead: ReturnType<typeof headAt> = expectedHead) {
  const plan = durableWritePlan({ ref, mutationKey, nextVersion: targetHead.version });
  return Object.freeze({
    contract: "memory-head-commit-input/r1" as const, plan,
    durableObjectDigests: Object.freeze([...durableObjectDigests]),
    currentHead, expectedHead, targetHead,
    mutation: Object.freeze({ key: mutationKey, contentDigest }),
  });
}

test("DURABLE-VALUES: 虚拟零 head 为 version 1，receipt 严格等于约定字段摘要", () => {
  const zero = virtualZeroDurableHead(documentId);
  assert.equal(zero.version, 1);
  assert.equal(zero.contentDigest, "0".repeat(64));
  assert.equal(zero.receipt, digestJson({ documentId, dbVersion: 0,
    actorId: "memory-durable-virtual-zero", clientMutationId: "memory-durable-virtual-zero",
    contentSha256: "0".repeat(64) }));
  assert.equal(zero.receipt, durableHeadReceipt({ documentId, dbVersion: 0,
    actorId: "memory-durable-virtual-zero", clientMutationId: "memory-durable-virtual-zero",
    contentSha256: "0".repeat(64) }));
  assert.equal(zero.digest, digestJson(["memory-durable-head/r1", 1, zero.receipt, zero.mutationKey, "0".repeat(64)]));
  assert.deepEqual(virtualZeroDurableHead(documentId), zero);
  assert.equal(Object.isFrozen(zero), true);
});

test("DURABLE-VALUES: head.version = DB version + 1，receipt/digest 稳定且与来源字段绑定", () => {
  const first = headAt(1);
  assert.equal(first.version, 2);
  assert.equal(first.receipt, digestJson({ documentId, dbVersion: 1, actorId, clientMutationId, contentSha256: ref.contentSha256 }));
  assert.equal(headAt(2).version, 3);
  assert.deepEqual(headAt(1), first);
  assert.notEqual(headAt(2).receipt, first.receipt);
  assert.notEqual(virtualZeroDurableHead(documentId).receipt, first.receipt);
  assert.notEqual(headAt(1, sha("other")).digest, first.digest);
  assert.notEqual(durableHeadValue({ documentId, dbVersion: 1, actorId: "actor:other", clientMutationId,
    contentSha256: ref.contentSha256 }).receipt, first.receipt);
  assert.equal(durableHeadValue({ documentId, dbVersion: 1, actorId, clientMutationId: "mutation:other",
    contentSha256: ref.contentSha256 }).mutationKey !== first.mutationKey, true);
});

test("DURABLE-VALUES: 单对象 plan 自洽，authorityDigest 标记为非权威派生", () => {
  const target = headAt(1);
  const plan = durableWritePlan({ ref, mutationKey, nextVersion: target.version });
  const key = `objects/sha256/${ref.contentSha256.slice(0, 2)}/${ref.contentSha256}.md`;
  assert.deepEqual(plan.objects, [Object.freeze({
    relativePath: key, refDigest: digestJson(ref), byteLength: ref.byteLength, objectDigest: ref.contentSha256,
  })]);
  assert.equal(plan.authorityDigest, digestJson(["memory-durable-write-plan/r1", key, mutationKey, target.version]));
  assert.equal(plan.digest, digestJson({ contract: "memory-publication-plan-value/r1",
    authorityDigest: plan.authorityDigest, objects: plan.objects }));
  assert.equal(Object.isFrozen(plan), true);
  const decision = decideHeadCommit(gateInput(virtualZeroDurableHead(documentId), target, [ref.contentSha256]));
  assert.equal(decision.outcome, "commit-allowed");
  assert.deepEqual(decision.head, target);
});

test("DURABLE-VALUES: 相同 head 重放返回 already-committed 且不改变 head", () => {
  const target = headAt(1);
  const decision = decideHeadCommit(gateInput(target, target, [ref.contentSha256]));
  assert.equal(decision.outcome, "already-committed");
  if (decision.outcome !== "already-committed") return;
  assert.deepEqual(decision.head, target);
  assert.equal(decision.digest, digestJson({ contract: "memory-head-commit-decision/r1", outcome: "already-committed",
    head: target, objectDigests: [ref.contentSha256], mutation: { key: mutationKey, contentDigest: ref.contentSha256 },
    planDigest: durableWritePlan({ ref, mutationKey, nextVersion: target.version }).digest }));
});

test("DURABLE-VALUES: 门禁四类拒绝码与稳定错误原因一一映射", () => {
  const zero = virtualZeroDurableHead(documentId);
  const target = headAt(1);
  const stale = headAt(3);
  const wrongReceipt = Object.freeze({ ...zero, receipt: sha("wrong-receipt") });
  const outside = gateInput(zero, headAt(1, sha("计划外正文")), [ref.contentSha256], sha("计划外正文"));
  const cases: Array<[string, MemoryHeadCommitDecisionCode]> = [
    ["stale expectedHead", "head_conflict"],
    ["wrong receipt", "receipt_mismatch"],
    ["missing durableObjectDigests", "incomplete_durability"],
    ["plan outside body", "incomplete_durability"],
  ];
  const inputs = [
    gateInput(stale, target, [ref.contentSha256], ref.contentSha256, zero),
    gateInput(wrongReceipt, target, [ref.contentSha256], ref.contentSha256, zero),
    gateInput(zero, target, []),
    outside,
  ];
  cases.forEach(([label, code], index) => {
    const decision = decideHeadCommit(inputs[index]!);
    assert.equal(decision.outcome, "rejected", label);
    if (decision.outcome !== "rejected") return;
    assert.equal(decision.code, code, label);
    const reason = durableGateErrorReason(decision.code);
    assert.equal(reason, {
      head_conflict: "memory_version_conflict",
      receipt_mismatch: "memory_receipt_mismatch",
      incomplete_durability: "memory_durable_gate_incomplete",
      mutation_conflict: "memory_mutation_conflict",
    }[code]);
    assert.equal(decision.digest, digestJson({ contract: "memory-head-commit-decision/r1", outcome: "rejected",
      code, mutation: { key: mutationKey, contentDigest: inputs[index]!.mutation.contentDigest },
      planDigest: inputs[index]!.plan.digest }));
  });
});
