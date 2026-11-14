import test from "node:test";
import assert from "node:assert/strict";
import { createToastStore } from "../src/web/src/composables/useToast.ts";

test("S6-AC04：相同回执只提示一次，手动关闭与四秒到期移除提示", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const store = createToastStore();
  const first = store.success("成员已移除", "mutation-1");
  assert.equal(store.success("成员已移除", "mutation-1"), first);
  assert.equal(store.items.value.length, 1);
  t.mock.timers.tick(3999); assert.equal(store.items.value.length, 1);
  t.mock.timers.tick(1); assert.equal(store.items.value.length, 0);
  store.success("成员已移除", "mutation-1");
  assert.equal(store.items.value.length, 0, "迟到的相同回执不能再次提示成功");
  const second = store.info("已复制地址"); store.dismiss(second);
  assert.equal(store.items.value.length, 0);
  store.clear();
});

test("S6-AC04：鼠标和焦点分别暂停计时，最多三条展示，排队提示得到完整展示时间", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const store = createToastStore();
  const first = store.success("项目已归档");
  t.mock.timers.tick(1000); store.pause(first, "pointer"); store.pause(first, "focus");
  t.mock.timers.tick(10000); store.resume(first, "pointer"); t.mock.timers.tick(10000);
  assert.equal(store.items.value.length, 1, "焦点还在提示内时，移开鼠标不会恢复消失计时");
  store.resume(first, "focus"); t.mock.timers.tick(2999); assert.equal(store.items.value.length, 1);
  t.mock.timers.tick(1); assert.equal(store.items.value.length, 0);
  const ids = ["甲", "乙", "丙", "丁"].map(name => store.success(`${name}已保存`));
  assert.equal(store.items.value.length, 3); assert.equal(store.queuedCount.value, 1);
  t.mock.timers.tick(2000); store.dismiss(ids[0]!);
  assert.equal(store.queuedCount.value, 0); assert.ok(store.items.value.some(item => item.id === ids[3]));
  t.mock.timers.tick(3999); assert.ok(store.items.value.some(item => item.id === ids[3]));
  t.mock.timers.tick(1); assert.equal(store.items.value.length, 0);
  store.clear();
});
