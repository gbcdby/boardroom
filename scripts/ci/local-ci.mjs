#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const outDir = path.join(root, ".agent-output", "local-ci");
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = argv.find(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const value = hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
  return value === "" ? true : value;
};
const mode = option("full", false) ? "full" : option("shard") ? "shard" : option("focus") ? "focus" : "preflight";
const jobs = Math.max(1, Number(option("jobs", 4)) || 4);
const skipWeb = Boolean(option("no-web", false));
const skipNative = Boolean(option("no-native", false));
const skipLocalLimited = Boolean(option("skip-local-limited", false));

const results = [];
const started = Date.now();
const stamp = () => new Date().toISOString();
const record = (name, command, status, startedAt, skipped = false) => {
  results.push({ name, command, status, skipped, durationMs: Date.now() - startedAt });
  const label = skipped ? "SKIP" : status === 0 ? "PASS" : "FAIL";
  console.log(`${label} ${name} (${Date.now() - startedAt}ms)`);
};
const skip = (name, reason) => record(name, reason, null, Date.now(), true);
function runLinuxOnly(name, command, args = []) {
  if (process.platform !== "linux") return skip(name, "Linux-only controls (O_PATH / pipe2 / pidfd / linux headers)");
  return run(name, command, args);
}
function run(name, command, args = [], env = {}) {
  console.log(`\n[${stamp()}] ${name}: ${command} ${args.join(" ")}`);
  const at = Date.now();
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  const status = result.error ? 1 : (result.status ?? 1);
  if (result.error) console.error(result.error.message);
  record(name, [command, ...args].join(" "), status, at);
  return status === 0;
}
function runFocus(files) {
  const list = Array.isArray(files) ? files : String(files).split(",");
  if (!list.length) { console.error("--focus needs at least one test file"); process.exitCode = 2; return false; }
  return run("focus", process.execPath, ["--test", "--test-reporter=spec", ...list]);
}
function runShard(shard) {
  return run(`shard ${shard}`, "npm", ["run", `test:ci:macos:${String(shard).replace("/", "of")}`]);
}

function preflight() {
  const ok = true;
  console.log(JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch,
    mode, jobs, skipWeb, skipNative, started: stamp(),
  }, null, 2));
  run("typecheck", "npm", ["run", "typecheck"]);
  if (!skipWeb) run("build:web", "npm", ["run", "build"]);
  if (!skipNative) run("native build", process.execPath, ["scripts/build-maintenance-platform.mjs", "--required"]);
  run("whole-suite budget/ launcher controls", "python3", ["-B", "scripts/ci/test_linux_isolation.py",
    "WholeSuiteBudgetContracts", "LauncherContracts.test_original_commands_and_explicit_pg_scope", "-v"]);
  run("fs effective options", "python3", ["tests/fs-effective-options.test.py"]);
  run("fs source preservation", "python3", ["tests/fs-source-preservation.test.py"]);
  for (const file of ["whole-brd-f0.test.py", "whole-brd-f0b.test.py", "whole-brd-f2.test.py", "whole-brd-f3.test.py", "whole-brd-f3-dm.test.py"])
    runLinuxOnly(file, "python3", ["-B", `tests/${file}`]);
  run("partition plan", process.execPath, ["--test", "scripts/ci/test-linux-partition-plan.mjs"]);
  if (process.platform === "linux") run("partition contracts", "python3", ["-B", "scripts/ci/test_linux_isolation.py", "WholeSuitePartitionContracts", "-v"]);
  else skip("partition contracts", "Linux-only partition execution contracts");
  run("macOS partition contracts", "python3", ["-B", "scripts/ci/test_macos_partitions.py", "-v"]);
  if (process.platform === "darwin" && !skipNative) {
    run("darwin maintenance acceptance", process.execPath,
      ["--test", "--test-reporter=tap", "--test-timeout=60000", "--test-concurrency=1", "tests/maintenance-darwin.acceptance.ts"]);
    const regression = ["tests/db-host-migration.test.ts", "tests/native-management-admission.test.ts", "tests/storage-source-client.test.ts",
      "tests/maintenance-platform.test.ts", "tests/maintenance-objects.test.ts", "tests/maintenance-plan.test.ts"];
    if (skipLocalLimited) skip("maintenance-sqlite regression", "本机 libproc 进程审计受限；CI macos-26 分片仍执行该文件");
    else regression.splice(4, 0, "tests/maintenance-sqlite.test.ts");
    run("darwin maintenance regression", process.execPath,
      ["--test", "--test-reporter=tap", "--test-timeout=60000", "--test-concurrency=1", ...regression]);
  }
  return ok;
}

async function full() {
  const total = 8;
  const queue = Array.from({ length: total }, (_, index) => `${index + 1}/${total}`);
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const shard = queue[cursor++];
      const log = createWriteStream(path.join(outDir, `macos-${shard.replace("/", "-")}.log`));
      const at = Date.now();
      const code = await new Promise(resolve => {
        const child = spawn("npm", ["run", `test:ci:macos:${shard.replace("/", "of")}`], { cwd: root, stdio: ["ignore", log, log] });
        child.on("close", resolve);
        child.on("error", () => resolve(1));
      });
      log.end();
      record(`shard ${shard}`, `npm run test:ci:macos:${shard.replace("/", "of")}`, code, at);
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, total) }, worker));
}

if (mode === "preflight") preflight();
else if (mode === "focus") runFocus(option("focus"));
else if (mode === "shard") runShard(option("shard"));
else if (mode === "full") await full();

const failed = results.filter(result => !result.skipped && result.status !== 0);
writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({
  started, finished: stamp(), durationMs: Date.now() - started, mode, platform: process.platform,
  node: process.version, results, failed: failed.length,
}, null, 2));
console.log(`\n本地 CI：${results.filter(result => result.status === 0).length}/${results.length - results.filter(result => result.skipped).length} 个可执行步骤通过，${results.filter(result => result.skipped).length} 个平台专属步骤跳过；日志 ${outDir}`);
if (failed.length) process.exitCode = 1;
