import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEgressBroker, publicIpv4, validEgressHost } from "../src/server/runtime/isolation/egress.ts";
import { linuxIsolationAvailable, prepareLinuxIsolation, spawnIsolatedProcess } from "../src/server/runtime/isolation/linux.ts";
import { createPipeBridge } from "../src/server/runtime/isolation/pipe-bridge.ts";

test("R3 egress 只接受固定公共域名，私网/回环/IP/通配符不能成为TLS出口", async () => {
  for (const host of ["127.0.0.1", "::1", "localhost", "x.localhost", "*.anthropic.com", "a.internal", "api.anthropic.com@localhost", "api.anthropic.com:80"]) assert.equal(validEgressHost(host), false, host);
  assert.equal(validEgressHost("api.anthropic.com"), true);
  for (const address of ["127.0.0.1", "10.1.1.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.1", "203.0.113.1", "::ffff:127.0.0.1"]) assert.equal(publicIpv4(address), false, address);
  assert.equal(publicIpv4("1.1.1.1"), true);
  const root = await mkdtemp(path.join(tmpdir(), "br-egress-"));
  const broker = createEgressBroker(["api.anthropic.com"]);
  try {
    for (const request of ["CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n", "CONNECT api.anthropic.com:80 HTTP/1.1\r\n\r\n", "GET http://127.0.0.1/api/health HTTP/1.1\r\n\r\n", "CONNECT unknown.example:443 HTTP/1.1\r\n\r\n", `CONNECT api.anthropic.com:443 HTTP/1.1\r\nX:${"x".repeat(9000)}`]) {
      const inbound = new PassThrough(); const outbound = new PassThrough();
      const socket = Duplex.from({ readable: inbound, writable: outbound });
      broker.attach(socket);
      const response = await new Promise<string>((resolve, reject) => {
        let output = ""; outbound.on("data", data => output += data); outbound.once("end", () => resolve(output)); outbound.once("error", reject); inbound.end(request);
      });
      assert(response.startsWith("HTTP/1.1 403"), response);
    }
  } finally { broker.close(); await rm(root, { recursive: true, force: true }); }
});

test("R3 Linux 真实 namespace canary：工作文件/MCP可达，owner HTTP/管理文件/越界symlink不可达", { timeout: 20_000 }, async t => {
  if (!await linuxIsolationAvailable()) { t.skip("当前OS/容器没有所需隔离原语；生产profile仍unsupported"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "br-iso-"));
  const workdir = path.join(root, "work"); const control = path.join(root, "control");
  await mkdir(workdir); await mkdir(control);
  await writeFile(path.join(control, "database-canary"), "PRIVATE_CANARY");
  await symlink(path.join(control, "database-canary"), path.join(workdir, "outside"));
  const owner = createServer(socket => socket.end("OWNER_API_MUST_NOT_BE_REACHABLE"));
  await new Promise<void>(resolve => owner.listen(0, "127.0.0.1", resolve));
  const port = (owner.address() as { port: number }).port;
  const source = `
    import fs from 'node:fs/promises'; import net from 'node:net';
    const result={};
    await fs.writeFile('allowed.txt','workspace-write-ok'); result.workspace=true;
    for (const [key,name] of [['control',${JSON.stringify(path.join(control, "database-canary"))}],['symlink','outside']]) {
      try {await fs.readFile(name);result[key]='exposed';} catch {result[key]='denied';}
    }
    result.owner=await new Promise(resolve=>{const s=net.createConnection({host:'127.0.0.1',port:${port}});s.on('connect',()=>{s.destroy();resolve('exposed')});s.on('error',()=>resolve('denied'));setTimeout(()=>{s.destroy();resolve('denied')},1000).unref()});
    result.mcp=await new Promise((resolve,reject)=>{const s=net.createConnection({host:'127.0.0.1',port:47631});s.on('connect',()=>s.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})+'\\n'));s.on('data',b=>{resolve(JSON.parse(b.toString()).result.canary);s.unref()});s.on('error',reject)});
    result.env=process.env.AGENT_STUDIO_PG_CONNECTION_STRING===undefined;
    console.log(JSON.stringify(result));`;
  let prepared: Awaited<ReturnType<typeof prepareLinuxIsolation>> | undefined;
  try {
    prepared = await prepareLinuxIsolation({ executable: process.execPath, argv: ["--input-type=module", "-e", source], prompt: "", workdir,
      stateRoot: path.join(root, "state"), bindingId: "canary-binding",
      protectedPaths: [control, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")], egressHosts: [] });
    const child = spawnIsolatedProcess(prepared); let stdout = ""; let stderr = "";
    const bridge = createPipeBridge(child, { egressHosts: [], onStdout: b => { stdout += b; }, onInvalid: () => assert.fail("invalid bridge output") });
    bridge.transport.onmessage = request => { if ("id" in request && request.id !== undefined) void bridge.transport.send({ jsonrpc: "2.0", id: request.id, result: { canary: "mcp-canary" } }); };
    await bridge.transport.start(); await bridge.start();
    child.stderr?.on("data", b => stderr += b);
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, `隔离canary失败: ${stderr}`);
    assert.deepEqual(JSON.parse(stdout), { workspace: true, control: "denied", symlink: "denied", owner: "denied", mcp: "mcp-canary", env: true });
    assert.equal(await readFile(path.join(workdir, "allowed.txt"), "utf8"), "workspace-write-ok");
    assert.equal(await readFile(path.join(control, "database-canary"), "utf8"), "PRIVATE_CANARY");
  } finally {
    await prepared?.cleanup();
    await new Promise<void>(resolve => owner.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("R3 安全点停止给自有CLI机会落盘；强制结束只回收该隔离进程树", { timeout: 20_000 }, async t => {
  if (!await linuxIsolationAvailable()) { t.skip("当前OS/容器没有所需隔离原语；不声明支持"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "br-stop-"));
  const workdir = path.join(root, "work"); await mkdir(workdir);
  const control = path.join(root, "control"); await mkdir(control);
  const launch = async (source: string, bindingId: string) => {
    const prepared = await prepareLinuxIsolation({ executable: process.execPath, argv: ["--input-type=module", "-e", source], prompt: "", workdir,
      stateRoot: path.join(root, "state"), bindingId, protectedPaths: [control], egressHosts: [] });
    const child = spawnIsolatedProcess(prepared);
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const bridge = createPipeBridge(child, { egressHosts: [], onStdout: b => { if (b.toString().includes("READY")) ready(); }, onInvalid: () => assert.fail("invalid bridge") });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    await bridge.transport.start(); await bridge.start();
    await Promise.race([started, closed.then(() => assert.fail("dummy host exited before readiness"))]);
    return { child, bridge, closed, prepared };
  };
  try {
    const graceful = await launch("import fs from 'node:fs'; process.on('SIGTERM',()=>{fs.writeFileSync('graceful-stop','flushed');process.exit(0)}); console.log('READY');setInterval(()=>{},1000);", "graceful");
    try { await graceful.bridge.stopAtSafePoint(); assert.equal(await graceful.closed, 0); assert.equal(await readFile(path.join(workdir, "graceful-stop"), "utf8"), "flushed"); }
    finally { graceful.child.kill("SIGKILL"); await graceful.prepared.cleanup(); }

    const unrelatedPath = path.join(control, "unrelated-alive");
    const unrelated = spawn(process.execPath, ["--input-type=module", "-e", `import fs from 'node:fs';setTimeout(()=>fs.writeFileSync(${JSON.stringify(unrelatedPath)},'alive'),700);`], { shell: false, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
    const unrelatedExit = new Promise<void>(resolve => unrelated.once("close", () => resolve()));
    const nestedSource = "import fs from 'node:fs';setTimeout(()=>fs.writeFileSync('orphan-effect','must-not-happen'),700);setInterval(()=>{},1000);";
    const forced = await launch(`import {spawn} from 'node:child_process';spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(nestedSource)}],{stdio:'ignore'});console.log('READY');setInterval(()=>{},1000);`, "forced");
    try {
      forced.child.kill("SIGKILL"); await forced.closed; await unrelatedExit; await delay(150);
      await assert.rejects(readFile(path.join(workdir, "orphan-effect")), { code: "ENOENT" });
      assert.equal(await readFile(unrelatedPath, "utf8"), "alive");
    } finally { forced.child.kill("SIGKILL"); unrelated.kill("SIGKILL"); await forced.prepared.cleanup(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
