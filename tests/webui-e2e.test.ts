import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";

const execFileAsync = promisify(execFile);

/**
 * T1（#14）WebUI E2E（轻量，非浏览器）。
 *
 * 覆盖边界（诚实说明）：
 * - **不做真实浏览器/Playwright 的 DOM 交互**。本机未引入浏览器驱动，安装成本高。
 * - 覆盖：(1) 构建产物可被服务端提供，首页与深链回落 200；
 *   (2) 构建产物包含项目页面的关键 UI 文本（说明页面确实被打包，而不是旧占位页）；
 *   (3) 组件实际调用的**同一组 HTTP 接口**走通完整「创建项目→加成员→指定 manager→
 *   建群组选参与者」流程。前端仅做薄封装，因此接口走通 + 页面已打包 = 表单流程可用。
 * - 未覆盖：Vue 组件内联渲染、点击事件绑定、错误提示的实际 DOM 呈现。
 *
 * 确定性：产物相关的用例**每次自行构建到本测试的临时目录**（不读仓库里残留的 `dist/web`，
 * 也不写仓库），因此无论工作区有没有 dist、是新是旧，结果都稳定。
 */

const silentLogger = createLogger({ write: () => {} });

/** 仓库根：本文件位于 `<repo>/tests/`。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITE_CONFIG = path.join(REPO_ROOT, "src/web/vite.config.ts");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t1e2e-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 把 WebUI 构建到指定目录（一次性，供该用例专用）。
 * 直接调用项目自带的 vite 与配置，输出到 tmp，不污染仓库 dist/web。
 */
async function buildWebInto(outDir: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules/vite/bin/vite.js"),
      "build",
      "--config",
      VITE_CONFIG,
      "--outDir",
      outDir,
      "--emptyOutDir",
    ],
    { cwd: REPO_ROOT },
  );
}

async function startTestServer(dir: string, webRoot?: string): Promise<RunningServer> {
  return startServer({
    config: {
      port: 0,
      dataDir: dir,
      heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
      configFile: null,
    },
    logger: silentLogger,
    ...(webRoot === undefined ? {} : { webRoot }),
  });
}

test("构建产物包含项目/群组页面关键 UI 文本（自行构建到临时目录）", async () => {
  await withTempDir(async (dir) => {
    const webRoot = path.join(dir, "web");
    await buildWebInto(webRoot);

    // 读取本次构建的 JS，断言项目页面的关键文案与元素确实被打进产物（而非旧占位页）。
    const assetsDir = path.join(webRoot, "assets");
    const files = await readdir(assetsDir);
    const jsFiles = files.filter((f) => f.endsWith(".js"));
    assert.ok(jsFiles.length > 0, "应存在打包后的 JS 产物");
    let bundle = "";
    for (const file of jsFiles) bundle += await readFile(path.join(assetsDir, file), "utf8");

    for (const marker of [
      "创建项目", "添加成员", "设为 manager", "创建群组", "参与者", "顶层 manager", "成员在线状态",
      // T3 群聊界面关键文案
      "群聊", "发送身份", "输入消息", "@all",
      // T1 #48 生命周期界面关键文案（归档 / 恢复 / 二次确认永久删除）
      "归档项目", "恢复项目", "归档群组", "永久删除项目", "确认永久删除", "显示已归档",
    ]) {
      assert.ok(bundle.includes(marker), `构建产物应包含文案「${marker}」`);
    }
    // 前端调用的 API 路径确实存在（含 T2 成员状态端点、T3 消息端点）。
    assert.ok(bundle.includes("/api/projects"), "构建产物应调用 /api/projects");
    assert.ok(bundle.includes("member-statuses"), "构建产物应调用成员状态端点");
    assert.ok(bundle.includes("/messages"), "构建产物应调用群组消息端点");

    // T4 状态看板：页面文案与 WS 事件名/在线离线关键词确实打包进产物。
    for (const marker of ["状态看板", "等待中", "工作中", "在线", "离线", "断线", "心跳超时"]) {
      assert.ok(bundle.includes(marker), `构建产物应包含状态看板文案「${marker}」`);
    }
    assert.ok(bundle.includes("status_update"), "构建产物应含 status_update 实时事件名");
    assert.ok(bundle.includes("presence"), "构建产物应含 presence 在线声明");
  });
});

test("项目页面路由与深链路可加载（服务本次构建的临时产物）", async () => {
  await withTempDir(async (buildDir) => {
    const webRoot = path.join(buildDir, "web");
    await buildWebInto(webRoot);

    await withTempDir(async (dataDir) => {
      const server = await startTestServer(dataDir, webRoot);
      try {
        const root = await fetch(`${server.url}/`);
        assert.equal(root.status, 200);
        assert.match(await root.text(), /<div id="app">/);

        const projects = await fetch(`${server.url}/projects`);
        assert.equal(projects.status, 200);
        assert.match(await projects.text(), /<div id="app">/);
      } finally {
        await server.close();
      }
    });
  });
});

test("WebUI 表单流程使用的同一组 HTTP 接口走通：项目→成员→manager→群组→参与者", async () => {
  await withTempDir(async (buildDir) => {
    const webRoot = path.join(buildDir, "web");
    await buildWebInto(webRoot);

    await withTempDir(async (dataDir) => {
      const server = await startTestServer(dataDir, webRoot);
      const post = async (pathname: string, body: unknown) => {
        const res = await fetch(`${server.url}${pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as any };
      };
      const put = async (pathname: string, body: unknown) => {
        const res = await fetch(`${server.url}${pathname}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as any };
      };
      try {
        const project = (await post("/api/projects", { name: "E2E 项目" })).body.project;
        const alice = (await post(`/api/projects/${project.id}/members`, { kind: "human", displayName: "Alice" }))
          .body.member;
        const bob = (await post(`/api/projects/${project.id}/members`, { kind: "human", displayName: "Bob" })).body
          .member;
        const managerResult = await put(`/api/projects/${project.id}/manager`, { memberId: alice.id });
        assert.equal(managerResult.status, 200);
        assert.equal(managerResult.body.project.manager.id, alice.id);

        const group = (
          await post(`/api/projects/${project.id}/groups`, {
            name: "E2E 群",
            participantMemberIds: [alice.id, bob.id],
          })
        ).body.group;

        const participants = (await (await fetch(`${server.url}/api/groups/${group.id}/participants`)).json()) as any;
        assert.deepEqual(
          participants.participants.map((m: any) => m.displayName).sort(),
          ["Alice", "Bob"],
        );
      } finally {
        await server.close();
      }
    });
  });
});

/**
 * T3（#16）群聊 E2E（轻量，非浏览器）——覆盖边界（诚实说明）：
 * - **不做真实浏览器 DOM 交互**（本机未引入浏览器驱动）。这里走 ChatView 调用的
 *   **同一组 HTTP 接口**：建项目→加成员→建群→发消息（@单人/@all）→读历史，
 *   并校验 `/chat` 路由的深链回落可加载、`/messages` 端点在产物中被调用。
 * - 未覆盖：Vue 组件内联渲染、点击绑定、WebSocket 在浏览器中的实际渲染
 *   （WS 顺序由 `tests/chat-http-ws.test.ts` 在服务端边界验证）。
 */
test("群聊页面路由可加载；ChatView 使用的同一组 HTTP 接口走通发送与历史", async () => {
  await withTempDir(async (buildDir) => {
    const webRoot = path.join(buildDir, "web");
    await buildWebInto(webRoot);

    await withTempDir(async (dataDir) => {
      const server = await startTestServer(dataDir, webRoot);
      const post = async (pathname: string, body: unknown) => {
        const res = await fetch(`${server.url}${pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as any };
      };
      try {
        // /chat 深链回落 index.html。
        const chat = await fetch(`${server.url}/chat`);
        assert.equal(chat.status, 200);
        assert.match(await chat.text(), /<div id="app">/);

        const project = (await post("/api/projects", { name: "聊天项目" })).body.project;
        const alice = (await post(`/api/projects/${project.id}/members`, { kind: "human", displayName: "Alice" })).body
          .member;
        const bob = (await post(`/api/projects/${project.id}/members`, { kind: "human", displayName: "Bob" })).body
          .member;
        const group = (
          await post(`/api/projects/${project.id}/groups`, { name: "聊天群", participantMemberIds: [alice.id, bob.id] })
        ).body.group;

        const m1 = await post(`/api/groups/${group.id}/messages`, {
          senderMemberId: alice.id,
          text: "你好 @Bob",
        });
        assert.equal(m1.status, 201);
        assert.equal(m1.body.message.seq, 1);
        assert.ok(m1.body.message.mentions.includes(bob.id));

        const m2 = await post(`/api/groups/${group.id}/messages`, {
          senderMemberId: alice.id,
          text: "全体 @all",
        });
        assert.equal(m2.status, 201);

        const hist = (await (await fetch(`${server.url}/api/groups/${group.id}/messages`)).json()) as any;
        assert.deepEqual(
          hist.messages.map((m: any) => m.text),
          ["你好 @Bob", "全体 @all"],
        );
        assert.deepEqual(
          hist.messages.map((m: any) => m.seq),
          [1, 2],
        );
      } finally {
        await server.close();
      }
    });
  });
});

test("T5：服务端重启后 WebUI 群聊历史页仍可加载并读到重启前的消息（历史持久化）", async () => {
  await withTempDir(async (buildDir) => {
    const webRoot = path.join(buildDir, "web");
    await buildWebInto(webRoot);

    await withTempDir(async (dataDir) => {
      const post = async (server: RunningServer, pathname: string, body: unknown) => {
        const res = await fetch(`${server.url}${pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return (await res.json()) as any;
      };

      // ---- 第一次进程：建项目/人成员/群组，发两条消息 ----
      let first = await startTestServer(dataDir, webRoot);
      const project = (await post(first, "/api/projects", { name: "持久化聊天" })).project;
      const alice = (await post(first, `/api/projects/${project.id}/members`, { kind: "human", displayName: "Alice" }))
        .member;
      const group = (
        await post(first, `/api/projects/${project.id}/groups`, { name: "群", participantMemberIds: [alice.id] })
      ).group;
      await post(first, `/api/groups/${group.id}/messages`, { senderMemberId: alice.id, text: "第一条" });
      await post(first, `/api/groups/${group.id}/messages`, { senderMemberId: alice.id, text: "第二条" });
      await first.close();

      // ---- 重启：重新启动同一数据目录 + 同一构建产物 ----
      const second = await startTestServer(dataDir, webRoot);
      try {
        // /chat 深链仍可回落加载。
        const chat = await fetch(`${second.url}/chat`);
        assert.equal(chat.status, 200);
        assert.match(await chat.text(), /<div id="app">/);

        // 历史接口返回重启前两条，顺序稳定。
        const hist = (await (await fetch(`${second.url}/api/groups/${group.id}/messages`)).json()) as any;
        assert.deepEqual(
          hist.messages.map((m: any) => m.text),
          ["第一条", "第二条"],
        );
        assert.deepEqual(
          hist.messages.map((m: any) => m.seq),
          [1, 2],
        );
      } finally {
        await second.close();
      }
    });
  });
});
