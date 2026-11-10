import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client as PgClient } from "pg";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { runtimeObservabilityMigration } from "../src/server/db/migrations/runtime-observability.ts";
import { newId } from "../src/server/db/ids.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createLogger } from "../src/server/logger.ts";
import { createRuntimeObservability } from "../src/server/runtime/observability.ts";
import type { NormalizedUsageObservation, RuntimeEventInput } from "../src/server/runtime/observation-types.ts";

const observationMigrations = migrations.includes(runtimeObservabilityMigration)
  ? migrations : [...migrations, runtimeObservabilityMigration];

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-observations-"));
  const db = new SqliteDriver({ dataDir: dir });
  await db.connect();
  await db.migrate(observationMigrations);
  let at = Date.parse("2026-11-10T00:00:00.000Z");
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => { lines.push(line); } });
  const now = () => at;
  return { dir, db, logger, lines, now, advance: (ms: number) => { at += ms; },
    async close() { await db.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("OBS-74-02：白名单关联元数据保留，raw stdout/env/prompt 与错误原文不落盘", async () => {
  const f = await fixture();
  try {
    const observation = createRuntimeObservability(f);
    const bindingId = newId();
    const eventId = newId();
    const secret = "private-cli-canary-do-not-store";
    const result = await observation.record({
      event: "spawned", eventId, bindingId, runnerGeneration: 7, exitCode: 0,
      reasonCode: secret, stdout: secret, prompt: secret, env: { API_KEY: secret }, argv: [secret],
      fullPath: secret, error: new Error(secret), attemptId: secret,
    } as unknown as RuntimeEventInput);
    assert.equal(result.stored, true);
    const page = await observation.list({ bindingId });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.eventId, eventId);
    assert.equal(page.events[0]?.runnerGeneration, 7);
    assert.equal(page.events[0]?.exitCode, 0);
    assert.equal(page.events[0]?.reasonCode, "unknown");
    assert.equal(JSON.stringify(await f.db.query("SELECT * FROM agent_runtime_events")).includes(secret), false);
    assert.equal(f.lines.join("").includes(secret), false);
    assert.equal((await observation.record({ event: "spawned", eventId, bindingId })).duplicate, true);
    assert.equal((await observation.list()).events.length, 1);
  } finally { await f.close(); }
});

function usage(overrides: Partial<NormalizedUsageObservation> = {}): NormalizedUsageObservation {
  return {
    bindingId: newId(), source: "codex-cli", harnessVersion: "0.167.0-alpha.4", metric: "inputTokens",
    scope: "invocation", scopeId: newId(), epochId: newId(), sequence: 1, runnerGeneration: 1,
    reportedAt: "2026-11-10T00:00:00.000Z", coverage: "complete", value: 12,
    cumulative: false, schemaVerified: true, zeroMeaningful: true, successful: true,
    ...overrides,
  };
}

test("OBS-74-06：缺失、未验证版本和失败零不伪造0；成功的有效零保留", async () => {
  const f = await fixture();
  try {
    const observation = createRuntimeObservability(f);
    const bindingId = newId();
    const examples = [
      { value: null, expected: null, reason: "usage_missing" },
      { value: 12, schemaVerified: false, expected: null, reason: "schema_unverified" },
      { value: 0, successful: false, expected: null, reason: "partial_usage" },
      { value: 0, zeroMeaningful: false, expected: null, reason: "partial_usage" },
      { value: 0, expected: 0, reason: null },
      { value: 8, successful: false, expected: 8, reason: "partial_usage" },
      { value: Number.NaN, expected: null, reason: "usage_missing" },
      { value: -1, expected: null, reason: "usage_missing" },
      { value: 1.5, expected: null, reason: "usage_missing" },
    ];
    for (const example of examples) {
      const input = usage({ ...example, bindingId });
      assert.equal((await observation.observeUsage(input)).stored, true);
      const snapshot = (await observation.listUsage({ bindingId })).find((row) => row.scopeId === input.scopeId)!;
      assert.equal(snapshot.value, example.expected);
      assert.equal(snapshot.reasonCode, example.reason);
      assert.equal(snapshot.estimated, false);
    }
    const events = (await observation.list()).events;
    assert.equal(events.filter((event) => event.event === "usage_unavailable").length, 7);
    assert.equal(events.find((event) => event.usage?.value === 0)?.usage?.coverage, "complete");
  } finally { await f.close(); }
});

test("OBS-74-06：重复最终结果和乱序不会重复记录或覆盖快照", async () => {
  const f = await fixture();
  try {
    const observation = createRuntimeObservability(f);
    const first = usage({ sequence: 2, value: 20 });
    await observation.observeUsage(first);
    const replay = await observation.observeUsage({ ...first, value: 999 });
    const old = await observation.observeUsage({ ...first, sequence: 1, value: 10 });
    assert.equal(replay.duplicate, true);
    assert.equal(old.duplicate, true);
    assert.equal((await observation.listUsage({ bindingId: first.bindingId })).length, 1);
    assert.equal((await observation.listUsage({ bindingId: first.bindingId }))[0]?.value, 20);
    assert.equal((await observation.list()).events.length, 1);
    const reloaded = createRuntimeObservability(f);
    assert.equal((await reloaded.observeUsage(first)).duplicate, true);
  } finally { await f.close(); }
});

test("OBS-74-06/07：resume累计首值不归本轮、回退后等待新epoch，轮转不删除基线", async () => {
  const f = await fixture();
  try {
    const observation = createRuntimeObservability({ ...f, retention: { maxAgeMs: 10, maxEvents: 1 } });
    const first = usage({ source: "claude-code", harnessVersion: "2.1.233", metric: "costUsd",
      scope: "session", value: 20, cumulative: true });
    await observation.observeUsage(first);
    let snapshot = (await observation.listUsage({ bindingId: first.bindingId }))[0]!;
    assert.equal(snapshot.value, 20);
    assert.equal(snapshot.delta, null);
    assert.equal(snapshot.reasonCode, "baseline_unknown");
    assert.equal(snapshot.estimated, true);
    f.advance(11);
    await observation.prune();
    assert.equal((await observation.list()).events.length, 0);
    await observation.observeUsage({ ...first, sequence: 2, value: 23 });
    snapshot = (await observation.listUsage({ bindingId: first.bindingId }))[0]!;
    assert.equal(snapshot.delta, 3);
    await observation.observeUsage({ ...first, sequence: 3, value: 2 });
    snapshot = (await observation.listUsage({ bindingId: first.bindingId }))[0]!;
    assert.equal(snapshot.delta, null);
    assert.equal(snapshot.reasonCode, "cumulative_reset");
    assert.equal(snapshot.coverage, "partial");
    await observation.observeUsage({ ...first, sequence: 4, value: 3 });
    snapshot = (await observation.listUsage({ bindingId: first.bindingId }))[0]!;
    assert.equal(snapshot.delta, null);
    assert.equal(snapshot.epochReliable, false);
    const reset = { ...first, epochId: newId(), sequence: 1, value: 4 };
    await observation.observeUsage(reset);
    await observation.observeUsage({ ...reset, sequence: 2, value: 6 });
    const epochs = await observation.listUsage({ bindingId: first.bindingId });
    assert.equal(epochs.find((row) => row.epochId === reset.epochId)?.delta, 2);
    assert.equal(epochs.find((row) => row.epochId === first.epochId)?.delta, null);
    assert.equal((await observation.list()).events.length, 1);
  } finally { await f.close(); }
});

test("OBS-74-06：unavailable间隔不能抹掉已知累计上界或掩盖回退", async () => {
  const f = await fixture();
  try {
    const observation = createRuntimeObservability(f);
    const first = usage({ value: 20, cumulative: true });
    await observation.observeUsage(first);
    await observation.observeUsage({ ...first, sequence: 2, value: null, coverage: "unavailable" });
    // 重建观察器模拟服务重启；高水位必须由持久快照提供，不能只留在内存。
    const reloaded = createRuntimeObservability(f);
    await reloaded.observeUsage({ ...first, sequence: 3, value: 3 });
    await reloaded.observeUsage({ ...first, sequence: 4, value: 5 });
    const snapshot = (await reloaded.listUsage({ bindingId: first.bindingId }))[0]!;
    assert.equal(snapshot.value, 5);
    assert.equal(snapshot.cumulativeHighWatermark, 20);
    assert.equal(snapshot.delta, null);
    assert.equal(snapshot.epochReliable, false);
    assert.equal(snapshot.coverage, "partial");
    assert.equal(snapshot.reasonCode, "cumulative_reset");
  } finally { await f.close(); }
});

test("OBS-74-06：token与金额保持独立作用域，版本变化/未知统计不合并总费用", async () => {
  const f = await fixture();
  try {
    const observation = createRuntimeObservability(f);
    const tokens = usage();
    const money = usage({ bindingId: tokens.bindingId, source: "claude-code", harnessVersion: "2.1.233",
      metric: "costUsd", scope: "session", value: 2.5, cumulative: true });
    await observation.observeUsage(tokens);
    await observation.observeUsage(money);
    await observation.observeUsage({ ...money, harnessVersion: "2.1.234", sequence: 2, value: 4 });
    await observation.observeUsage({ ...money, sequence: 2, value: null });
    await observation.observeUsage({ ...money, sequence: 3, value: 5 });
    const snapshots = await observation.listUsage({ bindingId: tokens.bindingId });
    assert.equal(snapshots.length, 3);
    assert.equal(snapshots.find((row) => row.metric === "inputTokens")?.scope, "invocation");
    assert.ok(snapshots.filter((row) => row.metric === "costUsd").every((row) => row.delta === null));
    assert.equal(snapshots.find((row) => row.harnessVersion === "2.1.233")?.reasonCode, "baseline_unknown");
    assert.equal(snapshots.find((row) => row.metric === "inputTokens")?.scopeId, tokens.scopeId);
    assert.ok(snapshots.filter((row) => row.metric === "costUsd").every((row) => row.scopeId === money.scopeId));
  } finally { await f.close(); }
});

test("R-64-NATIVE-003：会话按持久generation/result_index排序，resume归零和墙钟回拨不丢样本", async () => {
  const f = await fixture();
  try {
    const observation = createRuntimeObservability(f);
    const first = usage({ source: "claude-code", harnessVersion: "2.1.322", metric: "costUsd", scope: "session",
      cumulative: true, runnerGeneration: 7, sequence: 4, value: 20, reportedAt: "2026-11-10T02:00:00.000Z" });
    assert.equal((await observation.observeUsage(first)).stored, true);
    const resumed = { ...first, runnerGeneration: 8, sequence: 0, value: 23, reportedAt: "2026-11-10T01:00:00.000Z" };
    assert.equal((await observation.observeUsage(resumed)).stored, true);
    const reloaded = createRuntimeObservability(f);
    assert.equal((await reloaded.observeUsage({ ...resumed, value: 999 })).duplicate, true);
    assert.equal((await reloaded.observeUsage({ ...first, sequence: 100, value: 999 })).duplicate, true);
    assert.equal((await reloaded.observeUsage({ ...resumed, sequence: 1, value: 26, reportedAt: "2026-11-10T00:00:00.000Z" })).stored, true);
    const rows = await reloaded.listUsage({ bindingId: first.bindingId });
    assert.equal(rows.length, 1); assert.equal(rows[0]!.value, 26);
    assert.equal(rows[0]!.runnerGeneration, 8); assert.equal(rows[0]!.sequence, 1);
    assert.equal(rows[0]!.delta, 3, "仅这个独立complete夹具可计算差额；真实CLI parser仍partial");
    assert.equal((await reloaded.list()).events.length, 3);
  } finally { await f.close(); }
});

test("R-64-NATIVE-003：旧无代次快照不成为差额基线，已知高水位仍保留", async () => {
  const f = await fixture();
  try {
    const observation = createRuntimeObservability(f);
    const first = usage({ scope: "session", metric: "costUsd", cumulative: true, sequence: 4, value: 20 });
    await observation.observeUsage(first);
    const legacy = { ...(await observation.listUsage({ bindingId: first.bindingId }))[0]! };
    delete (legacy as { runnerGeneration?: number }).runnerGeneration;
    await f.db.exec("UPDATE agent_runtime_usage_snapshots SET payload = ? WHERE id = ?", [JSON.stringify(legacy), legacy.id]);
    assert.equal((await observation.observeUsage({ ...first, runnerGeneration: 2, sequence: 0, value: 23 })).stored, true);
    let snapshot = (await observation.listUsage({ bindingId: first.bindingId }))[0]!;
    assert.equal(snapshot.delta, null); assert.equal(snapshot.reasonCode, "baseline_unknown");
    assert.equal(snapshot.cumulativeHighWatermark, 23);
    await observation.observeUsage({ ...first, runnerGeneration: 3, sequence: 0, value: 3 });
    await createRuntimeObservability(f).observeUsage({ ...first, runnerGeneration: 4, sequence: 0, value: 5 });
    snapshot = (await observation.listUsage({ bindingId: first.bindingId }))[0]!;
    assert.equal(snapshot.value, 5); assert.equal(snapshot.cumulativeHighWatermark, 23);
    assert.equal(snapshot.delta, null); assert.equal(snapshot.epochReliable, false);
    assert.equal(snapshot.coverage, "partial"); assert.equal(snapshot.reasonCode, "cumulative_reset");
    const missingGeneration = { ...first, runnerGeneration: undefined };
    assert.equal((await observation.observeUsage(missingGeneration as unknown as NormalizedUsageObservation)).stored, false);
  } finally { await f.close(); }
});

test("OBS-74-08：记录拒绝和数据库持续不可用仍返回可见故障，不抛出原始诊断", async () => {
  const f = await fixture();
  try {
    const observation = createRuntimeObservability(f);
    const rejected = await observation.record({ event: "untrusted-free-text-event" } as unknown as RuntimeEventInput);
    assert.equal(rejected.stored, false);
    assert.equal((await observation.health()).rejectedRecords, 1);
    await f.db.close();
    assert.equal((await observation.record({ event: "ready" })).stored, false);
    const health = await observation.health();
    assert.equal(health.incomplete, true);
    assert.equal(health.storageFailures, 2);
    assert.equal(health.rejectedRecords, 1);
    assert.equal(f.lines.join("").includes("untrusted-free-text-event"), false);
    assert.equal(f.lines.join("").includes("尚未 connect"), false);
  } finally { await f.close(); }
});

test("OBS-74-06/07 PostgreSQL：跨连接容量锁、并发去重和乱序快照", {
  skip: !process.env["AGENT_STUDIO_PG_TEST_URL"] && "未配置真实 PostgreSQL，CI 按 AGENT_STUDIO_PG_TEST_URL 执行",
}, async () => {
  const connectionString = process.env["AGENT_STUDIO_PG_TEST_URL"]!;
  const schema = `runtime_observation_${randomBytes(6).toString("hex")}`;
  const oneDb = new PostgresDriver({ connectionString, schema });
  const twoDb = new PostgresDriver({ connectionString, schema });
  try {
    await oneDb.connect();
    await oneDb.migrate(observationMigrations);
    await twoDb.connect();
    const logger = createLogger({ write: () => {} });
    const options = { logger, now: () => Date.parse("2026-11-10T00:00:00.000Z"), retention: { maxEvents: 3 } };
    const one = createRuntimeObservability({ ...options, db: oneDb });
    const two = createRuntimeObservability({ ...options, db: twoDb });
    const writes = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? one : two).record({ event: "spawned" })));
    assert.ok(writes.every((result) => result.stored));
    assert.equal((await oneDb.query<{ n: string }>("SELECT COUNT(*) AS n FROM agent_runtime_events"))[0]?.n, "3");
    assert.equal((await one.health()).droppedEvents, 17);
    const sample = usage({ cumulative: true, scope: "session" });
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? one : two).observeUsage({ ...sample, sequence: i + 1, value: i + 1 })));
    const snapshots = await two.listUsage({ bindingId: sample.bindingId });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.value, 20);
    assert.equal(snapshots[0]?.sequence, 20);
    assert.equal((await one.observeUsage({ ...sample, sequence: 20, value: 20 })).duplicate, true);
    const resumed = { ...sample, runnerGeneration: 2, sequence: 0, value: 23,
      reportedAt: "2026-11-09T23:59:00.000Z" };
    assert.equal((await two.observeUsage(resumed)).stored, true, "新的持久generation允许源序号和墙钟回退");
    assert.equal((await one.observeUsage({ ...sample, sequence: 999, value: 999 })).duplicate, true);
    assert.equal((await one.observeUsage({ ...resumed, value: 999 })).duplicate, true);
    const resumedRows = await one.listUsage({ bindingId: sample.bindingId });
    assert.equal(resumedRows.length, 1); assert.equal(resumedRows[0]?.value, 23);
    assert.equal(resumedRows[0]?.runnerGeneration, 2); assert.equal(resumedRows[0]?.sequence, 0);
    assert.equal(resumedRows[0]?.delta, 3);
    assert.equal((await two.health()).incomplete, false);
    assert.ok((await two.list()).events.length <= 3);
  } finally {
    await twoDb.close();
    await oneDb.close();
    const admin = new PgClient({ connectionString });
    await admin.connect();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  }
});

test("OBS-74-07：并发实例共用全局条数上限，按时间轮转并报告最早记录", async () => {
  const f = await fixture();
  try {
    const one = createRuntimeObservability({ ...f, retention: { maxEvents: 3, maxAgeMs: 100 } });
    const two = createRuntimeObservability({ ...f, retention: { maxEvents: 3, maxAgeMs: 100 } });
    await one.record({ event: "start_requested" });
    f.advance(10);
    await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? one : two).record({ event: "spawned" })));
    assert.equal((await f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runtime_events"))[0]?.n, 3);
    const before = await one.health();
    assert.equal(before.droppedEvents, 6);
    assert.equal(before.historyTruncated, true);
    assert.equal(before.oldestObservedAt, new Date(f.now()).toISOString());
    f.advance(101);
    const page = await one.list();
    assert.equal(page.events.length, 0);
    assert.equal(page.oldestObservedAt, null);
    assert.equal((await two.health()).droppedEvents, 9);
  } finally { await f.close(); }
});

test("OBS-74-07：单条字节限制保留固定事实并标 truncated", async () => {
  const f = await fixture();
  try {
    const observation = createRuntimeObservability({ ...f, retention: { maxEventBytes: 256 } });
    await observation.record({
      event: "runtime.updated", bindingId: newId(), runtimeId: newId(), projectId: newId(),
      memberId: newId(), attemptId: newId(), turnId: newId(), messageId: newId(), triggerBatchId: newId(),
      changedFields: ["cwd", "model", "instructions", "resumePolicy", "permissionMode"], configRevision: 9,
    });
    const [row] = await f.db.query<{ payload: string }>("SELECT payload FROM agent_runtime_events");
    assert.ok(Buffer.byteLength(row!.payload) <= 256);
    const event = JSON.parse(row!.payload);
    assert.equal(event.truncated, true);
    assert.equal(event.event, "runtime.updated");
    assert.equal(typeof event.eventId, "string");
    assert.equal(event.observedAt, new Date(f.now()).toISOString());
  } finally { await f.close(); }
});

test("OBS-74-08：历史写入失败和 logger 故障可见，消息/投递没有被 ACK 或清理", async () => {
  const f = await fixture();
  try {
    const repos = createRepositories(f.db);
    const project = await repos.projects.create({ name: "observability-isolation" });
    const group = await repos.groups.create({ projectId: project.id, name: "queue" });
    const member = await repos.members.create({ projectId: project.id, kind: "human", displayName: "owner" });
    await repos.groups.addParticipant(group.id, member.id);
    const sent = await repos.messages.create({ groupId: group.id, senderMemberId: member.id, body: "keep-message", mentions: [] });
    await repos.deliveries.ensure(sent.id, member.id);
    const original = await f.db.query("SELECT * FROM message_deliveries");
    const logger = createLogger({ write: () => { throw new Error("secret-sink-error"); } });
    const observation = createRuntimeObservability({ ...f, logger, retention: { maxEvents: 1, maxAgeMs: 1 } });
    await f.db.exec(`CREATE TRIGGER block_observation BEFORE INSERT ON agent_runtime_events
      BEGIN SELECT RAISE(ABORT, 'private-storage-error'); END`);
    const failed = await observation.record({ event: "spawned" });
    assert.equal(failed.stored, false);
    assert.equal(failed.incomplete, true);
    await f.db.exec("DROP TRIGGER block_observation");
    await observation.record({ event: "ready" });
    const health = await observation.health();
    assert.equal(health.incomplete, true);
    assert.equal(health.storageFailures, 1);
    assert.equal(health.loggerWriteFailures, 2);
    f.advance(2);
    await observation.prune();
    assert.deepEqual(await f.db.query("SELECT * FROM message_deliveries"), original);
    assert.equal((await repos.messages.listByGroup(group.id))[0]?.body, "keep-message");
    assert.equal((await observation.list()).events.length, 0);
    const reloaded = createRuntimeObservability({ ...f, logger: createLogger({ write: () => {} }) });
    assert.equal((await reloaded.health()).incomplete, true);
  } finally { await f.close(); }
});
