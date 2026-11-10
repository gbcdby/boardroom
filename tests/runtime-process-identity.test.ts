import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureOwnedProcessIdentity, inspectOwnedProcess } from "../src/server/runtime/hosts/process-identity.ts";
import { linuxIsolationAvailable, prepareLinuxIsolation, spawnIsolatedProcess } from "../src/server/runtime/isolation/linux.ts";
import { createPipeBridge } from "../src/server/runtime/isolation/pipe-bridge.ts";
import type { OwnedProcessIdentity } from "../src/server/runtime/hosts/types.ts";

test("R3 恢复身份只读核验boot/namespace/starttime；PID重用或未知不误杀", { timeout: 15_000 }, async t => {
  if (!await linuxIsolationAvailable()) { t.skip("隔离原语不可用，旧进程归属不据此升级"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "br-identity-")); const workdir = path.join(root, "work"); await mkdir(workdir);
  const prepared = await prepareLinuxIsolation({ executable: process.execPath, argv: ["-e", "process.on('SIGTERM',()=>process.exit(0));console.log('READY');setInterval(()=>{},1000)"], prompt: "",
    workdir, stateRoot: path.join(root, "state"), bindingId: "identity", protectedPaths: [path.join(root, "control")], egressHosts: [] });
  const child = spawnIsolatedProcess(prepared);
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const bridge = createPipeBridge(child, { egressHosts: [], onStdout: data => { if (data.toString().includes("READY")) ready(); }, onInvalid: () => assert.fail("invalid pipe") });
  try {
    await bridge.transport.start(); await bridge.start(); await Promise.race([started, exited.then(() => assert.fail("dummy exited"))]);
    const identity = await captureOwnedProcessIdentity(child); assert(identity);
    assert.equal((await inspectOwnedProcess(identity)).status, "observed_alive");
    assert.equal((await inspectOwnedProcess({ ...identity, startTicks: String(BigInt(identity.startTicks) + 1n) })).reason, "start_ticks_changed");
    assert.equal((await inspectOwnedProcess({ ...identity, pidNamespace: "pid:[0]" })).status, "unknown");
    assert.equal((await inspectOwnedProcess({ ...identity, launcherProtocol: "external" } as unknown as OwnedProcessIdentity)).reason, "identity_invalid");
    assert.equal((await inspectOwnedProcess({ ...identity, kernelBootId: "00000000-0000-0000-0000-000000000000" })).reason, "boot_changed");
    assert.equal(child.exitCode, null, "只读检查不能终止当前wrapper");
    await bridge.stopAtSafePoint(); await exited;
    assert.equal((await inspectOwnedProcess(identity)).status, "wrapper_exited");
    assert.equal(await captureOwnedProcessIdentity(child), undefined);
    const external = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
    const externalExit = new Promise<void>(resolve => external.once("close", () => resolve()));
    try { assert.equal(await captureOwnedProcessIdentity(external), undefined, "不能把普通ChildProcess伪装成本隔离协议"); }
    finally { external.kill("SIGTERM"); await externalExit; }
  } finally { child.kill("SIGKILL"); await exited; bridge.close(); await prepared.cleanup(); await rm(root, { recursive: true, force: true }); }
});
