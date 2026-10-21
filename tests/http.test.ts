import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/server/db/database.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";

const silentLogger = createLogger({ write: () => {} });

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-http-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

/** 写入一个自包含的 WebUI 构建产物目录，避免测试依赖 npm run build 的产物。 */
async function withWebFixture<T>(fn: (webRoot: string) => Promise<T>): Promise<T> {
  return withTempDir(async (base) => {
    const webRoot = path.join(base, "web");
    await mkdir(webRoot, { recursive: true });
    await writeFile(
      path.join(webRoot, "index.html"),
      '<!doctype html><html><body><div id="app"></div></body></html>',
      "utf8",
    );
    return fn(webRoot);
  });
}

test("健康检查返回进程、数据库与迁移版本", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const response = await fetch(`${server.url}/api/health`);

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(body["status"], "ok");
      assert.equal(body["uptimeSeconds"] !== undefined, true);
      assert.deepEqual(body["database"], { status: "ok", writable: true });
      assert.deepEqual(body["migrations"], { version: 0, applied: 0, pending: 0 });
    } finally {
      await server.close();
    }
  });
});

test("健康检查反映已应用的迁移版本", async () => {
  await withTempDir(async (dir) => {
    // 先用一条迁移建表并记录版本，再交给 server 读取。
    const { db } = openDatabase(dir);
    runMigrations(db, [
      { version: 1, name: "probe", up: "CREATE TABLE probe (id INTEGER PRIMARY KEY);" },
    ]);
    db.close();

    const server = await startTestServer(dir);
    try {
      const body = (await (await fetch(`${server.url}/api/health`)).json()) as {
        migrations: { version: number; applied: number; pending: number };
      };
      assert.equal(body.migrations.version, 1);
      assert.equal(body.migrations.applied, 1);
    } finally {
      await server.close();
    }
  });
});

test("健康检查在数据库不可写时报告 degraded", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      server.database.close();
      const response = await fetch(`${server.url}/api/health`);

      assert.equal(response.status, 503);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body["status"], "degraded");
      const database = body["database"] as Record<string, unknown>;
      assert.equal(database["status"], "error");
      assert.equal(typeof database["error"], "string");
    } finally {
      await server.close().catch(() => {});
    }
  });
});

test("未知路径返回 404 JSON", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const response = await fetch(`${server.url}/api/nope`);
      assert.equal(response.status, 404);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body["error"], "not_found");
    } finally {
      await server.close();
    }
  });
});

test("WebUI 静态页可访问，未知前端路由回落到 index.html", async () => {
  await withWebFixture(async (webRoot) => {
    await withTempDir(async (dir) => {
      const server = await startTestServer(dir, webRoot);
      try {
        const root = await fetch(`${server.url}/`);
        assert.equal(root.status, 200);
        assert.match(root.headers.get("content-type") ?? "", /text\/html/);
        const html = await root.text();
        assert.match(html, /<div id="app">/);

        const deepLink = await fetch(`${server.url}/projects/123`);
        assert.equal(deepLink.status, 200);
        assert.match(await deepLink.text(), /<div id="app">/);
      } finally {
        await server.close();
      }
    });
  });
});

test("静态资源不可越出 web 根目录", async () => {
  await withWebFixture(async (webRoot) => {
    await withTempDir(async (dir) => {
      const server = await startTestServer(dir, webRoot);
      try {
        const response = await fetch(`${server.url}/..%2f..%2fpackage.json`);
        assert.equal(response.status === 404 || response.status === 200, true);
        if (response.status === 200) {
          assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        }
      } finally {
        await server.close();
      }
    });
  });
});

test("端口被占用时给出明确错误", async () => {
  await withTempDir(async (dir) => {
    const first = await startTestServer(dir);
    try {
      await assert.rejects(
        startServer({
          config: {
            port: first.port,
            dataDir: path.join(dir, "second"),
            heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
            configFile: null,
          },
          logger: silentLogger,
        }),
        /端口/,
      );
    } finally {
      await first.close();
    }
  });
});

test("只绑定 127.0.0.1", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      assert.equal(server.host, "127.0.0.1");
      assert.equal(server.url.startsWith("http://127.0.0.1:"), true);
    } finally {
      await server.close();
    }
  });
});

test("启动时执行迁移并记录到数据库", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const body = (await (await fetch(`${server.url}/api/health`)).json()) as {
        migrations: { version: number };
      };
      assert.equal(body.migrations.version, 0);
      assert.equal(server.migrationState.version, 0);
      // 生产迁移列表在 F1 为空，因此 pending 为 0。
      assert.equal(migrations.length, 0);
    } finally {
      await server.close();
    }
  });
});
