import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { migrateData } from "../src/server/db/migrate-data.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import type { RuntimeRepository } from "../src/server/runtime/types.ts";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-runtime-"));
  const db = new SqliteDriver({ dataDir: dir });
  await db.connect(); await db.migrate(migrations);
  const repos = createRepositories(db);
  let clock = new Date("2026-11-10T12:00:00.000Z");
  const runtimes = createRuntimeRepository(db, { now: () => clock });
  const project = await repos.projects.create({ name: "主项目" });
  const otherProject = await repos.projects.create({ name: "其他项目" });
  const group = await repos.groups.create({ projectId: project.id, name: "甲群" });
  const otherGroup = await repos.groups.create({ projectId: project.id, name: "乙群" });
  const crossGroup = await repos.groups.create({ projectId: otherProject.id, name: "跨项目群" });
  return {
    dir, db, repos, runtimes, project, group, otherProject, otherGroup, crossGroup,
    advance(ms: number) { clock = new Date(clock.getTime() + ms); },
    async create(name = "托管助手") {
      return runtimes.create({ name, backend: "claude-code", defaults: { workdir: dir, model: "first-model" },
        bindings: [{ projectId: project.id, groupId: group.id }] });
    },
    async close() { await db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("R1-1 原子创建 stopped 配置不制造连接；同名外部身份与无效绑定不会被接管", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    const b = created.bindings[0]!;
    assert.equal(b.binding.desiredState, "stopped"); assert.equal(b.runner.state, "stopped");
    assert.equal(b.runner.applied, null); assert.equal(b.runner.exitConfirmed, true);
    assert.equal((await f.repos.mcpSessions.listByProject(f.project.id)).length, 0);
    assert.equal(await f.repos.statuses.get(f.project.id, b.binding.memberId), null);
    assert.equal(b.effective.config.permissionMode, "auto");
    await assert.rejects(f.repos.agents.update(created.runtime.agentId, { displayName: "不能静默改身份" }), /runtime_identity_immutable/);
    await assert.rejects(f.create(), /runtime_identity_exists/);
    const external = await f.repos.agents.create({ displayName: "已有外部", hostType: "claude-code" });
    await assert.rejects(f.create("已有外部"), /runtime_identity_exists/);
    assert.equal((await f.repos.agents.get(external.id))?.displayName, "已有外部");
    await assert.rejects(f.runtimes.create({ name: "事务回滚", backend: "claude-code", defaults: { workdir: f.dir },
      bindings: [{ projectId: f.project.id, groupId: f.group.id }, { projectId: f.otherProject.id, groupId: f.group.id }] }), /runtime_group_project_mismatch/);
    assert.equal(await f.repos.agents.findByIdentity("事务回滚", "claude-code"), null);
    assert.equal((await f.runtimes.list()).length, 1);
  } finally { await f.close(); }
});

test("R1-2 默认与覆盖有来源，CAS拒绝丢更新，运行快照不随保存或崩溃恢复改变", async () => {
  const f = await fixture();
  try {
    const created = await f.create(); const id = created.runtime.id; const b = created.bindings[0]!.binding;
    const override = await f.runtimes.addBinding(id, { projectId: f.project.id, groupId: f.otherGroup.id, overrides: { model: "local-model" } });
    assert.equal(override.binding.memberId, b.memberId); assert.equal(override.effective.sources.model, "override");
    const cross = await f.runtimes.addBinding(id, { projectId: f.otherProject.id, groupId: f.crossGroup.id });
    assert.notEqual(cross.binding.memberId, b.memberId);
    await f.runtimes.intent(b.id, "start"); const first = await f.runtimes.claim(b.id, "supervisor-1");
    await f.runtimes.setSession(first, "session-one");
    const results = await Promise.allSettled([
      f.runtimes.updateDefaults(id, 1, { workdir: f.dir, model: "second-model" }),
      f.runtimes.updateDefaults(id, 1, { workdir: f.dir, model: "third-model" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const v = (await f.runtimes.getBinding(b.id))!;
    assert.equal(v.runtime.revision, 2); assert.equal(v.runner.applied?.config.model, "first-model");
    assert.equal(v.pendingChanges, true);
    assert.equal((await f.runtimes.getBinding(override.binding.id))!.effective.config.model, "local-model");
    const intentBefore = v.binding.intentRevision;
    assert.equal((await f.runtimes.intent(b.id, "start")).binding.intentRevision, intentBefore);
    await f.runtimes.markExit(first, { exitCode: 1, errorCode: "process_exited" });
    const recovery = await f.runtimes.claim(b.id, "supervisor-1");
    const resumed = (await f.runtimes.getBinding(b.id))!;
    assert.equal(resumed.runner.applied?.config.model, "first-model"); assert.equal(resumed.runner.harnessSessionId, "session-one");
    await f.runtimes.intent(b.id, "apply");
    assert.equal((await f.runtimes.getBinding(b.id))!.runner.state, "stopping");
    await assert.rejects(f.runtimes.markReady(recovery), /runtime_stop_in_progress/);
    await f.runtimes.markExit(recovery, { exitCode: 0 });
    await f.runtimes.claim(b.id, "supervisor-2");
    const applied = (await f.runtimes.getBinding(b.id))!;
    assert.equal(applied.runner.applied?.config.model, applied.effective.config.model);
    assert.equal(applied.runner.harnessSessionId, null); assert.equal(applied.runner.sessionState, "reset");
    assert.equal(applied.pendingChanges, false);
  } finally { await f.close(); }
});

test("R1-2 高级策略仅属于显式绑定修订，新绑定与下一次配置编辑默认关闭", async () => {
  const f = await fixture();
  try {
    const c = await f.create(); const b = c.bindings[0]!.binding;
    const high = await f.runtimes.updateBinding(b.id, { runtimeRevision: 1, bindingRevision: 1, overrides: {}, advancedStrategy: "bypassPermissions" });
    assert.equal(high.effective.advancedStrategy, "bypassPermissions"); assert.equal(high.binding.revision, 2);
    await f.runtimes.intent(b.id, "start"); const fence = await f.runtimes.claim(b.id, "owner");
    const second = await f.runtimes.addBinding(c.runtime.id, { projectId: f.project.id, groupId: f.otherGroup.id });
    assert.equal(second.effective.advancedStrategy, null);
    await f.runtimes.updateDefaults(c.runtime.id, 1, { workdir: f.dir, model: "changed" });
    const changed = (await f.runtimes.getBinding(b.id))!;
    assert.equal(changed.effective.advancedStrategy, null); assert.equal(changed.runner.applied?.advancedStrategy, "bypassPermissions");
    await assert.rejects(f.runtimes.updateBinding(b.id, { runtimeRevision: 1, bindingRevision: 2, overrides: {}, advancedStrategy: "bypassPermissions" }), /runtime_revision_conflict/);
    const normal = await f.runtimes.updateBinding(b.id, { runtimeRevision: 2, bindingRevision: 2, overrides: { model: null } });
    assert.equal(normal.binding.advanced, null); assert.equal(normal.effective.config.model, null);
    await f.runtimes.markExit(fence, { exitCode: 0 });
  } finally { await f.close(); }
});

test("明确应用校验用户所见配置版本，旧界面不能应用并发编辑后的配置", async () => {
  const f = await fixture();
  try {
    const c = await f.create(); const b = c.bindings[0]!.binding;
    await f.runtimes.updateDefaults(c.runtime.id, 1, { workdir: f.dir, model: "edited-elsewhere" });
    await assert.rejects(f.runtimes.intent(b.id, "start", 0, { runtimeRevision: 1, bindingRevision: 1 }), /runtime_revision_conflict/);
    assert.equal((await f.runtimes.getBinding(b.id))!.binding.desiredState, "stopped");
    await f.runtimes.intent(b.id, "start", 0, { runtimeRevision: 2, bindingRevision: 1 });
    const fence = await f.runtimes.claim(b.id, "owner");
    await f.runtimes.updateBinding(b.id, { runtimeRevision: 2, bindingRevision: 1, overrides: { model: "new-pending" } });
    await assert.rejects(f.runtimes.intent(b.id, "apply", undefined, { runtimeRevision: 2, bindingRevision: 1 }), /runtime_revision_conflict/);
    assert.equal((await f.runtimes.getBinding(b.id))!.runner.state, "starting");
    assert.equal((await f.runtimes.getBinding(b.id))!.runner.applied?.config.model, "edited-elsewhere");
    const businessError = Object.assign(new Error("禁止的业务操作"), { code: "FORBIDDEN" });
    await assert.rejects(f.runtimes.withFence(fence, async () => { throw businessError; }), (error) => error === businessError);
  } finally { await f.close(); }
});

test("R1-3 同Member不同群原子互斥，租约过期不抢占，跨项目成员可并行", async () => {
  const f = await fixture();
  try {
    const c = await f.create(); const a = c.bindings[0]!.binding;
    const b = (await f.runtimes.addBinding(c.runtime.id, { projectId: f.project.id, groupId: f.otherGroup.id })).binding;
    const cross = (await f.runtimes.addBinding(c.runtime.id, { projectId: f.otherProject.id, groupId: f.crossGroup.id })).binding;
    for (const id of [a.id, b.id, cross.id]) await f.runtimes.intent(id, "start");
    const other = createRuntimeRepository(f.db);
    const results = await Promise.allSettled([f.runtimes.claim(a.id, "a", { leaseMs: 100 }), f.runtimes.claim(b.id, "b", { leaseMs: 100 })]);
    const won = results.find((r) => r.status === "fulfilled"); assert.ok(won?.status === "fulfilled");
    const fence = won.value; const loser = fence.bindingId === a.id ? b.id : a.id;
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const independent = await other.claim(cross.id, "independent"); assert.notEqual(independent.memberId, fence.memberId);
    f.advance(101);
    await assert.rejects(f.runtimes.checkFence(fence), /runtime_lease_expired/);
    await assert.rejects(f.runtimes.claim(loser, "late"), /runtime_member_owned/);
    await f.runtimes.renew(fence, 1000); await f.runtimes.checkFence(fence);
    await f.runtimes.markExit(fence, { exitCode: 0 });
    const next = await f.runtimes.claim(loser, "next"); assert.ok(next.generation > fence.generation);
    let invoked = false;
    await assert.rejects(f.runtimes.withFence(fence, async () => { invoked = true; }), /runtime_fence_stale/);
    assert.equal(invoked, false);
    await assert.rejects(f.runtimes.markExit(fence, { exitCode: 0 }), /runtime_fence_stale/);
  } finally { await f.close(); }
});

test("R1-3 stop先阻止新轮次但允许在途ACK，start不能撤销已开始的安全点停止", async () => {
  const f = await fixture();
  try {
    const b = (await f.create()).bindings[0]!.binding;
    await f.runtimes.intent(b.id, "start"); const owner = await f.runtimes.claim(b.id, "owner");
    await f.runtimes.markReady(owner, 1234); await f.runtimes.patchRunner(owner, { phase: "working" });
    await f.runtimes.intent(b.id, "stop");
    await assert.rejects(f.runtimes.withFence(owner, async () => {}, { requireRunningIntent: true }), /runtime_desired_stopped/);
    assert.equal(await f.runtimes.withFence(owner, async () => "in-flight-ack"), "in-flight-ack");
    await f.runtimes.intent(b.id, "start");
    assert.equal((await f.runtimes.getBinding(b.id))!.runner.state, "stopping");
    await assert.rejects(f.runtimes.claim(b.id, "second"), /runtime_member_owned/);
    await f.runtimes.markExit(owner, { exitCode: 0 });
    const second = await f.runtimes.claim(b.id, "second"); assert.ok(second.generation > owner.generation);
    await f.repos.projects.archive(f.project.id);
    await f.runtimes.markExit(second, { exitCode: 0 });
    assert.equal((await f.runtimes.getBinding(b.id))!.runner.exitConfirmed, true);
  } finally { await f.close(); }
});

test("R1-3 start不绕过退避，retry显式重试但不丢失applied配置", async () => {
  const f = await fixture();
  try {
    const b = (await f.create()).bindings[0]!.binding;
    await f.runtimes.intent(b.id, "start"); const fence = await f.runtimes.claim(b.id, "owner");
    await f.runtimes.markExit(fence, { exitCode: 1, errorCode: "launch_failed", retryAt: "2026-11-10T12:05:00.000Z" });
    await f.runtimes.intent(b.id, "start");
    assert.equal((await f.runtimes.getBinding(b.id))!.runner.nextRetryAt, "2026-11-10T12:05:00.000Z");
    await assert.rejects(f.runtimes.claim(b.id, "next"), /runtime_retry_backoff/);
    await f.runtimes.intent(b.id, "retry");
    await f.runtimes.claim(b.id, "next");
    assert.equal((await f.runtimes.getBinding(b.id))!.runner.applied?.config.model, "first-model");
  } finally { await f.close(); }
});

test("R1-3 external与managed共享成员锁；既有连接拒绝预留，未托管成员保持兼容", async () => {
  const f = await fixture();
  try {
    const c = await f.create();
    const member = await f.repos.members.create({ projectId: f.otherProject.id, agentId: c.runtime.agentId, kind: "agent", displayName: c.runtime.name });
    const external = await f.repos.mcpSessions.connect({ agentId: c.runtime.agentId, memberId: member.id, projectId: f.otherProject.id,
      groupId: f.crossGroup.id, displayName: c.runtime.name, hostType: "claude-code" });
    await assert.rejects(f.runtimes.addBinding(c.runtime.id, { projectId: f.otherProject.id, groupId: f.crossGroup.id }), /external_session_conflict/);
    assert.equal((await f.repos.mcpSessions.get(external.id))?.state, "connected");
    await f.repos.mcpSessions.disconnect(external.id, new Date().toISOString());
    await f.runtimes.addBinding(c.runtime.id, { projectId: f.otherProject.id, groupId: f.crossGroup.id });
    await assert.rejects(f.runtimes.withMemberLock(member.id, () => f.runtimes.assertExternalJoinAllowed(member.id)), /runtime_member_reserved/);
    const agent = await f.repos.agents.create({ displayName: "普通外部", hostType: "other" });
    const ordinary = await f.repos.members.create({ projectId: f.project.id, agentId: agent.id, kind: "agent", displayName: "普通外部" });
    await f.runtimes.withMemberLock(ordinary.id, () => f.runtimes.assertExternalJoinAllowed(ordinary.id));
  } finally { await f.close(); }
});

test("R1-4 删除配置先停且保留身份、成员、群关系与消息", async () => {
  const f = await fixture();
  try {
    const c = await f.create(); const b = c.bindings[0]!.binding;
    const message = await f.repos.messages.create({ groupId: b.groupId, senderMemberId: b.memberId, body: "保留历史" });
    await f.runtimes.intent(b.id, "start");
    await assert.rejects(f.runtimes.removeBinding(b.id), /runtime_must_stop_first/);
    await f.runtimes.intent(b.id, "stop"); await f.runtimes.removeBinding(b.id);
    assert.equal((await f.runtimes.get(c.runtime.id))!.bindings.length, 0);
    await f.runtimes.delete(c.runtime.id);
    assert.ok(await f.repos.agents.get(c.runtime.agentId)); assert.ok(await f.repos.members.get(b.memberId));
    assert.ok((await f.repos.groups.participants(b.groupId)).includes(b.memberId));
    assert.equal((await f.repos.messages.get(message.id))?.body, "保留历史");
    await f.runtimes.assertExternalJoinAllowed(b.memberId);
  } finally { await f.close(); }
});

test("R1-4 项目/群/成员删除均等待确认退出，purge计数准确且不影响其他项目绑定", async () => {
  const f = await fixture();
  try {
    const c = await f.create(); const a = c.bindings[0]!.binding;
    const b = (await f.runtimes.addBinding(c.runtime.id, { projectId: f.project.id, groupId: f.otherGroup.id })).binding;
    const cross = (await f.runtimes.addBinding(c.runtime.id, { projectId: f.otherProject.id, groupId: f.crossGroup.id })).binding;
    await f.runtimes.intent(a.id, "start"); const fence = await f.runtimes.claim(a.id, "owner", { leaseMs: 100 });
    await f.runtimes.intent(cross.id, "start"); const separate = await f.runtimes.claim(cross.id, "separate");
    await assert.rejects(f.repos.projects.purge(f.project.id), /runtime_must_stop_first/);
    await assert.rejects(f.repos.groups.delete(a.groupId), /runtime_must_stop_first/);
    await assert.rejects(f.repos.members.delete(a.memberId), /runtime_must_stop_first/);
    await f.runtimes.intent(a.id, "stop"); f.advance(101);
    await assert.rejects(f.repos.groups.purge(a.groupId), /runtime_must_stop_first/);
    await f.runtimes.markExit(fence, { exitCode: 0 });
    const preview = await f.repos.groups.previewPurge(a.groupId);
    assert.equal(preview.agentRuntimeBindings, 1); assert.equal(preview.agentRunnerStates, 1);
    assert.equal(preview.agentRuntimeMembers, 0);
    const deleted = await f.repos.groups.purge(a.groupId); assert.deepEqual(deleted, preview);
    assert.ok(await f.repos.members.get(a.memberId)); assert.ok(await f.runtimes.getBinding(b.id));
    const last = await f.repos.groups.purge(b.groupId); assert.equal(last.agentRuntimeMembers, 1);
    await f.runtimes.assertExternalJoinAllowed(a.memberId);
    await f.repos.projects.purge(f.project.id);
    assert.ok(await f.runtimes.get(c.runtime.id)); await f.runtimes.checkFence(separate);
    assert.ok(await f.repos.groups.get(cross.groupId));
  } finally { await f.close(); }
});

test("R1-4 v7旧库升级不回填托管身份；非空运行配置/所有权可逐值迁移", async () => {
  const legacyDir = await mkdtemp(path.join(tmpdir(), "boardroom-runtime-v7-"));
  const legacy = new SqliteDriver({ dataDir: legacyDir });
  try {
    await legacy.connect(); await legacy.migrate(migrations.filter((m) => m.version <= 7));
    const old = createRepositories(legacy);
    const agent = await old.agents.create({ displayName: "old-external", hostType: "other" });
    const result = await legacy.migrate(migrations);
    assert.equal(result.applied.some((m) => m.version === 8), true);
    assert.equal((await createRuntimeRepository(legacy).list()).length, 0);
    assert.deepEqual(await old.agents.get(agent.id), agent);
  } finally { await legacy.close(); await rm(legacyDir, { recursive: true, force: true }); }

  const f = await fixture(); const targetDir = await mkdtemp(path.join(tmpdir(), "boardroom-runtime-copy-"));
  const target = new SqliteDriver({ dataDir: targetDir });
  try {
    const c = await f.create(); const b = c.bindings[0]!.binding;
    await f.runtimes.updateBinding(b.id, { runtimeRevision: 1, bindingRevision: 1, overrides: { model: "special" }, advancedStrategy: "bypassPermissions" });
    await f.runtimes.intent(b.id, "start"); const fence = await f.runtimes.claim(b.id, "original-owner");
    await f.runtimes.setSession(fence, "stable-sid"); await f.runtimes.markReady(fence, 12345);
    await f.runtimes.updateDefaults(c.runtime.id, 1, { workdir: f.dir, model: "pending" });
    const expected = await f.runtimes.get(c.runtime.id);
    const migrated = await migrateData({ dbDriver: "sqlite", dataDir: f.dir }, { dbDriver: "sqlite", dataDir: targetDir }, { snapshotSource: true });
    assert.equal(migrated.validation.ok, true);
    await target.connect(); const copied = createRuntimeRepository(target);
    assert.deepEqual(await copied.get(c.runtime.id), expected);
    await assert.rejects(copied.claim(b.id, "new-owner"), /runtime_member_owned/);
  } finally { await target.close(); await f.close(); await rm(targetDir, { recursive: true, force: true }); }
});

test("持久wake队列排除suppressed/NULL/ACK，按消息时间跨群排序而非群ID排序", async () => {
  const f = await fixture();
  try {
    const c = await f.create(); const a = c.bindings[0]!.binding;
    const b = (await f.runtimes.addBinding(c.runtime.id, { projectId: f.project.id, groupId: f.otherGroup.id })).binding;
    await f.runtimes.intent(a.id, "start"); await f.runtimes.intent(b.id, "start");
    const first = await f.repos.messages.create({ groupId: b.groupId, senderMemberId: b.memberId, body: "first" });
    const suppressed = await f.repos.messages.create({ groupId: a.groupId, senderMemberId: a.memberId, body: "suppressed" });
    const normal = await f.repos.messages.create({ groupId: a.groupId, senderMemberId: a.memberId, body: "ordinary" });
    const second = await f.repos.messages.create({ groupId: a.groupId, senderMemberId: a.memberId, body: "second" });
    await f.repos.deliveries.ensure(first.id, b.memberId, { decision: "allowed" });
    await f.repos.deliveries.ensure(suppressed.id, a.memberId, { decision: "suppressed", reason: "rate_limited" });
    await f.repos.deliveries.ensure(normal.id, a.memberId);
    await f.repos.deliveries.ensure(second.id, a.memberId, { decision: "allowed" });
    await f.db.exec("UPDATE messages SET created_at = ? WHERE id = ?", ["2026-11-10T11:00:00.000Z", first.id]);
    const queue = await f.runtimes.listWakeable();
    assert.deepEqual(queue.map((item) => item.bindingId), [b.id, a.id]);
    assert.deepEqual(queue.flatMap((item) => item.messageIds), [first.id, second.id]);
    await f.repos.deliveries.recordAttempt(first.id, b.memberId, "acked");
    assert.deepEqual((await f.runtimes.listWakeable()).flatMap((item) => item.messageIds), [second.id]);
  } finally { await f.close(); }
});

test("输入只接收结构化非秘密配置，sid不跨绑定复用，原因码不容纳原始输出", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.runtimes.create({ name: "unsafe", backend: "claude-code", defaults: { workdir: f.dir, env: { SECRET: "canary" } } as never,
      bindings: [{ projectId: f.project.id, groupId: f.group.id }] }), /runtime_config_field_unsupported/);
    const c = await f.create(); const a = c.bindings[0]!.binding;
    const b = (await f.runtimes.addBinding(c.runtime.id, { projectId: f.otherProject.id, groupId: f.crossGroup.id })).binding;
    await f.runtimes.intent(a.id, "start"); await f.runtimes.intent(b.id, "start");
    const fa = await f.runtimes.claim(a.id, "a"); const fb = await f.runtimes.claim(b.id, "b");
    await f.runtimes.setSession(fa, "isolated-session");
    await assert.rejects(f.runtimes.setSession(fb, "isolated-session"), /runtime_conflict/);
    await assert.rejects(f.runtimes.patchRunner(fa, { lastErrorCode: "stderr contains canary" }), /runtime_reason_invalid/);
  } finally { await f.close(); }
});

// 此 helper 也供下方真实 PostgreSQL 并发探针复用，避免将 fake 锁当作数据库证据。
async function competingClaims(runtimes: RuntimeRepository, first: string, second: string) {
  await runtimes.intent(first, "start"); await runtimes.intent(second, "start");
  const results = await Promise.allSettled([runtimes.claim(first, "owner-a"), runtimes.claim(second, "owner-b")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
}

const PG_URL = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
test("R1-3/4 真实PG迁移保留非空快照，独立请求争抢不同群只产生一个Member owner", { skip: !PG_URL }, async () => {
  const f = await fixture();
  const schema = `runtime_${randomBytes(8).toString("hex")}`;
  const pg = new PostgresDriver({ connectionString: PG_URL!, schema });
  try {
    const c = await f.create(); const a = c.bindings[0]!.binding;
    const b = (await f.runtimes.addBinding(c.runtime.id, { projectId: f.project.id, groupId: f.otherGroup.id, overrides: { model: "independent-model" } })).binding;
    await f.runtimes.intent(a.id, "start"); const first = await f.runtimes.claim(a.id, "old-owner");
    await f.runtimes.setSession(first, "pg-resumable-session"); await f.runtimes.markExit(first, { exitCode: 0 });
    await f.runtimes.updateDefaults(c.runtime.id, 1, { workdir: f.dir, model: "pending-model" });
    const expected = await f.runtimes.get(c.runtime.id);
    const migration = await migrateData({ dbDriver: "sqlite", dataDir: f.dir }, { dbDriver: "postgres", pgConnectionString: PG_URL!, pgSchema: schema }, { snapshotSource: true });
    assert.equal(migration.validation.ok, true);
    await pg.connect(); const stored = createRuntimeRepository(pg);
    assert.deepEqual(await stored.get(c.runtime.id), expected);
    await competingClaims(stored, a.id, b.id);
    const owned = (await stored.listBindings()).filter((view) => view.runner.owner !== null);
    assert.equal(owned.length, 1);
    assert.equal((await pg.query("SELECT member_id FROM agent_runtime_members WHERE lease_owner IS NOT NULL")).length, 1);
  } finally {
    await pg.connect(); await pg.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pg.close(); await f.close();
  }
});
