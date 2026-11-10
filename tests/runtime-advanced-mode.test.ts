import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHostArguments } from "../src/server/runtime/hosts/adapters.ts";
import { VERIFIED_HOST_PROFILES, type HostEvent, type HostLaunchSnapshot, type VerifiedHostProfile } from "../src/server/runtime/hosts/types.ts";
import { selectVerifiedHostProfile, type HostProfileIdentity } from "../src/server/runtime/hosts/profiles.ts";
import { createHostLauncher } from "../src/server/runtime/hosts/launcher.ts";
import { createHostOutputParser } from "../src/server/runtime/hosts/parser.ts";
import { linuxIsolationAvailable, prepareLinuxIsolation, spawnIsolatedProcess } from "../src/server/runtime/isolation/linux.ts";
import { createPipeBridge } from "../src/server/runtime/isolation/pipe-bridge.ts";

function snapshot(): HostLaunchSnapshot {
  return { bindingId: "advanced-binding", ownerId: "advanced-owner", generation: 1, revision: 2, backend: "claude-code",
    config: { workdir: "/tmp/advanced-work", permissionMode: "auto", bypass: false } };
}

test("R3 显式高级策略可构建独立模式，同时保留无人审批、配置来源和绑定 MCP 限制", () => {
  for (const permissionMode of ["auto", "manual"]) {
    const input = { ...snapshot(), config: { ...snapshot().config, permissionMode, bypass: true } };
    const args = buildHostArguments(input);
    for (const [name, value] of [["--permission-mode", "bypassPermissions"], ["--permission-prompts", "none"],
      ["--setting-sources", ""], ["--settings", "/run/boardroom/settings.json"], ["--mcp-config", "/run/boardroom/mcp.json"]]) {
      assert.equal(args[args.indexOf(name!) + 1], value);
    }
    assert(args.includes("--strict-mcp-config"));
    assert(args.includes("--disable-slash-commands"));
    assert(args.includes("--no-chrome"));
    assert(!args.includes("--restricted"), "restricted 与已选高级策略不兼容");
    assert(!args.includes("--safe-mode"), "safe-mode 会禁用 boardroom MCP");
    assert(!args.includes("--allow-dangerously-skip-permissions"), "普通模式不得获得切换高级的额外授权");
  }
});

test("R3 普通权限字符串不能替代逐绑定的高级意图", () => {
  assert.throws(() => buildHostArguments({ ...snapshot(), config: { ...snapshot().config, permissionMode: "bypassPermissions" } }), /profile_unsupported/);
  const args = buildHostArguments(snapshot());
  assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
  assert(args.includes("--restricted"));
  assert(!args.includes("--allow-dangerously-skip-permissions"));
});

test("R3 两档工具名单明确包含 Bash；restricted 不是 Bash 的隔离边界", () => {
  for (const bypass of [false, true]) {
    const input = { ...snapshot(), config: { ...snapshot().config, bypass } };
    const args = buildHostArguments(input);
    assert.deepEqual(args[args.indexOf("--tools") + 1]?.split(","), ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
    const withoutBash = buildHostArguments({ ...input, config: { ...input.config, tools: ["Read", "Glob"] } });
    assert.deepEqual(withoutBash[withoutBash.indexOf("--tools") + 1]?.split(","), ["Read", "Glob"]);
    assert.throws(() => buildHostArguments({ ...input, config: { ...input.config, tools: ["untrusted-plugin"] } }), /config_invalid/);
  }
});

test("R3 profile 必须精确匹配各身份轴；Auto 证据不能释放高级模式", () => {
  const auto: VerifiedHostProfile = { backend: "claude-code", version: "fixture-version", platform: "linux", architecture: "x64",
    executableSha256: "0".repeat(64), mode: "auto", evidence: "fixture-only-not-host-acceptance", isolationProfile: "linux-private-net-v1",
    nativeCredentialLayout: "claude-linux-user-login-v1", egressPolicy: "anthropic-api-oauth-v1", resumeVerified: false };
  const identity: HostProfileIdentity = { backend: auto.backend, version: auto.version, platform: auto.platform, architecture: auto.architecture, mode: auto.mode };
  assert.equal(selectVerifiedHostProfile([auto], identity), auto);
  for (const mismatch of [{ backend: "codex-cli" as const }, { version: "other-version" }, { platform: "darwin" },
    { architecture: "arm64" }, { mode: "bypassPermissions" }, { mode: "unknown" }]) {
    assert.equal(selectVerifiedHostProfile([auto], { ...identity, ...mismatch }), undefined);
  }
  const advanced: VerifiedHostProfile = { ...auto, mode: "bypassPermissions", evidence: "independent-mode-fixture-only" };
  assert.equal(selectVerifiedHostProfile([auto, advanced], { ...identity, mode: "bypassPermissions" }), advanced);
  assert.equal(selectVerifiedHostProfile([advanced], identity), undefined, "高级证据也不能代替 Auto 验收");
});

test("R3 实际权限模式必须与请求相同，回落、未知与未经请求升级均不 ready", () => {
  for (const expected of ["auto", "bypassPermissions"]) {
    for (const observed of ["auto", "bypassPermissions", "plan", "manual", "unknown", undefined]) {
      const events: HostEvent[] = [];
      const parser = createHostOutputParser({ backend: "claude-code", version: "fixture", expectedPermissionMode: expected, onEvent: e => events.push(e) });
      parser.push(`${JSON.stringify({ type: "system", subtype: "init", permissionMode: observed })}\n`);
      parser.end();
      assert.equal(events.some(event => event.type === "ready"), observed === expected);
      const permission = events.find(event => event.type === "permission");
      assert.equal(permission?.status, observed === expected ? "observed" : !observed || observed === "unknown" ? "unknown" : "fallback");
    }
  }
});

test("R3 高级 argv 可构造仍不能跳过生产 profile 门控，未验收组合不能启动", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "br-advanced-profile-"));
  try {
    const profilesBefore = structuredClone(VERIFIED_HOST_PROFILES);
    const version = "0.0.0-boardroom-advanced-unverified";
    assert(!VERIFIED_HOST_PROFILES.some(profile => profile.backend === "claude-code" && profile.version === version));
    const workdir = path.join(root, "work"); await mkdir(workdir);
    const executable = path.join(root, "version-only-cli");
    const unexpectedStart = path.join(root, "unexpected-start");
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf '%s\\n' '${version} (Claude Code)'\n  exit 0\nfi\nprintf 'started' > '${unexpectedStart}'\nexit 99\n`, { mode: 0o700 });
    const launcher = createHostLauncher({ stateRoot: path.join(root, "state"), protectedPaths: [path.join(root, "control")],
      installations: [{ backend: "claude-code", executable }] });
    const input = { ...snapshot(), config: { ...snapshot().config, workdir, bypass: true } };
    assert(buildHostArguments(input).includes("bypassPermissions"));
    const preflight = await launcher.preflight(input);
    assert.equal(preflight.supported, false);
    assert.equal(preflight.reason, "host_version_unsupported");
    assert.equal(preflight.expectedPermissionMode, "bypassPermissions");
    await assert.rejects(launcher.launch(input, { onEvent() { assert.fail("unverified advanced host spawned"); } }), /host_version_unsupported/);
    await assert.rejects(readFile(unexpectedStart), { code: "ENOENT" });
    assert.deepEqual(VERIFIED_HOST_PROFILES, profilesBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R3 隔离宿主使用实际非零身份、零能力，两棵 RW 树可写且固定策略只读", { timeout: 20_000 }, async t => {
  if (!await linuxIsolationAvailable()) { t.skip("已核实的 bwrap/namespace 原语不可用；不以 argv 断言替代身份与挂载实测"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "br-nonroot-"));
  const workdir = path.join(root, "work"); await mkdir(workdir);
  const source = `
    import fs from 'node:fs/promises';
    await fs.writeFile('workspace-marker','workspace-ok');
    await fs.writeFile('/home/runner/.claude/session-marker','session-ok');
    const status=await fs.readFile('/proc/self/status','utf8');
    const uidMap=await fs.readFile('/proc/self/uid_map','utf8');
    const gidMap=await fs.readFile('/proc/self/gid_map','utf8');
    let readonly=false;try{await fs.writeFile('/run/boardroom/settings.json','changed')}catch{readonly=true}
    console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),
      uidMap,gidMap,
      capabilities:['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(name=>status.match(new RegExp('^'+name+':\\\\s*(.*)$','m'))[1]),
      workspace:await fs.readFile('workspace-marker','utf8'),session:await fs.readFile('/home/runner/.claude/session-marker','utf8'),
      settings:JSON.parse(await fs.readFile('/run/boardroom/settings.json','utf8')),readonly}));`;
  const prepared = await prepareLinuxIsolation({ executable: process.execPath, argv: ["--input-type=module", "-e", source], prompt: "",
    workdir, stateRoot: path.join(root, "state"), bindingId: "nonroot-canary", protectedPaths: [path.join(root, "control")], egressHosts: [] });
  const child = spawnIsolatedProcess(prepared); let stdout = "";
  const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const bridge = createPipeBridge(child, { egressHosts: [], onStdout: b => stdout += b, onInvalid: () => assert.fail("invalid bridge") });
  try {
    await bridge.transport.start(); await prepared.verifyWritableBoundary(); await bridge.start();
    assert.equal(await closed, 0);
    const observed = JSON.parse(stdout);
    assert.notEqual(observed.uid, 0, "CLI 的真实 UID 不可为 root");
    assert.notEqual(observed.gid, 0);
    assert(observed.groups.every((group: number) => group === observed.gid), "不可获得主 GID 之外的补充组");
    const mapping = (value: string) => value.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    assert.deepEqual(mapping(observed.uidMap), [[observed.uid, 0, 1]], "只能映射 outer namespace 的单个调用者身份");
    assert.deepEqual(mapping(observed.gidMap), [[observed.gid, 0, 1]], "只能映射 outer namespace 的单个调用者组");
    assert(observed.capabilities.every((value: string) => /^0+$/.test(value)));
    assert.equal(observed.workspace, "workspace-ok"); assert.equal(observed.session, "session-ok");
    assert.equal(observed.readonly, true);
    assert.deepEqual(observed.settings, { disableAllHooks: true, enableAllProjectMcpServers: false });
    assert.equal(await readFile(path.join(workdir, "workspace-marker"), "utf8"), "workspace-ok");
  } finally { clearTimeout(timeout); child.kill("SIGKILL"); bridge.close(); await closed.catch(() => {}); await prepared.cleanup(); await rm(root, { recursive: true, force: true }); }
});
