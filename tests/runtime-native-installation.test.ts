import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findNativeInstallation, nativeExecutableCandidates, resolveNativeInstallation } from "../src/server/runtime/hosts/native-installation.ts";
import { VERIFIED_HOST_PROFILES, type HostInstallation, type VerifiedHostProfile } from "../src/server/runtime/hosts/types.ts";
import { linuxIsolationAvailable } from "../src/server/runtime/isolation/linux.ts";

/** 合成profile只测试固定策略解析，不加入VERIFIED_HOST_PROFILES，也不代表真实CLI支持。 */
const profile: VerifiedHostProfile = { backend: "claude-code", version: "0.0.0-test", platform: "linux", architecture: process.arch,
  executableSha256: "0".repeat(64), mode: "auto", evidence: "synthetic-layout-test-only", isolationProfile: "linux-private-net-v1",
  nativeCredentialLayout: "claude-linux-user-login-v1", egressPolicy: "anthropic-api-oauth-v1", resumeVerified: false };
const SENTINEL = "SYNTHETIC_CREDENTIAL_MARKER_NOT_REAL_SECRET";
const linuxLayoutOptions = { skip: process.platform !== "linux" ? "Linux 原生凭据布局仅在 Linux 验证；非 Linux 拒绝路径另测" : false };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "br-native-login-"));
  const home = path.join(root, "home"); const nativeDir = path.join(home, ".claude");
  const executable = path.join(home, ".local", "bin", "claude");
  await mkdir(path.dirname(executable), { recursive: true }); await mkdir(nativeDir);
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const credentials = path.join(nativeDir, ".credentials.json");
  const installation: HostInstallation = { backend: "claude-code", executable };
  return { root, home, nativeDir, credentials, installation, close: () => rm(root, { recursive: true, force: true }) };
}

test("R3 默认二进制发现可接原生Linux布局，凭据只生成固定只读挂载与固定出口", linuxLayoutOptions, async () => {
  const f = await fixture();
  try {
    // 故意不是JSON：resolver没有解析凭据，元信息通过也不声称token有效。
    await writeFile(f.credentials, SENTINEL, { mode: 0o600 });
    const discovered = await findNativeInstallation("claude-code", f.home);
    assert(discovered); assert(nativeExecutableCandidates("claude-code", f.home).includes(discovered.executable));
    const resolved = await resolveNativeInstallation(discovered, profile, f.home);
    assert.deepEqual(resolved.credentialMounts, [{ source: f.credentials, destination: "/home/runner/.claude/.credentials.json" }]);
    assert.deepEqual(resolved.egressHosts, ["api.anthropic.com", "claude.ai", "platform.claude.com"]);
    assert(!JSON.stringify(resolved).includes(SENTINEL));
    assert.equal(await readFile(f.credentials, "utf8"), SENTINEL, "合成源文件没有被重写");
  } finally { await f.close(); }
});

for (const kind of ["missing", "directory", "file-symlink", "directory-symlink"] as const) {
  test(`R3 原生凭据${kind}不能成为受信认证挂载`, linuxLayoutOptions, async () => {
    const f = await fixture();
    try {
      if (kind === "directory") await mkdir(f.credentials);
      if (kind === "file-symlink") {
        const outside = path.join(f.root, "outside-token"); await writeFile(outside, SENTINEL, { mode: 0o600 });
        await symlink(outside, f.credentials);
      }
      if (kind === "directory-symlink") {
        const outside = path.join(f.root, "outside-login"); await mkdir(outside);
        await writeFile(path.join(outside, ".credentials.json"), SENTINEL, { mode: 0o600 });
        await rm(f.nativeDir, { recursive: true }); await symlink(outside, f.nativeDir);
      }
      await assert.rejects(resolveNativeInstallation(f.installation, profile, f.home), /^Error: login_required$/);
    } finally { await f.close(); }
  });
}

test("R3 非Linux宿主拒绝Linux原生安装profile", { skip: process.platform === "linux" ? "仅在非 Linux 宿主验证平台保护" : false }, async () => {
  const f = await fixture();
  try {
    await writeFile(f.credentials, SENTINEL, { mode: 0o600 });
    await assert.rejects(resolveNativeInstallation(f.installation, profile, f.home), /^Error: profile_unsupported$/);
  } finally { await f.close(); }
});

test("R3 profile必须声明已知认证与出口策略，Codex/dsh和任意URL均失败关闭", async () => {
  const f = await fixture();
  try {
    await writeFile(f.credentials, SENTINEL, { mode: 0o600 });
    for (const patch of [
      { nativeCredentialLayout: "arbitrary-path" }, { egressPolicy: "https://127.0.0.1/api" },
      { egressPolicy: "custom.example" }, { egressPolicy: undefined }, { nativeCredentialLayout: undefined },
      { backend: "codex-cli" }, { backend: "dsh" }, { platform: "darwin" },
    ]) {
      await assert.rejects(resolveNativeInstallation(f.installation, { ...profile, ...patch } as VerifiedHostProfile, f.home), /^Error: profile_unsupported$/);
    }
  } finally { await f.close(); }
});

test("R3 installation附加任意mount/env/endpoint不能覆盖profile固定策略", linuxLayoutOptions, async () => {
  const profilesBefore = structuredClone(VERIFIED_HOST_PROFILES);
  const f = await fixture();
  try {
    await writeFile(f.credentials, SENTINEL, { mode: 0o600 });
    const unexpected = { ...f.installation, credentialMounts: [{ source: "/private/control", destination: "/home/runner/.claude/.credentials.json" }],
      egressHosts: ["attacker.example", "127.0.0.1"], env: { ANTHROPIC_API_KEY: SENTINEL }, endpoint: "http://127.0.0.1/api" };
    const resolved = await resolveNativeInstallation(unexpected, profile, f.home);
    assert.deepEqual(Object.keys(resolved).sort(), ["backend", "credentialMounts", "egressHosts", "executable"]);
    assert.equal(resolved.credentialMounts[0]?.source, f.credentials);
    assert.deepEqual(resolved.egressHosts, ["api.anthropic.com", "claude.ai", "platform.claude.com"]);
    assert(!JSON.stringify(resolved).includes(SENTINEL));
    assert.deepEqual(VERIFIED_HOST_PROFILES, profilesBefore, "合成策略解析不能改变已验证支持表");
  } finally { await f.close(); }
});

test("R3 合成原生登录文件在真实隔离HOME只读可见，服务端token/endpoint/env不继承", { timeout: 20_000 }, async t => {
  if (!await linuxIsolationAvailable()) { t.skip("隔离原语不可用；不把解析测试当作真实挂载通过"); return; }
  const profilesBefore = structuredClone(VERIFIED_HOST_PROFILES);
  const f = await fixture();
  try {
    await writeFile(f.credentials, SENTINEL, { mode: 0o600 });
    const workdir = path.join(f.root, "work"); await mkdir(workdir);
    const childSource = `
      import fs from 'node:fs/promises';
      const file='/home/runner/.claude/.credentials.json';
      const nativeReadable=(await fs.readFile(file,'utf8'))===${JSON.stringify(SENTINEL)};
      let readOnly=false; try {await fs.writeFile(file,'MUST_NOT_WRITE');} catch {readOnly=true;}
      const keys=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_PROFILE','ANTHROPIC_CONFIG_DIR','BOARDROOM_SERVER_ENV_CANARY'];
      console.log(JSON.stringify({nativeReadable,readOnly,envClean:keys.every(k=>process.env[k]===undefined),
        home:process.env.HOME==='/home/runner',configDir:process.env.CLAUDE_CONFIG_DIR==='/home/runner/.claude',
        fixedProxy:process.env.HTTPS_PROXY==='http://127.0.0.1:47632'}));`;
    // 单独的“服务端”进程只获得合成env，不读取或临时覆盖开发环境的真实凭据。
    const serviceSource = `
      import {findNativeInstallation,resolveNativeInstallation} from ${JSON.stringify(new URL("../src/server/runtime/hosts/native-installation.ts", import.meta.url).href)};
      import {prepareLinuxIsolation,spawnIsolatedProcess} from ${JSON.stringify(new URL("../src/server/runtime/isolation/linux.ts", import.meta.url).href)};
      import {createPipeBridge} from ${JSON.stringify(new URL("../src/server/runtime/isolation/pipe-bridge.ts", import.meta.url).href)};
      const installation=await findNativeInstallation('claude-code');
      if(!installation) throw new Error('synthetic_installation_missing');
      const resolved=await resolveNativeInstallation(installation,${JSON.stringify(profile)});
      const prepared=await prepareLinuxIsolation({executable:process.execPath,argv:['--input-type=module','-e',${JSON.stringify(childSource)}],prompt:'',
        workdir:${JSON.stringify(workdir)},stateRoot:${JSON.stringify(path.join(f.root, "state"))},bindingId:'native-layout-canary',
        protectedPaths:[${JSON.stringify(path.join(f.root, "control"))}],credentialMounts:resolved.credentialMounts,egressHosts:resolved.egressHosts});
      const child=spawnIsolatedProcess(prepared);let output='';
      const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
      const bridge=createPipeBridge(child,{egressHosts:resolved.egressHosts,onStdout:b=>{output+=b},onInvalid:()=>{throw new Error('invalid_pipe')}});
      child.stderr?.on('data',()=>{});
      try{await bridge.transport.start();await bridge.start();const code=await ended;if(code!==0)throw new Error('canary_failed');process.stdout.write(output)}
      finally{child.kill('SIGKILL');bridge.close();await prepared.cleanup()}`;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", serviceSource], {
      timeout: 15_000, maxBuffer: 4096, encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: f.home,
        CLAUDE_CONFIG_DIR: path.join(f.root, "untrusted-config"), ANTHROPIC_API_KEY: SENTINEL,
        ANTHROPIC_AUTH_TOKEN: SENTINEL, CLAUDE_CODE_OAUTH_TOKEN: SENTINEL, ANTHROPIC_BASE_URL: "http://127.0.0.1:9/api",
        ANTHROPIC_PROFILE: "untrusted-profile", ANTHROPIC_CONFIG_DIR: path.join(f.root, "untrusted-config"),
        HTTPS_PROXY: "http://127.0.0.1:9", BOARDROOM_SERVER_ENV_CANARY: SENTINEL },
    });
    assert.deepEqual(JSON.parse(result.stdout), { nativeReadable: true, readOnly: true, envClean: true, home: true, configDir: true, fixedProxy: true });
    assert.equal(await readFile(f.credentials, "utf8"), SENTINEL);
    assert.deepEqual(VERIFIED_HOST_PROFILES, profilesBefore, "隔离canary不能改变已验证支持表");
  } finally { await f.close(); }
});
