#!/usr/bin/env node
/** #112 / S5-AUDIT-16：生产服务、真实 HTTP/MCP SDK、独占数据库。没有模型调用。
 * stdout 仅 JSON 行；stdin {id,action:'round',index,token} / {id,action:'inspect'}。
 * 每个进程固定 1000 或 10000 条历史、6 次翻转；默认防环/记忆/心跳阈值不变。
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Client as PgClient } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { newId } from "../src/server/db/ids.ts";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_TIMEOUT_MS } from "../src/server/config.ts";

export const LIMITS = Object.freeze({ mutationMs: 500, mcpMs: 2000, webDomMs: 1000, flips: 6 });
const encode = value => JSON.stringify(value);
function safeError(error) {
  return { name: error?.name ?? "Error", code: error?.code ?? null,
    message: String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted-pg-uri]").slice(0, 2500) };
}
function payload(result) {
  const content = result.content?.find(item => item.type === "text")?.text;
  assert.equal(typeof content, "string", "MCP 必须返回实际 JSON 文本");
  const value = JSON.parse(content);
  assert.equal(value.ok, true, encode(value));
  return value;
}

export async function startV1LoadFixture({ engine = "sqlite", historyCount = 1000 } = {}) {
  assert.ok(["sqlite", "postgres"].includes(engine));
  assert.ok([1000, 10000].includes(historyCount));
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-v1-load-"));
  const schema = `v1_load_${randomUUID().replaceAll("-", "")}`;
  let admin, schemaCreated = false, server, closed = false, closing;
  const clients = [], rounds = [];
  const cleanup = { clientSessionsTerminated: 0, serverClosed: false, schemaDropped: false, temporaryDirectoryRemoved: false };
  async function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const errors = [];
      for (const { client, transport } of clients.toReversed()) {
        // SDK close 会先 abort；必须先 DELETE session，再关闭客户端。
        try { await transport.terminateSession(); cleanup.clientSessionsTerminated++; } catch (error) { errors.push(safeError(error)); }
        try { await client.close(); } catch (error) { errors.push(safeError(error)); }
      }
      try { await server?.close(); cleanup.serverClosed = Boolean(server); } catch (error) { errors.push(safeError(error)); }
      try {
        if (schemaCreated) {
          assert.match(schema, /^v1_load_[a-f0-9]{32}$/);
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          cleanup.schemaDropped = true;
        }
      } catch (error) { errors.push(safeError(error)); }
      try { await admin?.end(); } catch (error) { errors.push(safeError(error)); }
      try { await rm(directory, { recursive: true, force: true }); cleanup.temporaryDirectoryRemoved = true; }
      catch (error) { errors.push(safeError(error)); }
      assert.deepEqual(errors, [], `夹具清理失败：${encode(errors)}`);
      return cleanup;
    })();
    return closing;
  }
  try {
    const webRoot = process.env.AGENT_STUDIO_WEBUI_TEST_ROOT
      ? path.resolve(process.env.AGENT_STUDIO_WEBUI_TEST_ROOT) : path.resolve(import.meta.dirname, "../dist/web");
    await access(path.join(webRoot, "index.html"));
    let connectionString;
    if (engine === "postgres") {
      const source = process.env.AGENT_STUDIO_PG_TEST_URL ?? process.env.AGENT_STUDIO_PG_CONNECTION_STRING;
      assert.ok(source, "PostgreSQL 场景必须提供 AGENT_STUDIO_PG_TEST_URL");
      const scoped = new URL(source);
      assert.ok(["postgres:", "postgresql:"].includes(scoped.protocol));
      admin = new PgClient({ connectionString: source });
      await admin.connect();
      // 不复用既有 schema；失败时绝不 DROP 可能属于他人的同名对象。
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      connectionString = scoped.toString();
      const probe = new PgClient({ connectionString });
      try {
        await probe.connect();
        assert.equal((await probe.query("SHOW search_path")).rows[0].search_path, schema);
        assert.equal((await probe.query("SELECT current_schema() AS name")).rows[0].name, schema);
      } finally { await probe.end(); }
    }
    server = await startServer({
      config: { port: 0, dataDir: path.join(directory, "data"), dbDriver: engine, configFile: null,
        heartbeat: { intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS, timeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS },
        ...(connectionString ? { pgConnectionString: connectionString } : {}) },
      logger: createLogger({ write() {} }), webRoot,
    });
    const db = server.database, repos = createRepositories(db);
    if (engine === "postgres") assert.equal((await db.query("SELECT current_schema() AS name"))[0].name, schema);
    const agents = [];
    for (let i = 0; i < 3; i++) agents.push(await repos.agents.create({ displayName: `V1 负载 Agent ${i}`, hostType: "other" }));
    const projects = [];
    for (let p = 0; p < 5; p++) {
      const project = await repos.projects.create({ name: `V1 负载项目 ${p}` });
      const members = [];
      for (const agent of agents) members.push(await repos.members.create({ projectId: project.id, agentId: agent.id,
        kind: "agent", displayName: agent.displayName }));
      const groups = [];
      for (let g = 0; g < 5; g++) groups.push(await repos.groups.create({ projectId: project.id,
        name: `负载群 ${p}-${g}`, participantMemberIds: members.map(member => member.id) }));
      projects.push({ project, members, groups });
    }
    const primary = projects[0], projectId = primary.project.id, groupId = primary.groups[0].id;
    const target = primary.members[2], seededAt = new Date().toISOString();
    let seeded = 0;
    async function growHistory(total) {
      await db.transaction(async tx => {
        for (let start = seeded; start < total; start += 64) {
          const values = [], placeholders = [];
          for (let i = start; i < Math.min(start + 64, total); i++) {
            const group = primary.groups[i % primary.groups.length];
            const text = `历史 ${String(i).padStart(5, "0")}：${i < 1000 ? "普通协作记录，无提及。" : "长正文🙂".repeat(256)}`;
            // 所有作者与群都属于 p0，参与边已真实创建；生产触发器正常递增事实版本。
            values.push(newId(), group.id, target.id, Math.floor(i / primary.groups.length) + 1, text, "[]", seededAt);
            placeholders.push("(?, ?, ?, ?, ?, ?, ?)");
          }
          await tx.exec(`INSERT INTO messages (id, group_id, sender_member_id, seq, body, mentions, created_at) VALUES ${placeholders.join(",")}`, values);
        }
      });
      seeded = total;
    }
    await growHistory(1000);
    if (historyCount === 10000) await growHistory(10000);

    // 全文保留校验刻意在计时区间外；补偿自身不得读取这些历史正文。
    async function historyFingerprint() {
      const hash = createHash("sha256");
      let after = "", count = 0, utf8Bytes = 0;
      while (true) {
        const rows = await db.query("SELECT id, group_id, sender_member_id, seq, body, mentions, created_at FROM messages WHERE sender_member_id = ? AND id > ? ORDER BY id LIMIT 128", [target.id, after]);
        if (rows.length === 0) break;
        for (const row of rows) {
          assert.equal(row.mentions, "[]");
          hash.update(encode([row.id, row.group_id, row.sender_member_id, Number(row.seq), row.body, row.mentions, row.created_at]) + "\n");
          count++; utf8Bytes += Buffer.byteLength(row.body);
        }
        after = rows.at(-1).id;
      }
      return { count, utf8Bytes, sha256: hash.digest("hex") };
    }
    const history = await historyFingerprint();
    assert.equal(history.count, historyCount);
    if (historyCount === 10000) assert.ok(history.utf8Bytes > 2 * 1024 * 1024, "大档必须实际超过多 MiB 正文");
    const originalFacts = await repos.members.retainedFacts(target.id);
    const originalEdges = await db.query("SELECT group_id, joined_at FROM group_participants WHERE member_id = ? ORDER BY group_id", [target.id]);
    assert.equal(originalFacts.length, 6);
    assert.equal(originalFacts.find(fact => fact.kind === "authored-messages").revision, historyCount + 1);
    async function http(method, endpoint, body) {
      const response = await fetch(server.url + endpoint, { method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: encode(body) }) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    }
    async function connect(agentIndex, projectIndex) {
      const client = new Client({ name: `v1-load-sdk-${agentIndex}`, version: "protocol-only" });
      const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
      clients.push({ client, transport });
      await client.connect(transport);
      const call = async (name, args = {}) => payload(await client.callTool({ name, arguments: args }));
      const p = projects[projectIndex];
      const joined = await call("join", { displayName: agents[agentIndex].displayName, hostType: "other",
        projectId: p.project.id, groupId: p.groups[0].id });
      assert.equal(joined.memberId, p.members[agentIndex].id);
      return { call, joined };
    }
    const sender = await connect(0, 0), receiver = await connect(1, 0), third = await connect(2, 1);
    assert.equal(server.mcpSessionCount, 3);
    const settings = await http("GET", "/api/settings");
    assert.equal(settings.status, 200);
    const shape = {
      globalAgents: Number((await db.query("SELECT COUNT(*) AS n FROM agents"))[0].n),
      projects: Number((await db.query("SELECT COUNT(*) AS n FROM projects"))[0].n),
      groups: Number((await db.query("SELECT COUNT(*) AS n FROM groups"))[0].n),
      groupParticipants: Number((await db.query("SELECT COUNT(*) AS n FROM group_participants"))[0].n),
      historicalMessages: Number((await db.query("SELECT COUNT(*) AS n FROM messages"))[0].n),
      groupsPerProject: await db.query("SELECT project_id, COUNT(*) AS n FROM groups GROUP BY project_id ORDER BY project_id"),
      participantsPerGroup: await db.query("SELECT group_id, COUNT(*) AS n FROM group_participants GROUP BY group_id ORDER BY group_id"),
      historyPerGroup: await db.query("SELECT group_id, COUNT(*) AS n FROM messages GROUP BY group_id ORDER BY group_id"),
    };
    assert.deepEqual([shape.globalAgents, shape.projects, shape.groups, shape.groupParticipants, shape.historicalMessages], [3, 5, 25, 75, historyCount]);
    assert.ok(shape.groupsPerProject.every(row => Number(row.n) === 5));
    assert.ok(shape.participantsPerGroup.every(row => Number(row.n) === 3));
    assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM agent_runtime_bindings"))[0].n), 0);
    let previousAuditId = null, rootAuditId = null, revision = target.membershipRevision;
    async function round({ index, token }) {
      assert.equal(closed, false);
      assert.equal(index, rounds.length, "翻转必须按原操作及最新补偿事件顺序执行");
      assert.ok(index >= 0 && index < LIMITS.flips);
      assert.match(token, /^v1-load-[a-z0-9-]{1,100}$/);
      const startedAt = performance.now(), operations = {};
      const observe = async (name, body) => {
        const start = performance.now();
        try { const value = await body(); operations[name] = { startOffsetMs: start - startedAt,
          elapsedMs: performance.now() - start, status: "PASS", value }; return value; }
        catch (error) { operations[name] = { startOffsetMs: start - startedAt,
          elapsedMs: performance.now() - start, status: "FAIL", error: safeError(error) }; throw error; }
      };
      // 四条链同一事件循环同时发起，没有 sleep 或人为解锁后的重测。
      const pending = [
        observe("mutation", () => index === 0
          ? http("DELETE", `/api/projects/${projectId}/members/${target.id}`)
          : http("POST", `/api/projects/${projectId}/audit/${previousAuditId}/revoke`, {})),
        observe("receiveAndAck", async () => {
          const waited = await observe("wait", () => receiver.call("wait_for_messages", { timeoutMs: LIMITS.mcpMs }));
          assert.equal(waited.status, "message", encode(waited));
          assert.equal(waited.messages.length, 1, "历史无提及，接收者只应收到当前测量消息");
          const message = waited.messages[0];
          assert.equal(message.text, token);
          const ack = await observe("ack", () => receiver.call("acknowledge_message", { messageId: message.id }));
          return { messageId: message.id, ack };
        }),
        observe("send", () => sender.call("send_message", { text: token, mentions: [receiver.joined.memberId], clientMessageId: token })),
        observe("heartbeat", () => third.call("heartbeat")),
      ];
      await Promise.allSettled(pending);
      const measuredFinishedAt = performance.now();
      const result = { index, operation: index === 0 ? "remove" : index % 2 ? "undo" : "redo", token,
        status: "PASS", functionalStatus: "PASS", operations, measuredWallMs: measuredFinishedAt - startedAt, limits: LIMITS,
        verificationOutsideMeasuredSpan: true, errors: [] };
      try {
        for (const [name, operation] of Object.entries(operations)) {
          assert.equal(operation.status, "PASS", `${name}: ${encode(operation.error)}`);
          const limitMs = name === "mutation" ? LIMITS.mutationMs : LIMITS.mcpMs;
          if (operation.elapsedMs > limitMs) result.errors.push({ kind: "latency", operation: name,
            elapsedMs: operation.elapsedMs, limitMs, message: `${name} 超出固定门限` });
        }
        assert.equal(operations.mutation.value.status, index === 0 ? 204 : 200, encode(operations.mutation.value));
        const listing = await http("GET", `/api/projects/${projectId}/audit?targetId=${target.id}&limit=20`);
        assert.equal(listing.status, 200);
        const next = index === 0 ? listing.body.entries.find(entry => entry.action === "member.remove") : operations.mutation.value.body.entry;
        assert.ok(next);
        if (index === 0) rootAuditId = next.id;
        else {
          assert.equal(next.detail.reversal.undoesAuditId, previousAuditId);
          assert.equal(next.detail.reversal.rootAuditId, rootAuditId);
          assert.equal(next.detail.reversal.direction, result.operation);
          assert.equal(listing.body.entries.find(entry => entry.id === previousAuditId).reversedByAuditId, next.id);
        }
        previousAuditId = next.id;
        const member = await repos.members.getIncludingRemoved(target.id);
        assert.equal(member.removedAt !== null, index % 2 === 0);
        assert.ok(member.membershipRevision > revision); revision = member.membershipRevision;
        // 墓碑保留参与原边及 joined_at；只有有效参与者视图在移除时隐藏成员。
        const edges = await db.query("SELECT group_id, joined_at FROM group_participants WHERE member_id = ? ORDER BY group_id", [target.id]);
        assert.deepEqual(edges, originalEdges);
        let effectiveEdges = 0;
        for (const group of primary.groups) if ((await repos.groups.participants(group.id)).includes(target.id)) effectiveEdges++;
        assert.equal(effectiveEdges, index % 2 === 0 ? 0 : 5);
        assert.deepEqual(await repos.members.retainedFacts(target.id), originalFacts);
        const retained = await historyFingerprint();
        assert.deepEqual(retained, history, "每次翻转都完整保留作者与历史消息字节");
        assert.equal(await repos.deliveries.get(operations.send.value.messageId, target.id), null,
          "并发测量消息不得改变待移除成员的投递事实");
        const delivery = await repos.deliveries.get(operations.send.value.messageId, receiver.joined.memberId);
        assert.equal(delivery.status, "acked");
        assert.ok(delivery.firstMcpDeliveredAt);
        assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM messages"))[0].n), historyCount + index + 1);
        assert.equal(server.mcpSessionCount, 3);
        result.audit = { id: next.id, rootAuditId, undoesAuditId: next.detail.reversal.undoesAuditId };
        result.member = { removed: member.removedAt !== null, membershipRevision: member.membershipRevision,
          retainedGroupEdges: edges.length, effectiveGroupEdges: effectiveEdges };
        result.retainedHistory = retained;
        result.delivery = { status: delivery.status, firstMcpDeliveredAt: delivery.firstMcpDeliveredAt, ackedAt: delivery.ackedAt };
      } catch (error) { result.functionalStatus = "FAIL"; result.errors.push(safeError(error)); }
      if (result.errors.length) result.status = "FAIL";
      result.verificationMs = performance.now() - measuredFinishedAt;
      rounds.push(result);
      return result;
    }
    return {
      info: { protocol: "boardroom-v1-load/v1", engine, historyCount, url: server.url, projectId, groupId,
        targetMemberId: target.id, senderMemberId: sender.joined.memberId, receiverMemberId: receiver.joined.memberId,
        thirdClientProjectId: projects[1].project.id, schema: engine === "postgres" ? schema : null,
        shape, history, activeMcpConnections: server.mcpSessionCount, limits: LIMITS,
        defaultSettings: { heartbeat: settings.body.settings.heartbeat, antiLoop: settings.body.settings.antiLoop, memory: settings.body.settings.memory },
        loadDistribution: "所有历史均为 p0 待移除成员在本项目五群发送、无提及；其余项目保持真实三参与者群组。",
        modelInvocation: "NOT_RUN", measurements: "生产 HTTP + StreamableHTTP SDK；全文保留读回在计时之外；DOM 由独立 Chromium 观察。" },
      async command(input) {
        if (input.action === "round") return round(input);
        if (input.action === "inspect") return { history: await historyFingerprint(), rounds: rounds.length,
          allRoundsPassed: rounds.every(row => row.status === "PASS"),
          allRoundsFunctionalPassed: rounds.every(row => row.functionalStatus === "PASS"), activeMcpConnections: server.mcpSessionCount,
          totalMessages: Number((await db.query("SELECT COUNT(*) AS n FROM messages"))[0].n) };
        if (input.action === "close") return close();
        throw new Error("unsupported_v1_load_command");
      }, close,
    };
  } catch (error) { await close(); throw error; }
}

async function main() {
  const { values } = parseArgs({ options: { db: { type: "string", default: "sqlite" }, history: { type: "string", default: "1000" } } });
  let fixture, stopping = false;
  const stop = async code => {
    if (stopping) return; stopping = true;
    try { await fixture?.close(); } catch (error) { process.stderr.write(encode(safeError(error)) + "\n"); code = 1; }
    process.exit(code);
  };
  process.on("SIGTERM", () => { void stop(0); });
  process.on("SIGINT", () => { void stop(0); });
  try {
    fixture = await startV1LoadFixture({ engine: values.db, historyCount: Number(values.history) });
    process.stdout.write(encode({ type: "ready", ...fixture.info }) + "\n");
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      let command;
      try {
        command = JSON.parse(line);
        assert.equal(typeof command.id, "string");
        const result = await fixture.command(command);
        process.stdout.write(encode({ id: command.id, ok: true, result }) + "\n");
        if (command.action === "close") break;
      } catch (error) { process.stdout.write(encode({ id: command?.id ?? null, ok: false, error: safeError(error) }) + "\n"); }
    }
    await stop(0);
  } catch (error) { process.stderr.write(encode(safeError(error)) + "\n"); await stop(1); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
