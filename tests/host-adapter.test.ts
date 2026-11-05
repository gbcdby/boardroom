import test from "node:test";
import assert from "node:assert/strict";
import {
  UNKNOWN_HOST_ID,
  UNKNOWN_ADAPTER,
  DEFAULT_HOST_CAPABILITIES,
  KNOWN_HOST_TYPES,
  defineHostAdapter,
  createHostAdapterRegistry,
  defaultRegistry,
  getAdapter,
  isRegistered,
  registerAdapter,
  unregisterAdapter,
  listAdapterIds,
  type HostAdapter,
  type HostType,
} from "../src/server/mcp/adapters/index.ts";

/**
 * #56（F1）宿主适配层注册表骨架测试。
 *
 * seam：registry（getAdapter / isRegistered / registerAdapter / unregisterAdapter /
 * listAdapterIds）+ HostType 兼容性 + 能力默认值（NFR-HOST-02）。
 *
 * 非目标（属于其他票）：四个具体宿主模块（T1 #57）、core 运行期硬编码收敛（T2 #58）、
 * dsh 身份迁移（T3 #59）、证据文档（T4 #60）。本测试不触碰 join / interrupt 运行期逻辑。
 */

test("内建 unknown 适配器是默认回退，且 'other' 被视为已注册", () => {
  // 未注册、非 'other' 的宿主回退到 unknown 适配器。
  // 注意：#57（T1）已把 dsh 注册为正式宿主模块，故此处改用其它未注册 id 作为示例。
  const UNREGISTERED = "unregistered-host" as HostType;
  const fallback = getAdapter(UNREGISTERED);
  assert.equal(fallback.id, UNKNOWN_HOST_ID);
  assert.equal(fallback, UNKNOWN_ADAPTER);
  // 该未注册宿主本身不被认为是已注册（除 'other' 这一内建回退外）。
  assert.equal(isRegistered(UNREGISTERED), false);

  // 'other' 是内建回退，视为已注册；getAdapter('other') 返回的就是 unknown 适配器。
  assert.equal(isRegistered(UNKNOWN_HOST_ID), true);
  assert.equal(getAdapter(UNKNOWN_HOST_ID), UNKNOWN_ADAPTER);
});

test("注册临时适配器后 isRegistered/getAdapter 命中，卸载后回退到 unknown", () => {
  const temp: HostAdapter = defineHostAdapter({
    id: "test-host" as HostType,
    label: "测试宿主",
    transports: ["mcp"],
    capabilities: { interrupt: "accepted", wakeIdle: true, reconnect: "supported" },
    evidence: { source: "unit-test", verified: true },
  });

  try {
    registerAdapter(temp);
    assert.equal(isRegistered("test-host" as HostType), true);
    assert.equal(getAdapter("test-host" as HostType), temp);
    assert.ok(listAdapterIds().includes("test-host" as HostType));
  } finally {
    const removed = unregisterAdapter("test-host" as HostType);
    assert.equal(removed, true);
  }

  // 卸载后：不再是已注册，回退到 unknown。
  assert.equal(isRegistered("test-host" as HostType), false);
  assert.equal(getAdapter("test-host" as HostType), UNKNOWN_ADAPTER);
  assert.equal(unregisterAdapter("test-host" as HostType), false); // 已不存在。
});

test("unknown 回退不可被卸载（内建保护）", () => {
  assert.equal(unregisterAdapter(UNKNOWN_HOST_ID), false);
  assert.equal(isRegistered(UNKNOWN_HOST_ID), true);
});

test("独立注册表实例互不污染（默认注册表不受新建实例影响）", () => {
  const reg = createHostAdapterRegistry();
  const custom: HostAdapter = defineHostAdapter({
    id: "custom-host" as HostType,
    label: "自定义宿主",
  });
  reg.registerAdapter(custom);
  assert.equal(reg.isRegistered("custom-host" as HostType), true);
  assert.equal(reg.getAdapter("custom-host" as HostType), custom);
  // 默认全局注册表不受该独立实例影响。
  assert.equal(isRegistered("custom-host" as HostType), false);
  assert.equal(defaultRegistry.isRegistered("custom-host" as HostType), false);
});

test("能力默认值遵循 NFR-HOST-02：未声明即不承诺", () => {
  // 内建 unknown 适配器全部为「不承诺」。
  assert.deepEqual(UNKNOWN_ADAPTER.capabilities, DEFAULT_HOST_CAPABILITIES);
  assert.equal(UNKNOWN_ADAPTER.capabilities.interrupt, "unsupported");
  assert.equal(UNKNOWN_ADAPTER.capabilities.wakeIdle, false);
  assert.equal(UNKNOWN_ADAPTER.capabilities.reconnect, "unsupported");

  // 只声明部分能力时，其余按默认值填充（绝不臆造能力）。
  const partial = defineHostAdapter({
    id: "partial-host" as HostType,
    label: "部分能力宿主",
    capabilities: { interrupt: "accepted" },
  });
  assert.equal(partial.capabilities.interrupt, "accepted");
  assert.equal(partial.capabilities.wakeIdle, false);
  assert.equal(partial.capabilities.reconnect, "unsupported");

  // transports / joinConfig / evidence 缺省为安全值。
  assert.deepEqual(partial.transports, []);
  assert.deepEqual(partial.joinConfig, {});
  assert.deepEqual(partial.evidence, {});
});

test("HostType 兼容：claude-code / codex-cli / other 仍是合法已知宿主", () => {
  // 这三个字面量必须仍在 KNOWN_HOST_TYPES 中，保证现有 join 不被破坏。
  for (const id of ["claude-code", "codex-cli", "other"] as const) {
    assert.ok(
      (KNOWN_HOST_TYPES as readonly string[]).includes(id),
      `KNOWN_HOST_TYPES 必须包含 ${id}`,
    );
  }
  // 类型层面：它们仍是合法的 HostType（开放类型可容纳任意已注册 id）。
  const known: HostType[] = ["claude-code", "codex-cli", "other"];
  assert.equal(known.length, 3);
});
