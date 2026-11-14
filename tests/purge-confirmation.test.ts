import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { createT1ApiRouter, type T1ApiOptions } from "../src/server/api.ts";
import { createLogger } from "../src/server/logger.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { createDbDriver, type DbDriver } from "../src/server/db/driver.ts";
import { RepositoryError } from "../src/server/db/errors.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { actorForMember, ownerActor } from "../src/server/authz/actors.ts";
import type { Task } from "../src/shared/tasks.ts";
import type { MemoryDocument, MemorySummaryRequest, MemoryVersion } from "../src/shared/memory.ts";
import { memoryFixture, memoryPgUrl, pgUnavailable } from "./helpers/memory-fixture.ts";

const at = "2026-11-11T00:00:00.000Z";
const author = { kind: "human" as const, actorId: "owner", agentId: null, displayName: "人" };

function caller(repos: RepositorySet, db: DbDriver, options: Partial<T1ApiOptions> = {}) {
  const api = createT1ApiRouter({ db, repos, logger: createLogger({ write() {} }), ...options });
  return async (method: string, url: string, body?: unknown) => {
    const request = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, url, headers: {} }) as IncomingMessage;
    let status = 200, text = "";
    const response = { setHeader() {}, writeHead(code: number) { status = code; }, end(value?: string) { text = value ?? ""; } } as unknown as ServerResponse;
    assert.equal(await api.handle(request, response, url), true);
    return { status, body: text ? JSON.parse(text) : null };
  };
}

async function fixture(repos: RepositorySet) {
  const project = await repos.projects.create({ name: "永久删除影响快照" });
  const member = await repos.members.create({ projectId: project.id, kind: "human", displayName: "人" });
  const group = await repos.groups.create({ projectId: project.id, name: "目标群", participantMemberIds: [member.id] });
  return { project, member, group };
}

function task(projectId: string): Task {
  return { id: randomUUID(), projectId, title: "将被删除的任务", body: "完整业务事实", deliveryKind: "code", acceptanceText: "完整业务事实", acceptanceSource: "explicit", labels: [], state: "todo",
    assigneeMemberId: null, reviewerMemberId: null, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null,
    blockedReason: null, author, createdAt: at, updatedAt: at };
}
function document(projectId: string | null, agentId: string | null = null): MemoryDocument {
  const key = projectId === null ? { scope: "global" as const, projectId: null, agentId: agentId! }
    : { scope: "project" as const, projectId, agentId: null };
  return { id: randomUUID(), key, version: 1, markdown: "业务记忆", byteLength: Buffer.byteLength("业务记忆"), updatedAt: at, updatedBy: author, source: "human" };
}
function version(doc: MemoryDocument): MemoryVersion {
  return { id: randomUUID(), documentId: doc.id, version: doc.version, parentVersion: doc.version - 1, markdown: doc.markdown,
    byteLength: doc.byteLength, contentSha256: createHash("sha256").update(doc.markdown).digest("hex"), author, source: "human",
    clientMutationId: randomUUID(), summaryRequestId: null, createdAt: at };
}
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

/** PG 用独立池/连接；SQLite 用同 driver 的另一工厂，走真实驱动的事务排队。 */
async function withContender(db: DbDriver, run: (repos: RepositorySet, driver: DbDriver) => Promise<void>) {
  if (db.kind === "sqlite") return run(createRepositories(db), db);
  const schema = (await db.query<{ name: string }>("SELECT current_schema() AS name"))[0]!.name;
  const second = createDbDriver({ dbDriver: "postgres", pgConnectionString: memoryPgUrl!, pgSchema: schema });
  await second.connect();
  try { await run(createRepositories(second), second); } finally { await second.close(); }
}

/** 真实 HTTP socket 与实际数据库，不把 request/response 替身计为网络集成证据。 */
async function withHttp(repos: RepositorySet, db: DbDriver, run: (call: ReturnType<typeof caller>) => Promise<void>, onRequest: (request: IncomingMessage) => void = () => {}) {
  const api = createT1ApiRouter({ repos, db, logger: createLogger({ write() {} }) });
  const server = createServer((req, res) => {
    onRequest(req);
    void api.handle(req, res, new URL(req.url!, "http://localhost").pathname).then(matched => {
      if (!matched) { res.writeHead(404); res.end(); }
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    await run(async (method, url, body) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

for (const engine of ["sqlite", "postgres"] as const) {
  const skip = engine === "postgres" ? pgUnavailable : false;
  for (const kind of ["project", "group"] as const) {
    test(`${engine} ${kind} 预览后的新消息使确认失效，数据保留且必须重新预览`, { skip }, async () => memoryFixture(async (repos, db) => {
      const f = await fixture(repos), call = caller(repos, db);
      const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
      const preview = await call("DELETE", target);
      assert.equal(preview.status, 409);
      assert.equal(preview.body.error.code, "confirmation_required");
      const message = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "预览之后的新事实" });
      const refused = await call("DELETE", target, { confirm: preview.body.confirmation.token });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, "confirmation_changed");
      assert.ok(await repos.projects.get(f.project.id));
      assert.ok(await repos.groups.get(f.group.id));
      assert.equal((await repos.messages.get(message.id))?.body, "预览之后的新事实");
      assert.deepEqual(await repos.audit.list(f.project.id), []);
      const used = await call("DELETE", target, { confirm: preview.body.confirmation.token });
      assert.equal(used.status, 400);
      assert.equal(used.body.error.code, "invalid_confirmation");
      const fresh = await call("DELETE", target);
      assert.notEqual(fresh.body.confirmation.token, preview.body.confirmation.token);
      assert.equal(fresh.body.confirmation.cascade.messages, 1);
      assert.equal((await call("DELETE", target, { confirm: fresh.body.confirmation.token })).status, 204);
      assert.equal(await repos.groups.get(f.group.id), null);
      assert.equal((await repos.audit.list(f.project.id)).length, 1);
      assert.equal(Boolean(await repos.members.get(f.member.id)), kind === "group");
    }, engine));

    test(`${engine} ${kind} 正常凭据一次生效；错误/错作用域/旧预览/过期凭据不触发删除`, { skip }, async () => memoryFixture(async (repos, db) => {
      const f = await fixture(repos); let clock = new Date(at);
      const call = caller(repos, db, { now: () => clock });
      const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
      const otherTarget = kind === "project" ? `/api/groups/${f.group.id}` : `/api/projects/${f.project.id}`;
      const first = await call("DELETE", target), current = await call("DELETE", target);
      for (const [path, token] of [[target, "incorrect"], [target, first.body.confirmation.token], [otherTarget, current.body.confirmation.token]]) {
        const refused = await call("DELETE", path, { confirm: token });
        assert.equal(refused.status, 400); assert.equal(refused.body.error.code, "invalid_confirmation");
      }
      clock = new Date(clock.getTime() + 5 * 60_000);
      const expired = await call("DELETE", target, { confirm: current.body.confirmation.token });
      assert.equal(expired.status, 400); assert.equal(expired.body.error.code, "invalid_confirmation");
      assert.ok(await repos.groups.get(f.group.id));
      const fresh = await call("DELETE", target);
      const restarted = caller(repos, db);
      assert.equal((await restarted("DELETE", target, { confirm: fresh.body.confirmation.token })).body.error.code, "invalid_confirmation");
      assert.equal((await call("DELETE", target, { confirm: "still-incorrect" })).status, 400);
      const duplicates = await Promise.all([call("DELETE", target, { confirm: fresh.body.confirmation.token }), call("DELETE", target, { confirm: fresh.body.confirmation.token })]);
      assert.equal(duplicates.filter(result => result.status === 204).length, 1);
      assert.ok(duplicates.some(result => [400, 404].includes(result.status)));
      assert.equal((await call("DELETE", target, { confirm: fresh.body.confirmation.token })).status, 404);
      assert.equal((await repos.audit.list(f.project.id)).length, 1);
    }, engine));

    test(`${engine} ${kind} 同数量替换消息和参与关系、目标事实变化都拒绝旧快照`, { skip }, async () => memoryFixture(async (repos, db) => {
      const f = await fixture(repos), call = caller(repos, db);
      const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
      const replacementMember = await repos.members.create({ projectId: f.project.id, kind: "human", displayName: "替换参与者" });
      const beforeMessage = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "将被换掉" });
      const initial = await call("DELETE", target);
      // 测试设定同数量换身份；消息仓储没有公开物理删除，直接清理仍处于实际事务中。
      await repos.transaction(async () => {
        await db.exec("DELETE FROM messages WHERE id = ?", [beforeMessage.id]);
        await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "相同条数的新对象" });
      });
      const counts = kind === "project" ? await repos.projects.previewPurge(f.project.id) : await repos.groups.previewPurge(f.group.id);
      assert.deepEqual(counts, initial.body.confirmation.cascade);
      assert.equal((await call("DELETE", target, { confirm: initial.body.confirmation.token })).body.error.code, "confirmation_changed");
      const participants = await call("DELETE", target);
      await repos.groups.removeParticipant(f.group.id, f.member.id);
      await repos.groups.addParticipant(f.group.id, replacementMember.id);
      assert.deepEqual(kind === "project" ? await repos.projects.previewPurge(f.project.id) : await repos.groups.previewPurge(f.group.id), participants.body.confirmation.cascade);
      assert.equal((await call("DELETE", target, { confirm: participants.body.confirmation.token })).body.error.code, "confirmation_changed");
      const resource = await call("DELETE", target);
      if (kind === "project") await repos.projects.rename(f.project.id, "新目标名称");
      else await repos.groups.archive(f.group.id);
      assert.equal((await call("DELETE", target, { confirm: resource.body.confirmation.token })).body.error.code, "confirmation_changed");
      assert.ok(await repos.groups.get(f.group.id));
      assert.equal((await repos.messages.listByGroup(f.group.id)).length, 1);
      assert.deepEqual(await repos.audit.list(f.project.id), []);
    }, engine));

    test(`${engine} ${kind} 无关项目写入不使确认失效；群保留同项目其他群与任务`, { skip }, async () => memoryFixture(async (repos, db) => {
      const f = await fixture(repos), other = await fixture(repos), call = caller(repos, db);
      const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
      const preview = await call("DELETE", target);
      const unrelated = await repos.messages.create({ groupId: other.group.id, senderMemberId: other.member.id, body: "别的项目" });
      await repos.tasks.create(task(other.project.id));
      await repos.memory.insertHead(document(other.project.id));
      let retainedGroup: string | undefined;
      if (kind === "group") {
        retainedGroup = (await repos.groups.create({ projectId: f.project.id, name: "同项目保留群", participantMemberIds: [f.member.id] })).id;
        await repos.messages.create({ groupId: retainedGroup, senderMemberId: f.member.id, body: "同一作者在别的群增加事实" });
        await repos.tasks.create(task(f.project.id));
        await repos.memory.insertHead(document(f.project.id));
      }
      assert.equal((await call("DELETE", target, { confirm: preview.body.confirmation.token })).status, 204);
      assert.ok(await repos.messages.get(unrelated.id));
      if (retainedGroup) {
        assert.equal((await repos.messages.listByGroup(retainedGroup)).length, 1);
        assert.equal((await repos.tasks.list(f.project.id)).length, 1);
        assert.equal((await repos.memory.listProject(f.project.id)).length, 1);
      }
    }, engine));

    test(`${engine} ${kind} 当前manager无权限；确认在锁内再次核对权限`, { skip }, async () => memoryFixture(async (repos, db) => {
      const f = await fixture(repos);
      const agent = await repos.agents.create({ displayName: "manager", hostType: "fixture" });
      const manager = await repos.members.create({ projectId: f.project.id, kind: "agent", agentId: agent.id, displayName: "manager", role: "manager" });
      let actor = ownerActor(), deniedInside = false, resolutions = 0;
      const call = caller(repos, db, { resolveActor: async () => { resolutions++; return deniedInside && resolutions === 2 ? actorForMember(manager) : actor; } });
      const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
      actor = actorForMember(manager);
      assert.equal((await call("DELETE", target)).status, 403);
      actor = ownerActor();
      const preview = await call("DELETE", target);
      actor = actorForMember(manager);
      assert.equal((await call("DELETE", target, { confirm: preview.body.confirmation.token })).status, 403);
      actor = ownerActor(); resolutions = 0; deniedInside = true;
      assert.equal((await call("DELETE", target, { confirm: preview.body.confirmation.token })).status, 403);
      deniedInside = false;
      assert.ok(await repos.groups.get(f.group.id));
      assert.equal((await call("DELETE", target, { confirm: preview.body.confirmation.token })).body.error.code, "invalid_confirmation");
      const fresh = await call("DELETE", target);
      assert.equal((await call("DELETE", target, { confirm: fresh.body.confirmation.token })).status, 204);
    }, engine));

    test(`${engine} ${kind} 清理中途/审计失败整笔回滚，已尝试token不允许静默重试`, { skip }, async () => memoryFixture(async (repos, db) => {
      const f = await fixture(repos), call = caller(repos, db);
      await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "失败后必须保留" });
      const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
      const capture = () => kind === "project" ? repos.projects.capturePurge(f.project.id) : repos.groups.capturePurge(f.group.id);
      const initial = await capture();
      const originalExec = repos.context.exec;
      for (const failure of [/^DELETE FROM groups\b/, /^INSERT INTO audit_log\b/]) {
        const preview = await call("DELETE", target);
        let failed = false;
        repos.context.exec = async (sql, params) => {
          if (failure.test(sql)) { failed = true; throw new Error("受控存储失败"); }
          return originalExec(sql, params);
        };
        try { assert.equal((await call("DELETE", target, { confirm: preview.body.confirmation.token })).status, 500); }
        finally { repos.context.exec = originalExec; }
        assert.ok(failed);
        assert.deepEqual(await capture(), initial);
        assert.deepEqual(await repos.audit.list(f.project.id), []);
        assert.equal((await call("DELETE", target, { confirm: preview.body.confirmation.token })).body.error.code, "invalid_confirmation");
      }
      const fresh = await call("DELETE", target);
      assert.equal((await call("DELETE", target, { confirm: fresh.body.confirmation.token })).status, 204);
      assert.equal((await repos.audit.list(f.project.id)).length, 1);
    }, engine));

    test(`${engine} ${kind} 心跳、消费ACK、在线状态与空扫描推进不改变删除范围`, { skip }, async () => memoryFixture(async (repos, db) => {
      const f = await fixture(repos), call = caller(repos, db);
      const agent = await repos.agents.create({ displayName: "心跳Agent", hostType: "fixture" });
      const member = await repos.members.create({ projectId: f.project.id, agentId: agent.id, kind: "agent", displayName: agent.displayName });
      await repos.groups.addParticipant(f.group.id, member.id);
      const message = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "已存在的消息" });
      await repos.deliveries.ensure(message.id, member.id);
      await repos.statuses.set(f.project.id, member.id, "online");
      const session = await repos.mcpSessions.connect({ projectId: f.project.id, groupId: f.group.id, memberId: member.id, agentId: agent.id, displayName: agent.displayName, hostType: agent.hostType });
      const scope = { kind: "message_threshold" as const, projectId: f.project.id, groupId: f.group.id, agentId: agent.id };
      await repos.memory.updateScanCheckpointCas({ scope, after: null, through: null, sweep: 1, revision: 1 }, 0);
      const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
      const preview = await call("DELETE", target);
      await repos.mcpSessions.heartbeat(session.id, "2026-11-11T00:01:00.000Z");
      await repos.statuses.set(f.project.id, member.id, "waiting");
      await repos.deliveries.recordAttempt(message.id, member.id, "acked", "2026-11-11T00:02:00.000Z");
      await repos.memory.updateScanCheckpointCas({ scope, after: null, through: null, sweep: 2, revision: 2 }, 1);
      assert.equal((await call("DELETE", target, { confirm: preview.body.confirmation.token })).status, 204);
      assert.ok(await repos.agents.get(agent.id));
    }, engine));

    test(`${engine} ${kind} 写入先持项目锁则确认等待并因新事实拒绝`, { skip, timeout: 10000 }, async () => memoryFixture(async (repos, db) => {
      const f = await fixture(repos), call = caller(repos, db);
      const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
      const preview = await call("DELETE", target);
      await withContender(db, async other => {
        const entered = deferred(), release = deferred(), lockAttempted = deferred();
        const originalExec = db.exec.bind(db);
        if (engine === "postgres") db.exec = (sql, params) => {
          if (/^UPDATE projects SET updated_at = updated_at/.test(sql)) lockAttempted.resolve();
          return originalExec(sql, params);
        };
        const writer = other.transaction(async () => {
          await other.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "先提交的新事实" });
          entered.resolve(); await release.promise;
        });
        let confirmation: ReturnType<typeof call> | undefined;
        try {
          await entered.promise;
          let settled = false;
          confirmation = call("DELETE", target, { confirm: preview.body.confirmation.token }).then(result => { settled = true; return result; });
          if (engine === "postgres") await Promise.race([lockAttempted.promise, confirmation.then(() => { throw new Error("确认未等待独立PG连接持有的项目锁"); })]);
          await setImmediate();
          assert.equal(settled, false, "未提交写入持锁时确认不能先完成");
        } finally { release.resolve(); db.exec = originalExec; await writer; }
        const refused = await confirmation!;
        assert.equal(refused.status, 409); assert.equal(refused.body.error.code, "confirmation_changed");
        assert.equal((await repos.messages.listByGroup(f.group.id)).length, 1);
        assert.deepEqual(await repos.audit.list(f.project.id), []);
      });
    }, engine));

    test(`${engine} ${kind} 比较后暂停删除时竞争写入不能穿过锁；删除后按生命周期拒绝`, { skip, timeout: 10000 }, async () => memoryFixture(async (repos, db) => {
      const f = await fixture(repos), call = caller(repos, db);
      const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
      const preview = await call("DELETE", target);
      await withContender(db, async (other, contenderDb) => {
        const entered = deferred(), release = deferred(), lockAttempted = deferred();
        const originalContenderExec = contenderDb.exec.bind(contenderDb);
        if (engine === "postgres") contenderDb.exec = (sql, params) => {
          if (/^UPDATE projects SET updated_at = updated_at/.test(sql)) lockAttempted.resolve();
          return originalContenderExec(sql, params);
        };
        const original = repos.context.exec;
        let paused = false;
        repos.context.exec = async (sql, params) => {
          if (!paused && /^DELETE FROM /.test(sql)) { paused = true; entered.resolve(); await release.promise; }
          return original(sql, params);
        };
        const confirmation = call("DELETE", target, { confirm: preview.body.confirmation.token });
        let writer: Promise<unknown> | undefined;
        try {
          await entered.promise;
          let settled = false;
          writer = other.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "不能静默并入删除" })
            .then(() => { settled = true; return null; }, error => { settled = true; return error; });
          if (engine === "postgres") await Promise.race([lockAttempted.promise, writer.then(() => { throw new Error("写入未等待确认持有的项目锁"); })]);
          await setImmediate();
          assert.equal(settled, false, "比较后仍持有同一数据库边界");
        } finally { release.resolve(); repos.context.exec = original; contenderDb.exec = originalContenderExec; }
        assert.equal((await confirmation).status, 204);
        const refused = await writer;
        assert.ok(refused instanceof RepositoryError);
        assert.ok(["not_found", "invalid_reference", "mutation_scope_changed"].includes(refused.code));
        assert.equal(await repos.groups.get(f.group.id), null);
        assert.equal((await repos.audit.list(f.project.id)).length, 1);
      });
    }, engine));

    test(`${engine} ${kind} 真实HTTP：预览→另一入口发消息→拒绝→重预览→再次确认`, { skip }, async () => memoryFixture(async (repos, db) => {
      const f = await fixture(repos);
      await withHttp(repos, db, async call => {
        const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
        const first = await call("DELETE", target);
        const message = await call("POST", `/api/groups/${f.group.id}/messages`, { senderMemberId: f.member.id, text: "另一HTTP入口新增" });
        assert.equal(message.status, 201);
        const refused = await call("DELETE", target, { confirm: first.body.confirmation.token });
        assert.equal(refused.status, 409); assert.equal(refused.body.error.code, "confirmation_changed");
        assert.equal((await call("GET", target)).status, 200);
        assert.ok(await repos.messages.get(message.body.message.id));
        const fresh = await call("DELETE", target);
        assert.equal(fresh.body.confirmation.cascade.messages, 1);
        assert.equal((await call("DELETE", target, { confirm: fresh.body.confirmation.token })).status, 204);
        assert.equal((await call("GET", target)).status, 404);
      });
    }, engine));

    test(`${engine} ${kind} 真实HTTP并发两个请求：先写则拒删除，先删则拒迟到写入`, { skip, timeout: 15000 }, async () => memoryFixture(async (repos, db) => {
      for (const writerFirst of [true, false]) {
        const f = await fixture(repos), entered = deferred(), release = deferred(), accepted = deferred();
        let waitingFor: string | null = null;
        await withHttp(repos, db, async call => {
          const target = kind === "project" ? `/api/projects/${f.project.id}` : `/api/groups/${f.group.id}`;
          const preview = await call("DELETE", target);
          const write = () => call("POST", `/api/groups/${f.group.id}/messages`, { senderMemberId: f.member.id, text: "并发HTTP事实" });
          const remove = () => call("DELETE", target, { confirm: preview.body.confirmation.token });
          const original = repos.context.exec, originalDbExec = db.exec;
          const lockAttempted = deferred(); let paused = false;
          repos.context.exec = async (sql, params) => {
            const matching = writerFirst ? /^INSERT INTO messages\b/.test(sql.trimStart()) : /^DELETE FROM /.test(sql);
            if (!paused && matching) {
              paused = true;
              const inserted = writerFirst ? await original(sql, params) : null;
              entered.resolve(); await release.promise;
              return inserted ?? original(sql, params);
            }
            return original(sql, params);
          };
          const first = writerFirst ? write() : remove();
          let second: ReturnType<typeof call> | undefined;
          try {
            await Promise.race([entered.promise, first.then(() => { throw new Error("首请求未进入受控事务屏障"); })]);
            if (engine === "postgres" && !writerFirst) db.exec = (sql, params) => {
              const pending = originalDbExec.call(db, sql, params);
              if (sql === "UPDATE projects SET updated_at = updated_at WHERE id = ?" && params?.length === 1 && params[0] === f.project.id) lockAttempted.resolve();
              return pending;
            };
            waitingFor = writerFirst ? "DELETE" : "POST";
            let settled = false;
            second = (writerFirst ? remove() : write()).then(result => { settled = true; return result; });
            await accepted.promise;
            // PG 迟到写入须实际发起本项目锁操作；SQLite 同 driver 队列在此前阻塞，只验证接收/排队。
            if (engine === "postgres" && !writerFirst) await Promise.race([
              lockAttempted.promise,
              second.then(() => { throw new Error("迟到HTTP写入未发起本项目锁操作便已完成"); }),
            ]);
            await setImmediate();
            assert.equal(settled, false, "服务已接收第二请求，但它不能越过首请求的数据库事务");
          } finally {
            release.resolve(); repos.context.exec = original; db.exec = originalDbExec;
            await Promise.allSettled(second ? [first, second] : [first]);
          }
          const [firstResult, secondResult] = await Promise.all([first, second!]);
          if (writerFirst) {
            assert.equal(firstResult.status, 201); assert.equal(secondResult.status, 409);
            assert.equal(secondResult.body.error.code, "confirmation_changed");
            assert.ok(await repos.messages.get(firstResult.body.message.id));
            assert.deepEqual(await repos.audit.list(f.project.id), []);
          } else {
            assert.equal(firstResult.status, 204);
            assert.ok([400, 404, 409].includes(secondResult.status), JSON.stringify(secondResult));
            assert.equal(await repos.groups.get(f.group.id), null);
            assert.equal((await repos.audit.list(f.project.id)).length, 1);
          }
        }, request => { if (request.method === waitingFor) accepted.resolve(); });
      }
    }, engine));
  }

  test(`${engine} 项目新增/修改任务与记忆版本拒绝旧快照，其他项目与global保留`, { skip }, async () => memoryFixture(async (repos, db) => {
    const f = await fixture(repos), call = caller(repos, db), target = `/api/projects/${f.project.id}`;
    const createdTask = task(f.project.id), doc = document(f.project.id);
    const mutate = [
      () => repos.tasks.create(createdTask),
      () => repos.tasks.updateCas(f.project.id, createdTask.id, 1, { title: "数量相同的任务修订" }, at),
      () => repos.tasks.updateCas(f.project.id, createdTask.id, 2, { acceptanceText: "数量相同的新验收", deliveryKind: "finding" }, at),
      () => db.exec("UPDATE tasks SET acceptance_source = 'legacy_task_body' WHERE id = ?", [createdTask.id]),
      () => repos.transaction(async () => { await repos.memory.insertHead(doc); await repos.memory.insertVersion(version(doc)); }),
      () => repos.transaction(async () => {
        const next = { ...doc, version: 2, markdown: "记忆新版本", byteLength: Buffer.byteLength("记忆新版本") };
        await repos.memory.updateHeadCas(doc.id, 1, next); await repos.memory.insertVersion(version(next));
      }),
    ];
    for (const write of mutate) {
      const preview = await call("DELETE", target);
      await write();
      const refused = await call("DELETE", target, { confirm: preview.body.confirmation.token });
      assert.equal(refused.status, 409); assert.equal(refused.body.error.code, "confirmation_changed");
      assert.ok(await repos.projects.get(f.project.id));
    }
    assert.equal((await repos.tasks.get(f.project.id, createdTask.id))?.title, "数量相同的任务修订");
    assert.equal((await repos.memory.listVersions(doc.id)).length, 2);
    const agent = await repos.agents.create({ displayName: "保留Global", hostType: "fixture" });
    const global = document(null, agent.id); await repos.memory.insertHead(global); await repos.memory.insertVersion(version(global));
    const fresh = await call("DELETE", target);
    const updated = { ...global, version: 2 };
    await repos.memory.updateHeadCas(global.id, 1, updated); await repos.memory.insertVersion(version(updated));
    assert.equal((await call("DELETE", target, { confirm: fresh.body.confirmation.token })).status, 204);
    assert.equal((await repos.memory.get(global.key))?.version, 2);
    assert.equal((await repos.memory.listVersions(global.id)).length, 2);
  }, engine));

  test(`${engine} 群新增/改绑任务链接与总结请求失效，项目任务/文档始终保留`, { skip }, async () => memoryFixture(async (repos, db) => {
    const f = await fixture(repos), call = caller(repos, db), target = `/api/groups/${f.group.id}`;
    const agent = await repos.agents.create({ displayName: "总结者", hostType: "fixture" });
    const member = await repos.members.create({ projectId: f.project.id, agentId: agent.id, kind: "agent", displayName: agent.displayName });
    await repos.groups.addParticipant(f.group.id, member.id);
    const firstTask = await repos.tasks.create(task(f.project.id)), secondTask = await repos.tasks.create(task(f.project.id));
    const doc = document(f.project.id); await repos.memory.insertHead(doc); await repos.memory.insertVersion(version(doc));
    const message = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "关联消息" });
    const linkPreview = await call("DELETE", target);
    await repos.tasks.linkMessage(f.project.id, { taskId: firstTask.id, messageId: message.id, groupId: f.group.id, createdAt: at });
    assert.equal((await call("DELETE", target, { confirm: linkPreview.body.confirmation.token })).body.error.code, "confirmation_changed");
    const relationPreview = await call("DELETE", target);
    await repos.transaction(async () => {
      await db.exec("DELETE FROM task_message_links WHERE task_id = ? AND message_id = ?", [firstTask.id, message.id]);
      await repos.tasks.linkMessage(f.project.id, { taskId: secondTask.id, messageId: message.id, groupId: f.group.id, createdAt: at });
    });
    assert.deepEqual(await repos.groups.previewPurge(f.group.id), relationPreview.body.confirmation.cascade);
    assert.equal((await call("DELETE", target, { confirm: relationPreview.body.confirmation.token })).body.error.code, "confirmation_changed");
    const request: MemorySummaryRequest = { id: randomUUID(), projectId: f.project.id, agentId: agent.id, recipientMemberId: member.id, contextGroupId: f.group.id,
      documentId: null, baseVersion: 0, revision: 1, state: "pending", trigger: "session_end", triggerKey: randomUUID(), taskId: null,
      completedTaskRevision: null, messageIds: [], sourceWorkEventId: null, retryOfRequestId: null, attemptId: null, beginMutationId: null,
      resultVersion: null, resultSha256: null, error: null, evidence: null, createdAt: at, startedAt: null, finishedAt: null };
    const requestPreview = await call("DELETE", target); await repos.memory.createRequest(request);
    assert.equal((await call("DELETE", target, { confirm: requestPreview.body.confirmation.token })).body.error.code, "confirmation_changed");
    const fresh = await call("DELETE", target);
    assert.equal((await call("DELETE", target, { confirm: fresh.body.confirmation.token })).status, 204);
    assert.equal((await repos.tasks.list(f.project.id)).length, 2);
    assert.ok(await repos.memory.get(doc.key)); assert.equal((await repos.memory.listVersions(doc.id)).length, 1);
    assert.equal(await repos.memory.getRequest(request.id), null);
    assert.deepEqual(await repos.tasks.listMessageLinks(f.project.id, secondTask.id), []);
  }, engine));

  test(`${engine} 群reservation由保留变删除必须重确认，runtime门禁与配置保留`, { skip }, async () => memoryFixture(async (repos, db) => {
    const f = await fixture(repos), runtimes = createRuntimeRepository(db), call = caller(repos, db), target = `/api/groups/${f.group.id}`;
    const sibling = await repos.groups.create({ projectId: f.project.id, name: "另一个绑定" });
    const runtime = await runtimes.create({ name: "运行配置", backend: "claude-code", defaults: { workdir: process.cwd() },
      bindings: [{ projectId: f.project.id, groupId: f.group.id }, { projectId: f.project.id, groupId: sibling.id }] });
    const selected = runtime.bindings.find(b => b.binding.groupId === f.group.id)!.binding;
    const retained = runtime.bindings.find(b => b.binding.groupId === sibling.id)!.binding;
    const preview = await call("DELETE", target);
    assert.equal(preview.body.confirmation.cascade.agentRuntimeMembers, 0);
    await runtimes.removeBinding(retained.id);
    assert.equal((await call("DELETE", target, { confirm: preview.body.confirmation.token })).body.error.code, "confirmation_changed");
    const fresh = await call("DELETE", target);
    assert.equal(fresh.body.confirmation.cascade.agentRuntimeMembers, 1);
    await runtimes.intent(selected.id, "start"); const fence = await runtimes.claim(selected.id, "confirmation-test");
    const running = await call("DELETE", target, { confirm: fresh.body.confirmation.token });
    assert.equal(running.status, 409); assert.match(running.body.error.message, /runtime_must_stop_first/);
    assert.ok(await repos.groups.get(f.group.id));
    await runtimes.intent(selected.id, "stop"); await runtimes.markExit(fence, { exitCode: 0 });
    assert.equal((await call("DELETE", target, { confirm: fresh.body.confirmation.token })).body.error.code, "invalid_confirmation");
    const stopped = await call("DELETE", target);
    assert.equal((await call("DELETE", target, { confirm: stopped.body.confirmation.token })).status, 204);
    assert.ok(await runtimes.get(runtime.runtime.id));
    assert.ok(await repos.members.get(selected.memberId));
    assert.equal((await db.query("SELECT member_id FROM agent_runtime_members WHERE member_id = ?", [selected.memberId])).length, 0);
  }, engine));

  test(`${engine} 预览的目标名称在锁内读取，与实际摘要和审计相符`, { skip }, async () => memoryFixture(async (repos, db) => {
    const f = await fixture(repos); let firstGuard = true;
    const call = caller(repos, db, { resolveActor: async () => {
      if (firstGuard) { firstGuard = false; await repos.projects.rename(f.project.id, "锁定前的新名称"); }
      return ownerActor();
    } });
    const target = `/api/projects/${f.project.id}`, preview = await call("DELETE", target);
    assert.equal(preview.body.confirmation.projectName, "锁定前的新名称");
    assert.equal((await call("DELETE", target, { confirm: preview.body.confirmation.token })).status, 204);
    assert.equal((await repos.audit.list(f.project.id))[0]?.targetName, "锁定前的新名称");
  }, engine));
}
