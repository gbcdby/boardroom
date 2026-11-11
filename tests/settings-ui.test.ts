import test from "node:test";
import assert from "node:assert/strict";
import type { EffectiveSettings } from "../src/shared/settings.ts";
import { byTestId, deferred, find, json, settle, textOf, withPage } from "./helpers/web-ui.ts";

const settings: EffectiveSettings = {
  service: { host: "127.0.0.1", port: 49321, httpBaseUrl: "http://127.0.0.1:49321", websocketUrl: "ws://127.0.0.1:49321/ws", mcpHttpUrl: "http://127.0.0.1:49321/mcp" },
  storage: { driver: "sqlite", dataDirectory: "/visible/中文数据/<script>safe</script>", postgresConfigured: false },
  heartbeat: { intervalMs: 10000, timeoutMs: 30000 },
  antiLoop: { maxConsecutiveAutoReplies: 6, maxWakesPerMinutePerMember: 20 },
  memory: { messageThreshold: 50, maxDocumentBytes: 32768, maxInjectedBytes: 8192, summaryInputBytes: 65536, summaryAttemptTimeoutMs: 900000 },
  configuration: { filePath: null, precedence: ["defaults", "file", "environment"], activation: "restart-required", startedAt: "2026-11-11T03:00:00.000Z" },
};

test("S5-CONFIG-01/04：没有项目也可读取全局设置，展示实际值和生效方式，正文安全且没有保存或重启动作", async () => {
  const requests: { url: string; method: string | undefined }[] = [];
  await withPage("SettingsView", (url, init) => {
    requests.push({ url, method: init?.method });
    if (url.startsWith("/api/projects?")) return json({ projects: [] });
    if (url === "/api/settings") return json({ settings: { ...settings, credentials: "unknown-secret-canary" } });
    throw new Error(`未约定的设置请求 ${url}`);
  }, async (container) => {
    assert.equal(textOf(byTestId(container, "settings-http")), settings.service.httpBaseUrl);
    assert.equal(textOf(byTestId(container, "settings-mcp")), settings.service.mcpHttpUrl);
    assert.equal(textOf(byTestId(container, "settings-websocket")), settings.service.websocketUrl);
    assert.equal(textOf(byTestId(container, "settings-data-directory")), settings.storage.dataDirectory);
    assert.match(textOf(container), /SQLite/);
    assert.match(textOf(container), /未加载配置文件/);
    assert.match(textOf(container), /环境变量优先于配置文件/);
    assert.match(textOf(container), /正常停止服务/);
    assert.match(textOf(container), /重新启动/);
    assert.match(textOf(container), /迁移与校验/);
    assert.match(textOf(container), /32,768/);
    assert.match(textOf(container), /8,192/);
    assert.match(textOf(container), /65,536/);
    assert.match(textOf(container), /15 分钟/);
    assert.ok(byTestId(container, "settings-last-read").props.datetime);
    assert.equal(find(container, (node) => node.type === "script"), undefined);
    assert.equal(find(container, (node) => node.type === "button" && /保存|重启/.test(textOf(node))), undefined);
    assert.equal(find(container, (node) => ["input", "textarea", "select", "form"].includes(node.type)), undefined);
    assert.doesNotMatch(textOf(container), /unknown-secret-canary|选择一个项目/);
    assert.equal(requests.filter((request) => request.url === "/api/settings").length, 1);
    assert.ok(requests.every((request) => request.method === "GET"));
  }, { path: "/settings" });
});

test("S5-CONFIG-04：刷新中只请求一次，失败保留成功值和原读取时间，重试后展示新快照", async () => {
  const pending = deferred<Response>(); let reads = 0;
  await withPage("SettingsView", (url) => {
    if (url.startsWith("/api/projects?")) return json({ projects: [] });
    assert.equal(url, "/api/settings"); reads++;
    return reads === 1 ? json({ settings }) : reads === 2 ? pending.promise : json({ settings: {
      ...settings, storage: { ...settings.storage, driver: "postgres", postgresConfigured: true },
      configuration: { ...settings.configuration, filePath: "/visible/config.json" },
    } });
  }, async (container) => {
    const firstReadAt = byTestId(container, "settings-last-read").props.datetime;
    const first = byTestId(container, "settings-refresh").props.onClick();
    const duplicate = byTestId(container, "settings-refresh").props.onClick();
    await settle();
    assert.equal(reads, 2);
    assert.equal(byTestId(container, "settings-refresh").props.disabled, true);
    pending.resolve(json({ error: { code: "unavailable", message: "服务暂时无法读取设置" } }, 503));
    await Promise.all([first, duplicate]); await settle();
    assert.match(textOf(byTestId(container, "settings-error")), /刷新失败.*上次成功读取/);
    assert.equal(byTestId(container, "settings-last-read").props.datetime, firstReadAt);
    assert.equal(textOf(byTestId(container, "settings-driver")), "SQLite");
    await byTestId(container, "settings-retry").props.onClick(); await settle();
    assert.equal(textOf(byTestId(container, "settings-driver")), "PostgreSQL");
    assert.equal(textOf(byTestId(container, "settings-file")), "/visible/config.json");
    assert.equal(find(container, (node) => node.props["data-testid"] === "settings-error"), undefined);
  }, { path: "/settings" });
});

test("S5-CONFIG-04：初始读取失败不显示虚构默认配置，重试可恢复", async () => {
  const pending = deferred<Response>(); let reads = 0;
  await withPage("SettingsView", (url) => {
    if (url.startsWith("/api/projects?")) return json({ projects: [] });
    reads++; return reads === 1 ? pending.promise : json({ settings });
  }, async (container) => {
    assert.ok(byTestId(container, "settings-loading"));
    assert.equal(find(container, (node) => node.props["data-testid"] === "settings-http"), undefined);
    pending.resolve(json({ error: { code: "unavailable", message: "当前服务不可用" } }, 503));
    await settle();
    assert.match(textOf(byTestId(container, "settings-error")), /当前服务不可用/);
    assert.equal(find(container, (node) => node.props["data-testid"] === "settings-last-read"), undefined);
    assert.doesNotMatch(textOf(container), /上次成功读取的值/);
    await byTestId(container, "settings-retry").props.onClick(); await settle();
    assert.equal(textOf(byTestId(container, "settings-http")), settings.service.httpBaseUrl);
  }, { path: "/settings" });
});

test("S5-CONFIG-04：复制真实 MCP 地址有成功反馈，剪贴板失败给出手动复制提示且不会误报成功", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const pending = deferred<void>(); const copied: string[] = []; let denied = false;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: {
    async writeText(value: string) { if (denied) throw new Error("private-clipboard-error-canary"); copied.push(value); await pending.promise; },
  } } });
  try {
    await withPage("SettingsView", (url) => url.startsWith("/api/projects?") ? json({ projects: [] }) : json({ settings }), async (container) => {
      const first = byTestId(container, "settings-copy-mcp").props.onClick();
      const duplicate = byTestId(container, "settings-copy-mcp").props.onClick();
      await settle();
      assert.deepEqual(copied, [settings.service.mcpHttpUrl]);
      assert.equal(byTestId(container, "settings-copy-mcp").props.disabled, true);
      pending.resolve(); await Promise.all([first, duplicate]); await settle();
      assert.match(textOf(byTestId(container, "settings-copy-notice")), /已复制 MCP HTTP 地址/);
      denied = true;
      await byTestId(container, "settings-copy-mcp").props.onClick(); await settle();
      assert.match(textOf(byTestId(container, "settings-copy-error")), /手动复制/);
      assert.equal(find(container, (node) => node.props["data-testid"] === "settings-copy-notice"), undefined);
      assert.equal(textOf(byTestId(container, "settings-mcp")), settings.service.mcpHttpUrl);
      assert.doesNotMatch(textOf(container), /private-clipboard-error-canary/);
    }, { path: "/settings" });
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
