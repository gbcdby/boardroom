#!/usr/bin/env node
/**
 * T4（#51）状态看板与跨项目概览端到端验收脚本。
 *
 * 目的：用**真实 HTTP 服务端**把跨项目概览的核心链路跑成一个可重复脚本，输出逐项结论。
 * 本脚本**不修改业务代码**，只消费既有 HTTP API（GET /api/projects 的聚合概览 + 鉴权边界）。
 * 用 `node scripts/e2e-t4.mjs` 运行；退出码 0 = 全部断言通过，非 0 = 有断言失败。
 *
 * 场景：
 *   A. 人（owner，默认主体）创建两个项目，各自加人、建群、发消息；
 *      打开状态看板 → 跨项目概览一次看到全部两个项目的聚合状态
 *      （memberCount / groupCount / messageCount / onlineCount / lastActivityAt / status）；
 *      归档其中一个项目 → 默认概览不再包含它，?includeArchived=true 时带上且 status=archived。
 *   B. 鉴权边界（独立注入主体）：
 *      顶层 manager 只见自己项目（不泄漏另一项目）；
 *      普通成员**看不到**跨项目概览（OVERVIEW-01：连「有哪些项目」都不问到 → 403）。
 *
 * 偏差说明（已写入 unresolved）：原 ticket 措辞「普通成员只见自己项目」与本仓库既有安全边界
 * 冲突——普通成员没有 overview:view 能力点，被拒绝进入跨项目概览（返回 403），而非「只见自己项目」。
 * 本脚本如实验证 403 边界；若产品确实需要「成员看自己项目概览」，需在 F2 能力矩阵放开 overview:view，
 * 那是范围变更，不在本 ticket 内。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/server/logger.ts";
import { startServer } from "../src/server/server.ts";
import { ownerActor } from "../src/server/authz/actors.ts";

const silentLogger = createLogger({ level: "error", write: () => {} });

let passed = 0;
let failed = 0;
const results = [];

function record(ac, name, ok, detail) {
  results.push({ ac, name, ok, detail });
  if (ok) {
    passed += 1;
    console.log(`  ✔ [${ac}] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  ✘ [${ac}] ${name}${detail ? ` — ${detail}` : ""}`);
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

async function http(base, method, p, body, headers) {
  const hasBody = body !== undefined;
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
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

const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-e2e-t4-"));
console.log(`\n=== T4（#51）状态看板与跨项目概览端到端验收 ===\n数据目录：${dir}\n`);

let narrowedProjectId = null;

// 统一配置：非注入服务器留空 authorization（走默认主体解析，人=owner 可正常发消息）。
const config = {
  port: 0,
  dataDir: dir,
  heartbeat: { intervalMs: 500, timeoutMs: 5000 },
  configFile: null,
};

async function startT4Server(authorization) {
  return startServer({
    config,
    logger: silentLogger,
    ...(authorization ? { authorization } : {}),
  });
}

async function createProject(base, name) {
  const r = await http(base, "POST", "/api/projects", { name });
  check("OVERVIEW", `创建项目「${name}」201`, r.status === 201, `status=${r.status}`);
  return r.json.project;
}
async function addHuman(base, projectId, displayName) {
  const r = await http(base, "POST", `/api/projects/${projectId}/members`, { kind: "human", displayName });
  check("OVERVIEW", `添加成员「${displayName}」201`, r.status === 201, `status=${r.status}`);
  return r.json.member;
}
async function createGroup(base, projectId, name, participantMemberIds) {
  const r = await http(base, "POST", `/api/projects/${projectId}/groups`, { name, participantMemberIds });
  check("OVERVIEW", `创建群组「${name}」201`, r.status === 201, `status=${r.status}`);
  return r.json.group;
}
async function sendMessage(base, groupId, senderMemberId, text) {
  const r = await http(base, "POST", `/api/groups/${groupId}/messages`, { senderMemberId, text });
  if (r.status !== 201 && r.status !== 200) throw new Error(`发消息失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.message;
}

try {
  // ---------------------------------------------------------------------------
  // A. owner 跨项目概览聚合（默认主体）
  // ---------------------------------------------------------------------------
  const serverA = await startT4Server(null);
  try {
    const a = await createProject(serverA.url, "甲项目");
    const b = await createProject(serverA.url, "乙项目");

    const humanA = await addHuman(serverA.url, a.id, "Alice");
    const humanB = await addHuman(serverA.url, b.id, "Bob");
    const gA1 = await createGroup(serverA.url, a.id, "甲-群1", [humanA.id]);
    const gA2 = await createGroup(serverA.url, a.id, "甲-群2", [humanA.id]);
    const gB = await createGroup(serverA.url, b.id, "乙-群", [humanB.id]);
    await sendMessage(serverA.url, gA1.id, humanA.id, "甲-第一条");
    await sendMessage(serverA.url, gA2.id, humanA.id, "甲-第二条");
    await sendMessage(serverA.url, gB.id, humanB.id, "乙-第一条");

    const overview = await http(serverA.url, "GET", "/api/projects");
    check("OVERVIEW", "人（owner）跨项目概览 200 且看到两个项目",
      overview.status === 200 && overview.json.projects.length === 2,
      `status=${overview.status}, count=${overview.json.projects?.length}`);

    const viewA = overview.json.projects.find((p) => p.id === a.id);
    const viewB = overview.json.projects.find((p) => p.id === b.id);
    const allHaveMetrics = [viewA, viewB].every((p) =>
      typeof p.memberCount === "number" &&
      typeof p.groupCount === "number" &&
      typeof p.messageCount === "number" &&
      typeof p.onlineCount === "number" &&
      typeof p.status === "string" &&
      "lastActivityAt" in p,
    );
    check("OVERVIEW", "每个项目都带聚合字段（成员/群组/消息/在线/最近活跃/状态）", allHaveMetrics);

    check("OVERVIEW", "甲项目聚合计数正确（1 成员 / 2 群组 / 2 消息）",
      viewA.memberCount === 1 && viewA.groupCount === 2 && viewA.messageCount === 2,
      `member=${viewA.memberCount} group=${viewA.groupCount} msg=${viewA.messageCount}`);
    check("OVERVIEW", "甲项目最近活跃非空", viewA.lastActivityAt !== null);
    check("OVERVIEW", "无人在线时聚合状态为 idle", viewA.status === "idle", `status=${viewA.status}`);
    check("OVERVIEW", "乙项目聚合计数正确（1 成员 / 1 群组 / 1 消息）",
      viewB.memberCount === 1 && viewB.groupCount === 1 && viewB.messageCount === 1);

    // 归档乙项目 → 默认概览排除，?includeArchived=true 时带上且 status=archived
    const archive = await http(serverA.url, "POST", `/api/projects/${b.id}/archive`);
    check("OVERVIEW", "归档乙项目 200", archive.status === 200, `status=${archive.status}`);

    const defaultAfter = await http(serverA.url, "GET", "/api/projects");
    check("OVERVIEW", "默认概览不再包含已归档项目",
      defaultAfter.json.projects.length === 1 && defaultAfter.json.projects[0].id === a.id,
      `count=${defaultAfter.json.projects.length}`);

    const incArchived = await http(serverA.url, "GET", "/api/projects?includeArchived=true");
    const archivedView = incArchived.json.projects.find((p) => p.id === b.id);
    check("OVERVIEW", "includeArchived 时归档项目出现且 status=archived",
      Boolean(archivedView) && archivedView.status === "archived",
      `found=${Boolean(archivedView)} status=${archivedView?.status}`);
  } finally {
    await serverA.close();
  }

  // ---------------------------------------------------------------------------
  // B. 鉴权边界（注入主体；此处只做只读概览，不依赖发消息）
  // ---------------------------------------------------------------------------
  const serverB = await startT4Server({
    resolveHttpActor: ({ request, projectId }) => {
      if (request.headers["x-actor"] === "member") {
        return { actorId: "alice", kind: "human", role: "member", projectId: narrowedProjectId ?? projectId, nodeId: null, subtreeNodeIds: null };
      }
      if (request.headers["x-actor"] === "manager") {
        return { actorId: "mgr", kind: "agent", role: "top_manager", projectId: narrowedProjectId ?? projectId, nodeId: null, subtreeNodeIds: null };
      }
      return ownerActor(projectId);
    },
  });
  try {
    const a = await createProject(serverB.url, "收窄甲");
    const b = await createProject(serverB.url, "收窄乙");
    narrowedProjectId = a.id;
    await addHuman(serverB.url, a.id, "Alice");

    const mgr = await http(serverB.url, "GET", "/api/projects", undefined, { "x-actor": "manager" });
    check("OVERVIEW", "顶层 manager 仅见自己项目（不泄漏乙项目）",
      mgr.status === 200 && (mgr.json.projects ?? []).map((p) => p.id).join(",") === a.id,
      `ids=${(mgr.json.projects ?? []).map((p) => p.id).join(",")}`);

    const member = await http(serverB.url, "GET", "/api/projects", undefined, { "x-actor": "member" });
    check("OVERVIEW", "普通成员被拒（403 forbidden，跨项目概览不在其能力集内）",
      member.status === 403 && member.json?.error?.code === "forbidden",
      `status=${member.status} code=${member.json?.error?.code}`);
    check("OVERVIEW", "被拒响应不泄漏任何项目清单", member.json?.projects === undefined);
  } finally {
    await serverB.close();
  }
} catch (error) {
  if (!error?.assertion) {
    console.error("\n未捕获异常：", error);
    failed += 1;
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n=== T4 结论汇总 ===");
console.log(`合计：${passed} 通过 / ${failed} 失败`);
console.log(
  "注：原 ticket 措辞「普通成员只见自己项目」与本仓库既有安全边界冲突——普通成员无 overview:view，" +
    "被拒（403）而非「只见自己项目」。本脚本如实验证 403 边界；范围变更见 unresolved。\n",
);

process.exit(failed === 0 ? 0 : 1);
