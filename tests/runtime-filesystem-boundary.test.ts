import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readlink, readdir, rm, link, rename, stat, lstat, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { linuxIsolationAvailable, prepareLinuxIsolation, spawnIsolatedProcess, validateWorkdirFilesystemBoundary, verifiedBubblewrapVersion,
  type PreparedLinuxIsolation } from "../src/server/runtime/isolation/linux.ts";
import { createPipeBridge } from "../src/server/runtime/isolation/pipe-bridge.ts";

const exec = promisify(execFile);
const SAFE_ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const linuxOnly = { skip: process.platform !== "linux" };
const unsafe = /^Error: workdir_unsafe$/;
const prepareAvailable = process.platform === "linux" && await exec("/usr/bin/bwrap", ["--version"], { timeout: 3000, env: SAFE_ENV })
  .then(result => verifiedBubblewrapVersion(result.stdout)).catch(() => false);
const preparationOnly = { skip: prepareAvailable ? false : "当前没有已核实的 bwrap 0.12.0；不执行低层挂载准备" };
let mountNamespaceProbe: Promise<boolean> | undefined;
function mountNamespaceAvailable(): Promise<boolean> {
  return mountNamespaceProbe ??= exec("/usr/bin/unshare", ["--user", "--map-root-user", "--mount", "--fork", "/bin/true"], { timeout: 3000, env: SAFE_ENV }).then(() => true, () => false);
}
async function inMountNamespace(source: string, network = false): Promise<Record<string, unknown>> {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--mount", ...(network ? ["--net"] : []), "--fork", "--kill-child=SIGKILL", process.execPath, "--input-type=module", "-e", source],
    { timeout: 15_000, maxBuffer: 16_384, encoding: "utf8", env: SAFE_ENV });
  return JSON.parse(result.stdout);
}
async function descriptorCount(): Promise<number> { return (await readdir("/proc/self/fd")).length; }

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "br-fs-boundary-"));
  const workdir = path.join(root, "work"); const control = path.join(root, "control"); const stateRoot = path.join(root, "state");
  const bindingId = "filesystem-canary";
  const sessionDir = path.join(stateRoot, "sessions", createHash("sha256").update(bindingId).digest("hex").slice(0, 32));
  await mkdir(workdir); await mkdir(control); await mkdir(sessionDir, { recursive: true });
  const protectedFile = path.join(control, "database-canary"); const credential = path.join(control, "synthetic-credential");
  await writeFile(protectedFile, "CONTROL_BEFORE"); await writeFile(credential, "SYNTHETIC_CREDENTIAL_BEFORE");
  const input = { executable: process.execPath, argv: ["-e", "process.exit(0)"], prompt: "", workdir, stateRoot, bindingId,
    protectedPaths: [control], egressHosts: [], credentialMounts: [{ source: credential, destination: "/home/runner/.claude/.credentials.json" }] };
  return { root, workdir, control, stateRoot, sessionDir, protectedFile, credential, input,
    async unchanged() {
      assert.equal(await readFile(protectedFile, "utf8"), "CONTROL_BEFORE");
      assert.equal(await readFile(credential, "utf8"), "SYNTHETIC_CREDENTIAL_BEFORE");
    }, close: () => rm(root, { recursive: true, force: true }) };
}

async function runCanary(prepared: PreparedLinuxIsolation): Promise<Record<string, unknown>> {
  const child = spawnIsolatedProcess(prepared); let output = ""; let stderr = ""; let invalid = false;
  const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  child.stderr?.on("data", bytes => { stderr += bytes; });
  const bridge = createPipeBridge(child, { egressHosts: [], onStdout: bytes => { output += bytes; }, onInvalid: () => { invalid = true; } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await bridge.transport.start();
    await prepared.verifyWritableBoundary();
    await bridge.start();
    assert.equal(await ended, 0, stderr);
    assert.equal(invalid, false);
    return JSON.parse(output);
  } finally { clearTimeout(timer); child.kill("SIGKILL"); bridge.close(); await ended.catch(() => {}); }
}

test("R3 bwrap 只放行已核对 FD 挂载后身份检查的固定版本", () => {
  assert.equal(verifiedBubblewrapVersion("bubblewrap 0.12.0\n"), true);
  for (const output of ["bubblewrap 0.11.0\n", "bubblewrap 0.13.0\n", "bubblewrap 1.0.0\n", "--bind-fd FD DEST", "0.12.0", "bubblewrap 0.12.0-custom\n", "bubblewrap 0.12.0\nextra", "bubblewrap 0.12.0\n\n"]) {
    assert.equal(verifiedBubblewrapVersion(output), false, output);
  }
});

test("R3 普通树和原始字节文件名可通过；目录软链接和外部软链接不跟随", linuxOnly, async t => {
  const f = await fixture(); let prepared: PreparedLinuxIsolation | undefined;
  try {
    await mkdir(path.join(f.workdir, "nested"));
    await writeFile(path.join(f.workdir, "nested", "project.txt"), "project");
    await writeFile(Buffer.concat([Buffer.from(`${f.workdir}/`), Buffer.from([0xff])]), "raw filename");
    await symlink("nested", path.join(f.workdir, "directory-link"));
    await symlink(".", path.join(f.workdir, "loop"));
    await symlink(f.protectedFile, path.join(f.workdir, "outside"));
    await validateWorkdirFilesystemBoundary(f.workdir, f.input.protectedPaths);
    await t.test("实际准备持有同批根 FD，cleanup 后复核失败关闭", preparationOnly, async () => {
      const descriptorsBefore = await descriptorCount();
      prepared = await prepareLinuxIsolation(f.input);
      const inheritedPaths = await Promise.all(prepared.inheritedFds.map(fd => readlink(`/proc/self/fd/${fd}`)));
      for (const metadataPath of [f.stateRoot, path.dirname(f.sessionDir), f.control]) assert.equal(inheritedPaths.includes(metadataPath), false, "管理目录的元数据 FD 不传给 child");
      await prepared.verifyWritableBoundary();
      await f.unchanged();
      await prepared.cleanup();
      await assert.rejects(prepared.verifyWritableBoundary(), unsafe);
      assert.equal(await descriptorCount(), descriptorsBefore, "cleanup 回收挂载及元数据 FD");
    });
  } finally { await prepared?.cleanup(); await f.close(); }
});

for (const mount of ["workdir", "sessionDir"] as const) {
  for (const source of ["protectedFile", "credential"] as const) {
    test(`R3 ${mount} 预置 ${source} 硬链接被拒绝且源文件不变`, linuxOnly, async t => {
      const f = await fixture();
      try {
        await link(f[source], path.join(f[mount], "alias"));
        await assert.rejects(validateWorkdirFilesystemBoundary(f[mount], f.input.protectedPaths), unsafe);
        await t.test("实际挂载准备拒绝并回收本次 launch 目录", preparationOnly, async () => {
          const descriptorsBefore = await descriptorCount();
          await assert.rejects(prepareLinuxIsolation(f.input), unsafe);
          assert.equal((await readdir(f.stateRoot)).some(name => name.startsWith("launch-")), false);
          assert.equal(await descriptorCount(), descriptorsBefore, "拒绝路径也回收挂载及元数据 FD");
        });
        await f.unchanged();
      } finally { await f.close(); }
    });
  }
}

test("R3 纯项目内部硬链接也拒绝，不把多链接 inode 猜作安全来源", linuxOnly, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.workdir, "original"), "project");
    await link(path.join(f.workdir, "original"), path.join(f.workdir, "alias"));
    await assert.rejects(validateWorkdirFilesystemBoundary(f.workdir, f.input.protectedPaths), unsafe);
    await unlink(path.join(f.workdir, "alias"));
    await validateWorkdirFilesystemBoundary(f.workdir, f.input.protectedPaths);
  } finally { await f.close(); }
});

for (const mount of ["workdir", "sessionDir"] as const) {
  test(`R3 放行前复核会拒绝 prepare 之后加入 ${mount} 的硬链接`, preparationOnly, async () => {
    const f = await fixture(); let prepared: PreparedLinuxIsolation | undefined;
    try {
      prepared = await prepareLinuxIsolation(f.input);
      await link(f.protectedFile, path.join(f[mount], "late-alias"));
      await assert.rejects(prepared.verifyWritableBoundary(), unsafe);
      await f.unchanged();
    } finally { await prepared?.cleanup(); await f.close(); }
  });
}

for (const existing of [false, true]) {
  test(`R3 凭据挂载点${existing ? "已有内容不改写" : "预建为空文件"}，避免 bwrap 与最终扫描争用目录元数据`, preparationOnly, async () => {
    const f = await fixture(); let prepared: PreparedLinuxIsolation | undefined;
    try {
      const mountpoint = path.join(f.sessionDir, ".credentials.json");
      if (existing) await writeFile(mountpoint, "SESSION_BEFORE", { mode: 0o600 });
      prepared = await prepareLinuxIsolation(f.input);
      assert.equal(await readFile(mountpoint, "utf8"), existing ? "SESSION_BEFORE" : "");
      assert.equal((await stat(mountpoint)).mode & 0o777, 0o600);
      await prepared.verifyWritableBoundary();
      await f.unchanged();
    } finally { await prepared?.cleanup(); await f.close(); }
  });
}

test("R3 现有凭据挂载点本身若是硬链接仍会拒绝，无凭据挂载时不新建文件", preparationOnly, async () => {
  const f = await fixture(); let prepared: PreparedLinuxIsolation | undefined;
  try {
    const mountpoint = path.join(f.sessionDir, ".credentials.json");
    await link(f.credential, mountpoint);
    await assert.rejects(prepareLinuxIsolation(f.input), unsafe);
    await f.unchanged();
    await unlink(mountpoint);
    prepared = await prepareLinuxIsolation({ ...f.input, credentialMounts: [] });
    await assert.rejects(lstat(mountpoint), { code: "ENOENT" });
  } finally { await prepared?.cleanup(); await f.close(); }
});

test("R3 FIFO 不会被阻塞打开，扫描按固定原因拒绝", { ...linuxOnly, timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    await exec("/usr/bin/mkfifo", [path.join(f.workdir, "pipe")], { timeout: 1000, env: SAFE_ENV });
    await assert.rejects(validateWorkdirFilesystemBoundary(f.workdir, f.input.protectedPaths), unsafe);
  } finally { await f.close(); }
});

test("R3 socket inode 不能通过可写目录进入隔离", { ...linuxOnly, timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    const socket = path.join(f.workdir, "socket");
    // 只创建实际 socket 类型的 inode；不需要监听或打开被扫描对象。
    await exec("/usr/bin/python3", ["-c", "import os, stat, sys; os.mknod(sys.argv[1], stat.S_IFSOCK | 0o600)", socket], { timeout: 1000, env: SAFE_ENV });
    assert.equal((await lstat(socket)).isSocket(), true);
    await assert.rejects(validateWorkdirFilesystemBoundary(f.workdir, f.input.protectedPaths), unsafe);
  } finally { await f.close(); }
});

test("R3 过深目录按固定原因拒绝，不无限持有遍历 FD", { ...linuxOnly, timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    let directory = f.workdir;
    for (let depth = 0; depth < 129; depth++) { directory = path.join(directory, "d"); await mkdir(directory); }
    await assert.rejects(validateWorkdirFilesystemBoundary(f.workdir, f.input.protectedPaths), unsafe);
  } finally { await f.close(); }
});

test("R3 同设备嵌套 bind mount 在初次扫描和放行前复核均被拒绝", { ...preparationOnly, timeout: 15_000 }, async t => {
  try { await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--mount", "--fork", "/bin/true"], { timeout: 3000, env: SAFE_ENV }); }
  catch { t.skip("当前环境不支持真实 user/mount namespace；不以模拟 mount ID 代替"); return; }
  const f = await fixture();
  try {
    const mountSource = path.join(f.root, "mount-source"); const mountTarget = path.join(f.workdir, "mounted");
    await mkdir(mountSource); await mkdir(mountTarget); await writeFile(path.join(mountSource, "file"), "MOUNT_BEFORE");
    const source = `
      import {execFileSync} from 'node:child_process';
      import {stat,open,readFile} from 'node:fs/promises';
      import {prepareLinuxIsolation} from ${JSON.stringify(new URL("../src/server/runtime/isolation/linux.ts", import.meta.url).href)};
      const input=${JSON.stringify(f.input)},source=${JSON.stringify(mountSource)},target=${JSON.stringify(mountTarget)};
      const mount=()=>execFileSync('/usr/bin/mount',['--bind',source,target],{env:${JSON.stringify(SAFE_ENV)}});
      const unmount=()=>execFileSync('/usr/bin/umount',[target],{env:${JSON.stringify(SAFE_ENV)}});
      const id=async p=>{const h=await open(p);try{return(await readFile('/proc/self/fdinfo/'+h.fd,'utf8')).match(/^mnt_id:\\s+(\\d+)$/m)[1]}finally{await h.close()}};
      execFileSync('/usr/bin/mount',['--make-rprivate','/'],{env:${JSON.stringify(SAFE_ENV)}});
      const result={};
      mount();try{
        result.sameDevice=(await stat(source)).dev===(await stat(target)).dev;
        result.differentMount=await id(source)!==await id(target);
        try{const p=await prepareLinuxIsolation(input);await p.cleanup();result.initial='accepted'}catch(e){result.initial=e.message}
      }finally{unmount()}
      const prepared=await prepareLinuxIsolation(input);
      mount();try{try{await prepared.verifyWritableBoundary();result.final='accepted'}catch(e){result.final=e.message}}
      finally{unmount();await prepared.cleanup()}
      console.log(JSON.stringify(result));`;
    const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--mount", "--fork", process.execPath, "--input-type=module", "-e", source],
      { timeout: 10_000, maxBuffer: 8192, encoding: "utf8", env: SAFE_ENV });
    assert.deepEqual(JSON.parse(result.stdout), { sameDevice: true, differentMount: true, initial: "workdir_unsafe", final: "workdir_unsafe" });
    assert.equal(await readFile(path.join(mountSource, "file"), "utf8"), "MOUNT_BEFORE");
    await f.unchanged();
  } finally { await f.close(); }
});

test("R3 真实隔离仍实时写回两个 RW 目录，外部软链接不可达，凭据不能生成工作区硬链接", { timeout: 20_000 }, async t => {
  if (!await linuxIsolationAvailable()) { t.skip("已验证版本/namespace 原语不可用；不声明实际挂载通过"); return; }
  const f = await fixture(); let prepared: PreparedLinuxIsolation | undefined;
  try {
    await symlink(f.protectedFile, path.join(f.workdir, "outside"));
    const source = `
      import fs from 'node:fs';const result={};
      fs.writeFileSync('allowed','WORK_WRITTEN');fs.writeFileSync('/home/runner/.claude/allowed','SESSION_WRITTEN');
      try{fs.readFileSync('outside');result.symlink='exposed'}catch{result.symlink='denied'}
      try{fs.linkSync('/home/runner/.claude/.credentials.json','credential-alias');result.credentialLink='created'}catch(e){result.credentialLink=e.code}
      try{fs.writeFileSync('/home/runner/.claude/.credentials.json','changed');result.credentialWrite='written'}catch{result.credentialWrite='denied'}
      const status=fs.readFileSync('/proc/self/status','utf8');
      result.noCapabilities=/^CapEff:\\s+0+$/m.test(status)&&/^CapPrm:\\s+0+$/m.test(status);
      console.log(JSON.stringify(result));`;
    prepared = await prepareLinuxIsolation({ ...f.input, argv: ["--input-type=module", "-e", source] });
    assert.deepEqual(await runCanary(prepared), { symlink: "denied", credentialLink: "EXDEV", credentialWrite: "denied", noCapabilities: true });
    assert.equal(await readFile(path.join(f.workdir, "allowed"), "utf8"), "WORK_WRITTEN");
    assert.equal(await readFile(path.join(f.sessionDir, "allowed"), "utf8"), "SESSION_WRITTEN");
    await f.unchanged();
  } finally { await prepared?.cleanup(); await f.close(); }
});

test("R3 真实 bootstrap 等待放行时新增别名被拒绝，子命令没有执行", { timeout: 20_000 }, async t => {
  if (!await linuxIsolationAvailable()) { t.skip("已验证版本/namespace 原语不可用；未执行真实启动门禁 canary"); return; }
  const f = await fixture(); let prepared: PreparedLinuxIsolation | undefined;
  try {
    prepared = await prepareLinuxIsolation({ ...f.input, argv: ["-e", "require('node:fs').writeFileSync('CLI_MUST_NOT_RUN','ran')"] });
    const child = spawnIsolatedProcess(prepared);
    const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const ready = new Promise<void>(resolve => {
      let frames = "";
      child.stdout!.on("data", bytes => { frames += bytes; if (frames.includes('"kind":"bridge_ready"')) resolve(); });
    });
    const bridge = createPipeBridge(child, { egressHosts: [], onStdout: () => assert.fail("子命令不应产生输出"), onInvalid: () => assert.fail("invalid bridge") });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      await bridge.transport.start();
      await Promise.race([ready, ended.then(() => assert.fail("bootstrap 未就绪就退出"))]);
      await link(f.protectedFile, path.join(f.sessionDir, "late-alias"));
      await assert.rejects(prepared.verifyWritableBoundary(), unsafe);
      await bridge.stopAtSafePoint();
      assert.equal(await ended, 0);
      await assert.rejects(readFile(path.join(f.workdir, "CLI_MUST_NOT_RUN")), { code: "ENOENT" });
      await f.unchanged();
    } finally { clearTimeout(timer); child.kill("SIGKILL"); bridge.close(); await ended.catch(() => {}); }
  } finally { await prepared?.cleanup(); await f.close(); }
});

test("R3 原工作目录路径换根后，复核及真实 bwrap 仍使用原 pinned inode", { timeout: 20_000 }, async t => {
  if (!await linuxIsolationAvailable()) { t.skip("已验证版本/namespace 原语不可用；不把 FD 单测当实际挂载证据"); return; }
  const f = await fixture(); let prepared: PreparedLinuxIsolation | undefined;
  try {
    await writeFile(path.join(f.workdir, "identity"), "ORIGINAL");
    const original = await stat(f.workdir);
    const source = `import fs from 'node:fs';const s=fs.statSync('.');fs.writeFileSync('write-through','PINNED');console.log(JSON.stringify({identity:fs.readFileSync('identity','utf8'),dev:s.dev,ino:s.ino}));`;
    prepared = await prepareLinuxIsolation({ ...f.input, argv: ["--input-type=module", "-e", source] });
    const moved = path.join(f.root, "moved-original");
    await rename(f.workdir, moved); await mkdir(f.workdir);
    await link(f.protectedFile, path.join(f.workdir, "replacement-alias"));
    // 原路径现在不安全；已准备的挂载和最后复核仍只能看到原根 FD。
    await assert.rejects(validateWorkdirFilesystemBoundary(f.workdir, f.input.protectedPaths), unsafe);
    assert.deepEqual(await runCanary(prepared), { identity: "ORIGINAL", dev: original.dev, ino: original.ino });
    assert.equal(await readFile(path.join(moved, "write-through"), "utf8"), "PINNED");
    await assert.rejects(readFile(path.join(f.workdir, "write-through")), { code: "ENOENT" });
    await f.unchanged();
  } finally { await prepared?.cleanup(); await f.close(); }
});

test("R3 无法解析的保护软链接不能被当作不存在的普通叶子", linuxOnly, async () => {
  const f = await fixture();
  try {
    const dangling = path.join(f.root, "declared-protection");
    await symlink(path.join(f.control, "missing"), dangling);
    await assert.rejects(validateWorkdirFilesystemBoundary(f.workdir, [dangling]), unsafe);
    await assert.rejects(validateWorkdirFilesystemBoundary(f.workdir, [path.join(dangling, "child")]), unsafe);
  } finally { await f.close(); }
});

test("R3 保护路径的 symlink/.. 按实际目录解析，不能先消掉路径组件", linuxOnly, async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.control, "nested"));
    const alias = path.join(f.root, "control-child-alias"); await symlink(path.join(f.control, "nested"), alias);
    await assert.rejects(validateWorkdirFilesystemBoundary(f.control, [`${alias}/../database-canary`]), unsafe);
  } finally { await f.close(); }
});

for (const scenario of ["protected-root", "protected-child", "ancestor-bind", "protected-alias", "missing-protected-leaf", "escaped-root"] as const) {
  test(`R3 mountinfo 归一拒绝根别名 ${scenario}，即使所有普通文件 nlink=1`, { ...linuxOnly, timeout: 20_000 }, async t => {
    if (!await mountNamespaceAvailable()) { t.skip("当前环境不能建立真实 mount namespace；不模拟挂载坐标"); return; }
    const f = await fixture();
    try {
      const nested = path.join(f.control, "nested"); await mkdir(nested);
      const nestedFile = path.join(nested, "private"); await writeFile(nestedFile, "NESTED_BEFORE");
      let source = f.control; let target = f.workdir; let workdir = f.workdir;
      let protectedPaths = [f.control]; let canary = f.protectedFile;
      if (scenario === "protected-child") { source = nested; canary = nestedFile; }
      if (scenario === "ancestor-bind") { workdir = path.join(f.workdir, "nested"); canary = nestedFile; }
      if (scenario === "protected-alias") {
        target = path.join(f.root, "protected-alias"); await mkdir(target);
        workdir = nested; protectedPaths = [target]; canary = nestedFile;
      }
      if (scenario === "missing-protected-leaf") protectedPaths = [path.join(f.control, "not-created", "future-data")];
      if (scenario === "escaped-root") {
        source = path.join(f.root, "protected space \\040literal"); await mkdir(source);
        canary = path.join(source, "private"); await writeFile(canary, "ESCAPED_BEFORE"); protectedPaths = [source];
      }
      const before = await readFile(canary, "utf8");
      const input = { ...f.input, workdir, protectedPaths, credentialMounts: [] };
      const probe = `
        import {execFileSync} from 'node:child_process';import {stat,realpath,readdir} from 'node:fs/promises';
        import {prepareLinuxIsolation,validateWorkdirFilesystemBoundary} from ${JSON.stringify(new URL("../src/server/runtime/isolation/linux.ts", import.meta.url).href)};
        const input=${JSON.stringify(input)},source=${JSON.stringify(source)},target=${JSON.stringify(target)};
        execFileSync('/usr/bin/mount',['--make-rprivate','/'],{env:${JSON.stringify(SAFE_ENV)}});
        execFileSync('/usr/bin/mount',['--bind',source,target],{env:${JSON.stringify(SAFE_ENV)}});
        const result={nlink:(await stat(${JSON.stringify(canary)})).nlink};
        try{
          const fds=(await readdir('/proc/self/fd')).length;
          try{await validateWorkdirFilesystemBoundary(await realpath(input.workdir),input.protectedPaths);result.preflight='accepted'}catch(e){result.preflight=e.message}
          if(${prepareAvailable}){try{const p=await prepareLinuxIsolation(input);await p.cleanup();result.prepare='accepted'}catch(e){result.prepare=e.message}}
          else result.prepare='not-run';
          result.noDescriptorLeak=(await readdir('/proc/self/fd')).length===fds;
        }finally{execFileSync('/usr/bin/umount',[target],{env:${JSON.stringify(SAFE_ENV)}})}
        console.log(JSON.stringify(result));`;
      assert.deepEqual(await inMountNamespace(probe), { nlink: 1, preflight: "workdir_unsafe", prepare: prepareAvailable ? "workdir_unsafe" : "not-run", noDescriptorLeak: true });
      if (!prepareAvailable) t.diagnostic("仅验证实际 FD preflight；当前没有已核实 bwrap，未执行 prepare 集成");
      assert.equal(await readFile(canary, "utf8"), before); await f.unchanged();
    } finally { await f.close(); }
  });
}

for (const mount of ["sessionsRoot", "sessionDir"] as const) {
  test(`R3 ${mount} 根 bind 别名在创建会话目录或挂载点之前拒绝`, { ...preparationOnly, timeout: 20_000 }, async t => {
    if (!await mountNamespaceAvailable()) { t.skip("当前环境不能建立真实 mount namespace"); return; }
    const f = await fixture();
    try {
      const target = mount === "sessionsRoot" ? path.dirname(f.sessionDir) : f.sessionDir;
      const probe = `
        import {execFileSync} from 'node:child_process';import {readdir} from 'node:fs/promises';
        import {prepareLinuxIsolation} from ${JSON.stringify(new URL("../src/server/runtime/isolation/linux.ts", import.meta.url).href)};
        const input=${JSON.stringify(f.input)},source=${JSON.stringify(f.control)},target=${JSON.stringify(target)};
        execFileSync('/usr/bin/mount',['--make-rprivate','/'],{env:${JSON.stringify(SAFE_ENV)}});
        execFileSync('/usr/bin/mount',['--bind',source,target],{env:${JSON.stringify(SAFE_ENV)}});
        const names=JSON.stringify((await readdir(source)).sort()),fds=(await readdir('/proc/self/fd')).length,result={};
        try{try{const p=await prepareLinuxIsolation(input);await p.cleanup();result.prepare='accepted'}catch(e){result.prepare=e.message}
          result.noPreparationWrite=JSON.stringify((await readdir(source)).sort())===names;
          result.noDescriptorLeak=(await readdir('/proc/self/fd')).length===fds;
        }finally{execFileSync('/usr/bin/umount',[target],{env:${JSON.stringify(SAFE_ENV)}})}
        console.log(JSON.stringify(result));`;
      assert.deepEqual(await inMountNamespace(probe), { prepare: "workdir_unsafe", noPreparationWrite: true, noDescriptorLeak: true });
      await f.unchanged();
    } finally { await f.close(); }
  });
}

test("R3 与保护区无关的合法根 bind 仍能通过并真实写回原目录", { ...preparationOnly, timeout: 20_000 }, async t => {
  if (!await mountNamespaceAvailable() || !await linuxIsolationAvailable()) { t.skip("当前环境缺少已核实版本或真实 namespace 原语"); return; }
  const f = await fixture();
  try {
    const ordinary = path.join(f.root, "ordinary-project"); await mkdir(ordinary);
    const input = { ...f.input, argv: ["-e", "require('node:fs').writeFileSync('allowed-root-bind','LIVE_WRITE')"] };
    const probe = `
      import {execFileSync} from 'node:child_process';
      import {prepareLinuxIsolation,validateWorkdirFilesystemBoundary,spawnIsolatedProcess} from ${JSON.stringify(new URL("../src/server/runtime/isolation/linux.ts", import.meta.url).href)};
      import {createPipeBridge} from ${JSON.stringify(new URL("../src/server/runtime/isolation/pipe-bridge.ts", import.meta.url).href)};
      const input=${JSON.stringify(input)},target=input.workdir;
      execFileSync('/usr/bin/mount',['--make-rprivate','/'],{env:${JSON.stringify(SAFE_ENV)}});
      execFileSync('/usr/bin/mount',['--bind',${JSON.stringify(ordinary)},target],{env:${JSON.stringify(SAFE_ENV)}});
      let prepared,child,bridge,timer;const result={};
      try{
        await validateWorkdirFilesystemBoundary(target,input.protectedPaths);result.preflight='accepted';
        prepared=await prepareLinuxIsolation(input);child=spawnIsolatedProcess(prepared);
        const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
        bridge=createPipeBridge(child,{egressHosts:[],onStdout:()=>{},onInvalid:()=>{throw new Error('invalid_bridge')}});
        timer=setTimeout(()=>child.kill('SIGKILL'),10000);
        await bridge.transport.start();await prepared.verifyWritableBoundary();await bridge.start();result.exitCode=await ended;
      }finally{clearTimeout(timer);child?.kill('SIGKILL');bridge?.close();await prepared?.cleanup();execFileSync('/usr/bin/umount',[target],{env:${JSON.stringify(SAFE_ENV)}})}
      console.log(JSON.stringify(result));`;
    assert.deepEqual(await inMountNamespace(probe), { preflight: "accepted", exitCode: 0 });
    assert.equal(await readFile(path.join(ordinary, "allowed-root-bind"), "utf8"), "LIVE_WRITE");
    await f.unchanged();
  } finally { await f.close(); }
});

test("R3 放行前按原 FD 的当前位置复核，移入保护目录的工作根会拒绝", preparationOnly, async () => {
  const f = await fixture(); let prepared: PreparedLinuxIsolation | undefined;
  try {
    prepared = await prepareLinuxIsolation(f.input);
    await rename(f.workdir, path.join(f.control, "moved-work"));
    await assert.rejects(prepared.verifyWritableBoundary(), unsafe);
    await f.unchanged();
  } finally { await prepared?.cleanup(); await f.close(); }
});

test("R3 无关 nsfs 和非 UTF-8 挂载不影响普通树，相关特殊挂载仍失败关闭", { ...linuxOnly, timeout: 20_000 }, async t => {
  try { await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--mount", "--net", "--fork", "/bin/true"], { timeout: 3000, env: SAFE_ENV }); }
  catch { t.skip("当前环境不能建立真实 mount/net namespace；不模拟特殊挂载记录"); return; }
  const f = await fixture();
  try {
    const unrelated = path.join(f.root, "namespace-file"); const nested = path.join(f.workdir, "namespace-file");
    const ordinary = path.join(f.root, "ordinary-mount-source"); await mkdir(ordinary);
    await writeFile(unrelated, ""); await writeFile(nested, "");
    const bytesMount = "import os, subprocess, sys\np=os.fsencode(sys.argv[1])+b'/opaque-\\xff'\nif sys.argv[2]=='mount':\n os.mkdir(p)\n subprocess.run([b'/usr/bin/mount',b'--bind',os.fsencode(sys.argv[3]),p],check=True)\nelse:\n subprocess.run([b'/usr/bin/umount',p],check=True)\n";
    const probe = `
      import {execFileSync} from 'node:child_process';import {open,readFile} from 'node:fs/promises';
      import {validateWorkdirFilesystemBoundary} from ${JSON.stringify(new URL("../src/server/runtime/isolation/linux.ts", import.meta.url).href)};
      const root=${JSON.stringify(f.root)},workdir=${JSON.stringify(f.workdir)},protectedPaths=${JSON.stringify(f.input.protectedPaths)},unrelated=${JSON.stringify(unrelated)},nested=${JSON.stringify(nested)};
      const env=${JSON.stringify(SAFE_ENV)},result={};let outsideMounted=false,bytesMounted=false,nestedMounted=false;
      const check=async paths=>{try{await validateWorkdirFilesystemBoundary(workdir,paths);return 'accepted'}catch(e){return e.message}};
      const mount=target=>execFileSync('/usr/bin/mount',['--bind','/proc/self/ns/net',target],{env});
      const unmount=target=>execFileSync('/usr/bin/umount',[target],{env});
      execFileSync('/usr/bin/mount',['--make-rprivate','/'],{env});
      try{
        result.before=await check(protectedPaths);mount(unrelated);outsideMounted=true;
        const handle=await open(unrelated,0x200000);
        try{
          const id=(await readFile('/proc/self/fdinfo/'+handle.fd,'utf8')).match(/^mnt_id:\\s+(\\d+)$/m)[1];
          const record=(await readFile('/proc/self/mountinfo','utf8')).split('\\n').map(line=>line.split(' ')).find(fields=>fields[0]===id);
          result.opaqueNsfs=record[record.indexOf('-')+1]==='nsfs'&&!record[3].startsWith('/');
        }finally{await handle.close()}
        result.unrelated=await check(protectedPaths);
        execFileSync('/usr/bin/python3',['-c',${JSON.stringify(bytesMount)},root,'mount',${JSON.stringify(ordinary)}],{env});bytesMounted=true;
        const raw=await readFile('/proc/self/mountinfo');result.nonUtf8MountRecord=!Buffer.from(raw.toString('utf8')).equals(raw);
        result.unrelatedNonUtf8=await check(protectedPaths);
        mount(nested);nestedMounted=true;result.nested=await check(protectedPaths);unmount(nested);nestedMounted=false;
        result.protected=await check([unrelated]);
        execFileSync('/usr/bin/python3',['-c',${JSON.stringify(bytesMount)},root,'unmount',${JSON.stringify(ordinary)}],{env});bytesMounted=false;
        unmount(unrelated);outsideMounted=false;result.after=await check(protectedPaths);
      }finally{
        if(nestedMounted)unmount(nested);
        if(bytesMounted)execFileSync('/usr/bin/python3',['-c',${JSON.stringify(bytesMount)},root,'unmount',${JSON.stringify(ordinary)}],{env});
        if(outsideMounted)unmount(unrelated);
      }
      console.log(JSON.stringify(result));`;
    assert.deepEqual(await inMountNamespace(probe, true), { before: "accepted", opaqueNsfs: true, unrelated: "accepted", nonUtf8MountRecord: true,
      unrelatedNonUtf8: "accepted", nested: "workdir_unsafe", protected: "workdir_unsafe", after: "accepted" });
    await f.unchanged();
  } finally { await f.close(); }
});
