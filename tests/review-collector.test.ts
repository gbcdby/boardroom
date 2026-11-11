import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureReviewCandidate } from "../src/server/tasks/candidate.ts";
import { reviewEvidenceSchema } from "../src/server/tasks/schemas.ts";
import { validateReviewReport } from "../scripts/review-report.ts";
import type { ReviewReportAxis } from "../scripts/review-report.ts";

const exec = promisify(execFile);
const collector = fileURLToPath(new URL("../scripts/run-review-axes.mjs", import.meta.url));

// 仅验证采集器对合成事件/输出的处理，不调用模型，不作为真实宿主验收证据。
async function collectFixture(spec: string, standards: string, failedAxis: ReviewReportAxis | null = null) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-collector-fixture-"));
  try {
    const repo = path.join(dir, "candidate");
    await mkdir(repo);
    const git = async (...args: string[]) => (await exec("git", ["-C", repo, "-c", "user.name=Collector Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", ...args])).stdout.trim();
    await git("init", "-q");
    await writeFile(path.join(repo, "README.md"), "# Fixture base\n");
    await git("add", "."); await git("commit", "-qm", "base");
    const base = await git("rev-parse", "HEAD");
    await writeFile(path.join(repo, "README.md"), "# Fixture candidate\n");
    await git("commit", "-qam", "candidate");
    const candidate = await captureReviewCandidate({ repoPath: repo, fixedPoint: base });
    const detailPath = path.join(dir, "task.json");
    await writeFile(detailPath, JSON.stringify({ task: { id: "fixture-task", currentReviewRoundId: "fixture-round" },
      rounds: [{ id: "fixture-round", state: "running", taskRevision: 1, specSnapshot: { title: "Fixture only", body: "No model execution" }, candidate }] }));
    const fixtureCli = path.join(dir, "fixture-cli.mjs");
    await writeFile(fixtureCli, `#!/usr/bin/env node
import { writeFile, access } from "node:fs/promises";
import path from "node:path";
if (process.argv.includes("--version")) { console.log("fixture-only-no-model 1.0"); process.exit(0); }
const last = process.argv[process.argv.indexOf("--output-last-message") + 1];
const axis = path.basename(last, ".md");
const reports = ${JSON.stringify({ spec, standards })};
const event = value => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const chunk of process.stdin) { /* 消费真实脚本传入的 prompt，夹具不执行模型。 */ }
event({ type: "thread.started", thread_id: "synthetic-fixture-" + axis });
event({ type: "turn.started" });
await writeFile(last + ".fixture-started", "synthetic");
const other = path.join(path.dirname(last), (axis === "spec" ? "standards" : "spec") + ".md.fixture-started");
const deadline = Date.now() + 3000;
while (Date.now() < deadline) { if (await access(other).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
await new Promise(resolve => setTimeout(resolve, 100));
await writeFile(last, reports[axis]);
event({ type: "item.completed", item: { type: "agent_message", text: reports[axis] } });
event({ type: "turn.completed" });
if (axis === ${JSON.stringify(failedAxis)}) process.exitCode = 9;
`, { mode: 0o755 });
    let code = 0;
    const result = await exec(process.execPath, [collector, detailPath, fixtureCli], { cwd: dir, timeout: 15000 }).catch(error => {
      code = error.code; return { stdout: String(error.stdout), stderr: String(error.stderr) };
    });
    const summary = JSON.parse(result.stdout.trim());
    const evidence = JSON.parse(await readFile(path.join(summary.outputDir, "evidence.json"), "utf8"));
    const raw = await readFile(path.join(summary.outputDir, "standards.md"), "utf8");
    const transcript = await readFile(path.join(summary.outputDir, "standards.jsonl"), "utf8");
    const prompt = await readFile(path.join(summary.outputDir, "standards.prompt.md"), "utf8");
    return { code, summary, evidence, raw, transcript, prompt };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("R-NATIVE-002 夹具：220 字节半句不能成为 READY，原始输出仍保留", async () => {
  const incomplete = "The standards review has started and the candidate appears consistent, but ".padEnd(220, "x");
  assert.equal(Buffer.byteLength(incomplete), 220);
  const result = await collectFixture("PASS\nOnly a synthetic fixture, not a model review.\n", incomplete);
  assert.equal(result.evidence.independent, true);
  assert.equal(result.evidence.overlap, true);
  assert.equal(result.summary.status, "BLOCKED_OR_FAILED");
  assert.equal(result.code, 1);
  assert.equal(result.raw, incomplete);
  assert.match(result.transcript, /synthetic-fixture-standards/);
  assert.equal(result.evidence.reportComplete, false);
  assert.equal(result.evidence.results[1].modelOutputCollected, true);
  assert.equal(result.evidence.results[1].reportComplete, false);
  assert.ok(result.evidence.failureReasons.includes("standards:missing_or_ambiguous_verdict"));
});

function report(axis: ReviewReportAxis, verdict = "PASS") {
  return `Review-Axis: ${axis}\nVerdict: ${verdict}\n\n## Evidence\nREADME.md:1 与任务固定输入一致。\n\n## Risks and gaps\n未覆盖真实宿主，只验证采集器。\n\n## Checks\n此正文为测试夹具，未执行任何模型调用。\n\n<!-- review-report-complete:${axis} -->\n`;
}

test("R-NATIVE-002 格式：完整的通过和打回报告均可供 reviewer 核对", () => {
  for (const axis of ["spec", "standards"] as const) {
    for (const verdict of ["PASS", "CHANGES_REQUESTED"] as const) {
      assert.deepEqual(validateReviewReport(report(axis, verdict), axis), { reportComplete: true, verdict, errors: [] });
    }
  }
  assert.equal(validateReviewReport(report("spec").replaceAll("\n", "\r\n"), "spec").reportComplete, true);
});

test("R-NATIVE-002 格式：无结论、截断、矛盾结论、仅标记与错轴均拒绝", () => {
  const complete = report("spec");
  const cases = [
    ["missing verdict", complete.replace("Verdict: PASS\n", "")],
    ["truncated", complete.slice(0, complete.indexOf("## Checks"))],
    ["contradictory verdicts", complete.replace("Verdict: PASS", "Verdict: PASS\nVerdict: CHANGES_REQUESTED")],
    ["contradictory alternate conclusion", complete.replace("## Evidence", "结论：CHANGES_REQUESTED\n\n## Evidence")],
    ["marker only", "<!-- review-report-complete:spec -->"],
    ["empty sections", "Review-Axis: spec\nVerdict: PASS\n## Evidence\n## Risks and gaps\n## Checks\n<!-- review-report-complete:spec -->"],
    ["template only", complete.replace("README.md:1 与任务固定输入一致。", "<填写事实依据>")],
    ["wrong axis", report("standards")],
    ["text after end", complete + "Later output"],
    ["wrapped template", "```markdown\n" + complete + "```"],
    ["oversize", complete.replace("## Evidence\n", "## Evidence\n" + "x".repeat(64 * 1024))],
  ];
  for (const [name, value] of cases) {
    const result = validateReviewReport(value!, "spec");
    assert.equal(result.reportComplete, false, name);
    assert.equal(result.verdict, null, name);
    assert.ok(result.errors.length > 0, name);
  }
});

test("R-NATIVE-002 夹具：完整 CHANGES_REQUESTED 可 READY，不会冒充两轴 PASS 或提交平台", async () => {
  const result = await collectFixture(report("spec", "CHANGES_REQUESTED"), report("standards"));
  assert.equal(result.code, 0);
  assert.equal(result.summary.status, "READY_FOR_REVIEWER");
  assert.equal(result.evidence.reportComplete, true);
  assert.equal(result.evidence.results[0].reportVerdict, "CHANGES_REQUESTED");
  assert.equal(result.evidence.results[1].reportVerdict, "PASS");
  assert.equal(result.evidence.platformReportsSubmitted, false);
  assert.deepEqual(result.evidence.failureReasons, []);
  assert.match(result.prompt, /boardroom-review-report\/v1/);
  assert.match(result.prompt, /review-report-complete:standards/);
  assert.match(result.evidence.results[1].outputSha256, /^[a-f0-9]{64}$/);
  assert.equal(reviewEvidenceSchema.safeParse(result.evidence.results[0].evidence).success, true,
    "新增采集器校验字段不能污染平台 strict ReviewEvidence 输入");
});

test("R-NATIVE-002 夹具：完整正文也不能掩盖子进程失败，失败材料保留", async () => {
  const result = await collectFixture(report("spec"), report("standards"), "standards");
  assert.equal(result.code, 1);
  assert.equal(result.summary.status, "BLOCKED_OR_FAILED");
  assert.equal(result.evidence.results[1].reportComplete, true);
  assert.equal(result.evidence.results[1].modelOutputCollected, false);
  assert.equal(result.evidence.results[1].evidence.command.exitCode, 9);
  assert.ok(result.evidence.failureReasons.includes("standards:model_output_not_collected"));
  assert.equal(result.raw, report("standards"));
  assert.match(result.transcript, /turn.completed/);
});
