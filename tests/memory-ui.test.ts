import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, deferred, find, input, json, select, settle, submit, textOf, withPage } from "./helpers/web-ui.ts";

const project = { id: "project-1", name: "记忆体验", archivedAt: null, manager: null };
const settings = { messageThreshold: 50, maxDocumentBytes: 32768, maxInjectedBytes: 8192, summaryInputBytes: 65536, summaryAttemptTimeoutMs: 900000 };
const author = { kind: "human", actorId: "human:local", agentId: null, displayName: "本地用户" };
const createdAt = "2026-11-11T01:00:00Z";
function document(markdown: string, version = 1, agentId: string | null = null) {
  return { id: agentId ? `memory-${agentId}` : "memory-shared", key: { scope: agentId ? "project-agent" : "project", projectId: project.id, agentId }, version, markdown, byteLength: new TextEncoder().encode(markdown).length, updatedAt: createdAt, updatedBy: author, source: "human" };
}
function written(markdown: string, version = 1, agentId: string | null = null) {
  const doc = document(markdown, version, agentId);
  return { document: doc, writtenVersion: { id: `version-${version}`, documentId: doc.id, version, parentVersion: version - 1, markdown, byteLength: doc.byteLength, contentSha256: "a".repeat(64), author, source: "human", clientMutationId: "fixture", summaryRequestId: null, createdAt }, duplicate: false };
}
function summaryRequest(state: string, id = state) {
  return {
    id, projectId: project.id, agentId: "agent-a", recipientMemberId: "member-a", contextGroupId: null, documentId: "memory-agent-a", baseVersion: 1,
    revision: 1, state, trigger: "task_completed", triggerKey: `task-${id}`, taskId: "task-1", completedTaskRevision: 2, messageIds: [], sourceWorkEventId: null, retryOfRequestId: null,
    attemptId: state === "pending" ? null : `attempt-${id}`, beginMutationId: null, resultVersion: state === "completed" ? 2 : null, resultSha256: state === "completed" ? "a".repeat(64) : null,
    error: state === "failed" ? { code: "model_failed", message: "宿主失败 <script>不得执行</script>" } : null,
    evidence: state === "completed" ? { provenance: "agent-declared", host: "synthetic-ui-test", hostVersion: "1", invocationId: "synthetic", contextId: "synthetic", startedAt: createdAt, completedAt: createdAt, promptSha256: "b".repeat(64), outputSha256: "a".repeat(64), evidenceRef: "fixture://ui-only" } : null,
    createdAt, startedAt: state === "pending" ? null : createdAt, finishedAt: ["pending", "running"].includes(state) ? null : createdAt,
  };
}
function read(url: string) {
  if (url.startsWith("/api/projects?")) return json({ projects: [project] });
  if (url === "/api/memory-settings") return json({ settings });
  if (url.endsWith("/org")) return json({ members: [], nodes: [], roles: [] });
  if (url.endsWith("/memories")) return json({ documents: [] });
  if (url.endsWith("/memories/shared")) return json({ document: null, version: 0 });
  if (url.endsWith("/summary-requests")) return json({ requests: [] });
  throw new Error(`未约定的读取 ${url}`);
}

test("记忆：创建共享文档使用版本 0，UTF-8 计数准确，保存中防重复且保留继续输入", async () => {
  const response = deferred<Response>(); const writes: any[] = [];
  await withPage("MemoryView", (url, init) => {
    if (init?.method === "PUT") { writes.push({ url, body: JSON.parse(String(init.body)) }); return response.promise; }
    return read(url);
  }, async (container) => {
    assert.match(textOf(container), /项目共享/);
    await input(byTestId(container, "memory-editor"), "中文🙂");
    assert.match(textOf(byTestId(container, "memory-byte-count")), /10\s*\/\s*32,?768/);
    const first = submit(byTestId(container, "memory-save"));
    const duplicate = submit(byTestId(container, "memory-save"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, "/api/projects/project-1/memories/shared");
    assert.deepEqual(Object.keys(writes[0].body).sort(), ["clientMutationId", "expectedVersion", "markdown"]);
    assert.equal(writes[0].body.expectedVersion, 0);
    assert.equal(writes[0].body.markdown, "中文🙂");
    assert.match(writes[0].body.clientMutationId, /^[a-zA-Z0-9-]+$/);
    await input(byTestId(container, "memory-editor"), "中文🙂\n继续记录 <script>不能执行</script>");
    response.resolve(json(written("中文🙂")));
    await Promise.all([first, duplicate]); await settle();
    assert.match(textOf(byTestId(container, "memory-notice")), /已保存.*版本 1/);
    assert.equal(byTestId(container, "memory-editor").value, "中文🙂\n继续记录 <script>不能执行</script>");
    assert.equal(byTestId(container, "memory-save").props.disabled, false);
    assert.equal(find(container, (node) => node.type === "script"), undefined);
  }, { path: "/projects/project-1/memory" });
});

test("记忆：总结状态只表示持久事实，重试走项目级路径并等待目标 Agent", async () => {
  const response = deferred<Response>(); const writes: any[] = [];
  const requests = ["pending", "running", "completed", "failed", "conflicted", "cancelled"].map((state) => summaryRequest(state));
  await withPage("MemoryView", (url, init) => {
    if (init?.method === "POST") { writes.push({ url, body: JSON.parse(String(init.body)) }); return response.promise; }
    if (url.endsWith("/org")) return json({ members: [{ id: "member-a", projectId: project.id, agentId: "agent-a", kind: "agent", displayName: "林间", status: "active", role: "normal", nodeId: null }], nodes: [], roles: [] });
    if (url.endsWith("/agents/agent-a")) return json({ document: document("已确认的事实", 2, "agent-a"), version: 2 });
    if (url.endsWith("/summary-requests")) return json({ requests });
    return read(url);
  }, async (container) => {
    const panel = byTestId(container, "memory-summary");
    for (const label of ["待处理", "Agent 已接手", "已保存为版本 2", "失败", "版本冲突", "已取消"]) assert.match(textOf(panel), new RegExp(label));
    assert.doesNotMatch(textOf(panel), /正在生成|模型已验证/);
    assert.equal(find(panel, (node) => node.type === "script"), undefined);
    const first = byTestId(container, "memory-summary-retry-failed").props.onClick();
    const duplicate = byTestId(container, "memory-summary-retry-failed").props.onClick();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, "/api/projects/project-1/memories/summary-requests/failed/retry");
    assert.deepEqual(Object.keys(writes[0].body), ["clientMutationId"]);
    response.resolve(json({ request: { ...requests[0], id: "retried", trigger: "retry", retryOfRequestId: "failed", baseVersion: 2 } }, 201));
    await Promise.all([first, duplicate]); await settle();
    assert.match(textOf(byTestId(container, "memory-summary-notice")), /已安排新请求.*待处理/);
    assert.match(textOf(byTestId(container, "memory-summary-request-retried")), /待处理/);
    assert.equal(byTestId(container, "memory-summary-retry-failed").props.disabled, true);
    assert.equal(byTestId(container, "memory-editor").value, "已确认的事实");
  }, { path: "/projects/project-1/memory?scope=members&agentId=agent-a" });
});

test("记忆：保存冲突保留草稿，读取最新正文不改输入，明确接受新基准后才可保存", async () => {
  let head = document("原有共识"); const writes: any[] = [];
  await withPage("MemoryView", (url, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (writes.length === 1) { head = document("同事刚更新的共识", 2); return json({ error: { code: "memory_version_conflict", message: "记忆已被更新" } }, 409); }
      return json(written(body.markdown, 3));
    }
    if (url.endsWith("/memories/shared")) return json({ document: head, version: head.version });
    return read(url);
  }, async (container) => {
    await input(byTestId(container, "memory-editor"), "我的未保存共识");
    await submit(byTestId(container, "memory-save")); await settle();
    assert.equal(byTestId(container, "memory-editor").value, "我的未保存共识");
    assert.match(textOf(byTestId(container, "memory-conflict")), /保留/);
    assert.equal(byTestId(container, "memory-save").props.disabled, true);
    await byTestId(container, "memory-read-latest").props.onClick(); await settle();
    assert.match(textOf(byTestId(container, "memory-latest-text")), /同事刚更新的共识/);
    assert.equal(byTestId(container, "memory-editor").value, "我的未保存共识");
    assert.equal(writes.length, 1);
    assert.equal(byTestId(container, "memory-save").props.disabled, true);
    await byTestId(container, "memory-rebase").props.onClick(); await settle();
    await input(byTestId(container, "memory-editor"), "我的共识 + 同事更新");
    await submit(byTestId(container, "memory-save")); await settle();
    assert.equal(writes[1].expectedVersion, 2);
    assert.notEqual(writes[1].clientMutationId, writes[0].clientMutationId);
    assert.match(textOf(byTestId(container, "memory-notice")), /已保存.*版本 3/);
  }, { path: "/projects/project-1/memory" });
});

test("记忆：成员切换沿用草稿确认，停用及已离开 Agent 的授权文档仍可达", async () => {
  let confirmed = false; const urls: string[] = [];
  const members = [
    { id: "member-a", projectId: project.id, agentId: "agent-a", kind: "agent", displayName: "林间", status: "active", role: "normal", nodeId: "node-a" },
    { id: "member-b", projectId: project.id, agentId: "agent-b", kind: "agent", displayName: "已停用成员", status: "disabled", role: "normal", nodeId: null },
    { id: "human", projectId: project.id, agentId: null, kind: "human", displayName: "人类用户", status: "active", role: "normal", nodeId: null },
  ];
  await withPage("MemoryView", (url) => {
    urls.push(url);
    if (url.endsWith("/org")) return json({ members, nodes: [{ id: "node-a", memberId: "member-a", name: "需求分析" }], roles: [] });
    if (url.endsWith("/memories")) return json({ documents: [document("离开后保留的事实", 4, "agent-removed")] });
    const match = /\/memories\/agents\/(agent-a|agent-b|agent-removed)$/.exec(url);
    if (match) { const doc = document(`${match[1]} 的项目记忆`, 1, match[1]); return json({ document: doc, version: doc.version }); }
    return read(url);
  }, async (container, { router }) => {
    await input(byTestId(container, "memory-editor"), "项目共享草稿");
    await byTestId(container, "memory-scope-members").props.onClick(); await settle();
    assert.equal(router.currentRoute.value.query.agentId, undefined);
    assert.equal(byTestId(container, "memory-editor").value, "项目共享草稿");
    confirmed = true;
    await byTestId(container, "memory-scope-members").props.onClick(); await settle();
    assert.equal(router.currentRoute.value.query.agentId, "agent-a");
    assert.match(textOf(byTestId(container, "memory-agent")), /林间.*需求分析/);
    assert.match(textOf(byTestId(container, "memory-agent")), /已离开项目/);
    assert.doesNotMatch(textOf(byTestId(container, "memory-agent")), /人类用户/);
    await input(byTestId(container, "memory-editor"), "成员 A 的草稿");
    confirmed = false;
    await select(byTestId(container, "memory-agent"), "agent-b"); await settle();
    assert.equal(router.currentRoute.value.query.agentId, "agent-a");
    assert.equal(byTestId(container, "memory-agent").value, "agent-a");
    assert.equal(byTestId(container, "memory-editor").value, "成员 A 的草稿");
    confirmed = true;
    await select(byTestId(container, "memory-agent"), "agent-b"); await settle();
    assert.equal(byTestId(container, "memory-editor").value, "agent-b 的项目记忆");
    assert.equal(byTestId(container, "memory-editor").props.disabled, false, "停用不影响 owner 维护项目记忆");
    await select(byTestId(container, "memory-agent"), "agent-removed"); await settle();
    assert.equal(byTestId(container, "memory-editor").value, "agent-removed 的项目记忆");
    assert.equal(urls.some((url) => url.includes("global")), false);
    assert.doesNotMatch(textOf(container), /查看全局记忆/);
  }, { path: "/memory?projectId=project-1", confirmDiscard: () => confirmed });
});

test("记忆：迟到的成员读取和保存不会覆盖新成员或新项目", async () => {
  const oldRead = deferred<Response>(), oldSave = deferred<Response>(); let confirmed = false;
  const members = ["a", "b"].map((id) => ({ id: `member-${id}`, projectId: project.id, agentId: `agent-${id}`, kind: "agent", displayName: `成员 ${id}`, status: "active", role: "normal", nodeId: null }));
  await withPage("MemoryView", (url, init) => {
    if (url.startsWith("/api/projects?")) return json({ projects: [project, { ...project, id: "project-2", name: "项目乙" }] });
    if (init?.method === "PUT") return oldSave.promise;
    if (url.endsWith("/project-1/org")) return json({ members, nodes: [], roles: [] });
    if (url.endsWith("/agents/agent-a")) return oldRead.promise;
    if (url.endsWith("/agents/agent-b")) return json({ document: document("成员 B 的当前记忆", 2, "agent-b"), version: 2 });
    if (url.endsWith("/project-2/memories/shared")) return json({ document: { ...document("项目乙的独立记忆", 5), key: { scope: "project", projectId: "project-2", agentId: null } }, version: 5 });
    return read(url);
  }, async (container, { store, router }) => {
    await select(byTestId(container, "memory-agent"), "agent-b"); await settle();
    assert.equal(byTestId(container, "memory-editor").value, "成员 B 的当前记忆");
    oldRead.resolve(json({ document: document("成员 A 的迟到正文", 1, "agent-a"), version: 1 })); await settle();
    assert.equal(byTestId(container, "memory-editor").value, "成员 B 的当前记忆");
    await input(byTestId(container, "memory-editor"), "成员 B 的在途保存");
    const saving = submit(byTestId(container, "memory-save"));
    assert.equal(await store.selectProject("project-2"), false);
    assert.equal(router.currentRoute.value.path, "/projects/project-1/memory");
    confirmed = true;
    await store.selectProject("project-2"); await settle();
    assert.equal(byTestId(container, "memory-editor").value, "项目乙的独立记忆");
    oldSave.resolve(json(written("成员 B 的在途保存", 3, "agent-b"))); await saving; await settle();
    assert.equal(byTestId(container, "memory-editor").value, "项目乙的独立记忆");
    assert.equal(textOf(byTestId(container, "memory-version")), "版本 5");
    assert.doesNotMatch(textOf(container), /已保存为版本 3|成员 A 的迟到正文/);
  }, { path: "/projects/project-1/memory?scope=members&agentId=agent-a", confirmDiscard: () => confirmed });
});

test("记忆：保存响应丢失后重试复用同一 mutation，改正文生成新 mutation", async () => {
  const writes: any[] = [];
  await withPage("MemoryView", (url, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (writes.length === 1) return Promise.reject(new TypeError("网络连接中断"));
      return json({ ...written(body.markdown, writes.length - 1), duplicate: writes.length === 2 });
    }
    return read(url);
  }, async (container) => {
    await input(byTestId(container, "memory-editor"), "需要可靠保存");
    await submit(byTestId(container, "memory-save")); await settle();
    assert.equal(byTestId(container, "memory-editor").value, "需要可靠保存");
    assert.match(textOf(byTestId(container, "memory-error")), /草稿已保留/);
    await submit(byTestId(container, "memory-save")); await settle();
    assert.deepEqual(writes[1], writes[0]);
    await input(byTestId(container, "memory-editor"), "第二次明确编辑");
    await submit(byTestId(container, "memory-save")); await settle();
    assert.notEqual(writes[2].clientMutationId, writes[0].clientMutationId);
    assert.equal(writes[2].expectedVersion, 1);
  }, { path: "/projects/project-1/memory" });
});

test("记忆：可读取最近二十条之外的版本，历史是安全文本，恢复需新 CAS 保存", async () => {
  const urls: string[] = []; const writes: any[] = [];
  const versions = Array.from({ length: 35 }, (_, index) => written(`版本 ${35 - index} 的正文`, 35 - index).writtenVersion);
  const old = { ...versions[33]!, markdown: "旧的共识 <img src=x onerror=alert(1)>" };
  await withPage("MemoryView", (url, init) => {
    urls.push(url);
    if (init?.method === "PUT") { const body = JSON.parse(String(init.body)); writes.push(body); return json(written(body.markdown, 36)); }
    if (url.endsWith("/versions/2")) return json({ version: old });
    if (url.endsWith("/versions?beforeVersion=16")) return json({ versions: versions.slice(20) });
    if (url.endsWith("/versions")) return json({ versions: versions.slice(0, 20) });
    if (url.endsWith("/memories/shared")) return json({ document: document("当前正文", 35), version: 35 });
    return read(url);
  }, async (container) => {
    await byTestId(container, "memory-history-open").props.onClick(); await settle();
    await input(byTestId(container, "memory-history-number"), "2");
    await submit(byTestId(container, "memory-history-jump")); await settle();
    assert.ok(urls.includes("/api/projects/project-1/memories/shared/versions/2"));
    assert.match(textOf(byTestId(container, "memory-history-text")), /旧的共识 <img/);
    assert.equal(find(container, (node) => node.type === "img"), undefined);
    await byTestId(container, "memory-history-more").props.onClick(); await settle();
    assert.ok(urls.includes("/api/projects/project-1/memories/shared/versions?beforeVersion=16"));
    await input(byTestId(container, "memory-editor"), "仍未保存的草稿");
    await byTestId(container, "memory-history-use").props.onClick(); await settle();
    assert.equal(byTestId(container, "memory-editor").value, "仍未保存的草稿");
    await byTestId(container, "memory-restore-cancel").props.onClick(); await settle();
    assert.equal(byTestId(container, "memory-editor").value, "仍未保存的草稿");
    await byTestId(container, "memory-history-use").props.onClick(); await settle();
    await byTestId(container, "memory-restore-confirm").props.onClick(); await settle();
    assert.equal(byTestId(container, "memory-editor").value, old.markdown);
    assert.equal(writes.length, 0, "带入历史正文只改变草稿");
    await submit(byTestId(container, "memory-save")); await settle();
    assert.equal(writes[0].expectedVersion, 35);
    assert.equal(writes[0].markdown, old.markdown);
    assert.match(textOf(byTestId(container, "memory-notice")), /已保存为版本 36/);
  }, { path: "/projects/project-1/memory" });
});

test("记忆：字节上限不截断草稿，无效 Unicode 不能提交，空正文可以显式保存", async () => {
  const writes: any[] = [];
  await withPage("MemoryView", (url, init) => {
    if (init?.method === "PUT") { const body = JSON.parse(String(init.body)); writes.push(body); return json(written(body.markdown, 2)); }
    if (url === "/api/memory-settings") return json({ settings: { ...settings, maxDocumentBytes: 1024 } });
    if (url.endsWith("/memories/shared")) return json({ document: document("原有正文"), version: 1 });
    return read(url);
  }, async (container) => {
    await input(byTestId(container, "memory-editor"), "🙂".repeat(256));
    assert.equal(byTestId(container, "memory-save").props.disabled, false);
    await input(byTestId(container, "memory-editor"), "🙂".repeat(256) + "中");
    assert.equal(byTestId(container, "memory-save").props.disabled, true);
    assert.equal(byTestId(container, "memory-editor").value, "🙂".repeat(256) + "中");
    await submit(byTestId(container, "memory-save")); assert.equal(writes.length, 0);
    await input(byTestId(container, "memory-editor"), "\ud800");
    assert.equal(byTestId(container, "memory-save").props.disabled, true);
    assert.match(textOf(container), /无效.*字符/);
    await submit(byTestId(container, "memory-save")); assert.equal(writes.length, 0);
    await input(byTestId(container, "memory-editor"), "");
    await submit(byTestId(container, "memory-save")); await settle();
    assert.equal(writes[0].markdown, "");
    assert.equal(writes[0].expectedVersion, 1);
  }, { path: "/projects/project-1/memory" });
});

test("记忆：归档与失活的执行限制由控件和处理函数共同遵守", async () => {
  for (const archived of [true, false]) {
    let writes = 0;
    await withPage("MemoryView", (url, init) => {
      if (init?.method !== "GET") { writes++; return json(written("不应提交", 2)); }
      if (url.startsWith("/api/projects?")) return json({ projects: [{ ...project, archivedAt: archived ? createdAt : null }] });
      if (url.endsWith("/org")) return json({ members: [{ id: "member-a", projectId: project.id, agentId: "agent-a", kind: "agent", displayName: "林间", status: archived ? "active" : "disabled", role: "normal", nodeId: null }], nodes: [], roles: [] });
      if (url.endsWith("/agents/agent-a")) return json({ document: document("可读记忆", 1, "agent-a"), version: 1 });
      if (url.endsWith("/summary-requests")) return json({ requests: [summaryRequest("failed")] });
      return read(url);
    }, async (container) => {
      assert.equal(byTestId(container, "memory-editor").value, "可读记忆");
      assert.equal(byTestId(container, "memory-editor").props.disabled, archived);
      assert.equal(byTestId(container, "memory-summary-retry-failed").props.disabled, true);
      await byTestId(container, "memory-summary-retry-failed").props.onClick();
      if (archived) {
        assert.match(textOf(container), /项目已归档/);
        await input(byTestId(container, "memory-editor"), "处理函数也必须只读");
        await submit(byTestId(container, "memory-save"));
      } else assert.match(textOf(container), /当前无法执行总结/);
      assert.equal(writes, 0);
    }, { path: "/projects/project-1/memory?scope=members&agentId=agent-a" });
  }
});

test("记忆：目录和正文读取失败有独立重试，失败读取不会开放保存", async () => {
  let directoryAvailable = false, bodyAvailable = false;
  await withPage("MemoryView", (url) => {
    if (url.endsWith("/org") && !directoryAvailable) return json({ error: { code: "read_failed", message: "目录暂不可用" } }, 503);
    if (url.endsWith("/memories/shared")) return bodyAvailable ? json({ document: document("读取恢复的共识"), version: 1 }) : json({ error: { code: "read_failed", message: "正文暂不可用" } }, 503);
    return read(url);
  }, async (container) => {
    assert.match(textOf(container), /目录暂不可用/);
    assert.equal(find(container, (node) => node.props["data-testid"] === "memory-editor"), undefined);
    directoryAvailable = true;
    await byTestId(container, "memory-retry-directory").props.onClick(); await settle();
    assert.match(textOf(byTestId(container, "memory-error")), /正文暂不可用/);
    assert.equal(byTestId(container, "memory-save").props.disabled, true);
    bodyAvailable = true;
    const retry = find(container, (node) => node.type === "button" && textOf(node) === "重新读取（保留草稿）");
    assert.ok(retry); await retry.props.onClick(); await settle();
    assert.equal(byTestId(container, "memory-editor").value, "读取恢复的共识");
    assert.equal(byTestId(container, "memory-editor").props.disabled, false);
  }, { path: "/projects/project-1/memory" });
});

test("记忆：旧目标的历史与总结列表迟到，不出现在新目标面板", async () => {
  const oldHistory = deferred<Response>(), oldSummary = deferred<Response>();
  const members = ["a", "b"].map((id) => ({ id: `member-${id}`, projectId: project.id, agentId: `agent-${id}`, kind: "agent", displayName: `成员 ${id}`, status: "active", role: "normal", nodeId: null }));
  await withPage("MemoryView", (url) => {
    if (url.endsWith("/org")) return json({ members, nodes: [], roles: [] });
    if (url.endsWith("/agents/agent-a/versions")) return oldHistory.promise;
    if (url.endsWith("/agents/agent-a/summary-requests")) return oldSummary.promise;
    if (url.endsWith("/agents/agent-b/summary-requests")) return json({ requests: [{ ...summaryRequest("pending", "current-target"), agentId: "agent-b" }] });
    const match = /\/agents\/(agent-a|agent-b)$/.exec(url);
    if (match) return json({ document: document(`${match[1]} 的正文`, 1, match[1]), version: 1 });
    return read(url);
  }, async (container) => {
    const readingHistory = byTestId(container, "memory-history-open").props.onClick();
    await select(byTestId(container, "memory-agent"), "agent-b"); await settle();
    expectCurrent();
    oldHistory.resolve(json({ versions: [{ ...written("旧目标的历史正文").writtenVersion, author: { ...author, displayName: "旧目标的历史作者" } }] }));
    oldSummary.resolve(json({ requests: [{ ...summaryRequest("failed", "old-target"), error: { code: "old", message: "旧目标迟到的失败" } }] }));
    await readingHistory; await settle();
    expectCurrent();
    assert.doesNotMatch(textOf(container), /旧目标的历史作者|旧目标迟到的失败/);
    function expectCurrent() {
      assert.equal(byTestId(container, "memory-editor").value, "agent-b 的正文");
      assert.match(textOf(byTestId(container, "memory-summary-request-current-target")), /待处理/);
      assert.equal(byTestId(container, "memory-history-open").props["aria-expanded"], false);
    }
  }, { path: "/projects/project-1/memory?scope=members&agentId=agent-a" });
});
