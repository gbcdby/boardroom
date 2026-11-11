import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalizePath } from "../environment.ts";
import type { SkillFileEntry, SkillInspectionIssue, SkillInventoryPreview, SkillPackagePreview } from "../../shared/skills.ts";
import { compare, digest, relativePath, sha256, uniqueSorted } from "./common.ts";
import { parseMetadataYaml, readSkillMetadata } from "./metadata.ts";

type Code = SkillInspectionIssue["code"];
class InspectionError extends Error {
  readonly code: Code;
  constructor(code: Code, message: string) { super(message); this.code = code; }
}
function fail(code: Code, message: string): never { throw new InspectionError(code, message); }
export interface SkillInspectionLimits {
  readonly maxPackages: number; readonly maxEntries: number; readonly maxDepth: number;
  readonly maxFileBytes: number; readonly maxPackageBytes: number; readonly maxTotalBytes: number;
}
const defaults: SkillInspectionLimits = { maxPackages: 256, maxEntries: 4096, maxDepth: 32,
  maxFileBytes: 8 * 1024 * 1024, maxPackageBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };
export interface InspectLocalSkillOptions {
  readonly packageRoots?: readonly string[];
  /** 仅扫描这一层显式目录下包含 SKILL.md 的子目录。 */
  readonly collectionRoots?: readonly string[];
  readonly workSuites?: readonly { readonly rootPath: string; readonly manifestPath: string }[];
  readonly limits?: Partial<SkillInspectionLimits>;
}
const fileDeclaration = z.object({ path: z.string().refine(relativePath), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), transform: z.literal("add-disable-model-invocation").optional() }).strict();
const manifestSchema = z.object({ schema_version: z.literal("work-suite/v1"), suite_version: z.string().min(1),
  skills: z.array(z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), path: z.string().refine(relativePath),
    invocation: z.enum(["explicit-user", "implicit-or-explicit"]), files: z.array(fileDeclaration).min(1) }).strict()).max(256) }).passthrough();
type Declaration = z.infer<typeof manifestSchema>["skills"][number];
interface ManifestSource { path: string; suiteVersion: string; manifestDigest: string; declaration: Declaration }
interface Candidate { root: string; aliases: Set<string>; manifests: ManifestSource[] }
function inside(root: string, file: string) { const rel = path.relative(root, file); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); }
function requireAbsolute(value: string) {
  if (!value || value.includes("\0") || !path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) fail("invalid_path", "来源须为无 .. 的绝对本地路径");
}
async function directory(value: string): Promise<string> {
  requireAbsolute(value);
  const resolved = canonicalizePath(value);
  if (!(await stat(resolved)).isDirectory()) fail("invalid_path", "来源不是目录");
  return resolved;
}
function stamp(s: Awaited<ReturnType<typeof stat>>): string { return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
function issue(error: unknown, source: string): SkillInspectionIssue {
  return { code: error instanceof InspectionError ? error.code : "source_unreadable", source,
    detail: error instanceof InspectionError ? error.message : `本地来源不可读（${(error as NodeJS.ErrnoException).code ?? "unknown"}）` };
}
/** 限量 fd 读取，检查普通文件、链接数和读前/后身份，避免 FIFO 阻塞及无限增长。 */
async function readRegular(file: string, root: string, maxBytes: number): Promise<Buffer> {
  const actual = await realpath(file);
  if (!inside(root, actual)) fail("path_escape", "文件解析到包根之外");
  const before = await lstat(actual);
  if (!before.isFile()) fail("special_file", "只允许普通文件");
  if (before.nlink !== 1) fail("hardlink_unsupported", "多硬链接文件的来源边界不明确");
  if (before.size > maxBytes) fail("budget_exceeded", "文件或累计字节数超限");
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || stamp(opened) !== stamp(before)) fail("source_changed", "打开前来源发生变化");
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      total += read.bytesRead;
      if (total > maxBytes) fail("budget_exceeded", "读取时文件增长超过预算");
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    if (stamp(await handle.stat()) !== stamp(before) || await realpath(file) !== actual || stamp(await lstat(actual)) !== stamp(before)) fail("source_changed", "读取期间来源发生变化");
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
async function inspectPackage(candidate: Candidate, limits: SkillInspectionLimits, budget: { bytes: number }): Promise<SkillPackagePreview> {
  const files: SkillFileEntry[] = [], bytes = new Map<string, Buffer>(), checks: { path: string; stamp: string; real: string }[] = [];
  let packageBytes = 0;
  const root = candidate.root, rootStamp = stamp(await lstat(root));
  async function walk(file: string, relative: string, ancestors: ReadonlySet<string>, depth: number) {
    if (depth > limits.maxDepth || files.length >= limits.maxEntries) fail("budget_exceeded", "包目录深度或条目数超限");
    if (relative && !relativePath(relative)) fail("invalid_path", "包内文件名不能安全地表示为相对资源路径");
    const info = await lstat(file), actual = await realpath(file);
    if (!inside(root, actual)) fail("path_escape", "符号链接或目录解析到包根之外");
    checks.push({ path: file, stamp: stamp(info), real: actual });
    let target: string | null = null;
    if (info.isSymbolicLink()) {
      target = await readlink(file);
      if (path.isAbsolute(target) || target.includes("\\") || target.includes("\0")) fail("path_escape", "链接目标须是包内相对路径");
    }
    const followed = info.isSymbolicLink() ? await stat(file) : info;
    if (followed.isDirectory()) {
      if (ancestors.has(actual)) fail("symlink_cycle", "包内目录符号链接形成环");
      if (relative) files.push({ path: relative, kind: target === null ? "directory" : "symlink", sha256: null, byteLength: 0, target });
      const names = (await readdir(file)).sort(compare);
      if (names.length + files.length > limits.maxEntries) fail("budget_exceeded", "包目录条目数超限");
      const next = new Set([...ancestors, actual]);
      for (const name of names) await walk(path.join(file, name), relative ? `${relative}/${name}` : name, next, depth + 1);
    } else if (followed.isFile()) {
      const remaining = Math.min(limits.maxFileBytes, limits.maxPackageBytes - packageBytes, limits.maxTotalBytes - budget.bytes);
      if (remaining < 0) fail("budget_exceeded", "累计字节数超限");
      const data = await readRegular(file, root, remaining);
      packageBytes += data.length; budget.bytes += data.length; bytes.set(relative, data);
      files.push({ path: relative, kind: target === null ? "file" : "symlink", sha256: sha256(data), byteLength: data.length, target });
    } else fail("special_file", "包中不允许设备、socket、FIFO 等特殊文件");
  }
  await walk(root, "", new Set(), 0);
  if (stamp(await lstat(root)) !== rootStamp) fail("source_changed", "扫描期间包根改变");
  for (const check of checks) if (stamp(await lstat(check.path)) !== check.stamp || await realpath(check.path) !== check.real) fail("source_changed", "扫描期间资源树改变");
  const skill = bytes.get("SKILL.md");
  if (!skill) fail("metadata_invalid", "包缺少 SKILL.md");
  for (const manifest of candidate.manifests) {
    const declaration = manifest.declaration;
    const declared = new Set(declaration.files.map(file => file.path));
    if (declared.size !== declaration.files.length || declared.size !== bytes.size || [...bytes.keys()].some(file => !declared.has(file))) fail("manifest_mismatch", "work-suite 文件清单不完整或有重复");
    for (const entry of declaration.files) {
      const actual = bytes.get(entry.path);
      if (!actual || sha256(actual) !== entry.sha256) fail("manifest_mismatch", `work-suite 摘要不匹配：${entry.path}`);
      if (entry.source_sha256 || entry.transform) {
        const marker = "\ndisable-model-invocation: true\n---";
        const text = actual.toString("utf8"), index = text.indexOf(marker);
        if (entry.path !== "SKILL.md" || declaration.invocation !== "explicit-user" || entry.transform !== "add-disable-model-invocation"
          || !entry.source_sha256 || index < 0 || index + marker.length - 4 !== text.indexOf("\n---", 4)
          || sha256(text.slice(0, index) + "\n---" + text.slice(index + marker.length)) !== entry.source_sha256) fail("manifest_mismatch", "work-suite 导出变换的来源摘要不匹配");
      }
    }
  }
  let metadata: ReturnType<typeof readSkillMetadata>;
  try {
    const openai = bytes.get("agents/openai.yaml");
    if ((openai?.length ?? 0) > 64 * 1024) fail("budget_exceeded", "策略元数据过大");
    metadata = readSkillMetadata(skill, openai, candidate.manifests.map(manifest => manifest.declaration.invocation));
    for (const manifest of candidate.manifests) if (metadata.skillName !== manifest.declaration.name) fail("manifest_mismatch", "work-suite 名称与 SKILL.md 不一致");
    for (const resource of metadata.resources) if (!bytes.has(resource.path)) fail("metadata_invalid", `声明资源不存在或不是文件：${resource.path}`);
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    fail("metadata_invalid", "SKILL.md 或 agents/openai.yaml 元数据不符合受支持的数据契约");
  }
  files.sort((a, b) => compare(a.path, b.path));
  const contentDigest = digest({ schemaVersion: "skill-content/v1", files });
  return { kind: "local-preview", previewRef: `skill-preview:sha256:${contentDigest}`, versionId: null, ...metadata!,
    contentDigest, files, canonicalRoot: root, sourceAliases: [...candidate.aliases].sort(compare),
    manifests: uniqueSorted(candidate.manifests.map(m => ({ path: m.path, suiteVersion: m.suiteVersion, manifestDigest: m.manifestDigest, verified: true as const }))) };
}

/** 可信本地只读入口。明确来源；不执行代码、不写源、包库或数据库。 */
export async function inspectLocalSkillPackages(options: InspectLocalSkillOptions): Promise<SkillInventoryPreview> {
  const limits = { ...defaults, ...options.limits }, issues: SkillInspectionIssue[] = [], candidates = new Map<string, Candidate>();
  const budget = { bytes: 0 };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("技能检查预算须为正整数");
  const add = async (source: string, manifest?: ManifestSource, boundary?: string) => {
    const root = await directory(source);
    if (boundary && !inside(boundary, root)) fail("path_escape", "选中目录的子包越界");
    if (!candidates.has(root) && candidates.size >= limits.maxPackages) fail("budget_exceeded", "包数量超限");
    const candidate = candidates.get(root) ?? { root, aliases: new Set<string>(), manifests: [] };
    candidate.aliases.add(path.normalize(source)); if (manifest) candidate.manifests.push(manifest);
    candidates.set(root, candidate);
  };
  const attempt = async (source: string, action: () => Promise<void>) => { try { await action(); } catch (error) { issues.push(issue(error, source)); } };
  for (const source of [...new Set(options.packageRoots ?? [])].sort(compare)) await attempt(source, () => add(source));
  // 同一真实集合目录只枚举一次，仍保留每个显式别名作为来源证据。
  const collections = new Map<string, string[]>();
  for (const source of [...new Set(options.collectionRoots ?? [])].sort(compare)) await attempt(source, async () => {
    const root = await directory(source); collections.set(root, [...(collections.get(root) ?? []), source]);
  });
  for (const [root, aliases] of [...collections.entries()].sort(([a], [b]) => compare(a, b))) await attempt(root, async () => {
    const names = (await readdir(root)).sort(compare);
    if (names.length > limits.maxEntries) fail("budget_exceeded", "集合目录条目数超限");
    for (const name of names) {
      const source = path.join(root, name), info = await lstat(source);
      if (!info.isDirectory() && !info.isSymbolicLink()) continue;
      try { await lstat(path.join(source, "SKILL.md")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      await attempt(source, async () => { for (const alias of aliases) await add(path.join(alias, name), undefined, root); });
    }
  });
  for (const source of uniqueSorted(options.workSuites ?? [])) await attempt(source.manifestPath, async () => {
    const root = await directory(source.rootPath); requireAbsolute(source.manifestPath);
    const buffer = await readRegular(source.manifestPath, root, Math.min(1024 * 1024, limits.maxTotalBytes - budget.bytes));
    budget.bytes += buffer.length;
    let manifest: z.infer<typeof manifestSchema>;
    try {
      const text = new TextDecoder("utf8", { fatal: true }).decode(buffer);
      JSON.parse(text); // 限定 JSON 语法；再用拒绝重复键的数据解析器检查结构。
      manifest = manifestSchema.parse(parseMetadataYaml(text));
    }
    catch { fail("manifest_invalid", "work-suite/v1 清单结构无效"); }
    if (new Set(manifest!.skills.map(skill => skill.name)).size !== manifest!.skills.length) fail("manifest_invalid", "work-suite 技能名称重复");
    for (const entry of [...manifest!.skills].sort((a, b) => compare(a.name, b.name))) {
      if (entry.path !== `.agents/skills/${entry.name}`) fail("manifest_invalid", "work-suite 的标准包目录与名称不一致");
      const packageRoot = path.join(source.rootPath, entry.path);
      await attempt(packageRoot, () => add(packageRoot, { path: canonicalizePath(source.manifestPath), suiteVersion: manifest!.suite_version, manifestDigest: sha256(buffer), declaration: entry }, root));
    }
  });
  const packages: SkillPackagePreview[] = [];
  for (const candidate of [...candidates.values()].sort((a, b) => compare(a.root, b.root))) await attempt(candidate.root, async () => {
    packages.push(await inspectPackage(candidate, limits, budget));
  });
  const result = { schemaVersion: "skill-inventory-preview/v1" as const, readOnly: true as const, activationAllowed: false as const,
    packages, issues: uniqueSorted(issues) };
  return { ...result, digest: digest(result) };
}
