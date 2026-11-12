import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, deferred, find, input, json, settle, submit, textOf, withPage } from "./helpers/web-ui.ts";

const project = { id: "project-1", name: "已有项目", archivedAt: null, manager: null };

test("S6 全局项目列表不展开当前项目或长表单，创建失败保留输入并阻止重复提交", async () => {
  let detailReads = 0, mutations = 0;
  const pending = deferred<Response>();
  await withPage("ProjectsView", (url, init) => {
    if (init?.method === "POST") { mutations++; return pending.promise; }
    if (/\/(members|groups|member-statuses)/.test(url)) { detailReads++; return json({ members: [], groups: [], memberStatuses: [] }); }
    return json({ projects: [project] });
  }, async (container, { router }) => {
    assert.equal(detailReads, 0, "全局列表没有隐式展开当前项目的数据");
    assert.equal(find(container, node => node.props["data-testid"] === "project-detail"), undefined);
    assert.equal(find(container, node => node.props["data-testid"] === "new-project-name"), undefined);
    await byTestId(container, "open-create-project").props.onClick(); await settle();
    await input(byTestId(container, "new-project-name"), "新协作项目");
    const first = submit(byTestId(container, "create-project"));
    const second = submit(byTestId(container, "create-project")); await settle();
    assert.equal(mutations, 1);
    assert.equal(byTestId(container, "create-project").props.disabled, true);
    pending.resolve(json({ error: { code: "conflict", message: "名称暂时不可用" } }, 409));
    await Promise.all([first, second]); await settle();
    assert.equal(byTestId(container, "new-project-name").value, "新协作项目");
    assert.match(textOf(byTestId(container, "creation-dialog")), /名称暂时不可用/);
    await byTestId(container, "cancel-create").props.onClick(); await settle();
    assert.match(textOf(byTestId(container, "creation-dialog")), /放弃未保存/);
    find(container, node => node.type === "button" && textOf(node) === "继续编辑")!.props.onClick(); await settle();
    assert.equal(byTestId(container, "new-project-name").value, "新协作项目");
    await byTestId(container, "cancel-create").props.onClick(); await settle();
    await byTestId(container, "discard-create").props.onClick(); await settle();
    assert.equal(find(container, node => node.props["data-testid"] === "creation-dialog"), undefined);
    assert.equal(mutations, 1, "关闭创建不能发送变更");
    await router.push("/projects?create=project&filter=retained#creation-entry"); await settle();
    assert.ok(byTestId(container, "creation-dialog"));
    await byTestId(container, "cancel-create").props.onClick(); await settle();
    assert.equal(router.currentRoute.value.query.create, undefined, "关闭后清理创建指令，侧栏入口可再次打开");
    assert.equal(router.currentRoute.value.query.filter, "retained");
    assert.equal(router.currentRoute.value.hash, "#creation-entry");
    await router.push("/projects?create=project"); await settle();
    assert.ok(byTestId(container, "creation-dialog"));
  }, { path: "/projects" });
});

test("S6 项目创建成功进入刚创建的项目，旧当前项目不能截留页面", async () => {
  let created = false;
  const next = { ...project, id: "project-2", name: "新的项目" };
  await withPage("ProjectsView", (url, init) => {
    if (init?.method === "POST") { assert.equal(JSON.parse(String(init.body)).name, next.name); created = true; return json({ project: next }, 201); }
    if (url.endsWith("/members")) return json({ members: [] });
    if (url.includes("/groups")) return json({ groups: [] });
    if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
    return json({ projects: created ? [project, next] : [project] });
  }, async (container, { router, store }) => {
    await byTestId(container, "open-create-project").props.onClick(); await settle();
    await input(byTestId(container, "new-project-name"), next.name);
    await submit(byTestId(container, "create-project")); await settle();
    assert.equal(router.currentRoute.value.path, "/projects/project-2/overview");
    assert.equal(store.currentProjectId.value, next.id);
    assert.match(textOf(byTestId(container, "project-detail")), /新的项目/);
    assert.equal(find(container, node => node.props["data-testid"] === "creation-dialog"), undefined);
  }, { path: "/projects" });
});

test("S6 项目群组容器保留已归档入口，并在 URL 中保留过滤状态", async () => {
  const group = { id: "group-archived", projectId: project.id, name: "已归档讨论", archivedAt: "2026-11-12T01:00:00Z" };
  await withPage("ProjectsView", url => {
    if (url.endsWith("/members")) return json({ members: [] });
    if (url.endsWith("/participants")) return json({ participants: [] });
    if (url.includes("/groups")) return json({ groups: url.includes("includeArchived=true") ? [group] : [] });
    if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
    return json({ projects: [project] });
  }, async (container, { router }) => {
    assert.equal(byTestId(container, "toggle-archived").props["aria-pressed"], false);
    assert.doesNotMatch(textOf(container), /已归档讨论/);
    await byTestId(container, "toggle-archived").props.onClick(); await settle();
    assert.equal(router.currentRoute.value.query.archived, "1");
    assert.equal(router.currentRoute.value.query.filter, "retained");
    assert.equal(router.currentRoute.value.hash, "#groups-title");
    assert.match(textOf(byTestId(container, "group-list")), /已归档讨论/);
    await byTestId(container, "toggle-archived").props.onClick(); await settle();
    assert.equal(router.currentRoute.value.query.archived, undefined);
    assert.doesNotMatch(textOf(container), /已归档讨论/);
  }, { path: "/projects/project-1/overview?filter=retained#groups-title" });
});
