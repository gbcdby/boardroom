import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureReviewCandidate } from "../src/server/tasks/candidate.ts";

const exec = promisify(execFile);
async function git(dir: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", dir, "-c", "user.name=Candidate Test", "-c", "user.email=candidate@example.invalid", ...args])).stdout.trim();
}
async function fixture(fn: (dir: string, base: string, head: string) => Promise<void>, format = "sha1") {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-review-candidate-"));
  try {
    await git(dir, "init", "-q", `--object-format=${format}`);
    await writeFile(path.join(dir, "README.md"), "# 基础\n");
    await git(dir, "add", "."); await git(dir, "commit", "-qm", "base");
    const base = await git(dir, "rev-parse", "HEAD");
    await writeFile(path.join(dir, "README.md"), "# 基础\n\n已完成的任务\n");
    await git(dir, "commit", "-qam", "candidate");
    await fn(dir, base, await git(dir, "rev-parse", "HEAD"));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("AC-REVIEW-01：真实提交候选包含固定 diff、commit 与命令证据", async () => {
  await fixture(async (dir, base, head) => {
    const packet = await captureReviewCandidate({ repoPath: dir, fixedPoint: base });
    assert.equal(packet.baseCommit, base); assert.equal(packet.candidateCommit, head);
    assert.equal(packet.policy, "committed-clean");
    assert.match(packet.diff, /已完成的任务/);
    assert.equal(packet.commits[0]?.sha, head);
    assert.match(packet.diffSha256, /^[a-f0-9]{64}$/);
    assert.ok(packet.commands.every(command => command.exitCode === 0));
  });
});

test("AC-REVIEW-01：无效 ref、空 diff 与 dirty 候选分别拒绝", async () => {
  await fixture(async (dir, _base, head) => {
    await assert.rejects(captureReviewCandidate({ repoPath: dir, fixedPoint: "--malicious-option" }), { reason: "review_invalid_ref" });
    await assert.rejects(captureReviewCandidate({ repoPath: dir, fixedPoint: head }), { reason: "review_empty_diff" });
    await writeFile(path.join(dir, "README.md"), "uncommitted");
    await assert.rejects(captureReviewCandidate({ repoPath: dir, fixedPoint: "HEAD~1" }), { reason: "review_dirty_worktree" });
    await git(dir, "add", "README.md");
    await assert.rejects(captureReviewCandidate({ repoPath: dir, fixedPoint: "HEAD~1" }), { reason: "review_dirty_worktree" });
  });
  await fixture(async (dir, base) => {
    await writeFile(path.join(dir, "new.txt"), "untracked");
    await assert.rejects(captureReviewCandidate({ repoPath: dir, fixedPoint: base }), { reason: "review_dirty_worktree" });
  });
});

test("Git canary：clean/process、fsmonitor、external diff、textconv 均不执行，含仅 mtime 改变", async () => {
  await fixture(async (dir, base) => {
    await writeFile(path.join(dir, ".gitattributes"), "*.md filter=probe diff=probe\n");
    await git(dir, "add", ".gitattributes"); await git(dir, "commit", "-qm", "attributes");
    const marker = path.join(dir, ".git", "probe-executed");
    const script = path.join(dir, ".git", "probe.sh");
    await writeFile(script, `#!/bin/sh\nprintf bad > '${marker}'\ncat\n`);
    for (const key of ["filter.probe.clean", "filter.probe.process", "diff.probe.command", "diff.probe.textconv", "diff.external", "core.fsmonitor"]) {
      await git(dir, "config", key, `sh '${script}'`);
    }
    const future = new Date(Date.now() + 10000);
    await utimes(path.join(dir, "README.md"), future, future);
    const result = await captureReviewCandidate({ repoPath: dir, fixedPoint: base });
    assert.match(result.diff, /attributes|gitattributes/);
    await assert.rejects(access(marker), { code: "ENOENT" });
  });
});

test("真实 SHA-256 对象仓库可采集，skip-worktree 明确拒绝", async () => {
  await fixture(async (dir, base, head) => {
    const packet = await captureReviewCandidate({ repoPath: dir, fixedPoint: base });
    assert.equal(packet.candidateCommit, head); assert.equal(head.length, 64);
    await git(dir, "update-index", "--skip-worktree", "README.md");
    await assert.rejects(captureReviewCandidate({ repoPath: dir, fixedPoint: base }), { reason: "review_unsupported_worktree" });
  }, "sha256");
});

test("候选限额不截断通过；强制文本 diff 的无效 UTF-8 明确拒绝", async () => {
  await fixture(async (dir, base) => {
    await writeFile(path.join(dir, "README.md"), "x".repeat(2 * 1024 * 1024 + 100));
    await git(dir, "commit", "-qam", "large diff");
    await assert.rejects(captureReviewCandidate({ repoPath: dir, fixedPoint: base }), { reason: "review_capture_too_large" });
  });
  await fixture(async (dir, base) => {
    await writeFile(path.join(dir, ".gitattributes"), "README.md diff\n");
    await writeFile(path.join(dir, "README.md"), Buffer.from([0x80, 0x0a]));
    await git(dir, "add", "."); await git(dir, "commit", "-qm", "non utf8 forced text");
    await assert.rejects(captureReviewCandidate({ repoPath: dir, fixedPoint: base }), { reason: "review_unsupported_diff" });
  });
});
