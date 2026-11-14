import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { inspectLocalSkillPackages, type InspectLocalSkillOptions } from "../src/server/skills/inventory.ts";
import { prepareLocalSkillSnapshot, SkillSnapshotPreparationError } from "../src/server/skills/snapshot.ts";

const repository = path.resolve(import.meta.dirname, "..");
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function capture(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function visit(directory: string, prefix = "") {
    for (const name of (await fs.readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name, file = path.join(directory, name);
      const info = await fs.lstat(file);
      if (info.isSymbolicLink()) entries[relative] = `symlink:${await fs.readlink(file)}`;
      else if (info.isDirectory()) { entries[`${relative}/`] = "directory"; await visit(file, relative); }
      else entries[relative] = hash(await fs.readFile(file));
    }
  }
  await visit(root); return entries;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "boardroom-snapshot-source-"));
  const packageRoot = path.join(root, "sample"); await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: sample\ndescription: 样例\ndisable-model-invocation: false\n---\nprivate-body-canary\n");
  await fs.writeFile(path.join(root, "AGENTS.md"), "原项目指令");
  await fs.mkdir(path.join(root, ".claude"));
  await fs.writeFile(path.join(root, ".claude/settings.json"), '{"unchanged":true}');
  const environment = await resolveBoardroomEnvironment({ cwd: root, env: { BOARDROOM_HOME: path.join(root, "planned-home") } });
  return { root, packageRoot, environment, async close() { await fs.rm(root, { recursive: true, force: true }); } };
}

async function request(f: Awaited<ReturnType<typeof fixture>>, inventory: InspectLocalSkillOptions = { packageRoots: [f.packageRoot] }) {
  const inspected = await inspectLocalSkillPackages(inventory);
  assert.deepEqual(inspected.issues, []);
  const selected = inspected.packages.find(item => item.canonicalRoot === f.packageRoot) ?? inspected.packages[0]!;
  return { environment: f.environment, inventory, expectedInventoryDigest: inspected.digest,
    selectedPackage: { canonicalRoot: selected.canonicalRoot, contentDigest: selected.contentDigest } };
}

async function preparationFailure(input: Parameters<typeof prepareLocalSkillSnapshot>[0], code: SkillSnapshotPreparationError["code"]) {
  let prepared: Awaited<ReturnType<typeof prepareLocalSkillSnapshot>>;
  try { prepared = await prepareLocalSkillSnapshot(input); }
  catch (error) {
    assert.ok(error instanceof SkillSnapshotPreparationError);
    assert.equal(error.code, code); return error;
  }
  await prepared.cleanup(); assert.fail("不应产生成功快照");
}

function injectedFailure() { return Object.assign(new Error("injected-private-error-body"), { code: "EIO" }); }

test("阶段A：临时包保留完整资源布局和摘要，源树不改、脚本不执行且不生成正式版本", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareLocalSkillSnapshot>> | undefined;
  try {
    await fs.mkdir(path.join(f.packageRoot, "assets"));
    await fs.mkdir(path.join(f.packageRoot, "empty"));
    await fs.writeFile(path.join(f.packageRoot, "assets/data.bin"), Buffer.from([0, 1, 255]));
    await fs.writeFile(path.join(f.packageRoot, "never.sh"), "#!/bin/sh\ntouch SHOULD_NOT_EXIST\n");
    const before = await capture(f.root), input = await request(f);
    prepared = await prepareLocalSkillSnapshot(input);
    assert.equal(prepared.state, "prepared-temp");
    assert.equal(prepared.versionId, null);
    assert.equal(prepared.activationAllowed, false);
    assert.equal(prepared.invocationEligible, false);
    assert.equal(prepared.sourcePackage.contentDigest, input.selectedPackage.contentDigest);
    assert.deepEqual(await capture(prepared.snapshotPath), await capture(f.packageRoot));
    assert.deepEqual(await capture(f.root), before);
    const checked = await inspectLocalSkillPackages({ packageRoots: [prepared.snapshotPath] });
    assert.deepEqual(checked.issues, []);
    assert.equal(checked.packages[0]?.contentDigest, input.selectedPackage.contentDigest);
    assert.deepEqual(checked.packages[0]?.files, prepared.sourcePackage.files);
    assert.equal(JSON.stringify(prepared).includes("private-body-canary"), false);
    assert.equal(JSON.stringify(prepared).includes("touch SHOULD_NOT_EXIST"), false);
    assert.equal((await fs.lstat(path.dirname(prepared.snapshotPath))).mode & 0o777, 0o700);
    assert.ok(Object.isFrozen(prepared.sourcePackage));
    assert.ok(Object.isFrozen(prepared.sourcePackage.files));
    assert.equal((await prepared.cleanup()).state, "removed");
    assert.equal((await prepared.cleanup()).state, "already-removed");
    await assert.rejects(fs.lstat(prepared.snapshotPath), { code: "ENOENT" });
  } finally { await prepared?.cleanup(); await f.close(); }
});

test("内部文件/目录相对链接保留为链接，目录别名后代不会被再次写入或扁平化", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareLocalSkillSnapshot>> | undefined;
  try {
    await fs.mkdir(path.join(f.packageRoot, "assets"));
    await fs.mkdir(path.join(f.packageRoot, "resources"));
    await fs.writeFile(path.join(f.packageRoot, "assets/data.bin"), Buffer.from([2, 4, 8]));
    await fs.symlink("assets/data.bin", path.join(f.packageRoot, "data.bin"));
    await fs.symlink("../assets", path.join(f.packageRoot, "resources/linked"));
    await fs.symlink("resources/linked", path.join(f.packageRoot, "linked-again"));
    const alias = path.join(f.root, "source-alias"); await fs.symlink("sample", alias);
    const before = await capture(f.root), input = await request(f, { packageRoots: [f.packageRoot, alias] });
    prepared = await prepareLocalSkillSnapshot(input);
    assert.deepEqual(await capture(prepared.snapshotPath), await capture(f.packageRoot));
    for (const relative of ["data.bin", "resources/linked", "linked-again"]) {
      assert.equal((await fs.lstat(path.join(prepared.snapshotPath, relative))).isSymbolicLink(), true);
      assert.equal(await fs.readlink(path.join(prepared.snapshotPath, relative)), await fs.readlink(path.join(f.packageRoot, relative)));
    }
    assert.equal(prepared.sourcePackage.files.find(entry => entry.path === "resources/linked/data.bin")?.sha256, hash(Buffer.from([2, 4, 8])));
    assert.deepEqual([...prepared.sourcePackage.sourceAliases].sort(), [f.packageRoot, alias].sort());
    assert.deepEqual(await capture(f.root), before);
  } finally { await prepared?.cleanup(); await f.close(); }
});

test("A01：真实 work-suite 快照保留来源清单、摘要和用户发起限制", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareLocalSkillSnapshot>> | undefined;
  try {
    const sourceRoot = path.join(repository, ".agents/skills"), before = await capture(sourceRoot);
    const inventory = { workSuites: [{ rootPath: repository, manifestPath: path.join(sourceRoot, "work-suite.json") }] };
    const inspected = await inspectLocalSkillPackages(inventory), source = inspected.packages.find(pkg => pkg.skillName === "auto")!;
    assert.deepEqual(inspected.issues, []); assert.ok(source);
    prepared = await prepareLocalSkillSnapshot({ environment: f.environment, inventory, expectedInventoryDigest: inspected.digest,
      selectedPackage: { canonicalRoot: source.canonicalRoot, contentDigest: source.contentDigest } });
    assert.deepEqual(prepared.sourcePackage, source);
    assert.equal(prepared.sourcePackage.invocationMode, "user-only");
    assert.equal(prepared.sourcePackage.manifests[0]?.verified, true);
    assert.ok(Object.isFrozen(prepared.sourcePackage.manifests[0]));
    assert.deepEqual(await capture(sourceRoot), before);
    assert.deepEqual(await capture(prepared.snapshotPath), await capture(source.canonicalRoot));
  } finally { await prepared?.cleanup(); await f.close(); }
});

test("A01：只由清单增加的 user-only 与无证据的 unknown 均不被裸目标重扫稀释", async () => {
  const f = await fixture();
  try {
    const packageRoot = path.join(f.root, ".agents/skills/sample"); await fs.mkdir(path.dirname(packageRoot), { recursive: true });
    await fs.rename(f.packageRoot, packageRoot);
    const body = await fs.readFile(path.join(packageRoot, "SKILL.md"));
    const manifestPath = path.join(f.root, "work-suite.json");
    await fs.writeFile(manifestPath, JSON.stringify({ schema_version: "work-suite/v1", suite_version: "snapshot-test", skills: [
      { name: "sample", path: ".agents/skills/sample", invocation: "explicit-user", files: [{ path: "SKILL.md", sha256: hash(body) }] }] }));
    const before = await capture(f.root), input = await request(f, { workSuites: [{ rootPath: f.root, manifestPath }] });
    const prepared = await prepareLocalSkillSnapshot(input);
    try {
      assert.equal(prepared.sourcePackage.invocationMode, "user-only");
      assert.ok(prepared.sourcePackage.invocationEvidence.includes("work-suite/v1:invocation"));
      assert.equal((await inspectLocalSkillPackages({ packageRoots: [prepared.snapshotPath] })).packages[0]?.invocationMode, "implicit-or-explicit");
      assert.equal(prepared.invocationEligible, false);
      assert.deepEqual(await capture(f.root), before);
    } finally { await prepared.cleanup(); }
    await fs.writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: sample\ndescription: 未知限制\n---\n正文\n");
    const unknown = await prepareLocalSkillSnapshot(await request(f, { packageRoots: [packageRoot] }));
    try { assert.equal(unknown.sourcePackage.invocationMode, "unknown"); assert.equal(unknown.invocationEligible, false); }
    finally { await unknown.cleanup(); }
  } finally { await f.close(); }
});

test("A03：过期 inventory、无匹配选择与复制期间源变动均不给成功句柄", async (t) => {
  const f = await fixture();
  const nativeMkdtemp = fs.mkdtemp, nativeOpen = fs.open;
  try {
    const input = await request(f);
    const stale = await preparationFailure({ ...input, expectedInventoryDigest: "0".repeat(64) }, "source_changed");
    assert.equal(stale.cleanup.state, "not-created");
    const invalid = await preparationFailure({ ...input, selectedPackage: { ...input.selectedPackage, contentDigest: "0".repeat(64) } }, "selection_invalid");
    assert.equal(invalid.cleanup.state, "not-created");
    for (const moment of ["before-read", "after-read"] as const) {
      await t.test(moment, async (child) => {
        const original = await fs.readFile(path.join(f.packageRoot, "SKILL.md")), current = await request(f);
        let arena = "", injected = false;
        child.mock.method(fs, "mkdtemp", (async (...args: Parameters<typeof fs.mkdtemp>) => {
          const created = await nativeMkdtemp(...args); arena = String(created);
          if (moment === "before-read") { injected = true; await fs.appendFile(path.join(f.packageRoot, "SKILL.md"), "变动"); }
          return created;
        }) as typeof fs.mkdtemp);
        child.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
          const handle = await nativeOpen(...args);
          if (moment === "after-read" && String(args[0]).includes("package.pending") && !injected) {
            injected = true; await fs.appendFile(path.join(f.packageRoot, "SKILL.md"), "变动");
          }
          return handle;
        });
        try {
          const error = await preparationFailure(current, "source_changed");
          assert.equal(injected, true); assert.equal(error.cleanup.state, "removed");
          await assert.rejects(fs.lstat(arena), { code: "ENOENT" });
        } finally { child.mock.restoreAll(); await fs.writeFile(path.join(f.packageRoot, "SKILL.md"), original); }
      });
    }
  } finally { await f.close(); }
});

test("A02/A04：TMPDIR 的真实父目录不可落入包、集合、suite 或保护目录，符号链接/.. 不绕过", async () => {
  const f = await fixture(), previous = process.env["TMPDIR"];
  try {
    const safe = path.join(f.root, "safe-temp"), protectedRoot = f.environment.skillsRoot;
    await fs.mkdir(safe); await fs.mkdir(protectedRoot, { recursive: true });
    const nested = path.join(f.packageRoot, "child"); await fs.mkdir(nested);
    const alias = path.join(f.root, "temp-link"); await fs.symlink(nested, alias);
    const cases = [
      { temporary: f.packageRoot, inventory: { packageRoots: [f.packageRoot] } },
      { temporary: f.root, inventory: { collectionRoots: [f.root] } },
      { temporary: protectedRoot, inventory: { packageRoots: [f.packageRoot] } },
      { temporary: `${alias}/..`, inventory: { packageRoots: [f.packageRoot] } },
    ];
    for (const entry of cases) {
      const input = await request(f, entry.inventory), before = await capture(f.root);
      process.env["TMPDIR"] = entry.temporary;
      const error = await preparationFailure(input, "temporary_root_unsafe");
      assert.equal(error.cleanup.state, "not-created"); assert.deepEqual(await capture(f.root), before);
    }
    process.env["TMPDIR"] = safe;
    const prepared = await prepareLocalSkillSnapshot(await request(f));
    try { assert.equal(path.dirname(path.dirname(prepared.snapshotPath)), await fs.realpath(safe)); }
    finally { await prepared.cleanup(); }
    const packageRoot = path.join(f.root, ".agents/skills/suite-sample"); await fs.mkdir(packageRoot, { recursive: true });
    const body = "---\nname: suite-sample\ndescription: suite\n---\n正文\n"; await fs.writeFile(path.join(packageRoot, "SKILL.md"), body);
    const manifestPath = path.join(f.root, "work-suite.json");
    await fs.writeFile(manifestPath, JSON.stringify({ schema_version: "work-suite/v1", suite_version: "test", skills: [
      { name: "suite-sample", path: ".agents/skills/suite-sample", invocation: "explicit-user", files: [{ path: "SKILL.md", sha256: hash(body) }] }] }));
    const input = await request(f, { workSuites: [{ rootPath: f.root, manifestPath }] }), before = await capture(f.root);
    const rejected = await preparationFailure(input, "temporary_root_unsafe");
    assert.equal(rejected.cleanup.state, "not-created"); assert.deepEqual(await capture(f.root), before);
  } finally { if (previous === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = previous; await f.close(); }
});

test("A04：越界链接、硬链接、特殊文件和预算拒绝发生在创建 arena 之前", async (t) => {
  const f = await fixture(), nativeMkdtemp = fs.mkdtemp;
  try {
    const input = await request(f), before = await capture(f.root);
    let creations = 0;
    t.mock.method(fs, "mkdtemp", (async (...args: Parameters<typeof fs.mkdtemp>) => { creations++; return nativeMkdtemp(...args); }) as typeof fs.mkdtemp);
    await fs.writeFile(path.join(f.root, "outside"), "不可改");
    await fs.symlink("../outside", path.join(f.packageRoot, "invalid"));
    let error = await preparationFailure(input, "inventory_invalid"); assert.equal(error.inspectionIssues[0]?.code, "path_escape");
    await fs.rm(path.join(f.packageRoot, "invalid"));
    await fs.link(path.join(f.packageRoot, "SKILL.md"), path.join(f.root, "hardlink"));
    error = await preparationFailure(input, "inventory_invalid"); assert.equal(error.inspectionIssues[0]?.code, "hardlink_unsupported");
    await fs.rm(path.join(f.root, "hardlink"));
    const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
    await promisify(execFile)("mkfifo", [path.join(f.packageRoot, "pipe")]);
    error = await preparationFailure(input, "inventory_invalid"); assert.equal(error.inspectionIssues[0]?.code, "special_file");
    await fs.rm(path.join(f.packageRoot, "pipe"));
    error = await preparationFailure({ ...input, inventory: { ...input.inventory, limits: { maxFileBytes: 1 } } }, "inventory_invalid");
    assert.equal(error.inspectionIssues[0]?.code, "budget_exceeded"); assert.equal(error.cleanup.state, "not-created");
    await fs.rm(path.join(f.root, "outside"));
    assert.equal(creations, 0); assert.deepEqual(await capture(f.root), before);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("A05：写入或 rename 失败清理本次 arena，清理失败保留位置且不泄露原始异常", async (t) => {
  const nativeOpen = fs.open, nativeRename = fs.rename, nativeRm = fs.rm, nativeMkdtemp = fs.mkdtemp;
  for (const fault of ["write", "rename", "cleanup"] as const) await t.test(fault, async (child) => {
    const f = await fixture(); let arena = "", injected = false;
    try {
      const input = await request(f), before = await capture(f.root);
      child.mock.method(fs, "mkdtemp", (async (...args: Parameters<typeof fs.mkdtemp>) => {
        const created = await nativeMkdtemp(...args); arena = String(created); return created;
      }) as typeof fs.mkdtemp);
      child.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await nativeOpen(...args);
        if (fault !== "rename" && String(args[0]).includes("package.pending")) {
          child.mock.method(handle, "writeFile", async () => { injected = true; throw injectedFailure(); });
        }
        return handle;
      });
      child.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (fault === "rename" && String(args[0]).endsWith("package.pending")) { injected = true; throw injectedFailure(); }
        return nativeRename(...args);
      });
      child.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
        if (fault === "cleanup" && String(args[0]) === arena) throw injectedFailure();
        return nativeRm(...args);
      });
      const error = await preparationFailure(input, "copy_failed"); assert.equal(injected, true);
      assert.equal(error.message.includes("injected-private-error-body"), false);
      assert.deepEqual(await capture(f.root), before);
      if (fault === "cleanup") {
        assert.deepEqual(error.cleanup, { state: "retained", path: arena, reason: "cleanup-failed" });
        assert.equal((await fs.lstat(arena)).isDirectory(), true);
      } else { assert.equal(error.cleanup.state, "removed"); await assert.rejects(fs.lstat(arena), { code: "ENOENT" }); }
    } finally { child.mock.restoreAll(); if (arena) await nativeRm(arena, { recursive: true, force: true }); await f.close(); }
  });
});

test("A05：目标缺失、额外文件或坏字节都由完整重扫拒绝", async (t) => {
  const nativeOpen = fs.open;
  for (const fault of ["missing", "extra", "corrupt"] as const) await t.test(fault, async (child) => {
    const f = await fixture(); let target = "", injected = false;
    try {
      const input = await request(f), before = await capture(f.root);
      child.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await nativeOpen(...args);
        if (String(args[0]).includes("package.pending") && !injected) {
          target = String(args[0]); const close = handle.close.bind(handle);
          child.mock.method(handle, "close", async () => {
            await close(); injected = true;
            if (fault === "missing") await fs.rm(target);
            if (fault === "extra") await fs.writeFile(path.join(path.dirname(target), "extra"), "额外");
            if (fault === "corrupt") await fs.writeFile(target, "损坏");
          });
        }
        return handle;
      });
      const error = await preparationFailure(input, "snapshot_mismatch");
      assert.equal(injected, true); assert.equal(error.cleanup.state, "removed");
      assert.deepEqual(await capture(f.root), before);
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

test("A06：并行准备各有独立 arena，重复清理不影响其他快照或替换后的未知目录", async () => {
  const f = await fixture();
  let first: Awaited<ReturnType<typeof prepareLocalSkillSnapshot>> | undefined, second: typeof first;
  let moved: string | undefined;
  try {
    const input = await request(f), before = await capture(f.root);
    [first, second] = await Promise.all([prepareLocalSkillSnapshot(input), prepareLocalSkillSnapshot(input)]);
    assert.notEqual(path.dirname(first.snapshotPath), path.dirname(second.snapshotPath));
    assert.equal((await first.cleanup()).state, "removed"); assert.equal((await first.cleanup()).state, "already-removed");
    assert.deepEqual(await capture(second.snapshotPath), await capture(f.packageRoot));
    const arena = path.dirname(second.snapshotPath); moved = `${arena}-owned-moved`;
    await fs.rename(arena, moved); await fs.mkdir(arena); await fs.writeFile(path.join(arena, "foreign"), "保持");
    assert.deepEqual(await second.cleanup(), { state: "retained", path: arena, reason: "identity-changed" });
    assert.equal(await fs.readFile(path.join(arena, "foreign"), "utf8"), "保持");
    await fs.rm(arena, { recursive: true }); await fs.rename(moved, arena); moved = undefined;
    assert.equal((await second.cleanup()).state, "removed"); assert.deepEqual(await capture(f.root), before);
  } finally { await first?.cleanup(); await second?.cleanup(); if (moved) await fs.rm(moved, { recursive: true, force: true }); await f.close(); }
});
