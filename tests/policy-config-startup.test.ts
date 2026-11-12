import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startServer, type RunningServer } from "../src/server/server.ts";
import { loadConfig } from "../src/server/config.ts";
import { createLogger } from "../src/server/logger.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { createPolicyConfiguration } from "../src/server/policy/configuration.ts";
import type { PersistedPolicyDocument } from "../src/shared/policy.ts";
import { identityEngines, identityFixture, identityPgUrl, identitySkip } from "./helpers/identity-fixture.ts";

const access = { actor: ownerActor() };
for (const engine of identityEngines) {
  test(`${engine} S1 正式启动：stdio初始化一次，HTTP/重启读取同一用户版本且不增加初始化审计`, { skip: identitySkip(engine), timeout: 20000 }, async () => {
    const f = await identityFixture(engine);
    let server: RunningServer | undefined;
    const transportEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined
      && !/^(BOARDROOM_|AGENT_STUDIO_)/.test(entry[0])));
    try {
      let pgConnectionString: string | undefined;
      if (engine === "postgres") {
        const schema = (await f.db.query<{ name: string }>("SELECT current_schema() AS name"))[0]!.name;
        const url = new URL(identityPgUrl!); url.searchParams.set("options", `-c search_path=${schema}`); pgConnectionString = url.href;
      }
      const configPath = path.join(f.dir, "policy-config.json");
      await writeFile(configPath, JSON.stringify({ dataDir: f.dir, dbDriver: engine, ...(pgConnectionString ? { pgConnectionString } : {}) }));
      const env = { ...transportEnv, BOARDROOM_HOME: path.join(f.dir, "home"), AGENT_STUDIO_CONFIG: configPath, AGENT_STUDIO_LOG_LEVEL: "error" };
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("src/server/mcp/stdio.ts")], cwd: f.dir, env, stderr: "pipe" });
      const client = new Client({ name: "policy-startup-check", version: "1" });
      try {
        await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
        const tools = await client.listTools();
        assert.ok(tools.tools.length > 0, "stdout仍是可解析的MCP协议");
        assert.equal(tools.tools.some(tool => /policy/i.test(tool.name)), false, "本票不新增MCP策略写工具");
        assert.equal((await f.db.query("SELECT * FROM policy_documents")).length, 1);
        const initial = await createPolicyConfiguration({ repos: f.repos }).getGlobal(access);
        assert.equal(initial.document.revision, 1); assert.equal(initial.createdBy.id, "policy-bootstrap");
      } finally { await client.close(); await transport.close(); }
      const config = { ...await loadConfig({ cwd: f.dir, env }), port: 0 };
      server = await startServer({ config, logger: createLogger({ write() {} }) });
      const url = `${server.url}/api/policies/global`;
      const savedResponse = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, rules: [] }) });
      assert.equal(savedResponse.status, 200);
      const saved = (await savedResponse.json() as { policy: PersistedPolicyDocument }).policy;
      const before = await f.db.query("SELECT * FROM audit_log ORDER BY id");
      await server.close(); server = undefined;
      server = await startServer({ config, logger: createLogger({ write() {} }) });
      const read = await fetch(`${server.url}/api/policies/global`);
      assert.equal(read.status, 200); assert.deepEqual((await read.json() as { policy: PersistedPolicyDocument }).policy, saved);
      assert.deepEqual(await f.db.query("SELECT * FROM audit_log ORDER BY id"), before);
      assert.equal(before.filter(row => row.action === "policy.initialize").length, 1);
      await server.close(); server = undefined;
      await f.db.exec("UPDATE policy_document_versions SET document_json = '{}' WHERE document_id = 'user' AND revision = 2");
      await assert.rejects(startServer({ config, logger: createLogger({ write() {} }) }), /policy_storage_invalid/);
      assert.deepEqual(await f.db.query("SELECT * FROM audit_log ORDER BY id"), before);
    } finally { await server?.close(); await f.close(); }
  });
}
