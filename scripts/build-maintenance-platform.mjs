import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const required = process.argv.includes("--required");
if (process.argv.slice(2).some(argument => argument !== "--required")) throw new Error("Unsupported build argument");
if (process.platform !== "darwin") {
  if (required) throw new Error("macOS maintenance verification requires an actual Darwin host");
} else {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = path.join(root, "build", "maintenance-platform");
  const target = path.join(directory, `maintenance-darwin-${process.arch}`);
  const sqliteTarget = path.join(directory, `maintenance-sqlite-darwin-${process.arch}.dylib`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const sqliteTemporary = `${sqliteTarget}.${randomUUID()}.tmp`;
  let diagnostics = "compiler unavailable\n";
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const result = spawnSync("/usr/bin/cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-O2",
      path.join(root, "native", "maintenance-darwin.c"), "-lproc", "-o", temporary], { encoding: "utf8", timeout: 60_000 });
    diagnostics = result.stderr || diagnostics;
    if (result.status !== 0 || result.error) throw new Error("native compiler failed");
    const dependency = path.dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json"));
    const sqliteResult = spawnSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-dynamiclib",
      "-I", path.join(dependency, "deps", "sqlite3"), path.join(root, "native", "maintenance-sqlite.c"), "-o", sqliteTemporary],
      { encoding: "utf8", timeout: 60_000 });
    diagnostics = sqliteResult.stderr || diagnostics;
    if (sqliteResult.status !== 0 || sqliteResult.error) throw new Error("SQLite extension compiler failed");
    chmodSync(temporary, 0o700); chmodSync(sqliteTemporary, 0o700);
    renameSync(temporary, target); renameSync(sqliteTemporary, sqliteTarget);
  } catch {
    for (const file of [temporary, sqliteTemporary, target, sqliteTarget]) {
      try { rmSync(file, { force: true }); } catch { /* Runtime availability checks remain fail-closed. */ }
    }
    process.stderr.write("macOS 存储维护原生组件未构建；普通应用仍可使用，维护执行保持不可用。需要 Xcode Command Line Tools。\n");
    if (required) { process.stderr.write(diagnostics); process.exitCode = 1; }
  }
  // This public-restore-only capability is independent of the existing observer
  // executable and SQLite extension. A failure must not erase those valid tools.
  const publicTarget = path.join(directory, `postgres-public-directory-${process.arch}.node`);
  const publicTemporary = `${publicTarget}.${randomUUID()}.tmp`;
  let publicDiagnostics = "public directory bridge unavailable\n";
  try {
    if (Number(process.versions.napi) < 8) throw new Error("Node-API 8 is required");
    const headers = path.join(root, "native", "node-api", "v24.22.1");
    const sources = JSON.parse(readFileSync(path.join(headers, "SOURCES.json"), "utf8"));
    if (sources.upstreamVersion !== "v24.22.1" || sources.napiVersion !== 8 || !Array.isArray(sources.files)
      || sources.files.length !== 5) throw new Error("Unexpected Node-API header source");
    const names = ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h", "LICENSE"];
    for (const name of names) {
      const matches = sources.files.filter(file => file.name === name);
      if (matches.length !== 1 || createHash("sha256").update(readFileSync(path.join(headers, name))).digest("hex") !== matches[0].sha256)
        throw new Error("Node-API source checksum mismatch");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const built = spawnSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8",
      "-DNODE_GYP_MODULE_NAME=boardroom_public_directory", "-bundle", "-undefined", "dynamic_lookup", "-I", headers,
      path.join(root, "native", "postgres-public-directory.c"), "-o", publicTemporary],
    { encoding: "utf8", timeout: 60_000 });
    publicDiagnostics = built.stderr || publicDiagnostics;
    if (built.status !== 0 || built.error) throw new Error("public directory bridge compiler failed");
    chmodSync(publicTemporary, 0o700); renameSync(publicTemporary, publicTarget);
  } catch {
    for (const file of [publicTemporary, publicTarget]) {
      try { rmSync(file, { force: true }); } catch { /* Public restore remains unavailable. */ }
    }
    process.stderr.write("macOS public 恢复目录 FD 组件未构建；public 验证恢复保持不可用。\n");
    if (required) { process.stderr.write(publicDiagnostics); process.exitCode = 1; }
  }
}
