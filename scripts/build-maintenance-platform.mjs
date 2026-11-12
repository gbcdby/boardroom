import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
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
}
