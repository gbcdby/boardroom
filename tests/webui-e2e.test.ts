import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "../src/server/logger.ts";
import { defaultWebRoot, startServer, type RunningServer } from "../src/server/server.ts";

/**
 * T1（#14）WebUI E2E（轻量，非浏览器）。
 *
 * 覆盖边界（诚实说明）：
 * - **不做真实浏览器/Playwright 的 DOM 交互**。本机未引入浏览器驱动，安装成本高。
 * - 覆盖：(1) 构建产物 `dist/web` 可被服务端提供，首页与深链回落 200；
 *   (2) 构建产物包含项目页面的关键 UI 文本（说明页面确实被打包，而不是旧占位页）；
 *   (3) 组件实际调用的**同一组 HTTP 接口**走通完整「创建项目→加成员→指定 manager→
 *   建群组选参与者」流程。前端仅做薄封装，因此接口走通 + 页面已打包 = 表单流程可用。
 * - 未覆盖：Vue 组件内联渲染、点击事件绑定、错误提示的实际 DOM 呈现。
 */

const silentLogger = createLogger({ write: () => {} });

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t1e2e-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function webRootAvailable(): boolean {
  const root = defaultWebRoot();
  return existsSync(path.join(root, "index.html"));
}

async function startTestServer(dir: string): Promise<RunningServer> {
  return startServer({
    config: {
      port: 0,
      dataDir: dir,
      heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
      configFile: null,
    },
    logger: silentLogger,
  });
}

test("构建产物 dist/web 包含项目/群组页面关键 UI 文本", { skip: !webRootAvailable() && "需先 npm run build:web" }, async () => {
  const root = defaultWebRoot();
  // 读取打包后的 JS，断言项目页面的关键文案与元素确实被打进产物（而非旧占位页）。
  const { readdir, readFile } = await import("node:fs/promises");
  const assetsDir = path.join(root, "assets");
  const files = await readdir(assetsDir);
  const jsFiles = files.filter((f) => f.endsWith(".js"));
  assert.ok(jsFiles.length > 0, "应存在打包后的 JS 产物");
  let bundle = "";
  for (const file of jsFiles) bundle += await readFile(path.join(assetsDir, file), "utf8");

  for (const marker of ["创建项目", "添加成员", "设为 manager", "创建群组", "参与者", "顶层 manager"]) {
    assert.ok(bundle.includes(marker), `构建产物应包含文案「${marker}」`);
  }
  // 前端调用的 API 路径确实存在。
  assert.ok(bundle.includes("/api/projects"), "构建产物应调用 /api/projects");
});

test("项目页面路由与深链路可加载（HTTP 200 + 应用挂载点）", { skip: !webRootAvailable() && "需先 npm run build:web" }, async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
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

test("WebUI 表单流程使用的同一组 HTTP 接口走通：项目→成员→manager→群组→参与者", { skip: !webRootAvailable() && "需先 npm run build:web" }, async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
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
      assert.deepEqual(participants.participants.map((m: any) => m.displayName).sort(), ["Alice", "Bob"]);
    } finally {
      await server.close();
    }
  });
});
