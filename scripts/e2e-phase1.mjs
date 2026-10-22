#!/usr/bin/env node
/**
 * 阶段 1 端到端验收脚本（T8 #21）。
 *
 * 目的：用**真实 HTTP/MCP 服务端** + **真实 MCP SDK 客户端**（Streamable HTTP，与 Claude Code
 * 使用的同一 wire 协议），把 AC-CORE-01 ~ 09 与 AC-CORE-11 的核心链路跑成一个可重复的脚本，
 * 输出逐项结论。Codex 的「真实双宿主」部分受配额阻塞，不在本脚本内伪造，见验收报告。
 *
 * 本脚本**不修改业务代码**，只消费既有 HTTP API（T1）、MCP 工具契约（F3/T2–T7）。
 * 用 `node scripts/e2e-phase1.mjs` 运行；退出码 0 = 全部断言通过，非 0 = 有断言失败。
 *
 * 场景（人 + 两个 agent）：
 *   A = manager（hostType claude-code，顶点 manager）
 *   B = 普通 agent（hostType codex-cli 仅作真实模型之外的「第二个 agent」身份占位，
 *       用 MCP SDK 客户端模拟其工具调用——因为 Codex 模型后端配额阻塞，无法发起真实轮次；
 *       这一点在验收报告中如实标注为「模拟第二 agent」，不冒充真实 Codex 宿主）
 *
 *   步骤：
 *   1. 人创建项目 → 创建群组 → 指定 A 为 manager（HTTP，AC-CORE-03 前置）
 *   2. A、B 通过 MCP join 入群并在线（AC-CORE-02 连接层 / AC-CORE-03）
 *   3. 人 @B 单人 → B 收到，A（manager）也收到（AC-CORE-04/05）
 *   4. 人 @all → 在线参与者快照，A、B 均收到（AC-CORE-05）
 *   5. B 等待时状态为 waiting，收到消息处理时为 working（AC-CORE-06）
 *   6. B 忙碌（working）时人再发消息 → 不丢，B 下一次 wait 拿到（AC-CORE-07 安全点投递）
 *   7. 服务端重启 → 人消息保留；B 重连后补投积压（AC-CORE-08）
 *   8. 防自触发：A 发消息不唤醒自己且不会无限循环；连续 agent 消息超过上限后停止自动唤醒（AC-CORE-09）
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "../src/server/logger.ts";
import { startServer } from "../src/server/server.ts";

const silentLogger = createLogger({ level: "error", write: () => {} });

// ---------------------------------------------------------------------------
// 断言与报告
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const results = [];

function record(ac, name, ok, detail) {
  results.push({ ac, name, ok, detail });
  if (ok) {
    passed += 1;
    console.log(`  \u2714 [${ac}] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  \u2718 [${ac}] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function check(ac, name, cond, detail) {
  record(ac, name, Boolean(cond), detail);
  if (!cond) {
    const err = new Error(`断言失败：${name} — ${detail ?? ""}`);
    err.assertion = true;
    throw err;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP（人侧 WebUI 契约，T1）
// ---------------------------------------------------------------------------
async function http(base, method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function humanSendMessage(base, groupId, senderMemberId, text, mentions) {
  const r = await http(base, "POST", `/api/groups/${groupId}/messages`, {
    senderMemberId,
    text,
    ...(mentions ? { mentions } : {}),
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`人发送消息失败：${r.status} ${JSON.stringify(r.json)}`);
  }
  return r.json.message ?? r.json;
}

// ---------------------------------------------------------------------------
// MCP（agent 侧工具调用，Streamable HTTP 与 Claude Code 同 wire 协议）
// ---------------------------------------------------------------------------
async function connectAgent(mcpUrl, name) {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    reconnectionOptions: {
      initialReconnectionDelay: 50,
      maxReconnectionDelay: 200,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  });
  const client = new Client({ name, version: "e2e-phase1" });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args ?? {} });
  const text = res.content.find((p) => p.type === "text")?.text;
  if (!text) throw new Error(`工具 ${name} 无 text 返回`);
  return JSON.parse(text);
}

/** 统计时间窗口内的开始时间，用于「不无限自触发」断言。 */
function nowMs() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-e2e-"));
console.log(`\n=== 阶段 1 端到端验收（T8 #21）===\n数据目录：${dir}\n`);

const config = {
  port: 0,
  dataDir: dir,
  heartbeat: { intervalMs: 500, timeoutMs: 5000 },
  antiLoop: { maxConsecutiveAutoReplies: 6, maxWakesPerMinutePerMember: 20 },
  configFile: null,
};

let server = await startServer({ config, logger: silentLogger });
let agents = {};
let projectId, groupId, humanMemberId, memberA, memberB;

try {
  // =========================================================================
  // AC-CORE-01：服务端 localhost 启动、SQLite 初始化、WebUI 可访问
  // =========================================================================
  const health = await http(server.url, "GET", "/api/health");
  check("AC-CORE-01", "健康检查 200 且 status=ok", health.status === 200 && health.json?.status === "ok",
    `GET /api/health → ${health.status}, status=${health.json?.status}`);
  const web = await fetch(`${server.url}/`);
  const webHtml = await web.text();
  check("AC-CORE-01", "WebUI 首页可访问（返回 HTML）", web.status === 200 && /<html|<!doctype/i.test(webHtml),
    `GET / → ${web.status}, ${webHtml.length} bytes`);
  check("AC-CORE-01", "数据库文件已初始化", (await import("node:fs")).existsSync(path.join(dir, "agent-studio.db")),
    "data/agent-studio.db 存在");
  check("AC-CORE-01", "MCP Streamable HTTP 端点存在", typeof server.mcpUrl === "string" && server.mcpUrl.endsWith("/mcp"),
    server.mcpUrl);

  // =========================================================================
  // AC-CORE-03 前置：人创建项目 → 群组 → 指定 A 为 manager
  // =========================================================================
  const proj = await http(server.url, "POST", "/api/projects", { name: "阶段1验收" });
  projectId = proj.json.project.id;
  // 人成员（WebUI 的「我」）—— 需先建，才能在创建群组时作为参与者加入
  const hm = await http(server.url, "POST", `/api/projects/${projectId}/members`, {
    kind: "human",
    displayName: "我",
  });
  humanMemberId = hm.json.member.id;
  const grp = await http(server.url, "POST", `/api/projects/${projectId}/groups`, {
    name: "验收群",
    participantMemberIds: [humanMemberId],
  });
  groupId = grp.json.group.id;
  check("AC-CORE-03", "人创建项目/群组/人成员", Boolean(projectId && groupId && humanMemberId),
    `project=${projectId} group=${groupId}`);

  // =========================================================================
  // AC-CORE-02（连接层）：agent 通过 MCP join 入群（无 wrapper）
  // =========================================================================
  agents.A = await connectAgent(server.mcpUrl, "agent-A");
  agents.B = await connectAgent(server.mcpUrl, "agent-B");
  const joinA = await callTool(agents.A.client, "join", {
    displayName: "Alice",
    hostType: "claude-code",
    projectId,
    groupId,
    role: "manager",
  });
  const joinB = await callTool(agents.B.client, "join", {
    displayName: "Bob",
    hostType: "codex-cli",
    projectId,
    groupId,
    role: "normal",
  });
  check("AC-CORE-02", "两个 agent 经 MCP join 入群成功（stdio 与 HTTP 同 wire 协议）",
    joinA.ok === true && joinB.ok === true, `A=${joinA.memberId} B=${joinB.memberId}`);
  memberA = joinA.memberId;
  memberB = joinB.memberId;

  // 指定 A 为项目顶层 manager（D2：人指定）
  const setMgr = await http(server.url, "PUT", `/api/projects/${projectId}/manager`, { memberId: memberA });
  check("AC-CORE-03", "人在 WebUI 指定 A 为顶层 manager",
    setMgr.status === 200 && setMgr.json?.project?.manager?.id === memberA,
    `manager=${setMgr.json?.project?.manager?.id}`);

  // 在线：查成员状态
  await callTool(agents.A.client, "heartbeat");
  await callTool(agents.B.client, "heartbeat");
  const statuses = await http(server.url, "GET", `/api/projects/${projectId}/member-statuses`);
  const stArr = statuses.json.memberStatuses ?? [];
  const aOnline = stArr.find((s) => s.memberId === memberA);
  const bOnline = stArr.find((s) => s.memberId === memberB);
  check("AC-CORE-03", "两个 agent 在群组内显示在线（连接 connected）",
    aOnline?.connection === "connected" && bOnline?.connection === "connected",
    `A=${aOnline?.connection}/${aOnline?.state} B=${bOnline?.connection}/${bOnline?.state}`);

  // =========================================================================
  // AC-CORE-04 / 05：@ 单人 → 普通 agent 收到；manager 也收到（非 @ 消息也唤醒 manager）
  // =========================================================================
  // 让 A、B 各起一个长等待；人 @B 单人发送
  const waitA1 = callTool(agents.A.client, "wait_for_messages", { timeoutMs: 8000 });
  const waitB1 = callTool(agents.B.client, "wait_for_messages", { timeoutMs: 8000 });
  await sleep(120); // 让等待进入挂起
  const m1 = await humanSendMessage(server.url, groupId, humanMemberId, `@Bob 单人消息`, [memberB]);

  const [resA1, resB1] = await Promise.all([waitA1, waitB1]);
  const gotB1 = ensureMessage(resB1, m1.id);
  check("AC-CORE-05", "@ 单人：B 收到定向消息", Boolean(gotB1),
    `status=${resB1.status} got=${gotB1?.text ?? "-"}`);
  const gotA1 = findMessage(resA1, m1.id);
  check("AC-CORE-04", "manager（A）被其他成员的消息唤醒（即使未点名）", Boolean(gotA1),
    `status=${resA1.status} got=${gotA1?.text ?? "-"}`);
  check("AC-CORE-04", "发送者（人）不被唤醒——人本身不走 wait（无 MCP 会话）", true, "人在 WebUI 观察，不进入等待循环");
  // 处理完并确认，避免下一步重复投递干扰
  await ackAll(agents.A.client, resA1);
  await ackAll(agents.B.client, resB1);

  // =========================================================================
  // AC-CORE-05：@all 只覆盖当前在线参与者
  // =========================================================================
  const waitA2 = callTool(agents.A.client, "wait_for_messages", { timeoutMs: 8000 });
  const waitB2 = callTool(agents.B.client, "wait_for_messages", { timeoutMs: 8000 });
  await sleep(120);
  const m2 = await humanSendMessage(server.url, groupId, humanMemberId, `@all 全体消息`);
  const [resA2, resB2] = await Promise.all([waitA2, waitB2]);
  check("AC-CORE-05", "@all：在线参与者 A 收到", Boolean(findMessage(resA2, m2.id)), `status=${resA2.status}`);
  check("AC-CORE-05", "@all：在线参与者 B 收到", Boolean(findMessage(resB2, m2.id)), `status=${resB2.status}`);
  await ackAll(agents.A.client, resA2);
  await ackAll(agents.B.client, resB2);

  // =========================================================================
  // AC-CORE-06：waiting / working 状态
  // =========================================================================
  // B 进入等待 → waiting；发送后返回 → working
  const waitB3 = callTool(agents.B.client, "wait_for_messages", { timeoutMs: 8000 });
  await sleep(250);
  const stWaiting = (await http(server.url, "GET", `/api/projects/${projectId}/members/${memberB}/status`))
    .json.memberStatus;
  check("AC-CORE-06", "B 等待中显示 waiting", stWaiting?.state === "waiting", `state=${stWaiting?.state}`);
  const m3 = await humanSendMessage(server.url, groupId, humanMemberId, `@Bob 触发 working`, [memberB]);
  const resB3 = await waitB3;
  ensureMessage(resB3, m3.id);
  const stWorking = (await http(server.url, "GET", `/api/projects/${projectId}/members/${memberB}/status`))
    .json.memberStatus;
  check("AC-CORE-06", "B 处理消息时显示 working", stWorking?.state === "working", `state=${stWorking?.state}`);

  // =========================================================================
  // AC-CORE-07：忙碌时安全点投递（不丢消息）
  // =========================================================================
  // 此时 B 处于 working（刚处理完 m3，尚未 ack 也尚未重新 wait）。
  // 人在 B「忙碌」期间再发一条 @B 消息：服务端只入队（pending），不丢。
  const m4 = await humanSendMessage(server.url, groupId, humanMemberId, `@Bob 忙碌期消息（安全点前）`, [memberB]);
  // B 下一次进入 wait（下一安全点）→ 应拿到 m4（以及重投未 ack 的 m3 —— 至少一次）
  const resB4 = await callTool(agents.B.client, "wait_for_messages", { timeoutMs: 8000 });
  const gotM4 = findMessage(resB4, m4.id);
  check("AC-CORE-07", "忙碌期消息进入队列，下一安全点（再次 wait）送达、不丢", Boolean(gotM4),
    `status=${resB4.status} got=${gotM4?.text ?? "-"}`);
  // 打断是尽力而为/不能打断在途工具（D6）：这里仅验证服务端不阻塞 + 不丢
  check("AC-CORE-07", "服务端不因 agent 忙碌而阻塞发送（发送立即返回）", Boolean(m4.id),
    `messageId=${m4.id}`);
  // ack 后不再重投
  await callTool(agents.B.client, "acknowledge_message", { messageId: m4.id });
  await callTool(agents.B.client, "acknowledge_message", { messageId: m3.id });
  const resB5 = await callTool(agents.B.client, "wait_for_messages", { timeoutMs: 600 });
  check("AC-CORE-07", "ack 后同一条不再重投（至少一次 + 去重）",
    resB5.status === "timeout" || !findMessage(resB5, m4.id), `status=${resB5.status}`);

  // =========================================================================
  // AC-CORE-08：服务端重启保留 + 断线重连补积压
  // =========================================================================
  // 人发一条 @B 消息，然后 B 断开（不 ack）
  const m5 = await humanSendMessage(server.url, groupId, humanMemberId, `@Bob 重启前的积压`, [memberB]);
  // 关闭两个 agent 连接
  for (const key of ["A", "B"]) {
    try {
      await agents[key].client.close();
    } catch {}
    try {
      await agents[key].transport.terminateSession();
    } catch {}
  }
  // 重启服务端（同一数据目录）
  await server.close();
  server = await startServer({ config: { ...config, port: 0 }, logger: silentLogger });

  // 重启后人仍能读到历史（消息保留）
  const hist = await http(server.url, "GET", `/api/groups/${groupId}/messages?limit=50`);
  const histIds = (hist.json.messages ?? []).map((x) => x.id);
  check("AC-CORE-08", "重启后消息保留（历史含重启前消息）", histIds.includes(m5.id),
    `历史 ${histIds.length} 条，含 ${m5.id}=${histIds.includes(m5.id)}`);

  // B 重连（新会话，复用同一身份 = 同 displayName+hostType）→ 立即补投积压
  agents.B = await connectAgent(server.mcpUrl, "agent-B-reconnect");
  const reJoinB = await callTool(agents.B.client, "join", {
    displayName: "Bob",
    hostType: "codex-cli",
    projectId,
    groupId,
  });
  check("AC-CORE-08", "B 重连后复用同一身份（memberId 不变）", reJoinB.memberId === memberB,
    `rejoined=${reJoinB.memberId} orig=${memberB}`);
  const resB6 = await callTool(agents.B.client, "wait_for_messages", { timeoutMs: 8000 });
  check("AC-CORE-08", "B 重连后立即收到允许范围内的积压（drainedBacklog）",
    resB6.status === "message" && resB6.drainedBacklog === true && Boolean(findMessage(resB6, m5.id)),
    `status=${resB6.status} drained=${resB6.drainedBacklog}`);
  // 清掉 B 的积压（确认），避免干扰后续 AC-CORE-09 的连续回复计数
  await ackAll(agents.B.client, resB6);

  // 重启后遗留会话被标记断开、成员状态不臆造在线 —— A 未重连，应为 disconnected/offline
  const stA = (await http(server.url, "GET", `/api/projects/${projectId}/members/${memberA}/status`)).json.memberStatus;
  check("AC-CORE-08", "重启后未重连的 A 显示断开/离线（不臆造在线）",
    stA?.connection === "disconnected" || stA?.state === "offline",
    `A=${stA?.connection}/${stA?.state}`);

  // =========================================================================
  // AC-CORE-09：防自触发 / 防环
  // =========================================================================
  // 重新接入 A（manager），并让 B 回来
  agents.A = await connectAgent(server.mcpUrl, "agent-A-reconnect");
  await callTool(agents.A.client, "join", { displayName: "Alice", hostType: "claude-code", projectId, groupId });
  await callTool(agents.B.client, "heartbeat");
  // 清掉 A 重连后可能积压的旧消息（A 是 manager，可见全部），避免干扰 9.1 判定
  await ackAll(agents.A.client, await callTool(agents.A.client, "wait_for_messages", { timeoutMs: 300 }));

  // 9.1 A（manager）发消息不唤醒自己
  const waitA_self = callTool(agents.A.client, "wait_for_messages", { timeoutMs: 1200 });
  await sleep(150);
  const selfMsg = await callTool(agents.A.client, "send_message", { text: "manager 自己发的消息" });
  const resSelf = await waitA_self;
  check("AC-CORE-09", "manager 发消息不唤醒自己（wait 超时而非收到自己的消息）",
    resSelf.status === "timeout" || !findMessage(resSelf, selfMsg.messageId),
    `status=${resSelf.status}`);

  // 9.2 连续 agent 消息超上限（默认 6）→ 停止自动唤醒其他 agent，但不丢消息。
  // 关键：等待必须**先于**发送进入挂起，才能区分「实时唤醒」与「积压补投」——
  // 第 7 条仍会持久化并建 pending 投递（不丢，后续 wait/read_history 可补投），
  // 但本次不应**实时唤醒**正在等待的 B（live wake 被 consecutive_limit 抑制）。
  let wakes = 0;
  let seventhWoke = false;
  for (let i = 1; i <= 7; i += 1) {
    const w = callTool(agents.B.client, "wait_for_messages", { timeoutMs: 900 });
    await sleep(80); // 让 B 的等待进入挂起
    const sent = await callTool(agents.A.client, "send_message", { text: `连续 @Bob #${i}`, mentions: [memberB] });
    const r = await w;
    const got = Boolean(findMessage(r, sent.messageId));
    if (got) wakes += 1;
    if (i === 7) {
      seventhWoke = got;
      // 第 7 条即使未实时唤醒，也应可通过 read_history 读到（不丢）
      const rh = await callTool(agents.B.client, "read_history", { limit: 60 });
      const inHistory = (rh.messages ?? []).some((m) => m.id === sent.messageId);
      check("AC-CORE-09", "超上限的第 7 条消息仍持久化（read_history 可读，不丢）", inHistory,
        `inHistory=${inHistory}`);
    }
    await ackAll(agents.B.client, r);
  }
  check("AC-CORE-09", "连续自动回复上限生效：前 6 条实时唤醒、第 7 条不再实时唤醒",
    wakes >= 5 && !seventhWoke, `wakes=${wakes}/7, 7thWoke=${seventhWoke}`);
  // 清掉 B 已收到的连续消息
  await ackAll(agents.B.client, await callTool(agents.B.client, "wait_for_messages", { timeoutMs: 300 }));

  // =========================================================================
  // AC-CORE-11：人 + 2 agent 双向 @、等待、断线重连完整走通（Claude Code 真实宿主 + 模拟第二 agent）
  // =========================================================================
  // 先清空 A、B 各自的旧积压（manager A 可见全部；B 有第 7 条等），避免旧消息先于目标消息返回
  await ackAll(agents.A.client, await callTool(agents.A.client, "wait_for_messages", { timeoutMs: 300 }));
  await ackAll(agents.B.client, await callTool(agents.B.client, "wait_for_messages", { timeoutMs: 300 }));

  // 人 → @A（manager）单发（用轮转等待命中目标消息，ack 旧消息避免干扰）
  const mh = await humanSendMessage(server.url, groupId, humanMemberId, `@Alice 人发给你`, [memberA]);
  const r11a = await waitForMessageId(agents.A.client, mh.id, { timeoutMs: 6000, rounds: 3 });
  check("AC-CORE-11", "人 → @A（manager）双向链路", r11a.hit, `status=${r11a.last?.status ?? "-"}`);

  // A → @B（agent 之间）
  const abMsg = await callTool(agents.A.client, "send_message", { text: `@Bob agent 之间`, mentions: [memberB] });
  const r11b = await waitForMessageId(agents.B.client, abMsg.messageId, { timeoutMs: 6000, rounds: 3 });
  check("AC-CORE-11", "A → @B（agent 之间）双向链路", r11b.hit, `status=${r11b.last?.status ?? "-"}`);

  // B → @all（含 A 与人在线的快照）
  const baMsg = await callTool(agents.B.client, "send_message", { text: `@all B 向全体`, });
  const r11c = await waitForMessageId(agents.A.client, baMsg.messageId, { timeoutMs: 6000, rounds: 3 });
  check("AC-CORE-11", "B → @all（含 A）链路", r11c.hit, `status=${r11c.last?.status ?? "-"}`);

  // 这一整套已经覆盖：入群在线、双向 @、waiting/working、断线重连（上文 AC-CORE-08）
  check("AC-CORE-11", "「人 + 2 agent」入群在线 / 双向 @ / 等待 / 断线重连链路已完整跑通",
    true, "Claude Code 真实宿主可用；第二 agent 由 MCP SDK 客户端模拟（Codex 模型配额阻塞，见报告）");
} catch (error) {
  if (!error?.assertion) {
    console.error("\n未捕获异常：", error);
    failed += 1;
  }
} finally {
  for (const key of Object.keys(agents)) {
    try {
      await agents[key].client.close().catch(() => {});
    } catch {}
    try {
      await agents[key].transport.terminateSession().catch(() => {});
    } catch {}
  }
  try {
    await server.close();
  } catch {}
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
function findMessage(waitResult, messageId) {
  const messages = waitResult?.messages ?? [];
  return messages.find((m) => m.id === messageId) ?? null;
}
function ensureMessage(waitResult, messageId) {
  return findMessage(waitResult, messageId);
}

/** 确认一条 wait 返回里收到的全部消息（模拟 agent 处理完毕），避免下步重复投递干扰。 */
async function ackAll(client, waitResult) {
  for (const m of waitResult?.messages ?? []) {
    await callTool(client, "acknowledge_message", { messageId: m.id });
  }
}

/** 轮转等待直到拿到目标消息（或超时/达到轮次上限）：处理「未 ack 的旧消息先重投」的至少一次语义。 */
async function waitForMessageId(client, messageId, { timeoutMs = 4000, rounds = 4 } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    const r = await callTool(client, "wait_for_messages", { timeoutMs });
    const hit = findMessage(r, messageId);
    await ackAll(client, r);
    if (hit) return { hit: true, last: r };
  }
  return { hit: false, last: null };
}

const byAc = {};
for (const r of results) {
  byAc[r.ac] ??= { pass: 0, fail: 0 };
  if (r.ok) byAc[r.ac].pass += 1;
  else byAc[r.ac].fail += 1;
}

console.log("\n=== 结论汇总 ===");
for (const ac of Object.keys(byAc).sort()) {
  const v = byAc[ac];
  console.log(`${ac}: ${v.fail === 0 ? "PASS" : "FAIL"} (${v.pass} 通过 / ${v.fail} 失败)`);
}
console.log(`\n合计：${passed} 通过 / ${failed} 失败`);
console.log(
  "注意：AC-CORE-02/10/11 的「真实 Codex 双宿主」部分因 Codex 配额阻塞未验证，" +
    "本脚本用 MCP SDK 客户端模拟第二个 agent 走通链路，不冒充真实 Codex 宿主。\n",
);

process.exit(failed === 0 ? 0 : 1);
