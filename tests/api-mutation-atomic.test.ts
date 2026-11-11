import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createT1ApiRouter } from "../src/server/api.ts";
import { createLogger } from "../src/server/logger.ts";
import { memoryFixture } from "./helpers/memory-fixture.ts";
import type { OrgChangeRecorder } from "../src/server/org-change-hook.ts";
import type { DbDriver, DbTransaction } from "../src/server/db/driver.ts";

function caller(db: DbDriver, observer?: OrgChangeRecorder) {
  const api = createT1ApiRouter({ db, logger: createLogger({ write() {} }), ...(observer ? { orgChangeRecorder: observer } : {}) });
  return async (method: string, url: string, body?: unknown) => {
    const request = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, url, headers: {} }) as IncomingMessage;
    let status = 200, text = "";
    const response = { setHeader() {}, writeHead(code: number) { status = code; }, end(value?: string) { text = value ?? ""; } } as unknown as ServerResponse;
    assert.equal(await api.handle(request, response, url), true);
    return { status, body: text ? JSON.parse(text) : null };
  };
}

test("S5-AUDIT-01：生产组织路由审计写失败整笔回滚，默认装配不遗漏权威审计", async () => memoryFixture(async (repos, db) => {
  const p = await repos.projects.create({ name: "原子组织入口" }), call = caller(db);
  await db.exec("ALTER TABLE audit_log RENAME TO audit_log_unavailable");
  const failed = await call("POST", `/api/projects/${p.id}/org/nodes`, { name: "不能留下", role: "top_manager" });
  assert.equal(failed.status, 500);
  assert.deepEqual(await repos.org.listNodes(p.id), []);
  await db.exec("ALTER TABLE audit_log_unavailable RENAME TO audit_log");
  assert.deepEqual(await repos.audit.list(p.id), []);
  const created = await call("POST", `/api/projects/${p.id}/org/nodes`, { name: "完整提交", role: "top_manager" });
  assert.equal(created.status, 201);
  const entries = await repos.audit.list(p.id);
  assert.equal(entries.length, 1); assert.equal(entries[0]?.targetId, created.body.node.id);
}));

test("S5-AUDIT-01：提交后观察钩子失败不变更HTTP成功与已提交审计", async () => memoryFixture(async (repos, db) => {
  const p = await repos.projects.create({ name: "观察钩子" }); let observed = 0;
  const call = caller(db, { async record() { observed++; throw new Error("observer-only-failure"); } });
  const created = await call("POST", `/api/projects/${p.id}/org/nodes`, { name: "权威记录", role: "top_manager" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(created.status, 201); assert.equal(observed, 1);
  assert.equal((await repos.audit.list(p.id)).length, 1);
  assert.equal((await repos.org.listNodes(p.id)).length, 1);
}));

test("S5-AUDIT-13：HTTP聊天在同一范围中锁定真实sender与全部投递目标", async () => memoryFixture(async (repos, db) => {
  const project = await repos.projects.create({ name: "HTTP消息范围" });
  const sender = await repos.members.create({ projectId: project.id, kind: "human", displayName: "人" });
  const agent = await repos.agents.create({ displayName: "执行者", hostType: "other" });
  const recipient = await repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName: "执行者" });
  const group = await repos.groups.create({ projectId: project.id, name: "协作", participantMemberIds: [sender.id, recipient.id] });
  const call = caller(db), transaction = db.transaction.bind(db); let writes = 0;
  try {
    db.transaction = <T>(body: (tx: DbTransaction) => Promise<T>): Promise<T> => transaction(tx => body({ ...tx,
      exec: async (sql, params) => {
        if (/INSERT INTO message_deliveries/.test(sql)) {
          const scope = repos.mutations.current(); assert.ok(scope);
          scope.assertCovers([project.id], [sender.id, recipient.id]); writes++;
        }
        return tx.exec(sql, params);
      },
    }));
    const sent = await call("POST", `/api/groups/${group.id}/messages`, { senderMemberId: sender.id, text: "锁内投递", mentions: [recipient.id] });
    assert.equal(sent.status, 201, JSON.stringify(sent.body)); assert.ok(writes >= 2);
    assert.equal((await repos.deliveries.get(sent.body.message.id, recipient.id))?.status, "pending");
  } finally { db.transaction = transaction; }
}));
