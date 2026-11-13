import test from "node:test";
import assert from "node:assert/strict";
import { discoverMcpCatalog } from "../src/server/mcp/connections/discovery.ts";
import { discoveryTestServer, discoveryTool } from "./helpers/mcp-discovery-server.ts";

const connection = (endpoint: string) => ({ connectionId: "test", revision: 1, enabled: true,
  transport: { type: "streamable-http", endpoint } });

test("S7-AC01 真实 HTTP initialize/tools/list 完整分页、确定性目录和本次会话清理", async () => {
  const upstream = await discoveryTestServer({ page: cursor => cursor === undefined
    ? { tools: [discoveryTool("z-last")], nextCursor: "second" }
    : { tools: [discoveryTool("a-first")] } });
  try {
    const result = await discoverMcpCatalog(connection(upstream.endpoint));
    assert.equal(result.snapshot.discoveryStatus, "available");
    assert.deepEqual(result.snapshot.tools.map(tool => tool.ref.name), ["a-first", "z-last"]);
    assert.equal(result.pages, 2); assert.equal(result.cleanup, "closed");
    assert.equal(upstream.deletes, 1);
    assert.deepEqual(upstream.methods, ["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    assert.deepEqual(upstream.cursors, [undefined, "second"]);
    assert.equal(JSON.stringify(result).includes(upstream.endpoint), false);
  } finally { await upstream.close(); }
});

test("S7 原始 JSON schema 的特殊键和扩展字段完整参与工具身份，不被 SDK 转换丢弃", async () => {
  const schema = JSON.parse('{"type":"object","__proto__":{"marker":true},"properties":{"__proto__":{"type":"string"}},"x-extension":{"nested":[1,"二"]}}');
  const upstream = await discoveryTestServer({ page: () => ({ tools: [{ name: "schema", inputSchema: schema }] }) });
  try {
    const result = await discoverMcpCatalog(connection(upstream.endpoint));
    assert.deepEqual(result.snapshot.tools[0]!.inputSchema, schema);
  } finally { await upstream.close(); }
});

test("S7 分页失败/循环/同连接重复名不产生半份目录，上游错误正文不泄露", async () => {
  for (const page of [
    (cursor: unknown) => cursor === undefined ? { tools: [discoveryTool("one")], nextCursor: "next" } : { tools: "bad-private-schema" },
    () => ({ tools: [], nextCursor: "repeat" }),
    (cursor: unknown) => cursor === undefined ? { tools: [discoveryTool("same")], nextCursor: "next" } : { tools: [discoveryTool("same")] },
  ]) {
    const upstream = await discoveryTestServer({ page });
    try {
      await assert.rejects(discoverMcpCatalog(connection(upstream.endpoint)), (error: unknown) => {
        assert.match(String(error), /discovery_/); assert.doesNotMatch(String(error), /bad-private|127\.0\.0\.1|schema.*\{/); return true;
      });
      assert.equal(upstream.deletes, 1);
      assert.equal(upstream.methods.includes("tools/call"), false);
    } finally { await upstream.close(); }
  }
});

test("S7 未匹配协议/未声明 tools 能力/不可连明确失败，禁止自动凭据与 stdio 启动", async () => {
  for (const options of [{ protocolVersion: "unsupported-9999" }, { toolsCapability: false }, { status: 503 }]) {
    const upstream = await discoveryTestServer(options);
    try {
      await assert.rejects(discoverMcpCatalog(connection(upstream.endpoint)), (error: unknown) => {
        assert.doesNotMatch(String(error), /private-upstream|unsupported-9999|127\.0\.0\.1/); return true;
      });
      assert.equal(upstream.listRequests, 0);
    } finally { await upstream.close(); }
  }
  const upstream = await discoveryTestServer();
  try {
    await assert.rejects(discoverMcpCatalog({ ...connection(upstream.endpoint), transport: {
      type: "streamable-http", endpoint: upstream.endpoint, credentialRef: "private/reference" } }), /credential_unavailable/);
    await assert.rejects(discoverMcpCatalog({ connectionId: "stdio", revision: 1, enabled: true,
      transport: { type: "stdio", command: "npm", args: ["install", "arbitrary-package"] } }), /launch_unavailable/);
    assert.equal(upstream.methods.length, 0);
  } finally { await upstream.close(); }
  const unavailable = await discoveryTestServer();
  await unavailable.close();
  await assert.rejects(discoverMcpCatalog(connection(unavailable.endpoint)), (error: unknown) => {
    assert.equal((error as { state: string }).state, "connection_failed"); return true;
  });
});

test("S7 对端不支持/未确认远端会话清理时保留真实诊断，不能宣称已关闭", async () => {
  for (const deleteStatus of [405, 500]) {
    const upstream = await discoveryTestServer({ deleteStatus });
    try {
      const result = await discoverMcpCatalog(connection(upstream.endpoint));
      assert.equal(result.cleanup, deleteStatus === 405 ? "remote_unsupported" : "remote_unknown");
      assert.equal(upstream.deletes, 1);
    } finally { await upstream.close(); }
  }
});

test("S7 真实在途取消和总超时保留区别并关闭本次会话", { timeout: 10_000 }, async () => {
  for (const mode of ["cancel", "timeout"] as const) {
    let requested!: () => void;
    const arrived = new Promise<void>(resolve => { requested = resolve; });
    const upstream = await discoveryTestServer({ page: async () => { requested(); await new Promise(resolve => setTimeout(resolve, 350)); return { tools: [] }; } });
    try {
      const abort = new AbortController();
      const result = discoverMcpCatalog(connection(upstream.endpoint), { signal: abort.signal, timeoutMs: mode === "timeout" ? 100 : 2_000 });
      await arrived;
      if (mode === "cancel") abort.abort();
      await assert.rejects(result, mode === "cancel" ? /cancelled/ : /timed_out/);
      assert.equal(upstream.deletes, 1);
    } finally { await upstream.close(); }
  }
});
