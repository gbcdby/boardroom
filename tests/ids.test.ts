import test from "node:test";
import assert from "node:assert/strict";
import { newId, isId, ID_LENGTH } from "../src/server/db/ids.ts";

test("新生成的 ID 是 26 位 Crockford Base32", () => {
  const id = newId();
  assert.equal(id.length, ID_LENGTH);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("新生成的 ID 可被 isId 识别", () => {
  assert.equal(isId(newId()), true);
});

test("isId 拒绝非法输入", () => {
  assert.equal(isId(""), false);
  assert.equal(isId("not-an-id"), false);
  // 长度对但含非法字符（U 不在 Crockford 字母表内）。
  assert.equal(isId("000000000000000000000000U0"), false);
});

test("连续生成的 ID 单调递增（依赖时间戳前缀）", () => {
  const first = newId();
  const second = newId();
  assert.equal(second > first, true, `${second} 应大于 ${first}`);
});

test("同一毫秒内大量生成的 ID 互不相同", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 2000; i += 1) ids.add(newId());
  assert.equal(ids.size, 2000);
});

test("如提供了时钟，ID 前缀反映给定时间戳", () => {
  const fixed = 1_700_000_000_000;
  const id = newId(() => fixed);
  // 前 10 个字符编码 48 位毫秒时间戳；解码回来应等于固定时间。
  assert.equal(decodeTimestamp(id), fixed);
});

/** 测试内独立解码 48 位时间戳，不依赖被测模块的内部实现细节。 */
function decodeTimestamp(id: string): number {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = 0;
  for (const char of id.slice(0, 10)) {
    value = value * 32 + alphabet.indexOf(char);
  }
  return value;
}
