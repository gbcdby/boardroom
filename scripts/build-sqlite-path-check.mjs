// 独立 Linux 只读 pathname 观察组件；不参与 postinstall 或 production tuple 登记。
import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const component = path.join(root, "build", "maintenance-platform", "sqlite-path-check-linux-" + process.arch);
const flags = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-shared", "-fPIC"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const identity = file => lstatSync(file, { bigint: true });
const record = bytes => ({ bytes: bytes.length, sha256: hash(bytes) });
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
function fail(code) { throw new Error(code); }
function directory(file, privateMode = true) {
  const s = identity(file);
  if (!s.isDirectory() || s.uid !== BigInt(process.getuid()) || privateMode && (s.mode & 0o7777n) !== 0o700n
    || (s.mode & 0o022n) !== 0n || s.nlink < 2n || realpathSync(file) !== file) fail("sqlite_path_build_directory_invalid");
  return s;
}
function ensureDirectory(file, privateMode = true) {
  try { mkdirSync(file, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  return directory(file, privateMode);
}
function readBounded(file, maximum, mode) {
  const before = identity(file);
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum)
    || mode !== undefined && (before.uid !== BigInt(process.getuid()) || (before.mode & 0o7777n) !== BigInt(mode)))
    fail("sqlite_path_build_file_invalid");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!same(before, opened) || opened.size !== before.size) fail("sqlite_path_build_file_changed");
    const data = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < data.length) { const n = readSync(fd, data, offset, data.length - offset, offset); if (!n) fail("sqlite_path_build_short_read"); offset += n; }
    const after = fstatSync(fd, { bigint: true });
    if (!same(after, identity(file)) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
      fail("sqlite_path_build_file_changed");
    return data;
  } finally { closeSync(fd); }
}
function writeExclusive(file, data, mode) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { fchmodSync(fd, mode); writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function publishFile(temporary, target, bytes, mode, code) {
  try { linkSync(temporary, target); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try { if (!readBounded(target, bytes.length, mode).equals(bytes)) fail(code); }
    catch { fail(code); }
    return;
  }
  // No previous path was overwritten; remove only our own temporary link before publication.
  unlinkSync(temporary);
}

let stage, stageIdentity, lockIdentity, published = false;
const lock = path.join(component, ".build-lock");
try {
  if (process.argv.length !== 2 || process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) fail("sqlite_path_build_platform_or_arguments");
  ensureDirectory(path.join(root, "build"), false);
  ensureDirectory(path.join(root, "build", "maintenance-platform"), false);
  const componentIdentity = ensureDirectory(component);
  const manifestsIdentity = ensureDirectory(path.join(component, "manifests"));
  try { mkdirSync(lock, { mode: 0o700 }); lockIdentity = directory(lock); }
  catch (error) { if (error?.code === "EEXIST") fail("sqlite_path_build_busy"); throw error; }
  stage = mkdtempSync(path.join(component, ".build-")); stageIdentity = directory(stage);
  mkdirSync(path.join(stage, "result"), { mode: 0o700 });
  const dependency = path.dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json"));
  const lockBytes = readBounded(path.join(root, "package-lock.json"), 2 * 1024 * 1024);
  const packageBytes = readBounded(path.join(dependency, "package.json"), 64 * 1024);
  const builderBytes = readBounded(fileURLToPath(import.meta.url), 128 * 1024);
  const lockData = JSON.parse(lockBytes.toString("utf8")), pkg = JSON.parse(packageBytes.toString("utf8"));
  if (pkg.name !== "better-sqlite3" || pkg.version !== lockData.packages?.["node_modules/better-sqlite3"]?.version) fail("sqlite_path_build_dependency_mismatch");
  const sourcePaths = [path.join(root, "native", "maintenance-sqlite.c"), path.join(dependency, "deps", "sqlite3", "sqlite3ext.h"), path.join(dependency, "deps", "sqlite3", "sqlite3.h")];
  const roles = ["extension", "sqlite3ext.h", "sqlite3.h"], snapshots = ["extension.c", "sqlite3ext.h", "sqlite3.h"];
  const sourceBytes = sourcePaths.map((file, i) => readBounded(file, i === 0 ? 64 * 1024 : 2 * 1024 * 1024));
  for (let i = 0; i < snapshots.length; i++) writeExclusive(path.join(stage, snapshots[i]), sourceBytes[i], 0o600);
  const compilerReal = realpathSync("/usr/bin/cc"), compilerBytes = readBounded(compilerReal, 32 * 1024 * 1024);
  const compilerStat = identity(compilerReal);
  if ((compilerStat.mode & 0o022n) !== 0n || (compilerStat.mode & 0o111n) === 0n) fail("sqlite_path_build_compiler_invalid");
  // 不继承 CPATH/C_INCLUDE_PATH/GCC_EXEC_PREFIX/LIBRARY_PATH/LD_*/CC/CFLAGS 等搜索或注入变量。
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TMPDIR: stage };
  const version = spawnSync("/usr/bin/cc", ["--version"], { env: environment, cwd: stage, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 });
  if (version.status !== 0 || version.error || version.signal) fail("sqlite_path_build_compiler_unavailable");
  const args = [...flags, "-I", stage, path.join(stage, "extension.c"), "-o", path.join(stage, "result", "extension.so")];
  const compiled = spawnSync("/usr/bin/cc", args, { env: environment, cwd: stage, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 });
  if (compiled.status !== 0 || compiled.error || compiled.signal) fail("sqlite_path_build_compile_failed");
  const output = path.join(stage, "result", "extension.so");
  const fd = openSync(output, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, 0o700); fsyncSync(fd); } finally { closeSync(fd); }
  const binaryBytes = readBounded(output, 8 * 1024 * 1024, 0o700), binary = record(binaryBytes);
  if (binaryBytes.length < 64 || binaryBytes.readUInt32BE(0) !== 0x7f454c46 || binaryBytes[4] !== 2 || binaryBytes[5] !== 1
    || binaryBytes.readUInt16LE(16) !== 3 || binaryBytes.readUInt16LE(18) !== (process.arch === "x64" ? 62 : 183)) fail("sqlite_path_build_binary_invalid");
  for (let i = 0; i < sourcePaths.length; i++) if (hash(readBounded(sourcePaths[i], i === 0 ? 64 * 1024 : 2 * 1024 * 1024)) !== hash(sourceBytes[i])) fail("sqlite_path_build_source_changed");
  if (hash(readBounded(compilerReal, 32 * 1024 * 1024)) !== hash(compilerBytes) || realpathSync("/usr/bin/cc") !== compilerReal
    || !same(componentIdentity, directory(component))) fail("sqlite_path_build_source_changed");
  if (!readBounded(path.join(root, "package-lock.json"), 2 * 1024 * 1024).equals(lockBytes)
    || !readBounded(path.join(dependency, "package.json"), 64 * 1024).equals(packageBytes)
    || !readBounded(fileURLToPath(import.meta.url), 128 * 1024).equals(builderBytes)) fail("sqlite_path_build_source_changed");
  const manifest = { contract: "sqlite-path-check-build/v1", platform: "linux", architecture: process.arch,
    builder: record(builderBytes),
    dependency: { version: pkg.version, package: record(packageBytes), lock: record(lockBytes) },
    sources: sourceBytes.map((bytes, i) => ({ role: roles[i], ...record(bytes) })),
    compiler: { path: "/usr/bin/cc", realPath: compilerReal, ...record(compilerBytes), version: version.stdout.trim() },
    arguments: args, environment, buildDirectory: stage, binary };
  const manifestBytes = encode(manifest); if (manifestBytes.length > 64 * 1024) fail("sqlite_path_build_manifest_limit");
  const generation = path.join(component, binary.sha256);
  let newGeneration = false;
  try { mkdirSync(generation, { mode: 0o700 }); newGeneration = true; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  try {
    if (directory(generation).nlink !== 2n) fail("sqlite_path_build_generation_conflict");
    if (newGeneration) publishFile(output, path.join(generation, "extension.so"), binaryBytes, 0o700, "sqlite_path_build_generation_conflict");
    else if (!readBounded(path.join(generation, "extension.so"), 8 * 1024 * 1024, 0o700).equals(binaryBytes)) fail("sqlite_path_build_generation_conflict");
  } catch { fail("sqlite_path_build_generation_conflict"); }
  syncDirectory(generation); syncDirectory(component);
  const manifestIdentity = record(manifestBytes), manifestFile = path.join(component, "manifests", manifestIdentity.sha256 + ".json");
  writeExclusive(path.join(stage, "manifest.json"), manifestBytes, 0o600);
  if (!same(manifestsIdentity, directory(path.dirname(manifestFile)))) fail("sqlite_path_build_directory_changed");
  publishFile(path.join(stage, "manifest.json"), manifestFile, manifestBytes, 0o600, "sqlite_path_build_manifest_conflict");
  syncDirectory(path.dirname(manifestFile));
  const current = encode({ contract: "sqlite-path-check-current/v1", manifest: manifestIdentity });
  writeExclusive(path.join(stage, "current.json"), current, 0o600);
  if (!same(componentIdentity, directory(component))) fail("sqlite_path_build_directory_changed");
  try { const old = identity(path.join(component, "current.json"));
    if (!old.isFile() || old.nlink !== 1n || old.uid !== BigInt(process.getuid()) || (old.mode & 0o7777n) !== 0o600n) fail("sqlite_path_build_current_invalid");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  renameSync(path.join(stage, "current.json"), path.join(component, "current.json")); published = true; syncDirectory(component);
  process.stdout.write(JSON.stringify({ contract: "sqlite-path-check-built/v1", binary, manifest: manifestIdentity }) + "\n");
} catch (error) {
  process.stderr.write((published ? "sqlite_path_build_publication_unknown" : error instanceof Error ? error.message : "sqlite_path_build_failed") + "\n");
  process.exitCode = 1;
} finally {
  // 只清理本attempt创建且identity未变的临时目录；已发布/旧代际和其他组件一律保留。
  try { if (stage && stageIdentity && same(stageIdentity, identity(stage))) rmSync(stage, { recursive: true }); }
  catch { process.stderr.write("sqlite_path_build_staging_cleanup_unknown\n"); process.exitCode = 1; }
  try { if (lockIdentity && same(lockIdentity, identity(lock))) rmdirSync(lock); }
  catch { process.stderr.write("sqlite_path_build_lock_cleanup_unknown\n"); process.exitCode = 1; }
}
