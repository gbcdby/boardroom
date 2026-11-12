/**
 * M1（#54）数据迁移与回滚测试。
 *
 * - 单元：业务表清单完整性、外键拷贝顺序合法性、PG DDL 镜像与 SQLite DDL 版本对应。
 * - 集成（无需 PG）：SQLite → SQLite 全量拷贝 + 一致性校验 + 幂等重跑 + 回滚。
 * - 端到端（真实 PG，门控于 AGENT_STUDIO_PG_TEST_URL）：SQLite→PG 迁移校验、
 *   PG→SQLite 反向校验（与源库逐键一致）、回滚（DROP schema），并在 finally 清理。
 */
import test from "node:test";
import { createHash } from "node:crypto";
import type { MemoryDocument, MemorySummaryRequest } from "../src/shared/memory.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDbDriver } from "../src/server/db/driver.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import type { DbDriverOptions } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import {
  BUSINESS_TABLES,
  PG_BUSINESS_SCHEMA_MIGRATIONS,
  migrateData,
  rollbackTarget,
  validateData,
} from "../src/server/db/migrate-data.ts";
import { seedSampleData } from "../src/server/db/seed-sample-data.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { appendAuditEntry } from "../src/server/audit.ts";
import type { Task, ReviewRound, ReviewReport } from "../src/shared/tasks.ts";

const PG_URL =
  process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-m1-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedSqliteDir(dir: string): Promise<void> {
  const driver = createDbDriver({ dbDriver: "sqlite", dataDir: dir });
  await driver.connect();
  try {
    await driver.migrate(migrations);
    seedSampleData((driver as SqliteDriver).handle);
    // 迁移往返也必须保留 v7 的幂等键和唤醒事实，不能只验证全 NULL 的新列。
    await driver.exec(
      "UPDATE messages SET client_message_id = ? WHERE id = (SELECT id FROM messages ORDER BY id LIMIT 1)",
      ["migration-request"],
    );
    await driver.exec(
      "UPDATE message_deliveries SET wake_decision = 'allowed' WHERE id = (SELECT id FROM message_deliveries ORDER BY id LIMIT 1)",
    );
    await driver.exec(
      "UPDATE message_deliveries SET wake_decision = 'suppressed', wake_suppressed_reason = 'rate_limited' WHERE id = 'md2'",
    );
    // 阶段 3 每张新表都有非空数据，copy 不能靠「空表一致」获得绿灯。
    const repos = createRepositories(driver);
    const at = "2026-11-10T12:00:00.000Z";
    const author = { kind: "human" as const, actorId: "owner", displayName: "人" };
    const task: Task = { id: "task-copy", projectId: "pr1", title: "迁移任务", body: "验收正文", labels: ["迁移"], state: "in-progress",
      assigneeMemberId: "mb1", reviewerMemberId: "mb2", repoPath: "/repo", fixedPoint: "HEAD~1", revision: 1,
      currentReviewRoundId: null, blockedReason: null, author, createdAt: at, updatedAt: at };
    await repos.tasks.setSettings("pr1", 0, "mb2");
    await repos.tasks.create(task);
    const round: ReviewRound = { id: "round-copy", taskId: task.id, projectId: "pr1", revision: 1, taskRevision: 2, state: "ready", reviewerMemberId: "mb2",
      specSnapshot: { title: task.title, body: task.body, labels: task.labels }, candidate: { repositoryRoot: "/repo", fixedPointInput: "HEAD~1", baseCommit: "base", candidateCommit: "candidate",
        policy: "committed-clean", gitVersion: "test", diff: "diff --git a/a b/a\n+任务", diffSha256: "diff", commits: [{ sha: "candidate", subject: "任务提交" }], commands: [], capturedAt: at },
      failure: null, decision: null, createdAt: at, updatedAt: at };
    await repos.tasks.createRound(round);
    await repos.tasks.updateCas("pr1", task.id, 1, { state: "review", currentReviewRoundId: round.id }, at);
    const report: ReviewReport = { id: "report-copy", roundId: round.id, taskId: task.id, projectId: "pr1", axis: "spec", verdict: "pass", body: "通过", sources: ["spec"],
      evidence: { provenance: "reviewer-declared", host: "test", hostVersion: "1", parentRunId: "parent", invocationId: "run", contextId: "context", startedAt: at, completedAt: at,
        command: { argv: ["test"], cwd: "/repo", startedAt: at, completedAt: at, exitCode: 0 }, promptSha256: "prompt", transcriptSha256: "transcript", evidenceRef: "log",
        baseCommit: "base", candidateCommit: "candidate", diffSha256: "diff" }, contentSha256: "content", author, createdAt: at };
    await repos.tasks.addReport(report);
    await repos.tasks.addComment({ id: "comment-copy", taskId: task.id, projectId: "pr1", kind: "review_report", author, body: "通过", createdAt: at, reviewReportId: report.id });
    await repos.tasks.appendHistory({ id: "history-copy", taskId: task.id, projectId: "pr1", action: "task.review_started", actor: author, taskRevision: 2, detail: { roundId: round.id }, createdAt: at });
    await repos.tasks.linkMessage("pr1", { taskId: task.id, messageId: "msg1", groupId: "gp1", createdAt: at });
    await repos.tasks.enqueueWorkEvent({ id: "event-copy", projectId: "pr1", recipientMemberId: "mb2", taskId: task.id, kind: "task.review_ready", eventKey: "review:round-copy:ready",
      payload: { roundId: round.id, revision: 2 }, deliveryState: "pending", attempts: 0, createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
    await repos.tasks.markWorkEventsDelivered("pr1", "mb2", ["event-copy"], at);
    await appendAuditEntry(repos.audit, { projectId: "pr1", actor: { kind: "human", name: "人" }, action: "task.review_started", targetKind: "task", targetId: task.id, targetName: task.title });
    // v12 每张表非空，包含 global 私有版本及群绑定事件，验证真实 FK 复制顺序。
    const memoryAuthor = { ...author, agentId: null };
    for (const key of [{ scope: "global" as const, projectId: null, agentId: "ag1" },
      { scope: "project" as const, projectId: "pr1", agentId: null },
      { scope: "project-agent" as const, projectId: "pr1", agentId: "ag1" }]) {
      const markdown = `# ${key.scope} 记忆 🧠`;
      const doc: MemoryDocument = { id: `memory-${key.scope}`, key, version: 1, markdown, byteLength: Buffer.byteLength(markdown), updatedAt: at, updatedBy: memoryAuthor, source: "human" };
      await repos.memory.insertHead(doc);
      await repos.memory.insertVersion({ id: `version-${key.scope}`, documentId: doc.id, version: 1, parentVersion: 0, markdown,
        byteLength: doc.byteLength, contentSha256: createHash("sha256").update(markdown).digest("hex"), author: memoryAuthor, source: "human",
        clientMutationId: `copy-${key.scope}`, summaryRequestId: null, createdAt: at });
    }
    await repos.deliveries.markMcpDelivered("msg1", "mb1", at);
    await driver.exec("UPDATE message_deliveries SET id = 'md3' WHERE message_id = 'msg1' AND member_id = 'mb1'");
    await repos.memory.observeDeliveredMessage({ projectId: "pr1", agentId: "ag1", groupId: "gp1", messageId: "msg1", threshold: 1, at });
    const request: MemorySummaryRequest = { id: "memory-request-copy", projectId: "pr1", agentId: "ag1", recipientMemberId: "mb1", contextGroupId: "gp1",
      documentId: "memory-project-agent", baseVersion: 1, revision: 1, state: "pending", trigger: "message_threshold", triggerKey: "threshold:1",
      taskId: null, completedTaskRevision: null, messageIds: ["msg1"], sourceWorkEventId: null, retryOfRequestId: null, attemptId: null,
      beginMutationId: null, resultVersion: null, resultSha256: null, error: null, evidence: null, createdAt: at, startedAt: null, finishedAt: null };
    await repos.memory.createRequest(request);
    await repos.tasks.enqueueWorkEvent({ id: "memory-event-copy", projectId: "pr1", recipientMemberId: "mb1", taskId: null, contextGroupId: "gp1",
      kind: "memory.summary_requested", eventKey: "memory:request-copy", payload: { requestId: request.id, requestRevision: 1, trigger: request.trigger },
      deliveryState: "pending", attempts: 0, createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
    for (const kind of ["message_threshold", "task_completed"] as const) {
      const scope = { kind, projectId: "pr1", agentId: "ag1", groupId: kind === "message_threshold" ? "gp1" : null };
      await repos.memory.updateScanCheckpointCas({ scope, after: null, through: await repos.memory.scanHighWater(scope), sweep: 1, revision: 1 }, 0);
    }
    await driver.exec("UPDATE members SET removed_at = ?, membership_revision = 2, status = 'disabled', node_id = NULL, role = 'normal' WHERE id = 'mb3'", [at]);
    for (const [index, kind] of ["authored-messages", "deliveries", "memory-requests", "memory-receipts", "memory-counters", "memory-checkpoints"].entries()) {
      await driver.exec("UPDATE member_fact_revisions SET revision = ? WHERE kind = ?", [101 + index, kind]);
    }

  } finally {
    await driver.close();
  }
}

async function assertDispatchValues(options: DbDriverOptions): Promise<void> {
  const driver = createDbDriver(options);
  await driver.connect();
  try {
    assert.deepEqual(await driver.query("SELECT id, client_message_id FROM messages ORDER BY id"), [
      { id: "msg1", client_message_id: "migration-request" },
      { id: "msg2", client_message_id: null },
    ]);
    assert.deepEqual(await driver.query(
      "SELECT id, wake_decision, wake_suppressed_reason FROM message_deliveries ORDER BY id",
    ), [
      { id: "md1", wake_decision: "allowed", wake_suppressed_reason: null },
      { id: "md2", wake_decision: "suppressed", wake_suppressed_reason: "rate_limited" },
      { id: "md3", wake_decision: null, wake_suppressed_reason: null },
    ]);
    assert.equal(Number((await driver.query<{ n: number | string }>("SELECT COUNT(*) AS n FROM memory_documents"))[0]!.n), 3);
    assert.equal((await driver.query<{ first_mcp_delivered_at: string }>("SELECT first_mcp_delivered_at FROM message_deliveries WHERE message_id='msg1' AND member_id='mb1'"))[0]!.first_mcp_delivered_at, "2026-11-10T12:00:00.000Z");
    assert.equal((await driver.query<{ context_group_id: string }>("SELECT context_group_id FROM work_events WHERE id='memory-event-copy'"))[0]!.context_group_id, "gp1");
    const factRows = await driver.query<{ member_id: string; kind: string; revision: number | string }>("SELECT member_id, kind, revision FROM member_fact_revisions ORDER BY member_id, kind");
    const expected = ["mb1", "mb2", "mb3"].flatMap(member_id => ["authored-messages", "deliveries", "memory-requests", "memory-receipts", "memory-counters", "memory-checkpoints"]
      .map((kind, index) => ({ member_id, kind, revision: 101 + index })).sort((a, b) => a.kind.localeCompare(b.kind)));
    assert.deepEqual(factRows.map(row => ({ ...row, revision: Number(row.revision) })), expected);
    assert.deepEqual(await driver.query("SELECT removed_at, membership_revision, status, node_id, role FROM members WHERE id = 'mb3'"),
      [{ removed_at: "2026-11-10T12:00:00.000Z", membership_revision: 2, status: "disabled", node_id: null, role: "normal" }]);
  } finally { await driver.close(); }
}

// 跨表外键依赖（自引用 org_nodes 由递归读取处理，此处不计入顺序约束）。
const FK_DEPS: Record<string, string[]> = {
  project_workspace_versions: ["projects"],
  role_template_versions: ["role_templates"],
  org_nodes: ["projects"],
  members: ["projects", "agents", "org_nodes"],
  groups: ["projects"],
  group_participants: ["groups", "members"],
  messages: ["groups", "members"],
  message_deliveries: ["messages", "members", "projects"],
  member_statuses: ["projects", "members"],
  mcp_sessions: ["agents", "projects", "groups", "members"],
  agent_runtimes: ["agents"],
  agent_runtime_bindings: ["agent_runtimes", "projects", "groups", "members"],
  agent_runner_states: ["agent_runtime_bindings"],
  agent_runtime_members: ["agent_runtimes", "projects", "members", "agent_runtime_bindings"],
  project_task_settings: ["projects", "members"],
  tasks: ["projects", "members"],
  task_review_rounds: ["projects", "tasks"],
  task_review_reports: ["projects", "tasks", "task_review_rounds"],
  task_comments: ["projects", "tasks", "task_review_reports"],
  task_history: ["projects", "tasks"],
  task_message_links: ["projects", "tasks", "messages", "groups"],
  work_events: ["projects", "tasks", "members", "groups"],
  memory_documents: ["projects", "agents"], memory_versions: ["memory_documents"],
  memory_summary_requests: ["projects", "agents", "members", "groups", "tasks", "memory_documents"],
  memory_message_receipts: ["projects", "agents", "groups", "messages"],
  memory_trigger_counters: ["projects", "agents", "groups"], memory_scan_checkpoints: ["projects", "agents", "groups"],
};

test("业务表清单：37 张表、不含 schema_migrations、外键顺序合法且事实版本最后复制", () => {
  const names = BUSINESS_TABLES.map((t) => t.name);
  assert.equal(names.length, 37);
  assert.equal(names.at(-1), "member_fact_revisions");
  assert.ok(!names.includes("schema_migrations"));
  for (const expected of [
    "agents",
    "agent_legacy_aliases", "role_templates", "role_template_versions",
    "projects",
    "project_workspace_versions",
    "members",
    "groups",
    "org_nodes",
    "group_participants",
    "messages",
    "message_deliveries",
    "member_statuses",
    "mcp_sessions",
    "audit_log",
    "agent_runtimes",
    "agent_runtime_bindings",
    "agent_runner_states",
    "agent_runtime_members",
    "agent_runtime_events",
    "agent_runtime_observation_meta",
    "agent_runtime_usage_snapshots",
    "project_task_settings", "tasks", "task_review_rounds", "task_review_reports", "task_comments", "task_history", "task_message_links", "work_events",
    "memory_documents", "memory_versions", "memory_summary_requests", "memory_message_receipts", "memory_trigger_counters", "memory_scan_checkpoints",
  ]) {
    assert.ok(names.includes(expected), `缺少业务表 ${expected}`);
  }

  const pos = new Map(names.map((n, i) => [n, i]));
  for (const [table, deps] of Object.entries(FK_DEPS)) {
    for (const dep of deps) {
      assert.ok(
        (pos.get(dep) ?? -1) < (pos.get(table) ?? -1),
        `外键顺序错误：${table} 应晚于其依赖 ${dep}`,
      );
    }
  }

  // 复合主键表应有两列键。
  const gp = BUSINESS_TABLES.find((t) => t.name === "group_participants");
  const ms = BUSINESS_TABLES.find((t) => t.name === "member_statuses");
  assert.deepEqual(gp?.keyColumns, ["group_id", "member_id"]);
  assert.deepEqual(ms?.keyColumns, ["project_id", "member_id"]);
  // org_nodes 使用层级读取 SQL。
  const on = BUSINESS_TABLES.find((t) => t.name === "org_nodes");
  assert.ok(on?.readSql?.includes("WITH RECURSIVE"));
});

test("PG DDL 镜像：版本与 SQLite 一致，且不含 json_valid 检查", () => {
  assert.equal(PG_BUSINESS_SCHEMA_MIGRATIONS.length, migrations.length);
  const expectedVersions = migrations.map((m) => m.version).sort((a, b) => a - b);
  const pgVersions = PG_BUSINESS_SCHEMA_MIGRATIONS.map((m) => m.version).sort((a, b) => a - b);
  assert.deepEqual(pgVersions, expectedVersions);
  // 生产 SQLite DDL 用 json_valid 校验 mentions；PG 镜像应改用 PG 合法写法（此处省略）。
  const sqliteUp = migrations.map((m) => m.up).join("\n");
  assert.ok(sqliteUp.includes("json_valid"));
  const pgUp = PG_BUSINESS_SCHEMA_MIGRATIONS.map((m) => m.up).join("\n");
  assert.ok(!pgUp.includes("json_valid"));
  assert.ok(!pgUp.includes("json_type"));
});

test("SQLite → SQLite：全量拷贝、一致性校验、源库只读、幂等重跑", async () => {
  await withTempDir(async (srcDir) => {
    await seedSqliteDir(srcDir);
    const srcOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: srcDir };

    await withTempDir(async (dstDir) => {
      const dstOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: dstDir };

      const first = await migrateData(srcOpts, dstOpts, { snapshotSource: true });
      assert.equal(first.validation.ok, true);
      await assertDispatchValues(srcOpts);
      await assertDispatchValues(dstOpts);

      // 源库未改：全部业务表的行数保持一致。
      const srcCounts: Record<string, number> = {};
      const srcDriver = createDbDriver(srcOpts);
      await srcDriver.connect();
      try {
        for (const t of BUSINESS_TABLES) {
          const rows = await srcDriver.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t.name}`);
          srcCounts[t.name] = rows[0]?.c ?? 0;
        }
      } finally {
        await srcDriver.close();
      }
      assert.equal(srcCounts["agents"], 2);
      assert.equal(srcCounts["members"], 3);
      assert.equal(srcCounts["org_nodes"], 4);
      assert.equal(srcCounts["messages"], 2);
      assert.equal(srcCounts["audit_log"], 2);
      for (const table of ["project_task_settings", "tasks", "task_review_rounds", "task_review_reports", "task_comments", "task_history", "task_message_links"]) assert.equal(srcCounts[table], 1, table);
      assert.equal(srcCounts["work_events"], 2);
      for (const table of ["memory_documents", "memory_versions"]) assert.equal(srcCounts[table], 3, table);
      for (const table of ["memory_summary_requests", "memory_message_receipts", "memory_trigger_counters"]) assert.equal(srcCounts[table], 1, table);
      assert.equal(srcCounts["memory_scan_checkpoints"], 2);

      // 幂等重跑：再次迁移仍一致。
      const again = await migrateData(srcOpts, dstOpts);
      assert.equal(again.validation.ok, true);
      assert.deepEqual(again.perTableCounts, first.perTableCounts);
      await assertDispatchValues(dstOpts);
    });
  });
});

test("SQLite → SQLite：目标键集完整（含复合主键表与 id 保留）", async () => {
  await withTempDir(async (srcDir) => {
    await seedSqliteDir(srcDir);
    const srcOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: srcDir };
    await withTempDir(async (dstDir) => {
      const dstOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: dstDir };
      const report = await migrateData(srcOpts, dstOpts);

      // 抽查具体 id 在目标库存在。
      const dstDriver = createDbDriver(dstOpts);
      await dstDriver.connect();
      try {
        const member = await dstDriver.query<{ id: string }>(
          `SELECT id FROM members WHERE id = 'mb1'`,
        );
        assert.equal(member.length, 1);
        const gp = await dstDriver.query<{ group_id: string; member_id: string }>(
          `SELECT group_id, member_id FROM group_participants WHERE group_id = 'gp1' AND member_id = 'mb2'`,
        );
        assert.equal(gp.length, 1);
        await dstDriver.exec("UPDATE member_fact_revisions SET revision = revision + 1 WHERE member_id = 'mb1' AND kind = 'deliveries'");
      } finally {
        await dstDriver.close();
      }
      assert.equal(report.validation.ok, true);
      assert.equal((await validateData(srcOpts, dstOpts)).ok, false, "事实版本数值变化不能仅凭相同主键集通过校验");
    });
  });
});

test("回滚：清空目标业务表，源库不受影响；可重新迁移恢复", async () => {
  await withTempDir(async (srcDir) => {
    await seedSqliteDir(srcDir);
    const srcOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: srcDir };
    await withTempDir(async (dstDir) => {
      const dstOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: dstDir };
      await migrateData(srcOpts, dstOpts);

      const rb = await rollbackTarget(dstOpts);
      assert.equal(rb.clearedTables.length, 37);

      // 目标业务表已清空，校验失败。
      const afterRollback = await validateData(srcOpts, dstOpts);
      assert.equal(afterRollback.ok, false);

      // 源库仍完整。
      const srcStillOk = await validateData(srcOpts, srcOpts);
      assert.equal(srcStillOk.ok, true);

      // 重跑迁移可恢复。
      const recovered = await migrateData(srcOpts, dstOpts);
      assert.equal(recovered.validation.ok, true);
    });
  });
});

  test("PG 端到端：SQLite→PG 迁移校验 → PG→SQLite 反向校验 → 回滚 DROP schema", { skip: !PG_URL ? "未配置真实 PostgreSQL；交既有 CI 门控执行" : false }, async () => {
    const schema = `boardroom_m1_${Math.random().toString(16).slice(2, 10)}`;
    const pgOpts: DbDriverOptions = {
      dbDriver: "postgres",
      pgConnectionString: PG_URL!,
      pgSchema: schema,
    };
    await withTempDir(async (srcDir) => {
      await seedSqliteDir(srcDir);
      const srcOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: srcDir };

      await withTempDir(async (revDir) => {
        const revOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: revDir };
        try {
          // 正向：SQLite → PG
          const fwd = await migrateData(srcOpts, pgOpts, { snapshotSource: true });
          assert.equal(fwd.validation.ok, true, "SQLite→PG 一致性校验应通过");
          await assertDispatchValues(pgOpts);

          // 反向：PG → SQLite
          const rev = await migrateData(pgOpts, revOpts);
          assert.equal(rev.validation.ok, true, "PG→SQLite 一致性校验应通过");
          await assertDispatchValues(revOpts);

          // 反向产物与原源库逐键一致（证明 PG 中转未丢失/改写数据）。
          const identity = await validateData(srcOpts, revOpts);
          assert.equal(identity.ok, true, "反向迁移产物应与源库逐键一致");

          // 回滚：DROP 目标 schema。
          const rb = await rollbackTarget(pgOpts, { dropSchema: true });
          assert.equal(rb.droppedSchema, schema);
        } finally {
          // 无论如何清理 PG schema，避免遗留。
          const pg = createDbDriver(pgOpts);
          await pg.connect();
          try {
            await pg.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await pg.close();
          }
        }
      });
    });
  });
