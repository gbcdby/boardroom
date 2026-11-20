import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, statSync, mkdtempSync, mkdirSync, rmSync, existsSync, copyFileSync, writeFileSync, renameSync,
  chmodSync, linkSync, unlinkSync, symlinkSync, openSync, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");
const component = path.join(root, "build", "maintenance-platform", `sqlite-path-check-linux-${process.arch}`);
const linux = process.platform === "linux";
const moduleUrl = pathToFileURL(path.join(root, "src/server/storage/internal/sqlite-path-observation.ts")).href;
function fixture(body: (directory: string, source: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "boardroom-sqlite-path-"));
  const source = path.join(directory, "selected", "agent-studio.db");
  try { body(directory, source); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function observe(directory: string, url = moduleUrl, cwd = directory) {
  const code = "import {inspectSelectedSqlitePathBinding as inspect} from " + JSON.stringify(url) + ";" +
    "try { console.log(JSON.stringify({ok:true,arity:inspect.length,value:await inspect()})); }" +
    "catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); process.exitCode=1; }";
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd,
    env: { BOARDROOM_HOME: path.join(directory, "home"), AGENT_STUDIO_DB_DRIVER: "sqlite", AGENT_STUDIO_DATA_DIR: path.join(directory, "selected") },
    encoding: "utf8", timeout: 15_000 });
}
function sample(source: string): void {
  mkdirSync(path.dirname(source), { recursive: true });
  const db = new Database(source); db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO sample VALUES(1,'untouched');"); db.close();
}
function derive(directory: string, t: TestContext, name: string, transform: (source: string) => string): string {
  const original = readFileSync(path.join(root, "src/server/storage/internal/sqlite-path-observation.ts"), "utf8");
  let source = original.replace('const root = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));', "const root = " + JSON.stringify(root) + ";")
    .replace('from "../../environment.ts";', "from " + JSON.stringify(pathToFileURL(path.join(root, "src/server/environment.ts")).href) + ";");
  assert.notEqual(source, original);
  source = transform(source);
  source += "\nexport function __privateObservation() { return [...pendingOwners].map(s => ({ dbPhase:s.dbPhase, dbOpen:s.db?.open, files:s.files.map(f=>f.phase), fileOpen:s.files.map(f=>{try{fstatSync(f.fd);return true}catch{return false}}), failures:s.failures.map(f=>f.phase) })); }\n";
  const file = path.join(directory, name + ".ts");
  writeFileSync(file, source); symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  t.diagnostic(JSON.stringify({ scope: "isolated derived private observation only; original public cases run separately", name,
    originalBytes: Buffer.byteLength(original), originalSHA256: createHash("sha256").update(original).digest("hex"),
    derivedBytes: Buffer.byteLength(source), derivedSHA256: createHash("sha256").update(source).digest("hex") }));
  return pathToFileURL(file).href;
}
function buildCopy(body: (copy: string, output: string, run: (env?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>) => void): void {
  const copy = mkdtempSync(path.join(tmpdir(), "boardroom-path-build-"));
  try {
    for (const file of ["scripts/build-sqlite-path-check.mjs", "native/maintenance-sqlite.c", "package-lock.json",
      "node_modules/better-sqlite3/package.json", "node_modules/better-sqlite3/deps/sqlite3/sqlite3ext.h", "node_modules/better-sqlite3/deps/sqlite3/sqlite3.h"]) {
      const target = path.join(copy, file); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(path.join(root, file), target);
    }
    const output = path.join(copy, "build", "maintenance-platform", "sqlite-path-check-linux-" + process.arch);
    const run = (env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [path.join(copy, "scripts/build-sqlite-path-check.mjs")],
      { cwd: copy, env, encoding: "utf8", timeout: 60_000 });
    body(copy, output, run);
  } finally { rmSync(copy, { recursive: true, force: true }); }
}
function selectedManifest(output: string) {
  const pointer = JSON.parse(readFileSync(path.join(output, "current.json"), "utf8"));
  return JSON.parse(readFileSync(path.join(output, "manifests", pointer.manifest.sha256 + ".json"), "utf8"));
}

test("SQ-D02 I01：固定构建产生可核源/头/编译参数与二进制的完整manifest", { skip: !linux }, () => {
  const built = spawnSync(process.execPath, [path.join(root, "scripts/build-sqlite-path-check.mjs")],
    { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.equal(built.error, undefined);
  assert.equal(built.status, 0, built.stderr);
  const current = JSON.parse(readFileSync(path.join(component, "current.json"), "utf8"));
  assert.equal(current.contract, "sqlite-path-check-current/v1");
  const manifestBytes = readFileSync(path.join(component, "manifests", current.manifest.sha256 + ".json"));
  assert.equal(current.manifest.sha256, createHash("sha256").update(manifestBytes).digest("hex"));
  assert.equal(current.manifest.bytes, manifestBytes.length);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.contract, "sqlite-path-check-build/v1");
  assert.equal(manifest.platform, "linux"); assert.equal(manifest.architecture, process.arch);
  assert.equal(manifest.compiler.path, "/usr/bin/cc");
  assert.equal(manifest.sources.length, 3);
  assert.deepEqual(manifest.sources.map((source: { role: string }) => source.role), ["extension", "sqlite3ext.h", "sqlite3.h"]);
  assert.match(manifest.binary.sha256, /^[0-9a-f]{64}$/);
  const file = path.join(component, manifest.binary.sha256, "extension.so");
  const bytes = readFileSync(file);
  assert.equal(manifest.binary.bytes, bytes.length);
  assert.equal(manifest.binary.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(statSync(file).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(component, "current.json")).mode & 0o777, 0o600);
});

test("SQ-D02 I01：零参数原入口真实只读选源、返回已退休的detached观察", { skip: !linux }, () => fixture((directory, source) => {
  mkdirSync(path.dirname(source)); const db = new Database(source);
  db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO sample VALUES(1,'untouched');"); db.close();
  const before = readFileSync(source), identity = statSync(source, { bigint: true });
  const result = observe(directory);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.arity, 0); assert.equal(output.value.scope, "sqlite-main-path-observation/v1");
  assert.equal(output.value.retirement, "closed");
  assert.equal(output.value.pinIdentity.device, String(identity.dev)); assert.equal(output.value.pinIdentity.inode, String(identity.ino));
  assert.equal(output.value.observations.vfsMainPathUnmoved, true);
  assert.deepEqual(readFileSync(source), before);
  assert.equal("admitted" in output.value, false); assert.equal("handle" in output.value, false);
}));

test("SQ-D02 I01：原入口缺失源明确拒绝且不创建目录或数据库", { skip: !linux }, () => fixture((directory, source) => {
  const result = observe(directory);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, "source_unavailable");
  assert.equal(existsSync(path.dirname(source)), false);
}));

test("SQ-D02 I01：可遍历但不可读取的外部祖先不阻断真实只读观察", { skip: !linux }, () => fixture((directory, source) => {
  sample(source);
  const before = readFileSync(source);
  chmodSync(directory, 0o111);
  try {
    assert.throws(() => openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY), { code: "EACCES" });
    const result = observe(directory);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.value.retirement, "closed");
    assert.equal(output.value.observations.vfsMainPathUnmoved, true);
    assert.deepEqual(readFileSync(source), before);
    assert.equal(statSync(directory).mode & 0o777, 0o111, "不得扩大外部目录权限");
  } finally { chmodSync(directory, 0o700); }
}));

test("SQ-D02 I01：元数据祖先pin不绕过真实遍历权限", { skip: !linux }, () => fixture((directory, source) => {
  sample(source);
  const before = readFileSync(source);
  chmodSync(directory, 0o000);
  try {
    const result = observe(directory, moduleUrl, tmpdir());
    assert.equal(result.error, undefined, "子进程应执行原入口，而非在cwd准备时失败");
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(statSync(directory).mode & 0o777, 0o000);
  } finally { chmodSync(directory, 0o700); }
  assert.deepEqual(readFileSync(source), before);
}));

test("SQ-D02 I01：原入口二义source拒绝，不选择替代库或改变两个已有库", { skip: !linux }, () => fixture((directory, source) => {
  sample(source);
  const other = path.join(directory, "home", "state", "agent-studio.db"); sample(other);
  const before = [readFileSync(source), readFileSync(other)];
  const result = observe(directory);
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).code, "source_selection_rejected");
  assert.deepEqual([readFileSync(source), readFileSync(other)], before);
}));

test("SQ-D02 I01：compiler搜索环境污染不改变固定源码编译", { skip: !linux }, () => buildCopy((copy, output, run) => {
  const poison = path.join(copy, "poison"); mkdirSync(poison); writeFileSync(path.join(poison, "stddef.h"), "#error poisoned-search-path\n");
  const result = run({ PATH: poison, CC: "/untrusted/compiler", CFLAGS: "-include /untrusted/input",
    CPATH: poison, C_INCLUDE_PATH: poison, COMPILER_PATH: poison, GCC_EXEC_PREFIX: poison + "/", LIBRARY_PATH: poison });
  assert.equal(result.status, 0, result.stderr);
  const manifest = selectedManifest(output);
  assert.deepEqual(Object.keys(manifest.environment).sort(), ["LANG", "LC_ALL", "PATH", "TMPDIR"]);
  assert.equal(manifest.environment.PATH, "/usr/bin:/bin");
}));

test("SQ-D02 I01：编译失败保留旧current和有效代际，busy不删除别的attempt", { skip: !linux }, () => buildCopy((copy, output, run) => {
  assert.equal(run().status, 0);
  const before = readFileSync(path.join(output, "current.json")), manifest = selectedManifest(output);
  const binary = path.join(output, manifest.binary.sha256, "extension.so"), binaryBefore = readFileSync(binary);
  writeFileSync(path.join(copy, "native/maintenance-sqlite.c"), "#error intentional-isolated-fixture-failure\n");
  const failed = run(); assert.equal(failed.status, 1); assert.match(failed.stderr, /sqlite_path_build_compile_failed/);
  assert.deepEqual(readFileSync(path.join(output, "current.json")), before); assert.deepEqual(readFileSync(binary), binaryBefore);
  const lock = path.join(output, ".build-lock"); mkdirSync(lock, { mode: 0o700 }); writeFileSync(path.join(lock, "owned-by-other-attempt"), "keep");
  const busy = run(); assert.equal(busy.status, 1); assert.match(busy.stderr, /sqlite_path_build_busy/);
  assert.equal(readFileSync(path.join(lock, "owned-by-other-attempt"), "utf8"), "keep");
  assert.deepEqual(readFileSync(path.join(output, "current.json")), before);
}));

test("SQ-D02 I01：不替换预先存在但不完整的SHA generation目录", { skip: !linux }, () => buildCopy((_copy, output, run) => {
  assert.equal(run().status, 0);
  const generation = path.join(output, selectedManifest(output).binary.sha256);
  renameSync(generation, generation + "-preserved");
  mkdirSync(generation, { mode: 0o700 }); const before = statSync(generation, { bigint: true });
  const result = run();
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /sqlite_path_build_generation_conflict/);
  assert.equal(statSync(generation, { bigint: true }).ino, before.ino);
  assert.equal(existsSync(path.join(generation, "extension.so")), false);
  assert.equal(existsSync(path.join(generation + "-preserved", "extension.so")), true);
}));

test("SQ-D02 I01：原入口拒绝current/manifest/generation/binary的实际污染", { skip: !linux }, () => fixture((directory, source) => {
  sample(source);
  const current = path.join(component, "current.json"), currentBytes = readFileSync(current), manifest = selectedManifest(component);
  const selected = JSON.parse(currentBytes.toString("utf8")).manifest.sha256;
  const manifestFile = path.join(component, "manifests", selected + ".json"), manifestBytes = readFileSync(manifestFile);
  const generation = path.join(component, manifest.binary.sha256), binary = path.join(generation, "extension.so"), binaryBytes = readFileSync(binary);
  const rejected = () => { const result = observe(directory); assert.equal(result.status, 1, result.stdout); assert.equal(JSON.parse(result.stdout).ok, false); };
  const mutation = (apply: () => void, undo: () => void) => { try { apply(); rejected(); } finally { undo(); } };
  mutation(() => chmodSync(current, 0o644), () => chmodSync(current, 0o600));
  mutation(() => chmodSync(current, 0o4600), () => chmodSync(current, 0o600));
  const link = path.join(component, ".test-current-link");
  mutation(() => linkSync(current, link), () => { if (existsSync(link)) unlinkSync(link); });
  mutation(() => { renameSync(current, current + ".test-saved"); symlinkSync(current + ".test-saved", current); },
    () => { if (existsSync(current + ".test-saved")) { unlinkSync(current); renameSync(current + ".test-saved", current); } });
  mutation(() => writeFileSync(current, JSON.stringify({ contract: "sqlite-path-check-current/v1", manifest: { bytes: 1, sha256: "../escape" } }, null, 2) + "\n"),
    () => writeFileSync(current, currentBytes));
  mutation(() => writeFileSync(manifestFile, Buffer.concat([manifestBytes, Buffer.from(" ")])), () => writeFileSync(manifestFile, manifestBytes));
  mutation(() => chmodSync(generation, 0o755), () => chmodSync(generation, 0o700));
  mutation(() => { renameSync(generation, generation + ".test-saved"); symlinkSync(generation + ".test-saved", generation, "dir"); },
    () => { if (existsSync(generation + ".test-saved")) { unlinkSync(generation); renameSync(generation + ".test-saved", generation); } });
  const binaryLink = path.join(component, ".test-binary-link");
  mutation(() => linkSync(binary, binaryLink), () => { if (existsSync(binaryLink)) unlinkSync(binaryLink); });
  mutation(() => writeFileSync(binary, Buffer.concat([binaryBytes, Buffer.from([0])])), () => writeFileSync(binary, binaryBytes));
  assert.equal(observe(directory).status, 0);
}));

test("SQ-D02 I01：同native handle的实际rename检查失败，不返回成功观察（隔离副本）", { skip: !linux }, t => fixture((directory, source) => {
  sample(source);
  const url = derive(directory, t, "rename-at-native-check", code => {
    const anchor = 'const statement = s.db.prepare("SELECT boardroom_maintenance_source_unchanged() AS unchanged").safeIntegers();';
    assert.equal(code.split(anchor).length, 2);
    return 'import {renameSync} from "node:fs";\n' + code.replace(anchor, anchor + '\n    renameSync(source.sqlitePath, source.sqlitePath + ".moved");');
  });
  const result = observe(directory, url);
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).code, "source_changed");
  assert.equal(existsSync(source), false); assert.equal(existsSync(source + ".moved"), true);
}));

test("SQ-D02 I01：rename后恢复仍可通过，精确保留HAS_MOVED的ABA能力上限（隔离副本）", { skip: !linux }, t => fixture((directory, source) => {
  sample(source);
  const url = derive(directory, t, "rename-restore-before-native-check", code => {
    const anchor = 'const statement = s.db.prepare("SELECT boardroom_maintenance_source_unchanged() AS unchanged").safeIntegers();';
    assert.equal(code.split(anchor).length, 2);
    return 'import {renameSync} from "node:fs";\n' + code.replace(anchor, anchor +
      '\n    renameSync(source.sqlitePath, source.sqlitePath + ".moved"); renameSync(source.sqlitePath + ".moved", source.sqlitePath);');
  });
  const result = observe(directory, url);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).value.scope, "sqlite-main-path-observation/v1");
  assert.equal(existsSync(source), true); assert.equal(existsSync(source + ".moved"), false);
}));

for (const closed of [false, true]) test("SQ-D02 I01：close未知强留DB及binary/source pins，下一调用不新开资源（隔离副本，实际closed=" + closed + "）", { skip: !linux }, t => fixture((directory, source) => {
  sample(source);
  const url = derive(directory, t, closed ? "throw-after-real-close" : "throw-before-real-close", code => {
    const anchor = 's.db.close(); if (s.db.open) throw new Error("close_not_terminal"); s.dbPhase = "closed";';
    assert.equal(code.split(anchor).length, 2);
    return code.replace(anchor, (closed ? "s.db.close(); " : "") + 'throw new Error("isolated-close-outcome-unknown");');
  });
  const code = "import{inspectSelectedSqlitePathBinding as inspect,__privateObservation as state}from " + JSON.stringify(url) + ";" +
    "const codes=[];for(let i=0;i<2;i++){try{await inspect();codes.push('unexpected-success')}catch(e){codes.push(e.code)}}console.log(JSON.stringify({codes,state:state()}));";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: directory,
    env: { BOARDROOM_HOME: path.join(directory, "home"), AGENT_STUDIO_DATA_DIR: path.dirname(source), AGENT_STUDIO_DB_DRIVER: "sqlite" },
    encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.codes, ["native_retirement_unknown", "native_retirement_unknown"]);
  assert.equal(observed.state.length, 1); assert.equal(observed.state[0].dbPhase, "unknown"); assert.equal(observed.state[0].dbOpen, !closed);
  assert.ok(observed.state[0].files.every((phase: string) => phase === "open"));
  assert.ok(observed.state[0].fileOpen.every((open: boolean) => open === true));
  assert.deepEqual(observed.state[0].failures, ["database-close"]);
}));

test("SQ-D02 I01：binary fd关闭未知仍保留实际fd owner且不盲重试（隔离副本）", { skip: !linux }, t => fixture((directory, source) => {
  sample(source);
  const url = derive(directory, t, "unknown-binary-fd-close", code => {
    const anchor = 'closeSync(file.fd); file.phase = "closed";';
    assert.equal(code.split(anchor).length, 2);
    return code.replace(anchor, 'if (file.path.endsWith("/extension.so")) throw new Error("isolated-open-fd-close-unknown"); ' + anchor);
  });
  const code = "import{inspectSelectedSqlitePathBinding as inspect,__privateObservation as state}from " + JSON.stringify(url) + ";" +
    "const codes=[];for(let i=0;i<2;i++){try{await inspect();codes.push('unexpected-success')}catch(e){codes.push(e.code)}}console.log(JSON.stringify({codes,state:state()}));";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: directory,
    env: { BOARDROOM_HOME: path.join(directory, "home"), AGENT_STUDIO_DATA_DIR: path.dirname(source), AGENT_STUDIO_DB_DRIVER: "sqlite" },
    encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.codes, ["native_retirement_unknown", "native_retirement_unknown"]);
  assert.equal(observed.state.length, 1); assert.equal(observed.state[0].dbPhase, "closed");
  assert.equal(observed.state[0].files.filter((phase: string) => phase === "unknown").length, 1);
  assert.equal(observed.state[0].fileOpen.filter((open: boolean) => open === true).length, 1);
  assert.deepEqual(observed.state[0].failures, ["file-close"]);
}));

test("SQ-D02 I01：原入口不读取伪造选项且实际source/binary fd均已关闭", { skip: !linux }, () => fixture((directory, source) => {
  sample(source);
  const code = "import{inspectSelectedSqlitePathBinding as inspect}from " + JSON.stringify(moduleUrl) + ";" +
    "import{readdirSync,readlinkSync}from'node:fs';let traps=0;const fake=new Proxy({}, {get(){traps++;throw Error('not-readable')},ownKeys(){traps++;throw Error('not-readable')}});" +
    "const value=await inspect(fake);const remaining=readdirSync('/proc/self/fd').flatMap(n=>{try{return[readlinkSync('/proc/self/fd/'+n)]}catch{return[]}}).filter(p=>p===value.sqlitePath||p.endsWith('/extension.so'));console.log(JSON.stringify({traps,remaining,value}));";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: directory,
    env: { BOARDROOM_HOME: path.join(directory, "home"), AGENT_STUDIO_DATA_DIR: path.dirname(source), AGENT_STUDIO_DB_DRIVER: "sqlite" },
    encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout); assert.equal(observed.traps, 0); assert.deepEqual(observed.remaining, []);
  assert.equal(observed.value.sqlitePath, source);
}));
