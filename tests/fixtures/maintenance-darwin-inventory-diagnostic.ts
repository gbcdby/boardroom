import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Subsequent read-only observations while the failed test's source and lock are still alive. */
export async function recordDarwinInventoryFailure(
  stage: "after-external-close" | "held-source-lock",
  source: { dataDir: string; sqlitePath: string; sourcePath: string; identity: { device: string; inode: string } },
  blockers: readonly unknown[],
): Promise<void> {
  if (process.platform !== "darwin" || blockers.length === 0) return;
  let directory: string | undefined;
  try {
    const budgetMs = 25_000, deadline = Date.now() + budgetMs;
    const output = path.join(root, ".agent-output", "macos-tests", "native-inventory-diagnostics");
    await mkdir(output, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(path.join(output, `${stage}-`));
    const binary = path.join(root, "build", "maintenance-platform", `maintenance-darwin-${process.arch}`);
    const wrapper = path.join(root, "tests", "fixtures", "maintenance-darwin-inventory-diagnostic.c");
    const diagnosticBinary = path.join(directory, "inventory-trace");
    const scopes = [`f:${source.sqlitePath}`, `f:${source.sqlitePath}-wal`, `f:${source.sqlitePath}-shm`,
      `d:${path.join(source.dataDir, "managed", "sessions")}`];
    const digest = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
    const save = async (name: string, value: string) => writeFile(path.join(directory!, name), value, { mode: 0o600 });
    // Preserve the actual failed observation before collecting later inventories. Do not retry the assertion.
    await save("failure.json", JSON.stringify({ stage, capturedAt: new Date().toISOString(), blockers, source, scopes,
      pid: process.pid, uid: process.getuid?.() ?? null, platform: process.platform, arch: process.arch, node: process.version,
      candidate: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      diagnosticBudgetMs: budgetMs, traceBounds: { extraRangeProbeGroups: 8, queriesPerGroup: 4, eventLimit: 4096 },
      observation: "Inventories below are subsequent calls; the original blockers above remain authoritative." }, null, 2));
    await save("identity.json", JSON.stringify({ binarySha256: await digest(binary), wrapperSha256: await digest(wrapper),
      nativeSourceSha256: await digest(path.join(root, "native", "maintenance-darwin.c")),
      helperSha256: await digest(path.join(root, "tests", "fixtures", "maintenance-darwin-inventory-diagnostic.ts")),
      testSha256: await digest(path.join(root, "tests", "maintenance-sqlite.test.ts")) }, null, 2));
    const run = async (name: string, command: string, args: string[], commandBudgetMs = 5_000) => {
      const startedAt = new Date().toISOString();
      const timeoutMs = Math.min(commandBudgetMs, deadline - Date.now());
      if (timeoutMs <= 0) {
        await save(`${name}.execution.json`, JSON.stringify({ command, args, startedAt, status: "NOT_RUN", reason: "diagnostic-budget-exhausted" }, null, 2));
        return false;
      }
      const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
        killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
      await save(`${name}.stdout.txt`, result.stdout ?? "");
      await save(`${name}.stderr.txt`, result.stderr ?? "");
      await save(`${name}.execution.json`, JSON.stringify({ command, args, startedAt, finishedAt: new Date().toISOString(),
        status: result.status, signal: result.signal, error: result.error?.message ?? null,
        timeoutMs, killSignal: "SIGKILL", maxBufferBytes: 4 * 1024 * 1024 }, null, 2));
      return result.status === 0 && !result.error && !result.signal;
    };
    await run("production-source-users", binary, ["source-users", ...scopes]);
    await run("production-parent-handles", binary, ["parent-handles", ...scopes]);
    await run("kernel-version", "/usr/bin/uname", ["-srv"], 1_000);
    await run("os-version", "/usr/bin/sw_vers", [], 1_000);
    await run("sdk-version", "/usr/bin/xcrun", ["--show-sdk-version"], 1_000);
    await run("sdk-path", "/usr/bin/xcrun", ["--show-sdk-path"], 1_000);
    await run("compiler-version", "/usr/bin/cc", ["--version"], 1_000);
    try {
      if (await run("compile-trace", "/usr/bin/cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-O2",
        wrapper, "-lproc", "-o", diagnosticBinary])) {
        await chmod(diagnosticBinary, 0o700);
        await save("trace-identity.json", JSON.stringify({ binarySha256: await digest(diagnosticBinary) }, null, 2));
        await run("trace-source-users", diagnosticBinary, ["source-users", ...scopes]);
      }
    } finally { await rm(diagnosticBinary, { force: true }); }
    process.stderr.write(`Darwin inventory diagnostics: ${directory}\n`);
  } catch (error) {
    // A diagnostic failure must never replace the original guard assertion or skip fixture cleanup.
    process.stderr.write(`Darwin inventory diagnostic capture failed (${directory ?? "not-created"}): ${String(error)}\n`);
  }
}
