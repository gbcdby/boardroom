import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, json, settle, submit, textOf, withPage } from "./helpers/web-ui.ts";

test("当前项目可添加另一个项目已有的全局 Runtime，提交同一身份与CAS而不切项目", async () => {
  const projects = [{ id: "project-a", name: "项目 A", archivedAt: null }, { id: "project-b", name: "项目 B", archivedAt: null }];
  const runtime = { id: "runtime-1", name: "共享助手", backend: "claude-code", revision: 7,
    defaults: { model: null, workdir: "/work", tools: null, systemPrompt: "", permissionMode: "auto" } };
  const binding = (projectId: string, groupId: string) => ({ runtime,
    binding: { id: `binding-${projectId}`, projectId, groupId, desiredState: "stopped", revision: 1, advanced: null },
    runner: { state: "stopped", phase: "unknown", permissionObserved: "unknown", exitConfirmed: true, applied: null },
    effective: { config: runtime.defaults }, pendingChanges: false,
    status: { summary: "stopped", reason: null, member: null, capability: null },
  });
  const bindings = [binding("project-a", "group-a")];
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  const globals = globalThis as any;
  const previousDocument = globals.document;
  globals.document = { getElementById: () => null, hidden: false };
  try {
    await withPage("RuntimesView", (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)); writes.push({ url, body });
        const created = binding(body.projectId, body.groupId); bindings.push(created);
        return json({ binding: created }, 201);
      }
      if (url === "/api/runtimes") return json({ runtimes: [{ runtime, bindings }] });
      if (url.includes("/groups")) return json({ groups: [{ id: url.includes("project-a") ? "group-a" : "group-b", name: "协作群", archivedAt: null }] });
      return json({ projects });
    }, async (container, { store }) => {
      assert.equal(store.currentProjectId.value, "project-b");
      await byTestId(container, "runtime-reuse-open").props.onClick();
      await settle();
      assert.match(textOf(byTestId(container, "runtime-existing-select")), /共享助手/);
      await submit(byTestId(container, "runtime-add-binding"));
      await settle();
      assert.deepEqual(writes, [{ url: "/api/runtimes/runtime-1/bindings", body: {
        projectId: "project-b", groupId: "group-b", expectedRuntimeRevision: 7,
      } }]);
      assert.equal(store.currentProjectId.value, "project-b");
      assert.match(textOf(container), /共享助手/);
      assert.match(textOf(byTestId(container, "runtime-notice")), /保持停止/);
    }, { path: "/runtimes?projectId=project-b" });
  } finally { if (previousDocument === undefined) delete globals.document; else globals.document = previousDocument; }
});
