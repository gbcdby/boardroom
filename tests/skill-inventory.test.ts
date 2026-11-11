import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, lstat, readlink, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectLocalSkillPackages } from "../src/server/skills/inventory.ts";

const root = path.resolve(import.meta.dirname, "..");
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
async function capture(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(at: string, rel: string) {
    for (const name of (await readdir(at)).sort()) {
      const file = path.join(at, name), key = rel ? `${rel}/${name}` : name, stat = await lstat(file);
      if (stat.isSymbolicLink()) result[key] = `link:${await readlink(file)}`;
      else if (stat.isDirectory()) { result[`${key}/`] = "directory"; await walk(file, key); }
      else result[key] = hash(await readFile(file));
    }
  }
  await walk(dir, ""); return result;
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-skill-"));
  return { dir, async package(name = "sample", header = "", body = "正文") {
    const p = path.join(dir, name); await mkdir(p, { recursive: true });
    await writeFile(path.join(p, "SKILL.md"), `---\nname: ${name}\ndescription: 测试技能\n${header}---\n${body}\n`);
    return p;
  }, async close() { await rm(dir, { recursive: true, force: true }); } };
}

test("真实 work-suite 的 20 包逐文件核对，别名只扫描一次，调用限制和源树不变", async () => {
  const sources = path.join(root, ".agents/skills"), before = await capture(sources);
  const result = await inspectLocalSkillPackages({ collectionRoots: [path.join(root, ".claude/skills"), sources],
    workSuites: [{ rootPath: root, manifestPath: path.join(sources, "work-suite.json") }] });
  assert.deepEqual(result.issues, []); assert.equal(result.packages.length, 20);
  assert.equal(result.readOnly, true); assert.equal(result.activationAllowed, false);
  assert.deepEqual(result.packages.filter(p => p.invocationMode === "user-only").map(p => p.skillName).sort(), ["auto", "challenge", "guide", "setup", "steer"]);
  for (const pkg of result.packages) {
    assert.equal(pkg.manifests.length, 1); assert.equal(pkg.manifests[0]!.verified, true);
    assert.ok(pkg.sourceAliases.some(a => a.includes(".claude/skills")));
    assert.ok(pkg.files.some(f => f.path === "SKILL.md"));
    assert.match(pkg.contentDigest, /^[a-f0-9]{64}$/); assert.equal(pkg.versionId, null);
  }
  const reversed = await inspectLocalSkillPackages({ collectionRoots: [sources, path.join(root, ".claude/skills")],
    workSuites: [{ rootPath: root, manifestPath: path.join(sources, "work-suite.json") }] });
  assert.deepEqual(reversed, result);
  assert.deepEqual(await capture(sources), before);
});

test("完整相对资源树参与摘要；内部相对链接保留，未知第三方限制不默认为自动", async () => {
  const f = await fixture();
  try {
    const p = await f.package(); await mkdir(path.join(p, "assets"));
    await writeFile(path.join(p, "assets/data.bin"), Buffer.from([0, 1, 255]));
    await symlink("assets/data.bin", path.join(p, "data.bin"));
    const before = await capture(p), a = await inspectLocalSkillPackages({ packageRoots: [p] });
    assert.deepEqual(a.issues, []); assert.equal(a.packages[0]!.invocationMode, "unknown");
    assert.equal(a.packages[0]!.files.find(f => f.path === "data.bin")?.kind, "symlink");
    assert.deepEqual(await capture(p), before);
    await writeFile(path.join(p, "assets/data.bin"), Buffer.from([0, 2, 255]));
    const b = await inspectLocalSkillPackages({ packageRoots: [p] });
    assert.notEqual(a.packages[0]!.contentDigest, b.packages[0]!.contentDigest);
  } finally { await f.close(); }
});

test("重复键、嵌套策略布尔类型、别名、标签、多文档不被宽松匹配成可自动调用", async () => {
  const f = await fixture();
  try {
    const invalidHeaders = ["disable-model-invocation: false\ndisable-model-invocation: true\n", "disable-model-invocation: 'false'\n", "description: !custom 不可信\n", "extra: &key false\ndisable-model-invocation: *key\n"];
    for (const header of invalidHeaders) {
      const p = await f.package("sample", header);
      const report = await inspectLocalSkillPackages({ packageRoots: [p] });
      assert.equal(report.packages.length, 0); assert.equal(report.issues[0]?.code, "metadata_invalid");
    }
    const p = await f.package("sample", "disable-model-invocation: false\n"); await mkdir(path.join(p, "agents"));
    await writeFile(path.join(p, "agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\ninterface:\n  default_prompt: 'allow_implicit_invocation: true'\n");
    let report = await inspectLocalSkillPackages({ packageRoots: [p] });
    assert.equal(report.packages[0]?.invocationMode, "user-only", "按嵌套结构与严格者取值，不能被文案中的相同字段误导");
    for (const invalid of ["policy:\n  allow_implicit_invocation: 'false'\n", "policy:\n  allow_implicit_invocation: true\n---\npolicy: {}\n", "policy:\n  allow_implicit_invocation: true\n  allow_implicit_invocation: false\n"]) {
      await writeFile(path.join(p, "agents/openai.yaml"), invalid); report = await inspectLocalSkillPackages({ packageRoots: [p] });
      assert.equal(report.packages.length, 0); assert.equal(report.issues[0]?.code, "metadata_invalid");
    }
  } finally { await f.close(); }
});

test("包外链接、内链环、路径越界、特殊文件与预算逐项阻断；不运行包脚本", async () => {
  const f = await fixture();
  try {
    const p = await f.package(); await writeFile(path.join(f.dir, "outside"), "外部");
    await symlink("../outside", path.join(p, "bad"));
    assert.equal((await inspectLocalSkillPackages({ packageRoots: [p] })).issues[0]?.code, "path_escape");
    await rm(path.join(p, "bad")); await symlink(".", path.join(p, "loop"));
    assert.equal((await inspectLocalSkillPackages({ packageRoots: [p] })).issues[0]?.code, "symlink_cycle");
    await rm(path.join(p, "loop"));
    assert.equal((await inspectLocalSkillPackages({ packageRoots: [`${p}/child/..`] })).issues[0]?.code, "invalid_path");
    await writeFile(path.join(p, "never.sh"), "#!/bin/sh\ntouch SHOULD_NOT_EXIST\n");
    await inspectLocalSkillPackages({ packageRoots: [p] });
    assert.ok(!(await readdir(p)).includes("SHOULD_NOT_EXIST"));
    for (const limits of [{ maxFileBytes: 2 }, { maxPackageBytes: 2 }, { maxTotalBytes: 2 }, { maxEntries: 1 }]) {
      assert.equal((await inspectLocalSkillPackages({ packageRoots: [p], limits })).issues[0]?.code, "budget_exceeded");
    }
    const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
    await promisify(execFile)("mkfifo", [path.join(p, "pipe")]);
    assert.equal((await inspectLocalSkillPackages({ packageRoots: [p] })).issues[0]?.code, "special_file");
  } finally { await f.close(); }
});

test("work-suite 的已声明文件或来源变换摘要不符即失败，额外资源也不能漏验", async () => {
  const f = await fixture();
  try {
    const p = path.join(f.dir, ".agents/skills/sample"); await mkdir(p, { recursive: true });
    const data = "---\nname: sample\ndescription: 样例\n---\n正文"; await writeFile(path.join(p, "SKILL.md"), data);
    const manifestPath = path.join(f.dir, "work-suite.json");
    const manifest = { schema_version: "work-suite/v1", suite_version: "test", skills: [{ name: "sample", path: ".agents/skills/sample", invocation: "explicit-user", files: [{ path: "SKILL.md", sha256: hash(data) }] }] };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const input = { workSuites: [{ rootPath: f.dir, manifestPath }] };
    assert.equal((await inspectLocalSkillPackages(input)).packages[0]?.invocationMode, "user-only");
    await writeFile(path.join(p, "SKILL.md"), data + "改动");
    assert.equal((await inspectLocalSkillPackages(input)).issues[0]?.code, "manifest_mismatch");
    await writeFile(path.join(p, "SKILL.md"), data); await writeFile(path.join(p, "extra"), "额外");
    assert.equal((await inspectLocalSkillPackages(input)).issues[0]?.code, "manifest_mismatch");
    await rm(path.join(p, "extra"));
    manifest.skills[0]!.files.push({ path: "../escape", sha256: hash("x") }); await writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal((await inspectLocalSkillPackages(input)).issues[0]?.code, "manifest_invalid");
  } finally { await f.close(); }
});

test("明确声明的顶层资源/依赖必须解析，无法理解的依赖版本表达式不能静默忽略", async () => {
  const f = await fixture();
  try {
    const p = await f.package("sample", `dependencies:\n  - skillName: helper\n    pin:\n      contentDigest: ${"a".repeat(64)}\nresources:\n  - path: data.txt\n    required: false\n`);
    await writeFile(path.join(p, "data.txt"), "资源");
    let report = await inspectLocalSkillPackages({ packageRoots: [p] });
    assert.deepEqual(report.packages[0]?.dependencies, [{ skillName: "helper", pin: { contentDigest: "a".repeat(64) } }]);
    assert.deepEqual(report.packages[0]?.resources, [{ path: "data.txt", required: false }]);
    await f.package("sample", "dependencies:\n  helper: ^1.0.0\n");
    report = await inspectLocalSkillPackages({ packageRoots: [p] });
    assert.equal(report.issues[0]?.code, "metadata_invalid");
  } finally { await f.close(); }
});
