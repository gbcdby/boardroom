import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  initialConversationSelection, isProjectSwitch, reconcileConversationSelection,
} from "../src/web/src/composables/collabGraphSelection.ts";

const ids = ["g1:m1", "g2:m2"];

test("/?view=conversation 在加载前保留意图且不注入示例选中节点", () => {
  const beforeLoad = initialConversationSelection("conversation");
  assert.deepEqual(beforeLoad, { selectedId: null, pendingDeepLink: true });
  const loading = reconcileConversationSelection(beforeLoad, [], { loading: true, failed: false, projectChanged: false });
  assert.deepEqual(loading, beforeLoad);
  const empty = reconcileConversationSelection(beforeLoad, [], { loading: false, failed: false, projectChanged: false });
  assert.equal(empty.selectedId, null);
  assert.equal(empty.pendingDeepLink, true);
});

test("真实图就绪后兑现深链，选择第一个真实成员", () => {
  const ready = reconcileConversationSelection(
    initialConversationSelection("conversation"), ids,
    { loading: false, failed: false, projectChanged: false },
  );
  assert.deepEqual(ready, { selectedId: "g1:m1", pendingDeepLink: false });
});

test("首次无项目解析到真实项目不算切换，保留深链意图", () => {
  assert.equal(isProjectSwitch(undefined, "p1"), false);
  assert.equal(isProjectSwitch(null, "p1"), false);
  assert.equal(isProjectSwitch("p1", "p2"), true);
  assert.equal(isProjectSwitch("p1", "p1"), false);
});

test("项目切换或读取失败立即清空选中态，不显示上一项目 ID", () => {
  const selected = { selectedId: "g1:m1", pendingDeepLink: false };
  assert.deepEqual(
    reconcileConversationSelection(selected, ids, { loading: false, failed: false, projectChanged: true }),
    { selectedId: null, pendingDeepLink: false },
  );
  assert.deepEqual(
    reconcileConversationSelection(selected, ids, { loading: false, failed: true, projectChanged: false }),
    { selectedId: null, pendingDeepLink: false },
  );
});

test("重读后选中成员已不存在时清空；仍在当前图时保持选择", () => {
  const selected = { selectedId: "g1:m1", pendingDeepLink: false };
  assert.deepEqual(
    reconcileConversationSelection(selected, ["g2:m2"], { loading: false, failed: false, projectChanged: false }),
    { selectedId: null, pendingDeepLink: false },
  );
  assert.deepEqual(
    reconcileConversationSelection(selected, ids, { loading: false, failed: false, projectChanged: false }),
    selected,
  );
});

test("P02 已接为真实检查器，P03 与待我处理仍显式标注示例数据", async () => {
  const source = await readFile(new URL("../src/web/src/views/HomeView.vue", import.meta.url), "utf8");
  const conversation = source.match(/<h2 id="conversation-title"[^>]*>([\s\S]*?)<\/h2>/);
  assert.ok(conversation, "缺少 conversation-title 标题");
  assert.match(conversation![1]!, /仅 Boardroom 消息/);
  assert.doesNotMatch(conversation![1]!, /示例数据/);
  for (const heading of ["taskflow-title", "pending-title", "task-detail-title"]) {
    const match = source.match(new RegExp(`<h2 id="${heading}"[^>]*>([\\s\\S]*?)</h2>`));
    assert.ok(match, `缺少 ${heading} 标题`);
    assert.match(match![1]!, /示例数据/, `${heading} 缺少示例数据标注`);
  }
});
