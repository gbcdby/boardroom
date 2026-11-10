import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { createRuntimeSupervisor } from "../src/server/runtime/supervisor.ts";
import { createRuntimeObservability } from "../src/server/runtime/observability.ts";
import { createLogger } from "../src/server/logger.ts";
import { createPipeBridge } from "../src/server/runtime/isolation/pipe-bridge.ts";
import { linuxIsolationAvailable, prepareLinuxIsolation, spawnIsolatedProcess } from "../src/server/runtime/isolation/linux.ts";
import { createHostOutputParser } from "../src/server/runtime/hosts/parser.ts";
import { captureOwnedProcessIdentity } from "../src/server/runtime/hosts/process-identity.ts";
import type { HostLauncher } from "../src/server/runtime/hosts/types.ts";

async function until(predicate: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(5); }
  assert.fail(message);
}

/**
 * 真实 namespace + 匿名管道 + SDK gateway + MCP core 的停止顺序回归。
 * 子进程是无模型的 JSON-RPC 替身；本用例不加入生产 profile、不声称真实 CLI 支持。
 */
test("R6 隔离子进程经真实gateway等待时，安全停止须先送达控制帧再关闭共用管道", { timeout: 20_000 }, async t => {
  if (!await linuxIsolationAvailable()) { t.skip("隔离原语不可用；不能用InMemoryTransport替代该证据"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "br-isolated-gateway-"));
  const workdir = path.join(root, "work"); await mkdir(workdir);
  const dataDir = path.join(root, "db"); await mkdir(dataDir);
  const stateRoot = path.join(root, "state");
  const db = new SqliteDriver({ dataDir }); await db.connect(); await db.migrate(migrations);
  const repos = createRepositories(db);
  const repo = createRuntimeRepository(db);
  const logger = createLogger({ level: "error", write() {} });
  const observations = createRuntimeObservability({ db, logger });
  const project = await repos.projects.create({ name: "真实停止通道回归" });
  const group = await repos.groups.create({ projectId: project.id, name: "受控验收" });
  const created = await repo.create({ name: "dummy-safe-stop", backend: "claude-code", defaults: { workdir },
    bindings: [{ projectId: project.id, groupId: group.id }] });
  const bindingId = created.bindings[0]!.binding.id;
  const handles: ChildProcess[] = [];
  const launcher: HostLauncher = {
    async preflight() { return { supported: true, reason: "supported", expectedPermissionMode: "auto", isolation: "verified" }; },
    async launch(snapshot, observer) {
      // 替身实际通过隔离内 loopback、父子匿名管道和 SDK 完成 initialize/join/wait。
      const source = `import fs from 'node:fs';import net from 'node:net';
        process.on('SIGTERM',()=>{fs.writeFileSync('graceful-stop','flushed');process.exit(0)});
        console.log(JSON.stringify({type:'system',subtype:'init',permissionMode:'auto',session_id:'dummy-session'}));
        const socket=net.createConnection({host:'127.0.0.1',port:47631});let pending='';
        const send=value=>socket.write(JSON.stringify(value)+'\\n');
        socket.on('connect',()=>send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'isolated-dummy',version:'1'}}}));
        socket.on('data',bytes=>{pending+=bytes.toString();let index;while((index=pending.indexOf('\\n'))>=0){const message=JSON.parse(pending.slice(0,index));pending=pending.slice(index+1);
          if(message.id===1){send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'join',arguments:${JSON.stringify({ ...snapshot.identity, hostType: snapshot.backend })}}});}
          if(message.id===2){send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'wait_for_messages',arguments:{timeoutMs:30000}}});}
        }});socket.on('error',()=>process.exit(2));setInterval(()=>{},1000);`;
      const prepared = await prepareLinuxIsolation({ executable: process.execPath, argv: ["--input-type=module", "-e", source],
        prompt: "", workdir, stateRoot, bindingId, protectedPaths: [dataDir], egressHosts: [] });
      const child = spawnIsolatedProcess(prepared); handles.push(child);
      const parser = createHostOutputParser({ backend: "claude-code", version: "0.0.0-test", expectedPermissionMode: "auto", onEvent: observer.onEvent });
      const bridge = createPipeBridge(child, { egressHosts: [], onStdout: bytes => parser.push(bytes),
        onInvalid: () => observer.onEvent({ type: "protocol_invalid", reason: "invalid_schema" }) });
      child.stderr?.on("data", () => {});
      child.once("error", () => observer.onEvent({ type: "failure", reason: "launch_failed" }));
      let alive = true;
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("close", (code, signal) => {
        alive = false; bridge.close(); parser.end();
        void prepared.cleanup().then(() => resolve({ code, signal }));
      }));
      try {
        const processIdentity = await captureOwnedProcessIdentity(child);
        await observer.onMcpTransport!(bridge.transport); await bridge.start();
        return { ...(child.pid ? { pid: child.pid } : {}), ...(processIdentity ? { processIdentity } : {}), exited,
          stopAtSafePoint: () => { if (alive) void bridge.stopAtSafePoint().catch(() => observer.onEvent({ type: "failure", reason: "launch_failed" })); },
          forceStopOwned: () => { if (alive) child.kill("SIGKILL"); } };
      } catch (error) { child.kill("SIGKILL"); await exited; throw error; }
    },
  };
  const supervisor = createRuntimeSupervisor({ db, logger, observations, launcher, stateRoot, repository: repo, manual: true });
  try {
    await repo.intent(bindingId, "start"); await supervisor.tick();
    await until(async () => {
      const view = (await repo.getBinding(bindingId))!;
      return view.runner.state === "running" && view.runner.phase === "idle";
    }, "真实MCP join与wait未进入安全点");
    assert.equal((await repos.mcpSessions.listByProject(project.id))[0]?.state, "connected");
    await repo.intent(bindingId, "stop"); await supervisor.tick();
    await until(async () => (await repo.getBinding(bindingId))!.runner.exitConfirmed, "自有进程未确认退出");
    const stopped = (await repo.getBinding(bindingId))!;
    assert.equal(await readFile(path.join(workdir, "graceful-stop"), "utf8"), "flushed", "控制帧应到达子进程并给SIGTERM处理器落盘机会");
    assert.equal(stopped.runner.state, "stopped");
    assert.equal(stopped.runner.lastErrorCode, null, "共用管道提前关闭不能把正常停止变成启动失败或断连故障");
    assert.equal(stopped.runner.lastExitCode, 0);
    assert.equal(stopped.runner.nextRetryAt, null);
    assert.equal(stopped.runner.owner, null);
    assert.equal((await repos.mcpSessions.listByProject(project.id))[0]?.state, "disconnected");
  } finally {
    for (const child of handles) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await supervisor.close(); await db.close(); await rm(root, { recursive: true, force: true });
  }
});
