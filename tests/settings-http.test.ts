import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { ownerActor } from "../src/server/authz/actors.ts";
import { buildEffectiveSettings } from "../src/server/settings.ts";
import { createSettingsApi } from "../src/server/settings/api.ts";
import { createLogger } from "../src/server/logger.ts";
import type { Actor } from "../src/server/authz/authorize.ts";

test("S5-CONFIG-01/03：真实随机端口只读 API 接受本地 owner GET/HEAD，拒绝跨站、非法 Host、Agent 和写入", async () => {
  let reads = 0, readFails = false, actorFails = false;
  let actor: Actor | null = ownerActor();
  const logs: string[] = [];
  const server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? "/", "http://127.0.0.1").pathname).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  const api = createSettingsApi({ getSettings: () => {
    reads++;
    if (readFails) throw new Error("postgres://error-user:error-canary@private-host/data?token=private-query-canary");
    return buildEffectiveSettings({ config: { port: 0, dataDir: "/visible/data", configFile: null,
      heartbeat: { intervalMs: 10000, timeoutMs: 30000 }, pgConnectionString: "postgres://user:secret-canary@db/private?key=query-canary" },
    address: { host: "127.0.0.1", port: (server.address() as AddressInfo).port }, startedAt: "2026-11-11T03:00:00.000Z" });
  }, resolveActor: async (resolution) => {
    assert.equal(resolution.projectId, null);
    if (actorFails) throw new Error("credentials=actor-error-canary");
    return actor;
  },
  logger: createLogger({ write: (line) => { logs.push(line); } }) });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port, base = `http://127.0.0.1:${port}`;
  async function call(method = "GET", headers: OutgoingHttpHeaders = {}, url = "/api/settings") {
    return new Promise<{ status: number; headers: OutgoingHttpHeaders; text: string }>((resolve, reject) => {
      const request = httpRequest(base + url, { method, headers }, response => {
        let text = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, text }));
      });
      request.on("error", reject); request.end();
    });
  }
  try {
    const get = await call("GET", { origin: base, "sec-fetch-site": "same-origin" });
    assert.equal(get.status, 200);
    const data = JSON.parse(get.text).settings;
    assert.equal(data.service.port, port);
    assert.equal(data.service.mcpHttpUrl, `${base}/mcp`);
    assert.equal(data.storage.postgresConfigured, true);
    assert.equal(get.headers["cache-control"], "no-store");
    assert.match(String(get.headers["content-type"]), /application\/json/);
    assert.equal(get.headers["access-control-allow-origin"], undefined);
    assert.doesNotMatch(get.text, /secret-canary|query-canary|pgConnectionString/);
    const head = await call("HEAD");
    assert.equal(head.status, 200); assert.equal(head.text, "");
    assert.equal(head.headers["cache-control"], "no-store");
    const vite = await call("GET", { host: "localhost:5173", origin: "http://localhost:5173" });
    assert.equal(vite.status, 200);
    assert.equal(JSON.parse(vite.text).settings.service.httpBaseUrl, base, "Vite 代理 Host 不改变服务实际地址");
    const beforeDenied = reads;
    for (const headers of [
      { origin: "https://untrusted.example" }, { origin: "null" }, { origin: `${base}/` },
      { origin: `http://localhost:${port}` }, { "sec-fetch-site": "cross-site" },
      { host: "untrusted.example" }, { host: "localhost.evil:4317" }, { host: "127.0.0.1@evil" },
      { host: "127.0.0.1:0" }, { host: "127.0.0.1:65536" }, { host: "localhost:-1" }, { host: "localhost:" },
    ]) {
      const response = await call("GET", headers);
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await call(method);
      assert.equal(response.status, 405, method); assert.equal(response.headers.allow, "GET, HEAD");
    }
    for (const denied of [
      { ...ownerActor(), kind: "agent" as const },
      { ...ownerActor(), role: "top_manager" as const }, ownerActor("project-1"), null,
    ]) {
      actor = denied;
      assert.equal((await call("GET", {}, "/api/settings?actor=owner")).status, 403);
      assert.equal((await call("HEAD")).status, 403);
    }
    assert.equal(reads, beforeDenied, "拒绝请求不读取设置快照");
    assert.equal((await call("GET", {}, "/api/settings/unknown")).status, 404);
    actor = ownerActor(); readFails = true;
    const failedRead = await call();
    assert.equal(failedRead.status, 500);
    assert.deepEqual(JSON.parse(failedRead.text), { error: { code: "internal_error", message: "设置读取失败，请重试。" } });
    actorFails = true;
    const failedActor = await call();
    assert.equal(failedActor.status, 500);
    assert.equal(failedActor.text, failedRead.text);
    assert.doesNotMatch(logs.join(""), /canary|private-host|pgConnectionString|credentials=/);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
