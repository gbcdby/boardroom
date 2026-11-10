import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { createRuntimeObservability } from "../src/server/runtime/observability.ts";
import { createRuntimeSupervisor } from "../src/server/runtime/supervisor.ts";
import { createRuntimeGateway, type RuntimeGateway } from "../src/server/runtime/gateway.ts";
import { createLogger } from "../src/server/logger.ts";
import type { HostEvent, HostLauncher, HostLaunchSnapshot, HostPreflight, OwnedHostProcess, OwnedProcessIdentity, OwnedProcessInspection } from "../src/server/runtime/hosts/types.ts";

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

async function fixture(options: { announceMode?: boolean; preflight?: HostPreflight; launchFails?: boolean; startupTimeoutMs?: number;
  announcePermission?: "auto" | "manual"; checkPreflight?: HostLauncher["preflight"];
  processIdentity?: OwnedProcessIdentity; inspectPrevious?: NonNullable<HostLauncher["inspectPrevious"]> } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "runtime-supervisor-"));
  const db = new SqliteDriver({ dataDir: dir }); await db.connect(); await db.migrate(migrations);
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
    ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }) });
  return {
    db, dir, repos, runtime, project, group, otherGroup, created, binding, hosts, gateways, supervisor, observations,
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
    const queued = await unknown.enqueue(unknown.binding.id, "allowed");
    host.event({ type: "ready", permissionMode: "auto" });
    await until(async () => (await unknown.runtime.getBinding(unknown.binding.id))!.runner.state === "running", "Auto观察后应就绪");
    const first = await host.call("wait_for_messages", { timeoutMs: 100 });
    assert.ok(first.messages?.some((item) => item.id === queued.id));
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
