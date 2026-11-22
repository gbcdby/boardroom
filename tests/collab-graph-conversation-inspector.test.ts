import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { MessageDto } from "../src/web/src/api/client.ts";
import {
  filterMessagesForScope, toInspectorMessage, useGroupConversationInspector,
  type InspectorMessage, type InspectorScope,
} from "../src/web/src/composables/groupConversationInspector.ts";

const BASE = Date.UTC(2026, 10, 22, 5, 0, 0);
const groupScope = (groupId: string, name: string): InspectorScope => ({
  groupId, groupName: name, memberId: null, memberName: null,
});

function dto(id: string, groupId: string, senderMemberId: string, text: string, offsetMs: number): MessageDto {
  return {
    id, groupId, seq: 1, senderMemberId, senderDisplayName: senderMemberId === "m1" ? "同名代理" : "另一位",
    text, mentions: [], wakeMemberIds: [], visibleMemberIds: [], createdAt: new Date(BASE + offsetMs).toISOString(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("检查器消息四要素来自真实 MessageDto：发送者、正文、逻辑 ID、时间", () => {
  const source = dto("msg-real-1", "g1", "m1", "已持久保存的群消息正文", 1000);
  const mapped = toInspectorMessage(source);
  assert.deepEqual(mapped, {
    id: "msg-real-1",
    groupId: "g1",
    senderMemberId: "m1",
    sender: "同名代理",
    text: "已持久保存的群消息正文",
    createdAt: source.createdAt,
  });
  assert.deepEqual(
    filterMessagesForScope([mapped], groupScope("g1", "甲群")).map((item) => ({
      id: item.id, sender: item.sender, text: item.text, createdAt: item.createdAt,
    })),
    [{
      id: "msg-real-1", sender: "同名代理", text: "已持久保存的群消息正文", createdAt: source.createdAt,
    }],
  );
});

test("同名 Agent 跨群严格隔离：选中群只读本群消息，目标群无消息不兜底", () => {
  const first = toInspectorMessage(dto("msg-g1", "g1", "m1", "甲群正文", 1000));
  const second = toInspectorMessage(dto("msg-g2", "g2", "m1", "乙群正文", 2000));
  assert.deepEqual(filterMessagesForScope([first, second], groupScope("g1", "甲群")).map((m) => m.id), ["msg-g1"]);
  assert.deepEqual(filterMessagesForScope([first, second], groupScope("g2", "乙群")).map((m) => m.id), ["msg-g2"]);
  assert.deepEqual(filterMessagesForScope([first], groupScope("g2", "乙群")), []);
  assert.deepEqual(filterMessagesForScope([first, second], null), []);
});

test("切换群取消旧 scope：迟到响应不覆盖当前选择，关闭后旧响应也不回填", async () => {
  const oldRequest = deferred<readonly InspectorMessage[]>();
  const newRequest = deferred<readonly InspectorMessage[]>();
  const calls: string[] = [];
  const inspector = useGroupConversationInspector((scope) => {
    calls.push(scope.groupId);
    return scope.groupId === "g1" ? oldRequest.promise : newRequest.promise;
  });

  void inspector.select(groupScope("g1", "甲群"));
  await tick();
  assert.equal(inspector.loading.value, true);
  void inspector.select(groupScope("g2", "乙群"));
  await tick();
  assert.deepEqual(calls, ["g1", "g2"]);

  const newer = toInspectorMessage(dto("msg-g2", "g2", "m3", "乙群新选择正文", 2000));
  newRequest.resolve([newer]);
  await tick();
  assert.equal(inspector.loading.value, false);
  assert.deepEqual(inspector.messages.value.map((m) => m.id), ["msg-g2"]);
  assert.equal(inspector.scope.value?.groupId, "g2");

  const older = toInspectorMessage(dto("msg-g1", "g1", "m1", "甲群迟到正文", 1000));
  oldRequest.resolve([older]);
  await tick();
  assert.deepEqual(inspector.messages.value.map((m) => m.id), ["msg-g2"], "旧 scope 的迟到响应不得覆盖新面板");
  assert.equal(inspector.messages.value[0]?.text, "乙群新选择正文");

  const afterClose = deferred<readonly InspectorMessage[]>();
  const closing = useGroupConversationInspector(() => afterClose.promise);
  void closing.select(groupScope("g1", "甲群"));
  await tick();
  closing.clear();
  afterClose.resolve([older]);
  await tick();
  assert.equal(closing.scope.value, null);
  assert.deepEqual(closing.messages.value, []);
});

test("空数据/无权限给出可解释空态，不显示假消息、不跨群回退", async () => {
  const inspector = useGroupConversationInspector(async () => []);
  await inspector.select(groupScope("g-empty", "空群"));
  assert.equal(inspector.loading.value, false);
  assert.equal(inspector.error.value, null);
  assert.deepEqual(inspector.messages.value, []);

  const failed = useGroupConversationInspector(async () => { throw new Error("无权读取该群消息"); });
  await failed.select(groupScope("g-denied", "无权群"));
  assert.deepEqual(failed.messages.value, []);
  assert.match(failed.error.value ?? "", /无权读取/);
});

test("P02 接入真实检查器后不再标示例，P03/P04/P05 示例标注保留且不渲染伪造记录", async () => {
  const home = await readFile(new URL("../src/web/src/views/HomeView.vue", import.meta.url), "utf8");
  const conversationHeading = home.match(/<h2 id="conversation-title"[^>]*>([\s\S]*?)<\/h2>/);
  assert.ok(conversationHeading, "缺少 P02 标题");
  assert.match(conversationHeading![1]!, /仅 Boardroom 消息/);
  assert.doesNotMatch(conversationHeading![1]!, /示例数据/);
  for (const heading of ["taskflow-title", "pending-title", "task-detail-title"]) {
    const match = home.match(new RegExp(`<h2 id="${heading}"[^>]*>([\\s\\S]*?)</h2>`));
    assert.ok(match, `缺少 ${heading} 标题`);
    assert.match(match![1]!, /示例数据/, `${heading} 的示例标注不得移除`);
  }
  for (const path of ["src/web/src/views/CapabilityDemoView.vue", "src/web/src/views/PrototypeView.vue"]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /示例数据/, `${path} 的示例标注不得移除`);
  }
  assert.doesNotMatch(home, /demoConversation/);
  assert.doesNotMatch(home, /2 条新消息/);
  const source = await readFile(new URL("../src/web/src/composables/groupConversationInspector.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /transcript|工具记录|模型思考|toolCall|thinking/);
});
