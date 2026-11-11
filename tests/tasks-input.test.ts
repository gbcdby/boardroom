import test from "node:test";
import assert from "node:assert/strict";
import { createTaskSchema, updateTaskSchema, submitReviewReportSchema, parseTaskInput } from "../src/server/tasks/schemas.ts";

test("任务入口拒绝伪造主体、直接状态与修订覆盖", () => {
  const valid = { title: "整理接口", body: "完成字段与验收说明", assigneeMemberId: "worker" };
  for (const field of ["author", "actor", "memberId", "state", "revision", "projectId"]) {
    assert.throws(() => parseTaskInput(createTaskSchema, { ...valid, [field]: "forged" }), /task_input_invalid/);
  }
  assert.throws(() => parseTaskInput(updateTaskSchema, { expectedRevision: 1, state: "done" }), /task_input_invalid/);
  assert.throws(() => parseTaskInput(updateTaskSchema, { expectedRevision: 0, title: "不应写入" }), /task_input_invalid/);
});

test("任务正文按 UTF-8 字节限制，标签标准化不改变正文", () => {
  const valid = { title: "  整理接口  ", body: "保留\n  缩进", labels: ["  API ", "API", "回归"], assigneeMemberId: "worker" };
  const task = parseTaskInput(createTaskSchema, valid);
  assert.equal(task.title, "整理接口");
  assert.equal(task.body, valid.body);
  assert.deepEqual(task.labels, ["API", "回归"]);
  assert.throws(() => parseTaskInput(createTaskSchema, { ...valid, body: "汉".repeat(22000) }), /task_input_invalid/);
});

test("评审来源需要 declared 身份、有限命令与完整候选摘要", () => {
  const evidence = { provenance: "reviewer-declared", host: "codex-cli", hostVersion: "fixture-version",
    parentRunId: "parent", invocationId: "axis-one", contextId: "context-one",
    startedAt: "2026-11-10T00:00:00Z", completedAt: "2026-11-10T00:01:00Z",
    command: { argv: ["codex", "exec"], cwd: "/repo", startedAt: "2026-11-10T00:00:00Z", completedAt: "2026-11-10T00:01:00Z", exitCode: 0 },
    promptSha256: "a".repeat(64), transcriptSha256: "b".repeat(64), evidenceRef: "fixture://declared",
    baseCommit: "c".repeat(40), candidateCommit: "d".repeat(40), diffSha256: "e".repeat(64) };
  const report = { expectedTaskRevision: 2, expectedRoundRevision: 2, axis: "spec", verdict: "pass", body: "协议测试声明", sources: ["task:snapshot"], evidence };
  assert.equal(parseTaskInput(submitReviewReportSchema, report).evidence.provenance, "reviewer-declared");
  assert.throws(() => parseTaskInput(submitReviewReportSchema, { ...report, evidence: { ...evidence, provenance: "platform-verified" } }), /task_input_invalid/);
  assert.throws(() => parseTaskInput(submitReviewReportSchema, { ...report, evidence: { ...evidence, diffSha256: "short" } }), /task_input_invalid/);
  assert.throws(() => parseTaskInput(submitReviewReportSchema, { ...report, sources: [] }), /task_input_invalid/);
});
