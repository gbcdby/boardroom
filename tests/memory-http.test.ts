import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMemoryApi } from "../src/server/memory/api.ts";
import { createLogger } from "../src/server/logger.ts";
import { ownerActor, actorForMember } from "../src/server/authz/actors.ts";
import { memoryFixture, memoryPeople } from "./helpers/memory-fixture.ts";

test("HTTP 记忆入口支持空版本、幂等保存、冲突保留、不可变历史及归档只读", async () => memoryFixture(async (repos, db) => {
  const p = await memoryPeople(repos);
  const api = createMemoryApi({ db, logger: createLogger({ write() {} }), resolveActor: async ({ request, projectId }) =>
    request.headers["x-test-actor"] === "agent" ? actorForMember(p.member) : ownerActor(projectId) });
  const call = caller(api), url = `/api/projects/${p.project.id}/memories`;
  assert.deepEqual((await call("GET", url)).body.documents, []);
  assert.deepEqual((await call("GET", `${url}/shared`)).body, { document: null, version: 0 });
  const input = { expectedVersion: 0, clientMutationId: "human-first", markdown: "协作约定：中文 🌿" };
  const saved = await call("PUT", `${url}/shared`, input);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.document.version, 1);
  assert.equal(saved.body.writtenVersion.markdown, input.markdown);
  assert.equal((await call("PUT", `${url}/shared`, input)).body.duplicate, true);
  const conflict = await call("PUT", `${url}/shared`, { ...input, clientMutationId: "stale", markdown: "我的草稿" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.reason, "memory_version_conflict");
  assert.equal((await call("GET", `${url}/shared`)).body.document.markdown, input.markdown);
  assert.equal((await call("GET", `${url}/shared/versions`)).body.versions.length, 1);
  assert.equal((await call("GET", `${url}/shared/versions/1`)).body.version.markdown, input.markdown);
  assert.deepEqual((await call("GET", `${url}/shared/versions?beforeVersion=1`)).body.versions, []);
  const own = await call("PUT", `${url}/agents/${p.agent.id}`, { ...input, clientMutationId: "project-agent" });
  assert.equal(own.status, 200);
  assert.equal(own.body.document.key.scope, "project-agent");
  await repos.projects.archive(p.project.id);
  assert.equal((await call("GET", `${url}/shared`)).status, 200);
  assert.equal((await call("PUT", `${url}/shared`, { ...input, expectedVersion: 1, clientMutationId: "archived" })).status, 409);
}));

test("HTTP 记忆严格同源、主体/字段/路径隔离；设置只返回有效白名单", async () => memoryFixture(async (repos, db) => {
  const p = await memoryPeople(repos);
  const api = createMemoryApi({ db, logger: createLogger({ write() {} }), resolveActor: async ({ request, projectId }) =>
    request.headers["x-test-actor"] === "agent" ? actorForMember(p.member) : ownerActor(projectId) });
  const call = caller(api), url = `/api/projects/${p.project.id}/memories/shared`;
  const input = { expectedVersion: 0, clientMutationId: "first", markdown: "safe" };
  assert.equal((await call("PUT", url, input, { origin: "https://other.example" })).status, 403);
  assert.equal((await call("GET", url, undefined, { host: "other.example" })).status, 403);
  assert.equal((await call("PUT", url, { ...input, actor: { kind: "human" } })).status, 400);
  assert.equal((await call("PUT", url, input, { "content-type": "text/plain" })).status, 400);
  assert.equal((await call("GET", `${url}/versions?beforeVersion=-1`)).status, 400);
  assert.equal((await call("GET", `${url}/versions?targetAgentId=other`)).status, 400);
  assert.equal((await call("PUT", url, input, { "x-test-actor": "agent" })).status, 403);
  assert.equal((await call("GET", `/api/projects/${p.project.id}/memories/global`)).status, 404);
  assert.equal((await call("POST", `/api/projects/${p.project.id}/memories/agents/${p.agent.id}/summary-requests/fake/begin`, {})).status, 404);
  const settings = await call("GET", "/api/memory-settings");
  assert.equal(settings.status, 200);
  assert.deepEqual(Object.keys(settings.body.settings).sort(), ["maxDocumentBytes", "maxInjectedBytes", "messageThreshold", "summaryAttemptTimeoutMs", "summaryInputBytes"]);
  assert.equal(settings.body.settings.maxDocumentBytes, 32768);
  assert.equal((await call("GET", "/api/memory-settings", undefined, { "x-test-actor": "agent" })).status, 403);
  assert.equal((await call("PUT", "/api/memory-settings", {})).status, 405);
}));

function caller(api: ReturnType<typeof createMemoryApi>) {
  return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method, url, headers: { host: "127.0.0.1:3000", "content-type": "application/json", ...headers },
    }) as IncomingMessage;
    let status = 0, text = "";
    const response = { writeHead(code: number) { status = code; }, end(value?: string) { text = value ?? ""; } } as unknown as ServerResponse;
    assert.equal(await api.handle(request, response, new URL(url, "http://127.0.0.1").pathname), true);
    return { status, body: text ? JSON.parse(text) : null };
  };
}
