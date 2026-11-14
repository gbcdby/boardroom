#!/usr/bin/env node
/** 干净 CI 检出 npm ci 后：真实 npm start/prestart、HTTP/MCP、正常停止及同库重启。无模型。 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Client as PgClient } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EXPECTED_MCP_TOOL_NAMES } from "../tests/helpers/mcp-contract.ts";

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, "..");
const engine = process.env.AGENT_STUDIO_DB_DRIVER === "postgres" ? "postgres" : "sqlite";
const directory = await mkdtemp(path.join(tmpdir(), "boardroom-install-"));
const configPath = path.join(directory, "config.json"), dataDir = path.join(directory, "data");
const output = path.join(root, ".agent-output/install-e2e");
const schema = `install_${randomUUID().replaceAll("-", "")}`;
let pg, schemaCreated = false, child, client;
const report = { status: "FAIL", at: new Date().toISOString(), engine, node: process.version,
  os: { platform: process.platform, arch: process.arch, release: release() },
  scope: "real npm start / production HTTP and MCP SDK / owned temporary data / no model",
  dependencyInstall: "npm ci is a separate clean-checkout CI prerequisite; this script does not claim to install dependencies",
  checks: [], starts: [], errors: [] };
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENT_STUDIO_CONFIG: configPath, AGENT_STUDIO_DATA_DIR: dataDir,
  AGENT_STUDIO_PORT: String(port), AGENT_STUDIO_DB_DRIVER: engine, AGENT_STUDIO_LOG_LEVEL: "info" };
if (engine === "sqlite") delete env.AGENT_STUDIO_PG_CONNECTION_STRING;
const digest = value => createHash("sha256").update(value).digest("hex");

async function json(method, route, body, expected = 200) {
  const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(10000),
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(value)}`);
  return value;
}
async function start() {
  assert.equal(child, undefined);
  const startedAt = performance.now();
  const processHandle = spawn("npm", ["start"], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let text = "", launchError;
  processHandle.stdout.on("data", data => { text = (text + data).slice(-200000); });
  processHandle.stderr.on("data", data => { text = (text + data).slice(-200000); });
  processHandle.on("error", error => { launchError = error; });
  const closed = new Promise(resolve => processHandle.once("close", (code, signal) => resolve({ code, signal })));
  child = { handle: processHandle, closed, logs: () => text };
  for (let attempt = 0; attempt < 300; attempt++) {
    if (launchError) throw launchError;
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) throw new Error("npm start exited before the owned service became ready");
    let settings;
    try { settings = (await json("GET", "/api/settings")).settings; } catch { await delay(100); continue; }
    // 绑定端口交接的竞态不能让测试误写另一服务：所有业务操作之前核对独占配置与目录。
    assert.equal(settings.storage.dataDirectory, dataDir);
    assert.equal(settings.configuration.filePath, configPath);
    assert.equal(settings.service.port, port);
    assert.equal(settings.storage.driver, engine);
    assert.match(text, /build:web/);
    report.starts.push({ elapsedMs: Number((performance.now() - startedAt).toFixed(3)), port,
      actualEntrypoint: "npm start (including prestart -> build:web)", startedAt: settings.configuration.startedAt });
    return settings;
  }
  throw new Error("npm start did not expose the owned settings endpoint within 30 seconds");
}
async function stop() {
  if (!child) return;
  const owned = child; child = undefined;
  // 仅向本脚本刚创建的独立进程组发退出信号，npm/shell/node 同时正常收尾。
  try { process.kill(-owned.handle.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  let result;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await Promise.race([owned.closed, delay(100).then(() => null)]);
    if (result) break;
  }
  if (!result) {
    try { process.kill(-owned.handle.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await owned.closed; throw new Error("graceful shutdown exceeded 10 seconds; owned process group was terminated");
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch(origin + "/api/health", { signal: AbortSignal.timeout(100) }); }
    catch {
      assert.match(owned.logs(), /收到退出信号/);
      report.checks.push("owned npm process received shutdown and its listening endpoint closed"); return;
    }
    await delay(50);
  }
  throw new Error("owned endpoint still listens after normal shutdown");
}

try {
  report.commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  report.tree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
  report.worktree = (await exec("git", ["status", "--porcelain"], { cwd: root })).stdout.trim();
  report.scriptSha256 = digest(await readFile(new URL(import.meta.url)));
  report.npm = (await exec("npm", ["--version"], { cwd: root })).stdout.trim();
  if (engine === "postgres") {
    assert.ok(env.AGENT_STUDIO_PG_CONNECTION_STRING, "postgres requires a dedicated CI/test connection");
    const address = new URL(env.AGENT_STUDIO_PG_CONNECTION_STRING);
    pg = new PgClient({ connectionString: address.href }); await pg.connect();
    await pg.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    address.searchParams.set("options", `${address.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
    env.AGENT_STUDIO_PG_CONNECTION_STRING = address.href;
    const check = new PgClient({ connectionString: address.href }); await check.connect();
    try { assert.equal((await check.query("SELECT current_schema() AS schema")).rows[0].schema, schema); }
    finally { await check.end(); }
  }
  await writeFile(configPath, JSON.stringify({ port, dataDir, heartbeat: { intervalMs: 1000, timeoutMs: 30000 } }), { mode: 0o600 });
  const configDigest = digest(await readFile(configPath));
  await start(); await json("GET", "/api/health");
  const project = (await json("POST", "/api/projects", { name: "安装与重启验收" }, 201)).project;
  const member = (await json("POST", `/api/projects/${project.id}/members`, { kind: "human", displayName: "用户" }, 201)).member;
  const group = (await json("POST", `/api/projects/${project.id}/groups`, { name: "真实协议", participantMemberIds: [member.id] }, 201)).group;
  for (const route of ["/", "/settings", `/projects/${project.id}/tasks`, `/projects/${project.id}/memory`, `/projects/${project.id}/audit`]) {
    const response = await fetch(origin + route); assert.equal(response.status, 200); assert.match(await response.text(), /<div id="app"/);
  }
  report.checks.push("production health, resolved settings and five built WebUI deep links");
  client = new Client({ name: "installation-protocol-check", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + "/mcp")));
  const tools = await client.listTools(); report.toolNames = tools.tools.map(tool => tool.name).sort();
  assert.deepEqual(report.toolNames, EXPECTED_MCP_TOOL_NAMES, "production MCP tools must exactly match the independent public contract");
  for (const tool of ["join", "wait_for_messages", "create_task", "read_memory"]) assert.ok(report.toolNames.includes(tool));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const payload = JSON.parse(result.content.find(part => part.type === "text").text);
    assert.equal(payload.ok, true, JSON.stringify(payload)); return payload;
  };
  const joined = await call("join", { projectId: project.id, groupId: group.id, displayName: "安装验收 Agent", hostType: "other" });
  const waiting = call("wait_for_messages", { timeoutMs: 5000 });
  const text = `重启后保留-${randomUUID()}`;
  const message = (await json("POST", `/api/groups/${group.id}/messages`, { senderMemberId: member.id, text, mentions: [joined.memberId] }, 201)).message;
  const delivered = await waiting; assert.ok(delivered.messages.some(entry => entry.id === message.id));
  await call("acknowledge_message", { messageId: message.id });
  report.checks.push(`${report.toolNames.length} actual MCP tools match the independent contract, join, live HTTP message -> SDK wait -> durable ACK`);
  await client.close(); client = undefined; await stop();
  await start();
  const history = (await json("GET", `/api/groups/${group.id}/messages`)).messages;
  const retained = history.find(entry => entry.id === message.id);
  assert.equal(retained.text, text); assert.equal(retained.seq, message.seq); assert.equal(retained.senderDisplayName, "用户");
  assert.equal((await json("GET", `/api/projects/${project.id}/members`)).members.length, 2);
  assert.equal(digest(await readFile(configPath)), configDigest);
  report.checks.push("normal restart keeps the same project, members, message identity/order/author and configuration bytes");
  await stop(); report.status = "PASS";
} catch (error) {
  report.errors.push(String(error?.stack ?? error).replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[redacted-postgres-url]"));
} finally {
  try { await client?.close(); await stop(); } catch (error) { report.status = "FAIL"; report.errors.push(String(error.message)); }
  if (schemaCreated) { try { await pg.query(`DROP SCHEMA "${schema}" CASCADE`); } catch (error) { report.status = "FAIL"; report.errors.push("owned PostgreSQL schema cleanup failed"); } }
  await pg?.end(); await rm(directory, { recursive: true, force: true });
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, `${engine}.json`), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (report.status !== "PASS") process.exitCode = 1;
