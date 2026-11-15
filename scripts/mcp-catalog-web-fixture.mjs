#!/usr/bin/env node
/** 生产服务 + 临时 SQLite + 真实 loopback MCP。控制命令仅属于本测试进程。 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/server/config.ts";
import { startServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { digestJson } from "../src/server/mcp/capabilities/json.ts";
import { discoveryTestServer } from "../tests/helpers/mcp-discovery-server.ts";

export async function startMcpCatalogBrowserFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-mcp-catalog-web-"));
  const configFile = path.join(directory, "config.json");
  let mode = "pages", server, upstream, closed = false;
  const holds = new Set();
  const tool = (name, changed = false) => ({ name, title: name === "shared_tool" ? "资料检索" : "长名称工具",
    description: "来自工具服务的原文：<img src=x onerror=globalThis.mcpXss=1>。" + "这段不可信说明只显示为文本，不改变权限或执行环境。".repeat(14),
    inputSchema: { type: "object", properties: { query: { type: changed ? "integer" : "string" } } },
    annotations: { readOnlyHint: true, openWorldHint: true } });
  async function start(port) {
    const config = await loadConfig({ cwd: directory, env: { AGENT_STUDIO_CONFIG: configFile, AGENT_STUDIO_DATA_DIR: path.join(directory, "data") } });
    return startServer({ config: { ...config, port }, logger: createLogger({ write() {} }), webRoot: path.resolve(import.meta.dirname, "../dist/web") });
  }
  async function close() {
    if (closed) return; closed = true;
    for (const release of holds) release(); holds.clear();
    try { await server?.close(); } finally { try { await upstream?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
  }
  try {
    await writeFile(configFile, JSON.stringify({ port: 4317, dataDir: "./data" }));
    upstream = await discoveryTestServer({ page: async cursor => {
      if (mode === "hold") await new Promise(resolve => { holds.add(resolve); });
      if (mode === "empty") return { tools: [] };
      if (cursor === "second") return mode === "fail" ? { tools: "invalid-partial-page" }
        : { tools: [tool("long_" + "name_".repeat(35), mode === "schema2")] };
      return { tools: [tool("shared_tool", mode === "schema2")], nextCursor: "second" };
    } });
    server = await start(0);
  } catch (error) { await close(); throw error; }
  return {
    info: { url: server.url, endpoint: upstream.endpoint, directory,
      scope: "production HTTP / temporary SQLite / real initialize + paginated tools/list / no tools/call or runtime loading" },
    async command(action, value = {}) {
      assert.equal(closed, false);
      if (action === "mode") {
        assert(["pages", "schema2", "empty", "fail", "hold"].includes(value.mode)); mode = value.mode;
        if (mode !== "hold") { for (const release of holds) release(); holds.clear(); }
        return { mode };
      }
      if (action === "stats") return { mode, methods: upstream.methods, cursors: upstream.cursors,
        listRequests: upstream.listRequests, deletes: upstream.deletes, pendingPages: holds.size };
      if (action === "restart") { const port = server.port; await server.close(); server = await start(port); return { restarted: true, url: server.url }; }
      if (action === "orphan-attempt") {
        // Explicit crash-record fixture: no process is claimed to have actually crashed.
        // Exact input digest uses the production codec, then the UI recovers/cancels via real public endpoints.
        const { connectionId: id, input } = value;
        assert.equal(typeof id, "string"); assert.equal(typeof input.requestId, "string");
        const attemptId = randomUUID();
        await server.database.transaction(async () => {
          const head = (await server.database.query("SELECT revision,discovery_sequence FROM mcp_connections WHERE id=?", [id]))[0];
          assert.equal(head.revision, input.expectedRevision);
          const sequence = Number(head.discovery_sequence) + 1;
          await server.database.exec(`INSERT INTO mcp_discovery_attempts(id,request_id,input_digest,connection_id,connection_revision,sequence,owner_id,status,cleanup,created_at)
            VALUES(?,?,?,?,?,?,?,'running','remote_unknown',?)`, [attemptId, input.requestId, digestJson({ kind: "discover", id, value: input }), id,
            head.revision, sequence, "fixture-absent-owner", new Date().toISOString()]);
          await server.database.exec("UPDATE mcp_connections SET discovery_sequence=? WHERE id=?", [sequence, id]);
        });
        return { attemptId, fixture: "controlled durable running record without an owned worker" };
      }
      throw new Error("unsupported_mcp_catalog_fixture_command");
    }, close,
  };
}

async function main() {
  let fixture, closing;
  const close = (code = 0) => closing ??= (async () => { await fixture?.close(); })().then(() => process.exit(code), () => process.exit(1));
  process.on("SIGTERM", () => { void close(); }); process.on("SIGINT", () => { void close(); });
  try {
    fixture = await startMcpCatalogBrowserFixture(); process.stdout.write(`${JSON.stringify(fixture.info)}\n`);
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const command = JSON.parse(line);
      process.stdout.write(`${JSON.stringify({ id: command.id, result: await fixture.command(command.action, command.value) })}\n`);
    }
    await close();
  } catch (error) { process.stderr.write(`mcp_catalog_fixture_failed: ${error instanceof Error ? error.stack : "unknown"}\n`); await close(1); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
