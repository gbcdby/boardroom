import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink, rename, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { inspectWorkspaceRoot, revalidateWorkspaceRoot } from "../src/server/workspace/preflight.ts";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-workspace-path-"));
  const cwd = path.join(dir, "server"), root = path.join(dir, "source");
  await mkdir(cwd); await mkdir(root);
  const environment = await resolveBoardroomEnvironment({ cwd, env: { BOARDROOM_HOME: path.join(dir, "home") } });
  return { dir, root, environment, close: () => rm(dir, { recursive: true, force: true }) };
}

test("S3 预检：讨论目录、现有目录与符号链接共享真实根身份，缺失目录不创建", async () => {
  const f = await fixture();
  try {
    const discussion = await inspectWorkspaceRoot(null, f.environment);
    assert.equal(discussion.rootPath, null); assert.equal(discussion.rootIdentity, null);
    assert.equal(discussion.runReady, false);
    const plain = await inspectWorkspaceRoot(f.root, f.environment);
    assert.equal(plain.repositoryInfo?.kind, "not_git"); assert.equal(plain.requiresRevalidation, true);
    await symlink(f.root, path.join(f.dir, "alias"));
    const alias = await inspectWorkspaceRoot(path.join(f.dir, "alias"), f.environment);
    assert.equal(alias.canonicalRoot, plain.canonicalRoot);
    assert.equal(alias.physicalResourceKey, plain.physicalResourceKey);
    assert.notEqual(alias.rootPath, plain.rootPath);
    const before = await readdir(f.dir);
    await assert.rejects(inspectWorkspaceRoot("relative", f.environment), { code: "invalid_argument", reason: "path_not_absolute", field: "rootPath" });
    await assert.rejects(inspectWorkspaceRoot(path.join(f.dir, "missing"), f.environment), { reason: "path_missing" });
    assert.deepEqual(await readdir(f.dir), before);
  } finally { await f.close(); }
});

test("S3 预检：受保护根、其父子路径及别名均拒绝，普通工作区与 Skills 不改动", async () => {
  const f = await fixture();
  try {
    await mkdir(f.environment.skillsRoot, { recursive: true });
    await symlink(f.environment.skillsRoot, path.join(f.dir, "protected-alias"));
    for (const root of [f.environment.skillsRoot, path.join(f.dir, "home"), path.join(f.dir, "protected-alias")]) {
      await assert.rejects(inspectWorkspaceRoot(root, f.environment), { reason: "protected_path" });
    }
    await mkdir(path.join(f.root, "skills")); await writeFile(path.join(f.root, "AGENTS.md"), "原始规范\n");
    await writeFile(path.join(f.root, "skills/SKILL.md"), "原技能\n");
    const before = await readdir(f.root);
    await inspectWorkspaceRoot(f.root, f.environment);
    assert.deepEqual(await readdir(f.root), before);
    assert.equal(await readFile(path.join(f.root, "skills/SKILL.md"), "utf8"), "原技能\n");
    const blocked = path.join(f.dir, "unreadable"); await mkdir(blocked); await chmod(blocked, 0);
    try { if (process.getuid?.() !== 0) await assert.rejects(inspectWorkspaceRoot(blocked, f.environment), { reason: "path_inaccessible" }); }
    finally { await chmod(blocked, 0o700); }
  } finally { await f.close(); }
});

test("S3 预检：原路径被替换或符号链接换根返回 workspace_changed", async () => {
  const f = await fixture();
  try {
    const original = await inspectWorkspaceRoot(f.root, f.environment);
    await rename(f.root, path.join(f.dir, "old-source")); await mkdir(f.root);
    await assert.rejects(revalidateWorkspaceRoot(original, f.environment), { reason: "workspace_changed" });
    const alias = path.join(f.dir, "link"); await symlink(f.root, alias);
    const linked = await inspectWorkspaceRoot(alias, f.environment);
    await rm(alias); await symlink(path.join(f.dir, "old-source"), alias);
    await assert.rejects(revalidateWorkspaceRoot(linked, f.environment), { reason: "workspace_changed" });
  } finally { await f.close(); }
});

test("S3 Git 只读观察：脏文件、未跟踪文件与 index 保持原字节；不执行 filters/fsmonitor/hooks", async () => {
  const f = await fixture();
  const git = (...args: string[]) => { const result = spawnSync("git", args, { cwd: f.root, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  try {
    git("init", "-q"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
    await writeFile(path.join(f.root, "tracked.txt"), "before\n"); git("add", "tracked.txt"); git("commit", "-qm", "fixture");
    const clean = await inspectWorkspaceRoot(f.root, f.environment);
    assert.equal(clean.repositoryInfo?.kind, "git"); assert.equal(clean.repositoryInfo?.dirty, false);
    const marker = path.join(f.root, "EXECUTED");
    const hook = path.join(f.root, "unsafe.sh"); await writeFile(hook, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`); await chmod(hook, 0o755);
    git("config", "filter.probe.clean", hook); git("config", "filter.probe.required", "true"); git("config", "core.fsmonitor", hook);
    await writeFile(path.join(f.root, ".gitattributes"), "*.txt filter=probe\n");
    await writeFile(path.join(f.root, "tracked.txt"), "after\n"); await writeFile(path.join(f.root, "untracked.txt"), "keep\n");
    const indexBefore = await readFile(path.join(f.root, ".git/index"));
    const observed = await inspectWorkspaceRoot(f.root, f.environment);
    assert.equal(observed.repositoryInfo?.kind, "git"); assert.equal(observed.repositoryInfo?.dirty, true);
    assert.equal(observed.repositoryInfo?.comparison, "raw_bytes_no_filters");
    assert.ok((observed.repositoryInfo?.untrackedCount ?? 0) > 0);
    assert.equal((await readdir(f.root)).includes("EXECUTED"), false);
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")), indexBefore);
    assert.equal(await readFile(path.join(f.root, "tracked.txt"), "utf8"), "after\n");
    assert.equal(await readFile(path.join(f.root, "untracked.txt"), "utf8"), "keep\n");
  } finally { await f.close(); }
});
