import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { createTaskService } from "../src/server/tasks/service.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { createRuntimeObservability } from "../src/server/runtime/observability.ts";
import { createRuntimeSupervisor } from "../src/server/runtime/supervisor.ts";
import { createRuntimeGateway, type RuntimeGateway } from "../src/server/runtime/gateway.ts";
import { createLogger } from "../src/server/logger.ts";
import { canonicalizePath, databaseForConnectedReader } from "../src/server/environment.ts";
import { registerStorageSourceClient } from "../src/server/storage/source-client.ts";
import { createHostOutputParser } from "../src/server/runtime/hosts/parser.ts";
import type { HostEvent, HostLauncher, HostLaunchSnapshot, HostPreflight, OwnedHostProcess, OwnedProcessIdentity, OwnedProcessInspection, VerifiedUsageSchema } from "../src/server/runtime/hosts/types.ts";

type Observer = Parameters<HostLauncher["launch"]>[1];
interface Payload { ok: boolean; status?: string; messages?: { id: string; text: string }[]; error?: { code: string }; [key: string]: unknown }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function until(condition: () => Promise<boolean>, message: string) {
  for (let i = 0; i < 200; i += 1) { if (await condition()) return; await delay(1); }
  assert.fail(message);
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Payload> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return JSON.parse(content.find((part) => part.type === "text")!.text!) as Payload;
}

/** 仅模拟受控子进程；SDK、MCP core、gateway 和数据库全部是真实实现。 */
class ControlledHost implements OwnedHostProcess {
  readonly exited;
  readonly finished = deferred<{ code: number | null; signal: string | null }>();
  stops = 0;
  forced = 0;
  readonly snapshot: HostLaunchSnapshot;
  readonly observer: Observer;
  readonly client: Client;
  readonly processIdentity?: OwnedProcessIdentity;
  constructor(snapshot: HostLaunchSnapshot, observer: Observer, client: Client, processIdentity?: OwnedProcessIdentity) {
    this.snapshot = snapshot; this.observer = observer; this.client = client;
    if (processIdentity !== undefined) this.processIdentity = processIdentity;
    this.exited = this.finished.promise;
  }
  stopAtSafePoint() { this.stops += 1; }
  forceStopOwned() { this.forced += 1; }
  finish(code: number | null = 0, signal: string | null = null) { this.finished.resolve({ code, signal }); }
  event(event: HostEvent) { this.observer.onEvent(event); }
  call(name: string, args: Record<string, unknown>) { return call(this.client, name, args); }
}

async function fixture(options: { announceMode?: boolean; preflight?: HostPreflight; launchFails?: boolean; launchError?: string; startupTimeoutMs?: number;
  announcePermission?: "auto" | "manual"; checkPreflight?: HostLauncher["preflight"];
  processIdentity?: OwnedProcessIdentity; inspectPrevious?: NonNullable<HostLauncher["inspectPrevious"]>; storage?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "runtime-supervisor-"));
  const db = new SqliteDriver({ dataDir: dir }); await db.connect(); await db.migrate(migrations);
  const sourceClient = options.storage ? await registerStorageSourceClient({ db, entrypoint: "http",
    database: databaseForConnectedReader({ kind: "sqlite", dataDir: dir, sqlitePath: canonicalizePath(db.file), sourcePath: db.file, identity: null }) }) : undefined;
  const repos = createRepositories(db);
  let clock = Date.now();
  const runtime = createRuntimeRepository(db, { now: () => new Date(clock) });
  const logger = createLogger({ level: "error", write: () => {} });
  const observations = createRuntimeObservability({ db, logger, now: () => clock });
  const project = await repos.projects.create({ name: "调度验收" });
  const group = await repos.groups.create({ projectId: project.id, name: "甲群" });
  const otherGroup = await repos.groups.create({ projectId: project.id, name: "乙群" });
  const created = await runtime.create({ name: "托管验收", backend: "claude-code", defaults: { workdir: dir }, bindings: [{ projectId: project.id, groupId: group.id }] });
  const binding = created.bindings[0]!.binding;
  const human = await repos.members.create({ projectId: project.id, kind: "human", displayName: "测试用户" });
  await repos.groups.addParticipant(group.id, human.id); await repos.groups.addParticipant(otherGroup.id, human.id);
  const hosts: ControlledHost[] = [];
  const gateways: RuntimeGateway[] = [];
  let launches = 0;
  const launcher: HostLauncher = {
    ...(options.inspectPrevious ? { inspectPrevious: options.inspectPrevious } : {}),
    async preflight(snapshot) { return options.checkPreflight ? options.checkPreflight(snapshot)
      : options.preflight ?? { supported: true, reason: "supported", expectedPermissionMode: "auto", isolation: "verified" }; },
    async launch(snapshot, observer) {
      launches += 1;
      if (options.launchFails) throw new Error("synthetic-launch-failure");
      if (options.launchError) throw new Error(options.launchError);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "controlled-host", version: "test-only" });
      const host = new ControlledHost(snapshot, observer, client, options.processIdentity); hosts.push(host);
      await observer.onMcpTransport!(serverTransport); await client.connect(clientTransport);
      if (options.announceMode !== false) observer.onEvent({ type: "ready", permissionMode: options.announcePermission ?? "auto" });
      const joined = await host.call("join", { displayName: snapshot.identity!.displayName, hostType: snapshot.backend,
        projectId: snapshot.identity!.projectId, groupId: snapshot.identity!.groupId });
      assert.equal(joined.ok, true, JSON.stringify(joined));
      return host;
    },
  };
  const supervisor = createRuntimeSupervisor({ db, logger, launcher, observations, stateRoot: dir, repository: runtime,
    now: () => clock, random: () => 1, manual: true,
    gatewayFactory: async (input) => { const gateway = await createRuntimeGateway(input); gateways.push(gateway); return gateway; },
    ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(sourceClient ? { storageClient: sourceClient } : {}) });
  if (sourceClient) await sourceClient.bind({ stopNewWork: epoch => supervisor.beginMaintenanceDrain(epoch),
    async disconnectSessions() {}, closeMemory: async () => {}, stopOwnedRuntime: () => supervisor.drainMaintenance(),
    observeOwnedExit: input => supervisor.observeMaintenanceExit(input) });
  return {
    db, dir, repos, runtime, project, group, otherGroup, created, binding, hosts, gateways, supervisor, observations, sourceClient,
    get launches() { return launches; },
    advance(ms: number) { clock += ms; },
    async start() { await runtime.intent(binding.id, "start"); await supervisor.tick(); return hosts.at(-1); },
    async enqueue(bindingId: string, wake: "allowed" | "suppressed" | null, text = "queued-message") {
      const target = (await runtime.getBinding(bindingId))!.binding;
      const message = await repos.messages.create({ groupId: target.groupId, senderMemberId: human.id, body: text, mentions: [target.memberId] });
      await repos.deliveries.ensure(message.id, target.memberId, wake === null ? undefined : wake === "allowed" ? { decision: wake } : { decision: wake, reason: "rate_limited" });
      return message;
    },
    async close() {
      if (sourceClient) {
        for (const host of hosts) host.finish();
        await supervisor.close().catch(() => {}); await sourceClient.close().catch(() => {});
        for (const host of hosts) await host.client.close();
        await db.close(); await rm(dir, { recursive: true, force: true }); return;
      }
      for (const view of await runtime.listBindings()) await runtime.intent(view.binding.id, "stop");
      const closing = supervisor.close();
      for (const host of hosts) host.finish();
      await closing;
      for (const host of hosts) await host.client.close();
      await db.close(); await rm(dir, { recursive: true, force: true });
    },
  };
}

test("R6 常驻已就绪runner在无待应用配置时保持等待，不将null snapshot当成配置变更", async () => {
  const f = await fixture();
  try {
    const host = (await f.start())!;
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.state === "running", "runner 应在join+实际模式观察后就绪");
    const waited = await host.call("wait_for_messages", { timeoutMs: 20 });
    assert.equal(waited.status, "timeout", "无配置变更/停止/其他群任务时应保持常驻等待");
    await nextTurn();
    assert.equal(host.stops, 0); assert.equal(host.forced, 0);
  } finally { await f.close(); }
});

function requestStorageDrain(db: Database.Database) {
  db.prepare(`UPDATE storage_maintenance SET admission='draining',fence_epoch=1,owner_generation=1,
    active_migration_id='fixture',plan_digest=?,control_root_json='{}',mutex_identity_json='{}',
    journal_record_ref='fixture',journal_digest=?,journal_sequence=1`).run("a".repeat(64), "b".repeat(64));
}
const maintenanceIdentity: OwnedProcessIdentity = { version: 1, launcherProtocol: "linux-private-net-v1", pid: 4321,
  kernelBootId: "11111111-1111-1111-1111-111111111111", pidNamespace: "pid:[42]", startTicks: "1234" };

test("#152 maintenance等待忙碌runner的安全点和owned handle实际退出；保留真实意图/SID", async () => {
  // Host is explicitly controlled; database, gate, gateway and MCP are production code.
  const f = await fixture({ storage: true, processIdentity: maintenanceIdentity });
  const control = new Database(path.join(f.dir, "agent-studio.db"));
  try {
    const host = (await f.start())!;
    host.event({ type: "session", sessionId: "actual-observed-session" });
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.harnessSessionId !== null, "session observation missing");
    await f.runtime.updateBinding(f.binding.id, { runtimeRevision: 1, bindingRevision: 1, overrides: { model: "future-model" } });
    await f.runtime.intent(f.binding.id, "apply", undefined, { runtimeRevision: 1, bindingRevision: 2 });
    const before = (await f.runtime.getBinding(f.binding.id))!;
    requestStorageDrain(control); await f.sourceClient!.refresh(); await nextTurn();
    assert.equal(host.stops, 0); assert.equal(host.forced, 0);
    host.event({ type: "exit", code: 0, signal: null }); await nextTurn();
    assert.equal(f.sourceClient!.diagnostic.status, "draining", "输出exit不是owned exit");
    assert.equal((await host.call("wait_for_messages", { timeoutMs: 10 })).status, "cancelled");
    await until(async () => host.stops === 1, "safe stop missing");
    assert.equal((control.prepare("SELECT exit_confirmed FROM agent_runner_states WHERE binding_id=?").get(f.binding.id) as { exit_confirmed: number }).exit_confirmed, 0);
    host.finish(); const receipt = await f.sourceClient!.waitForDrain();
    assert.equal(receipt.ownedExits.length, 1); assert.equal(receipt.ownedExits[0]!.fence.owner, before.runner.owner);
    const binding = control.prepare("SELECT * FROM agent_runtime_bindings WHERE id=?").get(f.binding.id) as Record<string, unknown>;
    const runner = control.prepare("SELECT * FROM agent_runner_states WHERE binding_id=?").get(f.binding.id) as Record<string, unknown>;
    assert.equal(binding.desired_state, "running"); assert.equal(binding.intent_revision, before.binding.intentRevision);
    assert.deepEqual(JSON.parse(String(binding.requested_snapshot_json)), before.binding.requestedSnapshot);
    assert.equal(binding.reset_session_requested, Number(before.binding.resetSessionRequested));
    assert.deepEqual(JSON.parse(String(runner.applied_json)), before.runner.applied);
    assert.equal(runner.harness_session_id, "actual-observed-session"); assert.equal(runner.exit_confirmed, 1);
    await f.supervisor.tick(); assert.equal(f.launches, 1, "maintenance不可自动claim/retry");
  } finally { control.close(); await f.close(); }
});

test("#152 maintenance在preflight期间停新，不取得新claim/launch", async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = await fixture({ storage: true, checkPreflight: async () => {
    entered.resolve(); await release.promise;
    return { supported: true, reason: "supported", expectedPermissionMode: "auto", isolation: "verified" };
  } });
  const control = new Database(path.join(f.dir, "agent-studio.db"));
  try {
    const starting = f.start(); await entered.promise;
    requestStorageDrain(control); await f.sourceClient!.refresh(); release.resolve(); await starting;
    await f.sourceClient!.waitForDrain(); assert.equal(f.launches, 0);
    const runner = control.prepare("SELECT generation,exit_confirmed FROM agent_runner_states WHERE binding_id=?").get(f.binding.id);
    assert.deepEqual(runner, { generation: 0, exit_confirmed: 1 });
  } finally { release.resolve(); control.close(); await f.close(); }
});

test("#152 不可核实的runner身份阻断drain；不kill、不以超时确认退出", async () => {
  const f = await fixture({ storage: true }); const control = new Database(path.join(f.dir, "agent-studio.db"));
  try {
    const host = (await f.start())!;
    requestStorageDrain(control); await f.sourceClient!.refresh();
    await assert.rejects(f.sourceClient!.waitForDrain(), /source_writer_unknown/);
    assert.equal(host.forced, 0); assert.equal(host.stops, 0);
    assert.equal((control.prepare("SELECT exit_confirmed FROM agent_runner_states WHERE binding_id=?").get(f.binding.id) as { exit_confirmed: number }).exit_confirmed, 0);
  } finally { control.close(); await f.close(); }
});

for (const alreadyStopping of [false, true]) test(`#152 取消维护${alreadyStopping ? "必须等待已发停止的实际退出" : "可以撤回尚未发送的停止"}，不修改用户意图`, async () => {
  const f = await fixture({ storage: true, processIdentity: maintenanceIdentity });
  const control = new Database(path.join(f.dir, "agent-studio.db"));
  try {
    const host = (await f.start())!;
    const before = (await f.runtime.getBinding(f.binding.id))!.binding;
    requestStorageDrain(control); await f.sourceClient!.refresh(); await nextTurn();
    if (alreadyStopping) {
      await host.call("wait_for_messages", { timeoutMs: 10 });
      await until(async () => host.stops === 1, "safe stop missing");
    }
    let cancelled = false;
    const cancel = f.supervisor.cancelMaintenanceDrain(1).then(result => { cancelled = true; return result; });
    await nextTurn();
    if (alreadyStopping) assert.equal(cancelled, false, "送信号不等于已退出");
    else {
      assert.deepEqual(await cancel, { status: "withdrawn", pending: 1 });
      await assert.rejects(f.sourceClient!.waitForDrain(), /drain_incomplete/);
      await host.call("wait_for_messages", { timeoutMs: 10 }); await nextTurn();
      assert.equal(host.stops, 0, "未发的维护停止已撤回");
    }
    host.finish(); await cancel;
    await until(async () => f.sourceClient!.diagnostic.status === "drained", "真实退出后应可完成原epoch收束");
    const receipt = await f.sourceClient!.waitForDrain(); assert.equal(receipt.ownedExits.length, 1);
    const saved = control.prepare("SELECT desired_state,intent_revision FROM agent_runtime_bindings WHERE id=?").get(f.binding.id);
    assert.deepEqual(saved, { desired_state: before.desiredState, intent_revision: before.intentRevision });
    assert.deepEqual(await f.supervisor.cancelMaintenanceDrain(1), { status: "settled", pending: 0 });
  } finally { control.close(); await f.close(); }
});

test("R6 preflight期间显式应用新权限配置，旧能力结果不能领取新配置", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const checked: HostLaunchSnapshot[] = [];
  const f = await fixture({ announcePermission: "manual", checkPreflight: async snapshot => {
    checked.push(snapshot);
    if (checked.length === 1) { entered.resolve(); await release.promise; }
    return { supported: true, reason: "supported", expectedPermissionMode: snapshot.config.permissionMode, isolation: "verified" };
  } });
  try {
    const message = await f.enqueue(f.binding.id, "allowed", "新配置确认前保持排队");
    const starting = f.start();
    await entered.promise;
    await f.runtime.updateBinding(f.binding.id, {
      runtimeRevision: 1, bindingRevision: 1, overrides: { permissionMode: "manual" },
    });
    await f.runtime.intent(f.binding.id, "apply", undefined, { runtimeRevision: 1, bindingRevision: 2 });
    release.resolve();
    await starting;
    await f.supervisor.tick();
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.state === "running", "新配置应以匹配的权限判定就绪");
    assert.deepEqual(checked.map(snapshot => snapshot.config.permissionMode), ["auto", "manual"]);
    assert.equal(f.launches, 1, "过期preflight不能创建任何旧或新配置进程");
    const view = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(view.runner.generation, 1, "拒绝过期preflight时不能提前占用generation");
    assert.equal(view.runner.applied!.config.permissionMode, "manual");
    assert.equal(view.runner.permissionObserved, "manual");
    assert.equal(view.runner.lastErrorCode, null, "不能拿旧expected auto把正确的manual误判为回落");
    assert.equal((await f.repos.deliveries.get(message.id, f.binding.memberId))?.status, "pending");
    assert.equal((await f.hosts[0]!.call("wait_for_messages", { timeoutMs: 100 })).status, "message");
  } finally { release.resolve(); await f.close(); }
});

test("R6 启动超时只回收自有启动进程，已ready的忙碌轮次无运行硬超时", async () => {
  const unknown = await fixture({ announceMode: false, startupTimeoutMs: 100 });
  try {
    const host = (await unknown.start())!; unknown.advance(101); await unknown.supervisor.tick();
    assert.equal(host.forced, 1); assert.equal(host.stops, 0);
    assert.equal((await unknown.runtime.getBinding(unknown.binding.id))!.runner.exitConfirmed, false);
    host.event({ type: "failure", reason: "login_required" }); host.finish(1);
    await until(async () => (await unknown.runtime.getBinding(unknown.binding.id))!.runner.exitConfirmed, "超时进程退出未确认");
    assert.equal((await unknown.runtime.getBinding(unknown.binding.id))!.runner.lastErrorCode, "startup_timeout", "迟到宿主错误不能改写启动超时");
  } finally { await unknown.close(); }
  const ready = await fixture({ startupTimeoutMs: 100 });
  try {
    const host = (await ready.start())!;
    await until(async () => (await ready.runtime.getBinding(ready.binding.id))!.runner.state === "running", "runner 未就绪");
    ready.advance(10 * 60_000); await ready.supervisor.tick();
    assert.equal(host.forced, 0, "启动超时不得变成执行超时"); assert.equal(host.stops, 0);
  } finally { await ready.close(); }
});

test("R6 已就绪且正在处理的SDK连接断开立即离线，不误杀进程、清退避或确认投递", async () => {
  const f = await fixture({ startupTimeoutMs: 100 });
  try {
    const host = (await f.start())!;
    host.event({ type: "session", sessionId: "disconnect-preserved-session" });
    const message = await f.enqueue(f.binding.id, "allowed");
    assert.equal((await host.call("wait_for_messages", { timeoutMs: 100 })).status, "message");
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.harnessSessionId !== null, "原宿主会话尚未保存");
    const before = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(before.runner.phase, "working");
    assert.equal(before.runner.state, "running");
    assert.equal(before.runner.attemptCount, 1);
    assert.equal(f.gateways[0]!.joined, true);

    // 关闭真实SDK transport，但受控进程句柄仍然存活，不能等同于 child.exited。
    await host.client.close();
    assert.equal(f.gateways[0]!.joined, false, "业务连接关闭应同步撤销joined事实");
    await until(async () => (await f.repos.mcpSessions.listByProject(f.project.id))
      .every(session => session.state === "disconnected"), "SDK断连必须更新持久MCP连接事实");
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.lastErrorCode === "transport_lost", "runner必须说明连接丢失");
    f.advance(6 * 60_000);
    await f.supervisor.tick();
    const disconnected = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(disconnected.runner.owner, before.runner.owner, "没有真实退出证明不能让出Member所有权");
    assert.equal(disconnected.runner.exitConfirmed, false);
    assert.equal(disconnected.runner.state, "running", "进程状态仍反映尚未退出的自有进程");
    assert.equal(disconnected.runner.attemptCount, before.runner.attemptCount, "断连后的时间不能计入连续健康期");
    assert.equal(disconnected.runner.harnessSessionId, "disconnect-preserved-session");
    assert.equal(disconnected.runner.lastErrorCode, "transport_lost");
    assert.equal(host.stops, 0, "忙碌轮次没有安全点，不能发送安全停止");
    assert.equal(host.forced, 0, "曾ready的进程不能重新触发启动硬超时");
    assert.equal((await f.repos.deliveries.get(message.id, f.binding.memberId))?.status, "delivered");

    host.finish(1);
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "实际退出后才应释放runner");
    const exited = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(exited.runner.owner, null);
    assert.equal(exited.runner.lastErrorCode, "transport_lost");
    assert.ok(exited.runner.nextRetryAt, "仍需按原失败计数退避重试");
    assert.equal(exited.runner.harnessSessionId, "disconnect-preserved-session");
    assert.equal((await f.repos.deliveries.get(message.id, f.binding.memberId))?.status, "delivered", "断连及退出都不能伪造业务ACK");
  } finally { await f.close(); }
});

test("R6 空闲等待中的SDK连接断开结清wait并请求安全停止，真实退出前保留owner", async () => {
  const f = await fixture();
  try {
    const host = (await f.start())!;
    const waiting = host.call("wait_for_messages", { timeoutMs: 10_000 }).then(
      () => "completed", () => "transport-closed");
    await until(async () => f.gateways[0]!.pendingWaitCount === 1, "空闲wait没有挂起");
    const owner = (await f.runtime.getBinding(f.binding.id))!.runner.owner;
    await host.client.close();
    assert.equal(await waiting, "transport-closed");
    await until(async () => f.gateways[0]!.pendingWaitCount === 0, "断连应结清业务wait，不能等10秒超时");
    await until(async () => host.stops === 1, "已知安全点应请求自有进程优雅停止");
    const stopping = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(f.gateways[0]!.joined, false);
    assert.equal(stopping.runner.owner, owner);
    assert.equal(stopping.runner.exitConfirmed, false);
    assert.equal(stopping.runner.state, "stopping");
    assert.equal(stopping.runner.lastErrorCode, "transport_lost");
    assert.equal(stopping.binding.desiredState, "running", "连接故障不能改写用户运行意图");
    assert.equal(host.forced, 0);
    await f.supervisor.tick();
    assert.equal(host.stops, 1, "同一断连的重复调度不能重复发停止指令");
    assert.equal((await f.repos.mcpSessions.listByProject(f.project.id))[0]?.state, "disconnected");
    host.finish();
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "安全停止也须等实际退出确认");
    const exited = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(exited.runner.owner, null);
    assert.equal(exited.runner.lastErrorCode, "transport_lost", "优雅停止不能掩盖原断连原因");
    assert.ok(exited.runner.nextRetryAt);
  } finally { await f.close(); }
});

test("R6 unsupported保留running意图与队列，拉起失败退避且重复start不绕过", async () => {
  const unavailable = await fixture({ preflight: { supported: false, reason: "profile_unsupported", expectedPermissionMode: "auto", isolation: "unverified" } });
  try {
    await unavailable.start(); assert.equal(unavailable.launches, 0);
    const view = (await unavailable.runtime.getBinding(unavailable.binding.id))!;
    assert.equal(view.binding.desiredState, "running"); assert.equal(view.runner.lastErrorCode, "profile_unsupported");
    assert.equal(view.runner.exitConfirmed, true);
  } finally { await unavailable.close(); }
  const failed = await fixture({ launchFails: true });
  try {
    await failed.start(); assert.equal(failed.launches, 1);
    const view = (await failed.runtime.getBinding(failed.binding.id))!;
    assert.equal(view.binding.desiredState, "running"); assert.equal(view.runner.lastErrorCode, "resource_unavailable");
    assert.ok(view.runner.nextRetryAt); assert.equal(view.runner.exitConfirmed, true);
    await failed.runtime.intent(failed.binding.id, "start"); await failed.supervisor.tick();
    assert.equal(failed.launches, 1);
    failed.advance(1001); await failed.supervisor.tick(); assert.equal(failed.launches, 2);
    await failed.runtime.intent(failed.binding.id, "retry"); await failed.supervisor.tick();
    assert.equal(failed.launches, 3, "显式retry允许立即重新尝试，不与幂等start混用");
  } finally { await failed.close(); }
});

for (const disconnectFirst of [false, true]) {
  test(`R6 认证失败${disconnectFirst ? "晚于" : "早于"}SDK断连仍保留原因与消息，只接受显式重试`, async () => {
    const f = await fixture();
    try {
      const host = (await f.start())!;
      await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.state === "running", "runner 未就绪");
      const message = await f.enqueue(f.binding.id, "allowed", "认证失败不能确认此消息");
      if (disconnectFirst) await host.client.close();
      const parser = createHostOutputParser({ backend: "claude-code", version: "2.1.322", expectedPermissionMode: "auto", onEvent: event => host.event(event) });
      parser.push('{"type":"system","subtype":"init","permissionMode":"auto"}\n');
      parser.push('{"type":"assistant","error":"authentication_failed"}\n');
      parser.push('{"type":"result","subtype":"success","is_error":true}\n');
      parser.end();
      if (!disconnectFirst) await host.client.close();
      host.finish(1);
      await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "认证失败须等待进程退出确认");
      const view = (await f.runtime.getBinding(f.binding.id))!;
      assert.equal(view.runner.lastErrorCode, "auth_required");
      assert.equal(view.runner.nextRetryAt, null);
      assert.equal(view.runner.owner, null);
      assert.equal(view.binding.desiredState, "running");
      assert.equal((await f.repos.deliveries.get(message.id, f.binding.memberId))?.status, "pending");
      f.advance(24 * 60 * 60_000); await f.supervisor.tick();
      await f.runtime.intent(f.binding.id, "start"); await f.supervisor.tick();
      assert.equal(f.launches, 1, "轮询和重复 start 不得热重试认证失败");
      await f.runtime.intent(f.binding.id, "retry"); await f.supervisor.tick();
      assert.equal(f.launches, 2, "用户处理登录后可显式重试");
    } finally { await f.close(); }
  });
}

test("R6 空闲断连已开始安全停止后，迟到的认证失败仍禁止自动重试", async () => {
  const f = await fixture();
  try {
    const host = (await f.start())!;
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.state === "running", "runner 未就绪");
    assert.equal((await host.call("wait_for_messages", { timeoutMs: 10 })).status, "timeout");
    assert.equal((await f.runtime.getBinding(f.binding.id))!.runner.phase, "idle");
    await host.client.close(); await f.supervisor.tick();
    await until(async () => host.stops === 1, "断连没有触发安全停止");
    assert.equal((await f.runtime.getBinding(f.binding.id))!.runner.lastErrorCode, "transport_lost");
    const parser = createHostOutputParser({ backend: "claude-code", version: "2.1.322", expectedPermissionMode: "auto", onEvent: event => host.event(event) });
    parser.push('{"type":"assistant","error":"authentication_failed"}\n');
    parser.push('{"type":"result","subtype":"success","is_error":true}\n');
    parser.end(); host.finish(1);
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "真实退出未确认");
    const view = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(view.runner.lastErrorCode, "auth_required");
    assert.equal(view.runner.nextRetryAt, null);
    f.advance(24 * 60 * 60_000); await f.supervisor.tick();
    assert.equal(f.launches, 1);
  } finally { await f.close(); }
});

test("R6 显式停止后的认证输出保留停止意图与原退出原因", async () => {
  const f = await fixture();
  try {
    const host = (await f.start())!;
    assert.equal((await host.call("wait_for_messages", { timeoutMs: 10 })).status, "timeout");
    await f.runtime.intent(f.binding.id, "stop"); await f.supervisor.tick();
    assert.equal(host.stops, 1);
    host.event({ type: "failure", reason: "login_required" }); host.finish(1);
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "停止后退出未确认");
    const view = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(view.binding.desiredState, "stopped");
    assert.equal(view.runner.lastErrorCode, null);
    assert.equal(view.runner.nextRetryAt, null);
  } finally { await f.close(); }
});

for (const [launchError, expected] of [["workdir_unsafe", "configuration_invalid"], ["login_required", "auth_required"], ["profile_unsupported", "profile_unsupported"]] as const) {
  test(`R6 preflight 之后的 ${launchError} 拒绝不能退化为可重试资源错误`, async () => {
    const f = await fixture({ launchError });
    try {
      await f.start();
      const view = (await f.runtime.getBinding(f.binding.id))!;
      assert.equal(view.runner.lastErrorCode, expected);
      assert.equal(view.runner.nextRetryAt, null);
      assert.equal(view.runner.exitConfirmed, true);
      assert.equal(view.runner.owner, null);
      f.advance(24 * 60 * 60_000); await f.supervisor.tick();
      await f.runtime.intent(f.binding.id, "start"); await f.supervisor.tick();
      assert.equal(f.launches, 1);
      await f.runtime.intent(f.binding.id, "retry"); await f.supervisor.tick();
      assert.equal(f.launches, 2);
    } finally { await f.close(); }
  });
}

test("R6 无提交提示也能在轮询后投递持久allowed消息", async () => {
  const f = await fixture();
  try {
    const host = (await f.start())!;
    const waiting = host.call("wait_for_messages", { timeoutMs: 1000 });
    await until(async () => f.gateways[0]!.pendingWaitCount === 1, "常驻wait没有挂起");
    const message = await f.enqueue(f.binding.id, "allowed");
    await f.supervisor.tick();
    const result = await waiting;
    assert.equal(result.status, "message"); assert.ok(result.messages?.some((item) => item.id === message.id));
    assert.equal((await f.repos.deliveries.get(message.id, f.binding.memberId))?.status, "delivered");
    assert.equal(f.launches, 1);
  } finally { await f.close(); }
});

for (const wake of ["suppressed", null] as const) {
  test(`R6 轮询不能把${wake ?? "NULL"}投递变成自动唤醒，主动backlog仍可读取`, async () => {
    const f = await fixture();
    try {
      const host = (await f.start())!;
      const waiting = host.call("wait_for_messages", { timeoutMs: 80 });
      await until(async () => f.gateways[0]!.pendingWaitCount === 1, "常驻wait没有挂起");
      const message = await f.enqueue(f.binding.id, wake);
      assert.equal((await f.runtime.listWakeable()).length, 0);
      await f.supervisor.tick();
      const result = await waiting;
      assert.equal(result.status, "timeout", "持久决策不允许唤醒时轮询应保持等待");
      assert.equal((await f.repos.deliveries.get(message.id, f.binding.memberId))?.status, "pending");
      const proactive = await host.call("wait_for_messages", { timeoutMs: 80 });
      assert.equal(proactive.status, "message"); assert.ok(proactive.messages?.some((item) => item.id === message.id));
    } finally { await f.close(); }
  });
}

test("R6 同Member不同群在安全点公平让出，当前群未ACK旧消息不能永久饿死其他群", async () => {
  const f = await fixture();
  try {
    const firstHost = (await f.start())!;
    const second = await f.runtime.addBinding(f.created.runtime.id, { projectId: f.project.id, groupId: f.otherGroup.id });
    await f.runtime.intent(second.binding.id, "start");
    const old = await f.enqueue(f.binding.id, "allowed", "甲群旧消息");
    assert.equal((await firstHost.call("wait_for_messages", { timeoutMs: 100 })).status, "message");
    const newer = await f.enqueue(second.binding.id, "allowed", "乙群等待任务");
    const nextBatch = await firstHost.call("wait_for_messages", { timeoutMs: 100 });
    assert.equal(nextBatch.status, "cancelled");
    await until(async () => firstHost.stops === 1, "其他群需要工作时应安全退出当前runner");
    assert.equal(firstHost.forced, 0); assert.equal(f.launches, 1, "退出未确认前不能启动另一个群");
    firstHost.finish();
    await until(async () => f.hosts.length === 2, "确认退出后应该轮到其他群");
    const secondHost = f.hosts[1]!;
    await until(async () => f.gateways[1]!.joined && (await f.runtime.getBinding(second.binding.id))!.runner.state === "running", "第二个群的宿主未完成join与就绪");
    assert.equal(secondHost.snapshot.bindingId, second.binding.id);
    assert.equal((await f.repos.deliveries.get(old.id, f.binding.memberId))?.status, "delivered");
    const reply = await secondHost.call("wait_for_messages", { timeoutMs: 100 });
    assert.ok(reply.messages?.some((item) => item.id === newer.id), JSON.stringify(reply));
    assert.equal((await f.runtime.listBindings()).filter((view) => view.runner.owner !== null).length, 1);
  } finally { await f.close(); }
});

test("R6 保存默认与重复start不热改进程；明确apply在安全点换快照及新会话", async () => {
  const f = await fixture();
  try {
    const first = (await f.start())!;
    first.event({ type: "session", sessionId: "original-session" });
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.harnessSessionId === "original-session", "未记录宿主sid");
    // 生命周期切换允许关闭传输；立即注册错误处理，避免SDK关闭与断言之间的unhandled rejection。
    const waiting = first.call("wait_for_messages", { timeoutMs: 1000 })
      .then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    await until(async () => f.gateways[0]!.pendingWaitCount === 1, "wait未挂起");
    await f.runtime.updateDefaults(f.created.runtime.id, 1, { workdir: f.dir, model: "pending-model" });
    await f.runtime.intent(f.binding.id, "start"); await f.supervisor.tick();
    assert.equal(first.stops, 0); assert.equal(f.launches, 1); assert.equal(first.snapshot.config.model, undefined);
    await f.runtime.intent(f.binding.id, "apply", undefined, { runtimeRevision: 2, bindingRevision: 1 });
    await f.supervisor.tick();
    assert.equal(first.stops, 1); assert.equal(f.launches, 1, "旧进程退出确认前不能应用新代次");
    assert.equal(f.gateways[0]!.pendingWaitCount, 1, "停止控制帧必须先于共用传输关闭，旧wait此时仍待退出");
    first.finish();
    const ended = await waiting;
    if (ended.error !== null) assert.match(String(ended.error), /Connection closed/);
    else assert.equal(ended.value?.status, "cancelled");
    await until(async () => f.hosts.length === 2, "apply退出后未启动新配置");
    const applied = f.hosts[1]!;
    assert.equal(applied.snapshot.config.model, "pending-model"); assert.equal(applied.snapshot.sessionId, undefined);
    assert.ok(applied.snapshot.generation > first.snapshot.generation);
  } finally { await f.close(); }
});

test("R6 mode未知/回落阻止新业务，单次操作拒绝不伪报整轮终止或消息ACK", async () => {
  const unknown = await fixture({ announceMode: false });
  try {
    const host = (await unknown.start())!;
    assert.equal((await host.call("send_message", { text: "模式未证实不能开始" })).error?.code, "FORBIDDEN");
    const task = await createTaskService({ repos: unknown.repos }).create({ actor: ownerActor() }, unknown.project.id,
      { title: "权限模式确认后才能投递", assigneeMemberId: unknown.binding.memberId });
    const event = (await unknown.repos.tasks.listUnackedWorkEvents(unknown.project.id, unknown.binding.memberId)).find(item => item.taskId === task.id)!;
    assert.ok(event, "真实Task创建产生待领取工作事件");
    const repeatedJoin = await host.call("join", { displayName: host.snapshot.identity!.displayName, hostType: host.snapshot.backend,
      projectId: unknown.project.id, groupId: unknown.group.id });
    assert.equal(repeatedJoin.error?.code, "FORBIDDEN", "空join不是业务消费，但有工作事件的join仍须真实权限模式");
    assert.deepEqual((await unknown.repos.tasks.listUnackedWorkEvents(unknown.project.id, unknown.binding.memberId)).find(item => item.id === event.id), event,
      "拒绝不能增加投递次数或伪造ACK");
    const queued = await unknown.enqueue(unknown.binding.id, "allowed");
    host.event({ type: "ready", permissionMode: "auto" });
    await until(async () => (await unknown.runtime.getBinding(unknown.binding.id))!.runner.state === "running", "Auto观察后应就绪");
    const first = await host.call("wait_for_messages", { timeoutMs: 100 });
    assert.ok(first.messages?.some((item) => item.id === queued.id));
    assert.ok((first.workEvents as { id: string }[] | undefined)?.some(item => item.id === event.id), "真实模式确认后才可兑现工作事件");
    host.event({ type: "permission_denied", reason: "permission_required" }); await nextTurn();
    assert.equal(host.stops, 0); assert.equal(host.forced, 0);
    assert.equal((await unknown.repos.deliveries.get(queued.id, unknown.binding.memberId))?.status, "delivered");
    assert.equal((await host.call("acknowledge_message", { messageId: queued.id })).ok, true);
    const next = await unknown.enqueue(unknown.binding.id, "allowed", "下一轮");
    host.event({ type: "permission", mode: "manual", status: "fallback" });
    await until(async () => (await unknown.runtime.getBinding(unknown.binding.id))!.runner.permissionObserved === "manual", "回落未被观察");
    const result = await host.call("wait_for_messages", { timeoutMs: 100 });
    assert.equal(result.status, "cancelled");
    assert.equal((await unknown.repos.deliveries.get(next.id, unknown.binding.memberId))?.status, "pending");
  } finally { await unknown.close(); }
});

test("R6 stop与自有退出乱序不会复活；CLI输出exit事件不能冒充进程退出", async () => {
  const f = await fixture();
  try {
    const host = (await f.start())!;
    host.event({ type: "exit", code: 0, signal: null }); await nextTurn();
    assert.equal((await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, false);
    await f.enqueue(f.binding.id, "allowed");
    await host.call("wait_for_messages", { timeoutMs: 100 });
    await f.runtime.intent(f.binding.id, "stop"); await f.supervisor.tick();
    assert.equal(host.stops, 0); assert.equal(host.forced, 0, "正在工作的轮次不能被stop强杀");
    host.finish(1);
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "真实退出未确认");
    await f.supervisor.tick();
    const stopped = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(stopped.binding.desiredState, "stopped"); assert.equal(stopped.runner.nextRetryAt, null);
    assert.equal(f.launches, 1);
  } finally { await f.close(); }
});

test("R6 异常退出的自动恢复沿用applied和sid，不偷用保存未应用的配置", async () => {
  const f = await fixture();
  try {
    const first = (await f.start())!;
    first.event({ type: "session", sessionId: "recoverable-session" });
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.harnessSessionId === "recoverable-session", "sid未保存");
    await f.runtime.updateDefaults(f.created.runtime.id, 1, { workdir: f.dir, model: "pending-only" });
    first.finish(1);
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "退出未确认");
    await f.supervisor.tick(); assert.equal(f.launches, 1, "异常退出应先退避");
    f.advance(1001); await f.supervisor.tick();
    assert.equal(f.launches, 2);
    const resumed = f.hosts[1]!;
    assert.equal(resumed.snapshot.sessionId, "recoverable-session"); assert.equal(resumed.snapshot.config.model, undefined);
    assert.ok(resumed.snapshot.generation > first.snapshot.generation);
    assert.equal((await f.runtime.getBinding(f.binding.id))!.pendingChanges, true);
  } finally { await f.close(); }
});

test("R6 resume失败保留队列且不自动开新会话，明确new-session后可恢复", async () => {
  const f = await fixture();
  try {
    const original = (await f.start())!;
    original.event({ type: "session", sessionId: "broken-session" });
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.harnessSessionId === "broken-session", "sid未保存");
    original.finish(1);
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "首次退出未确认");
    f.advance(1001); await f.supervisor.tick();
    const resumed = f.hosts[1]!; assert.equal(resumed.snapshot.sessionId, "broken-session");
    const message = await f.enqueue(f.binding.id, "allowed");
    resumed.event({ type: "failure", reason: "resume_failed" });
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.sessionState === "invalid", "resume错误未记录");
    resumed.finish(1);
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "失败进程退出未确认");
    f.advance(60_001); await f.supervisor.tick(); assert.equal(f.launches, 2, "失效sid不能自动换新会话");
    await f.runtime.intent(f.binding.id, "retry"); await f.supervisor.tick();
    assert.equal(f.launches, 3, "明确retry应允许再次尝试原sid");
    const retried = f.hosts[2]!;
    assert.equal(retried.snapshot.sessionId, "broken-session", "retry不能暗中创建新会话");
    retried.event({ type: "failure", reason: "resume_failed" });
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.sessionState === "invalid", "再次resume错误未记录");
    retried.finish(1);
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "人工重试进程退出未确认");
    await f.supervisor.tick(); assert.equal(f.launches, 3, "再次失败也不能自动重复尝试");
    await f.runtime.intent(f.binding.id, "new-session", undefined, { runtimeRevision: 1, bindingRevision: 1 });
    await f.supervisor.tick();
    assert.equal(f.launches, 4, "用户明确new-session后必须能够启动新的宿主会话");
    assert.equal(f.hosts[3]!.snapshot.sessionId, undefined);
    assert.equal((await f.repos.deliveries.get(message.id, f.binding.memberId))?.status, "pending");
  } finally { await f.close(); }
});

test("R6 重启后旧owner租约过期不能猜测退出，人工retry也不能双启", async () => {
  const f = await fixture();
  try {
    await f.runtime.intent(f.binding.id, "start");
    const previous = await f.runtime.claim(f.binding.id, "previous-service-owner", { leaseMs: 100 });
    await f.runtime.patchRunner(previous, { pid: 999_999 });
    f.advance(1001); await f.supervisor.tick();
    assert.equal(f.launches, 0);
    await f.runtime.intent(f.binding.id, "retry"); await f.supervisor.tick();
    assert.equal(f.launches, 0);
    const view = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(view.runner.owner, previous.owner); assert.equal(view.runner.exitConfirmed, false);
    assert.equal(view.runner.pid, 999_999, "仅记录PID不能授权回收或释放旧所有权");
  } finally { await f.close(); }
});

// 检查结果由受控launcher注入，只验supervisor的所有权/CAS处理；不冒充Linux内核或CLI实测。
function processIdentity(): OwnedProcessIdentity {
  return { version: 1, launcherProtocol: "linux-private-net-v1", pid: 999_999,
    kernelBootId: "11111111-1111-1111-1111-111111111111", pidNamespace: "pid:[1234]", startTicks: "12345" };
}
function inspection(status: OwnedProcessInspection["status"]): OwnedProcessInspection {
  return { status, reason: status === "wrapper_exited" ? "process_absent" : status === "observed_alive" ? "identity_matches" : "read_unavailable",
    inspectedAt: new Date().toISOString() };
}
async function previousOwner(f: Awaited<ReturnType<typeof fixture>>) {
  await f.runtime.intent(f.binding.id, "start");
  const fence = await f.runtime.claim(f.binding.id, "previous-service-owner", { leaseMs: 100 });
  await f.runtime.setProcessIdentity(fence, processIdentity());
  await f.runtime.setSession(fence, "previous-session");
  return fence;
}

test("R6 受控宿主启动后保存恢复身份，真实退出后清除而不由PID猜测", async () => {
  const identity = processIdentity();
  const f = await fixture({ processIdentity: identity });
  try {
    const host = (await f.start())!;
    const started = (await f.runtime.getBinding(f.binding.id))!;
    assert.deepEqual(started.runner.processIdentity, identity); assert.equal(started.runner.pid, identity.pid);
    host.event({ type: "exit", code: 0, signal: null }); await nextTurn();
    assert.deepEqual((await f.runtime.getBinding(f.binding.id))!.runner.processIdentity, identity);
    host.finish(1);
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "自有进程退出未记录");
    assert.equal((await f.runtime.getBinding(f.binding.id))!.runner.processIdentity, null);
  } finally { await f.close(); }
});

test("R6 恢复检查遵守租约且unknown/alive不释放，确证退出后退避恢复同一sid", async () => {
  const inspections: OwnedProcessIdentity[] = [];
  let status: OwnedProcessInspection["status"] = "unknown";
  const f = await fixture({ inspectPrevious: async (identity) => { inspections.push(identity); return inspection(status); } });
  try {
    const previous = await previousOwner(f);
    const message = await f.enqueue(f.binding.id, "allowed");
    await f.supervisor.tick(); assert.equal(inspections.length, 0, "有效租约不能触发重启检查");
    f.advance(101); await f.supervisor.tick();
    assert.equal(inspections.length, 1); assert.equal(f.launches, 0);
    assert.equal((await f.runtime.getBinding(f.binding.id))!.runner.owner, previous.owner);
    status = "observed_alive"; await f.supervisor.tick();
    assert.equal(f.launches, 0); assert.equal((await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, false);
    status = "wrapper_exited"; await f.supervisor.tick();
    const recovered = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(recovered.runner.owner, null); assert.equal(recovered.runner.exitConfirmed, true);
    assert.ok(recovered.runner.nextRetryAt); assert.equal(f.launches, 0, "确证退出后仍须履行恢复退避");
    assert.equal((await f.repos.deliveries.get(message.id, f.binding.memberId))?.status, "pending");
    f.advance(1001); await f.supervisor.tick();
    assert.equal(f.launches, 1); assert.equal(f.hosts[0]!.snapshot.sessionId, "previous-session");
    assert.ok(f.hosts[0]!.snapshot.generation > previous.generation);
  } finally { await f.close(); }
});

for (const concurrentChange of ["renew", "generation"] as const) {
  test(`R6 内核检查期间${concurrentChange === "renew" ? "旧owner续租" : "新generation取得所有权"}使迟到退出证明失效`, async () => {
    const observed = deferred<void>(); const result = deferred<OwnedProcessInspection>();
    const f = await fixture({ inspectPrevious: async () => { observed.resolve(); return result.promise; } });
    try {
      const previous = await previousOwner(f); f.advance(101);
      const tick = f.supervisor.tick(); await observed.promise;
      let expected = previous;
      if (concurrentChange === "renew") await f.runtime.renew(previous, 5000);
      else {
        await f.runtime.markExit(previous, { exitCode: 0 });
        expected = await f.runtime.claim(f.binding.id, "new-service-owner");
      }
      result.resolve(inspection("wrapper_exited")); await tick;
      const current = (await f.runtime.getBinding(f.binding.id))!;
      assert.equal(current.runner.owner, expected.owner); assert.equal(current.runner.generation, expected.generation);
      assert.equal(current.runner.exitConfirmed, false); assert.equal(f.launches, 0);
    } finally { result.resolve(inspection("unknown")); await f.close(); }
  });
}

test("R6 stopped意图的旧进程确证退出后保持停止，消息不被当作已完成", async () => {
  const f = await fixture({ inspectPrevious: async () => inspection("wrapper_exited") });
  try {
    await previousOwner(f); const message = await f.enqueue(f.binding.id, "allowed");
    await f.runtime.intent(f.binding.id, "stop"); f.advance(101); await f.supervisor.tick();
    const stopped = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(stopped.runner.exitConfirmed, true); assert.equal(stopped.runner.owner, null);
    assert.equal(stopped.runner.lastErrorCode, null); assert.equal(stopped.runner.nextRetryAt, null);
    f.advance(60_000); await f.supervisor.tick(); assert.equal(f.launches, 0);
    assert.equal((await f.repos.deliveries.get(message.id, f.binding.memberId))?.status, "pending");
  } finally { await f.close(); }
});

test("R6 退出恢复保留不可重试错误与失效会话，不能顺便解除人工恢复要求", async () => {
  const f = await fixture({ inspectPrevious: async () => inspection("wrapper_exited") });
  try {
    const previous = await previousOwner(f);
    await f.runtime.patchRunner(previous, { lastErrorCode: "protocol_invalid", sessionState: "invalid" });
    f.advance(101); await f.supervisor.tick();
    const recovered = (await f.runtime.getBinding(f.binding.id))!;
    assert.equal(recovered.runner.exitConfirmed, true); assert.equal(recovered.runner.lastErrorCode, "protocol_invalid");
    assert.equal(recovered.runner.sessionState, "invalid"); assert.equal(recovered.runner.nextRetryAt, null);
    f.advance(60_000); await f.supervisor.tick(); assert.equal(f.launches, 0);
    await f.runtime.intent(f.binding.id, "new-session", undefined, { runtimeRevision: 1, bindingRevision: 1 });
    await f.supervisor.tick(); assert.equal(f.launches, 1); assert.equal(f.hosts[0]!.snapshot.sessionId, undefined);
  } finally { await f.close(); }
});

// 仅验证来源合同；不能将合成 schema 登记为真实宿主支持。
const SESSION_USAGE_SCHEMA: VerifiedUsageSchema = {
  format: "claude-result-v1", sequenceField: "result_index", evidence: "synthetic-session-scope-contract-only",
  metrics: {
    inputTokens: { scope: "invocation", cumulative: false, zeroMeaningful: false },
    costUsd: { scope: "session", cumulative: true, zeroMeaningful: false },
  },
};
function usageParser(host: ControlledHost) {
  return createHostOutputParser({ backend: "claude-code", version: "2.1.322", expectedPermissionMode: "auto",
    usageSchema: SESSION_USAGE_SCHEMA, onEvent: event => host.event(event) });
}
function usageFrame(sessionId: string, cost: number, tokens: number,
  { index = 0, turns = 1, successful = true }: { index?: number; turns?: number; successful?: boolean } = {}) {
  return JSON.stringify({ type: "result", subtype: "success", is_error: !successful,
    session_id: sessionId, result_index: index, num_turns: turns, total_cost_usd: cost, usage: { input_tokens: tokens } }) + "\n";
}

test("R-64-NATIVE-003：同SID续接的累计金额只保留会话快照，token仍属于两次调用", async () => {
  const f = await fixture();
  const sid = "synthetic-private-session-003";
  try {
    const first = (await f.start())!;
    usageParser(first).push(usageFrame(sid, 0.021495, 101));
    await until(async () => (await f.observations.listUsage({ bindingId: f.binding.id })).length === 2, "首份结果应采得独立token及金额");
    first.finish();
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "旧进程必须实际退出");
    await f.runtime.intent(f.binding.id, "retry"); await f.supervisor.tick();
    const second = f.hosts[1]!;
    assert.equal(second.snapshot.sessionId, sid);
    assert(second.snapshot.generation > first.snapshot.generation);
    // 两次进程的 native result_index 和 num_turns 都可重新从头计数。
    usageParser(second).push(usageFrame(sid, 0.024667, 202));
    await until(async () => (await f.observations.listUsage({ bindingId: f.binding.id })).some(row => row.value === 0.024667), "续接结果应已处理");
    const rows = await f.observations.listUsage({ bindingId: f.binding.id });
    const costs = rows.filter(row => row.metric === "costUsd");
    assert.equal(costs.length, 1, "不能把同一session累计金额拆成每次attempt各一份");
    assert.equal(costs[0]!.value, 0.024667);
    assert.equal(costs[0]!.scope, "session"); assert.equal(costs[0]!.cumulative, true);
    assert.equal(costs[0]!.coverage, "partial"); assert.equal(costs[0]!.delta, null);
    const tokens = rows.filter(row => row.metric === "inputTokens");
    assert.deepEqual(tokens.map(row => row.value).sort(), [101, 202]);
    assert(tokens.every(row => row.scope === "invocation"));
    assert.notEqual(tokens[0]!.scopeId, tokens[1]!.scopeId);
    assert.equal(JSON.stringify(rows).includes(sid), false, "公开观测不能带CLI SID");
    assert.equal(JSON.stringify(await f.observations.list({ bindingId: f.binding.id })).includes(sid), false);
  } finally { await f.close(); }
});

test("R-64-NATIVE-003：请求resume、错误SID与旧generation均不能冒认会话用量", async () => {
  const f = await fixture();
  const sid = "synthetic-private-original-sid";
  const wrongSid = "synthetic-private-wrong-sid";
  try {
    const first = (await f.start())!;
    const firstParser = usageParser(first);
    firstParser.push(usageFrame(sid, 20, 100));
    await until(async () => (await f.observations.listUsage({ bindingId: f.binding.id })).some(row => row.value === 20), "首次会话用量未写入");
    first.finish();
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "首个进程退出未确认");
    await f.runtime.intent(f.binding.id, "retry"); await f.supervisor.tick();
    const second = f.hosts[1]!;
    assert.equal(second.snapshot.sessionId, sid);
    const missingCount = async () => (await f.observations.list({ bindingId: f.binding.id })).events
      .filter(event => event.event === "usage_unavailable").length;
    const beforeMissing = await missingCount();
    // 请求中的 resume SID 不是本代进程已经报告该会话的证据。
    second.event({ type: "usage", source: "claude-code", harnessVersion: "2.1.322", scope: "session", sessionId: sid,
      sequence: 0, metric: "costUsd", value: 999, cumulative: true, zeroMeaningful: false,
      successful: true, coverage: "partial", schemaVerified: true });
    await until(async () => await missingCount() === beforeMissing + 1, "未观察到会话归属应保持不可得");
    assert.equal((await f.observations.listUsage({ bindingId: f.binding.id })).find(row => row.metric === "costUsd")!.value, 20);

    const parser = usageParser(second);
    parser.push(usageFrame(sid, 23, 200));
    await until(async () => (await f.observations.listUsage({ bindingId: f.binding.id })).some(row => row.value === 23), "合法续接未写入");
    parser.push(usageFrame(sid, 24, 201, { index: 2, turns: 0 }));
    await until(async () => (await f.observations.listUsage({ bindingId: f.binding.id })).some(row => row.value === 24), "轮次数回退不能推翻源结果顺序");
    parser.push(usageFrame(wrongSid, 999, 202, { index: 3 }));
    await until(async () => await missingCount() === beforeMissing + 2, "被拒绝的SID不能继续使用旧会话归属");
    assert.equal((await f.runtime.getBinding(f.binding.id))!.runner.harnessSessionId, sid);
    const cost = (await f.observations.listUsage({ bindingId: f.binding.id })).find(row => row.metric === "costUsd")!;
    assert.equal(cost.value, 24); assert.equal(cost.sequence, 2);

    // 已退出旧进程即使补发更大的序号，也不能进入现有 generation。
    firstParser.push(usageFrame(sid, 999, 999, { index: 999 }));
    first.event({ type: "usage_unavailable" });
    await nextTurn(); await nextTurn();
    assert.deepEqual((await f.observations.listUsage({ bindingId: f.binding.id })).find(row => row.metric === "costUsd"), cost);
    assert.equal(await missingCount(), beforeMissing + 2);
    const publicRecords = JSON.stringify({ usage: await f.observations.listUsage({ bindingId: f.binding.id }),
      events: await f.observations.list({ bindingId: f.binding.id }) });
    assert.equal(publicRecords.includes(sid), false); assert.equal(publicRecords.includes(wrongSid), false);
  } finally { await f.close(); }
});

test("R-64-NATIVE-003：不同binding报告相同原生SID也有独立公开引用", async () => {
  // 使用独立数据库允许同一个原生SID；真实共享数据库另有session唯一性约束。
  const one = await fixture(); const two = await fixture();
  try {
    for (const f of [one, two]) {
      usageParser((await f.start())!).push(usageFrame("same-private-native-sid", 20, 100));
      await until(async () => (await f.observations.listUsage({ bindingId: f.binding.id })).some(row => row.metric === "costUsd"), "会话统计未写入");
    }
    const a = (await one.observations.listUsage({ bindingId: one.binding.id })).find(row => row.metric === "costUsd")!;
    const b = (await two.observations.listUsage({ bindingId: two.binding.id })).find(row => row.metric === "costUsd")!;
    assert.notEqual(a.scopeId, b.scopeId); assert.notEqual(a.epochId, b.epochId);
  } finally { await two.close(); await one.close(); }
});

test("R-64-NATIVE-003：失败零与累计回退保留跨attempt高水位，明确新SID才分开", async () => {
  const f = await fixture();
  const sid = "synthetic-private-cumulative-sid";
  try {
    const first = (await f.start())!;
    usageParser(first).push(usageFrame(sid, 20, 100));
    await until(async () => (await f.observations.listUsage({ bindingId: f.binding.id })).some(row => row.value === 20), "初始累计未写入");
    const original = (await f.observations.listUsage({ bindingId: f.binding.id })).find(row => row.metric === "costUsd")!;
    async function resume(previous: ControlledHost) {
      previous.finish();
      await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "进程退出未确认");
      await f.runtime.intent(f.binding.id, "retry"); await f.supervisor.tick();
      return f.hosts.at(-1)!;
    }
    const failed = await resume(first);
    usageParser(failed).push(usageFrame(sid, 0, 0, { successful: false }));
    await until(async () => (await f.observations.listUsage({ bindingId: f.binding.id }))
      .some(row => row.metric === "costUsd" && row.runnerGeneration === failed.snapshot.generation), "失败零未处理");
    const zero = (await f.observations.listUsage({ bindingId: f.binding.id })).find(row => row.metric === "costUsd")!;
    assert.equal(zero.value, null); assert.equal(zero.delta, null); assert.equal(zero.cumulativeHighWatermark, 20);
    assert.equal(zero.scopeId, original.scopeId); assert.equal(zero.epochId, original.epochId);
    assert.equal(zero.epochReliable, true, "缺失零不能猜测会话reset");

    const reset = await resume(failed);
    usageParser(reset).push(usageFrame(sid, 3, 300));
    await until(async () => (await f.observations.listUsage({ bindingId: f.binding.id }))
      .some(row => row.metric === "costUsd" && row.runnerGeneration === reset.snapshot.generation), "回退累计未处理");
    const dropped = (await f.observations.listUsage({ bindingId: f.binding.id })).find(row => row.metric === "costUsd")!;
    assert.equal(dropped.value, 3); assert.equal(dropped.cumulativeHighWatermark, 20);
    assert.equal(dropped.scopeId, original.scopeId); assert.equal(dropped.epochId, original.epochId);
    assert.equal(dropped.delta, null); assert.equal(dropped.epochReliable, false); assert.equal(dropped.reasonCode, "cumulative_reset");

    reset.finish();
    await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "回退进程退出未确认");
    await f.runtime.intent(f.binding.id, "new-session", undefined, { runtimeRevision: 1, bindingRevision: 1 });
    await f.supervisor.tick();
    const fresh = f.hosts.at(-1)!;
    assert.equal(fresh.snapshot.sessionId, undefined);
    usageParser(fresh).push(usageFrame("synthetic-private-new-sid", 5, 400));
    await until(async () => (await f.observations.listUsage({ bindingId: f.binding.id }))
      .filter(row => row.metric === "costUsd").length === 2, "新SID应有独立会话引用");
    const costs = (await f.observations.listUsage({ bindingId: f.binding.id })).filter(row => row.metric === "costUsd");
    const newCost = costs.find(row => row.value === 5)!;
    assert.notEqual(newCost.scopeId, original.scopeId); assert.notEqual(newCost.epochId, original.epochId);
    assert.equal(newCost.cumulativeHighWatermark, 5); assert.equal(newCost.epochReliable, true);
    assert.equal(newCost.delta, null); assert.equal(newCost.coverage, "partial");
  } finally { await f.close(); }
});
