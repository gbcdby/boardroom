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
import { createLogger } from "../src/server/logger.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { createRuntimeObservability } from "../src/server/runtime/observability.ts";
import { createRuntimeSupervisor } from "../src/server/runtime/supervisor.ts";
import type { HostEvent, HostLauncher, HostLaunchSnapshot, OwnedHostProcess } from "../src/server/runtime/hosts/types.ts";

type ScopeChange = "项目归档" | "群归档" | "成员停用";
type Observer = Parameters<HostLauncher["launch"]>[1];
interface Payload { ok: boolean; status?: string; messages?: { id: string }[]; error?: { code: string } }

async function until(predicate: () => boolean | Promise<boolean>, reason: string) {
  for (let i = 0; i < 200; i += 1) { if (await predicate()) return; await delay(1); }
  assert.fail(reason);
}

/** 只替代自有子进程句柄；SQLite、MCP SDK、core、gateway、supervisor 均使用真实实现。 */
class ControlledHost implements OwnedHostProcess {
  readonly snapshot: HostLaunchSnapshot;
  readonly observer: Observer;
  readonly client: Client;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private resolveExit!: (result: { code: number | null; signal: string | null }) => void;
  stops = 0;
  forced = 0;
  constructor(snapshot: HostLaunchSnapshot, observer: Observer, client: Client) {
    this.snapshot = snapshot; this.observer = observer; this.client = client;
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
  }
  stopAtSafePoint() { this.stops += 1; }
  forceStopOwned() { this.forced += 1; }
  finish() { this.resolveExit({ code: 0, signal: null }); }
  event(event: HostEvent) { this.observer.onEvent(event); }
  async call(name: string, args: Record<string, unknown>): Promise<Payload> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return JSON.parse(content.find(part => part.type === "text")!.text!) as Payload;
  }
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "runtime-lifecycle-"));
  const db = new SqliteDriver({ dataDir: dir }); await db.connect(); await db.migrate(migrations);
  const repos = createRepositories(db);
  let clock = Date.now();
  const runtime = createRuntimeRepository(db, { now: () => new Date(clock) });
  const logger = createLogger({ level: "error", write: () => {} });
  const observations = createRuntimeObservability({ db, logger, now: () => clock });
  const project = await repos.projects.create({ name: "生命周期" });
  const group = await repos.groups.create({ projectId: project.id, name: "当前群" });
  const otherProject = await repos.projects.create({ name: "独立项目" });
  const otherGroup = await repos.groups.create({ projectId: otherProject.id, name: "独立群" });
  const created = await runtime.create({ name: "生命周期Agent", backend: "claude-code",
    defaults: { workdir: dir, systemPrompt: "原始附加指令" }, bindings: [{ projectId: project.id, groupId: group.id }] });
  const binding = created.bindings[0]!.binding;
  const human = await repos.members.create({ projectId: project.id, kind: "human", displayName: "用户" });
  await repos.groups.addParticipant(group.id, human.id);
  const hosts: ControlledHost[] = [];
  const preflightCalls = new Map<string, number>();
  const claimCalls = new Map<string, number>();
  const claim = runtime.claim.bind(runtime);
  runtime.claim = async (...args) => {
    claimCalls.set(args[0], (claimCalls.get(args[0]) ?? 0) + 1);
    return claim(...args);
  };
  const launcher: HostLauncher = {
    async preflight(snapshot) {
      preflightCalls.set(snapshot.bindingId, (preflightCalls.get(snapshot.bindingId) ?? 0) + 1);
      return { supported: true, reason: "supported", expectedPermissionMode: "auto", isolation: "verified" };
    },
    async launch(snapshot, observer) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "lifecycle-controlled-host", version: "test-only" });
      const host = new ControlledHost(snapshot, observer, client); hosts.push(host);
      await observer.onMcpTransport!(serverTransport); await client.connect(clientTransport);
      observer.onEvent({ type: "ready", permissionMode: "auto" });
      const joined = await host.call("join", { displayName: snapshot.identity!.displayName, hostType: snapshot.backend,
        projectId: snapshot.identity!.projectId, groupId: snapshot.identity!.groupId });
      assert.equal(joined.ok, true, JSON.stringify(joined));
      return host;
    },
  };
  const supervisor = createRuntimeSupervisor({ db, logger, launcher, observations, repository: runtime,
    stateRoot: dir, now: () => clock, random: () => 1, manual: true });
  return {
    runtime, repos, binding, created, supervisor, hosts, claimCalls, preflightCalls, dir,
    advance(ms: number) { clock += ms; },
    async start() {
      await runtime.intent(binding.id, "start"); await supervisor.tick();
      await until(async () => (await runtime.getBinding(binding.id))!.runner.state === "running", "runner 应完成 join 和权限确认");
      return hosts.at(-1)!;
    },
    async message(text: string) {
      const message = await repos.messages.create({ groupId: group.id, senderMemberId: human.id, body: text, mentions: [binding.memberId] });
      await repos.deliveries.ensure(message.id, binding.memberId, { decision: "allowed" });
      return message;
    },
    async scope(change: ScopeChange, active: boolean) {
      if (change === "项目归档") return active ? repos.projects.restore(project.id) : repos.projects.archive(project.id);
      if (change === "群归档") return active ? repos.groups.restore(group.id) : repos.groups.archive(group.id);
      return repos.members.setStatus(binding.memberId, active ? "active" : "disabled");
    },
    async independent() {
      const other = await runtime.create({ name: "独立Agent", backend: "claude-code", defaults: { workdir: dir },
        bindings: [{ projectId: otherProject.id, groupId: otherGroup.id }] });
      const view = other.bindings[0]!;
      assert.notEqual(view.binding.memberId, binding.memberId);
      await runtime.intent(view.binding.id, "start");
      return view;
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

for (const change of ["项目归档", "群归档", "成员停用"] as const) {
  for (const phase of ["idle", "working"] as const) {
    test(`R2 ${change}时${phase}进程在安全点退出，恢复沿用applied与显式sid`, async () => {
      const f = await fixture();
      try {
        const host = await f.start();
        const connection = (await f.repos.mcpSessions.listByProject(f.binding.projectId))
          .find(session => session.memberId === f.binding.memberId && session.state === "connected");
        assert.ok(connection, "托管 runner join 后必须有真实连接记录");
        host.event({ type: "session", sessionId: "lifecycle-session" });
        await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.harnessSessionId === "lifecycle-session", "sid 应持久化");
        if (phase === "working") await f.message("当前轮次");
        assert.equal((await host.call("wait_for_messages", { timeoutMs: 10 })).status, phase === "working" ? "message" : "timeout");
        const queued = await f.message("恢复后仍应可读的消息");
        const before = (await f.runtime.getBinding(f.binding.id))!;
        await f.runtime.updateDefaults(f.created.runtime.id, 1, { workdir: f.dir, systemPrompt: "保存但未应用的新指令" });
        await f.scope(change, false);
        assert.equal((await host.call("acknowledge_message", { messageId: queued.id })).ok, false, "安全点收尾不授予失资格范围 ACK 权限");
        assert.equal((await host.call("send_message", { text: "不能写入失资格范围" })).ok, false);
        assert.equal((await host.call("read_history", {})).ok, false, "消费入口仍需运行资格");
        await f.supervisor.tick();
        assert.equal(host.forced, 0, "资格变化不能强杀在途轮次");
        if (phase === "working") assert.equal(host.stops, 0, "忙碌期间只等待下一个安全点");
        else await until(() => host.stops === 1, "idle 进程已经在安全点，应收到停止请求");

        const waited = await host.call("wait_for_messages", { timeoutMs: 10 });
        assert.equal(waited.status, "cancelled", "失资格后的 wait 应确认安全点并停止，不开启新轮次");
        assert.deepEqual(waited.messages, []);
        await until(() => host.stops === 1, "安全点应恰好请求一次优雅停止");
        assert.equal((await f.repos.deliveries.get(queued.id, f.binding.memberId))!.status, "pending");
        assert.equal(host.forced, 0);
        const stopping = (await f.runtime.getBinding(f.binding.id))!;
        assert.equal(stopping.binding.desiredState, "running", "资格暂停不能覆盖用户运行意图");
        assert.equal(stopping.runner.state, "stopping");
        assert.equal(stopping.runner.exitConfirmed, false, "停止请求不能冒充真实退出");
        assert.equal(stopping.runner.generation, before.runner.generation);

        host.finish();
        await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "真实退出后才释放所有权");
        assert.equal((await f.repos.mcpSessions.get(connection.id))?.state, "disconnected",
          "退出清理必须关闭同代连接，停用资格不能留下 connected 记录阻塞恢复");
        const claimsBefore = f.claimCalls.get(f.binding.id);
        const preflightsBefore = f.preflightCalls.get(f.binding.id);
        for (let i = 0; i < 3; i += 1) await f.supervisor.tick();
        assert.equal(f.hosts.length, 1, "失资格范围不得自动重启");
        assert.equal(f.claimCalls.get(f.binding.id), claimsBefore, "失资格范围不能每轮继续 claim");
        assert.equal(f.preflightCalls.get(f.binding.id), preflightsBefore);

        await f.scope(change, true);
        await f.supervisor.tick();
        await until(async () => f.hosts.length === 2 && (await f.runtime.getBinding(f.binding.id))!.runner.state === "running", "恢复资格后应重建 runner");
        const resumed = (await f.runtime.getBinding(f.binding.id))!;
        const nextHost = f.hosts[1]!;
        const nextConnection = (await f.repos.mcpSessions.listByProject(f.binding.projectId))
          .find(session => session.memberId === f.binding.memberId && session.state === "connected");
        assert.ok(nextConnection);
        assert.notEqual(nextConnection.id, connection.id, "恢复保留宿主 sid，但建立新的 MCP 连接记录");
        assert.equal((await f.repos.mcpSessions.get(connection.id))?.state, "disconnected");
        assert.equal(resumed.binding.desiredState, "running");
        assert.equal(resumed.runner.applied!.digest, before.runner.applied!.digest);
        assert.equal(resumed.runner.harnessSessionId, "lifecycle-session");
        assert.equal(resumed.runner.sessionState, "resumable");
        assert.equal(resumed.runner.generation, before.runner.generation + 1);
        assert.equal(nextHost.snapshot.sessionId, "lifecycle-session");
        assert.equal(nextHost.snapshot.config.systemPrompt, "原始附加指令", "恢复不能偷换尚未应用的配置");
        assert.equal(resumed.effective.config.systemPrompt, "保存但未应用的新指令");
        const delivered = await nextHost.call("wait_for_messages", { timeoutMs: 10 });
        assert.equal(delivered.status, "message");
        assert.ok(delivered.messages?.some(message => message.id === queued.id));
      } finally { await f.close(); }
    });
  }

  test(`R2 ${change}后的忙碌owner满五分钟不阻断独立Member调度或清零失败计数`, async () => {
    const f = await fixture();
    try {
      const host = await f.start();
      await f.message("在途轮次");
      assert.equal((await host.call("wait_for_messages", { timeoutMs: 10 })).status, "message");
      const before = (await f.runtime.getBinding(f.binding.id))!;
      await f.scope(change, false);
      const other = await f.independent();
      f.advance(5 * 60_000 + 1);
      await f.supervisor.tick();
      await until(async () => (await f.runtime.getBinding(other.binding.id))!.runner.state === "running", "单个失资格 owner 不得中断全局轮询");
      const inactive = (await f.runtime.getBinding(f.binding.id))!;
      assert.equal(inactive.runner.attemptCount, before.runner.attemptCount, "失资格期间不属于健康运行窗口");
      assert.equal(inactive.runner.owner, before.runner.owner, "当前子进程未退出，仍需保留所有权");
      assert.equal(inactive.runner.exitConfirmed, false);
      assert.equal(host.stops, 0); assert.equal(host.forced, 0);
    } finally { await f.close(); }
  });

  test(`R2 ${change}后的显式stop不被业务授权阻断，恢复不会复活stopped意图`, async () => {
    const f = await fixture();
    try {
      const host = await f.start();
      await f.message("在途轮次");
      assert.equal((await host.call("wait_for_messages", { timeoutMs: 10 })).status, "message");
      await f.scope(change, false);
      await f.runtime.intent(f.binding.id, "stop");
      await f.supervisor.tick();
      assert.equal(host.stops, 0, "显式 stop 仍不得中断忙碌轮次");
      const waited = await host.call("wait_for_messages", { timeoutMs: 10 });
      assert.equal(waited.status, "cancelled", "有效 owner 的安全点确认不能被归档/停用拦截");
      await until(() => host.stops === 1, "wait 安全点应送达优雅停止请求");
      assert.equal(host.forced, 0);
      host.finish();
      await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "退出必须被确认");
      await f.scope(change, true);
      await f.supervisor.tick();
      await nextTurn();
      const stopped = (await f.runtime.getBinding(f.binding.id))!;
      assert.equal(stopped.binding.desiredState, "stopped");
      assert.equal(stopped.runner.state, "stopped");
      assert.equal(f.hosts.length, 1);
    } finally { await f.close(); }
  });

  test(`R2 ${change}的冷绑定不重复claim或preflight，恢复才按原意图启动`, async () => {
    const f = await fixture();
    try {
      await f.runtime.intent(f.binding.id, "start");
      const requested = (await f.runtime.getBinding(f.binding.id))!.binding.requestedSnapshot;
      await f.scope(change, false);
      for (let i = 0; i < 3; i += 1) await f.supervisor.tick();
      assert.equal(f.claimCalls.get(f.binding.id) ?? 0, 0);
      assert.equal(f.preflightCalls.get(f.binding.id) ?? 0, 0);
      assert.equal(f.hosts.length, 0);
      const inactive = (await f.runtime.getBinding(f.binding.id))!;
      assert.equal(inactive.binding.desiredState, "running");
      assert.deepEqual(inactive.binding.requestedSnapshot, requested);
      assert.notEqual(inactive.runner.lastErrorCode, "busy", "资格不满足不能误报其他owner占用");
      assert.equal(inactive.runner.attemptCount, 0);
      await f.scope(change, true);
      await f.supervisor.tick();
      await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.state === "running", "恢复后按已有 running 意图启动");
      assert.equal(f.hosts.length, 1);
      assert.equal(f.claimCalls.get(f.binding.id), 1);
      assert.equal(f.preflightCalls.get(f.binding.id), 1);
    } finally { await f.close(); }
  });

  for (const failure of ["auth_required", "process_exit"] as const) {
    test(`R2 ${change}与恢复保留既有${failure}原因及重试门禁`, async () => {
      const f = await fixture();
      try {
        const host = await f.start();
        const queued = await f.message("失败后仍需处理的消息");
        if (failure === "auth_required") {
          host.event({ type: "failure", reason: "login_required" });
          await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.lastErrorCode === failure, "宿主失败原因应持久化");
        }
        host.finish();
        await until(async () => (await f.runtime.getBinding(f.binding.id))!.runner.exitConfirmed, "子进程退出应落库");
        await f.supervisor.tick();
        const failed = (await f.runtime.getBinding(f.binding.id))!;
        assert.equal(failed.runner.lastErrorCode, failure);
        if (failure === "auth_required") assert.equal(failed.runner.nextRetryAt, null);
        else assert.ok(failed.runner.nextRetryAt, "意外退出应有持久退避");

        for (const active of [false, true]) {
          await f.scope(change, active);
          await f.supervisor.tick();
          await f.supervisor.tick();
          const unchanged = (await f.runtime.getBinding(f.binding.id))!;
          assert.equal(unchanged.runner.lastErrorCode, failure);
          assert.equal(unchanged.runner.nextRetryAt, failed.runner.nextRetryAt);
          assert.equal(unchanged.runner.attemptCount, failed.runner.attemptCount);
          assert.equal(unchanged.binding.desiredState, "running");
          assert.equal(unchanged.runner.applied!.digest, failed.runner.applied!.digest);
          assert.equal(f.hosts.length, 1, "恢复资格不能绕过人工 retry 或已有退避期限");
        }
        assert.equal((await f.repos.deliveries.get(queued.id, f.binding.memberId))!.status, "pending");
        if (failure === "auth_required") await f.runtime.intent(f.binding.id, "retry");
        else f.advance(1001);
        await f.supervisor.tick();
        await until(async () => f.hosts.length === 2 && (await f.runtime.getBinding(f.binding.id))!.runner.state === "running", "真实重试条件满足后才重新启动");
      } finally { await f.close(); }
    });
  }
}
