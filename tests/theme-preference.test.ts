import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const script = new URL("../src/web/public/theme-bootstrap.js", import.meta.url);
const key = "boardroom:appearance";
interface Snapshot { preference: string; appearance: string; persistent: boolean }
interface Controller { getSnapshot(): Snapshot; setPreference(value: string): void; subscribe(listener: (state: Snapshot) => void): () => void }
async function browser(options: { saved?: string | null; dark?: boolean; storageFailure?: "get" | "read" | "write"; noSystem?: boolean } = {}) {
  const values = new Map<string, string>(options.saved == null ? [] : [[key, options.saved]]);
  const listeners = new Map<string, (event: any) => void>();
  let systemChange: (() => void) | undefined;
  const media = { matches: options.dark ?? false, addEventListener(_name: string, callback: () => void) { systemChange = callback; } };
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
  const storage = {
    getItem(name: string) { if (options.storageFailure === "read") throw new Error("denied"); return values.get(name) ?? null; },
    setItem(name: string, value: string) { if (options.storageFailure === "write") throw new Error("quota"); values.set(name, value); },
  };
  const window = {
    document: { documentElement: root },
    get localStorage() { if (options.storageFailure === "get") throw new Error("denied"); return storage; },
    matchMedia: options.noSystem ? undefined : () => media,
    addEventListener(name: string, callback: (event: any) => void) { listeners.set(name, callback); },
    __boardroomTheme: undefined as Controller | undefined,
  };
  const source = await readFile(script, "utf8");
  runInNewContext(source, { window });
  assert.ok(window.__boardroomTheme, "首帧入口应创建唯一外观控制器");
  return { controller: window.__boardroomTheme, root, values, storage, window, source,
    system(dark: boolean) { media.matches = dark; systemChange?.(); },
    external(value: string | null, area: unknown = storage, changedKey: string | null = key) {
      if (value === null) values.delete(key); else values.set(key, value);
      listeners.get("storage")?.({ key: changedKey, newValue: value, storageArea: area });
    },
  };
}

test("S6-AC21：首帧采用显式偏好，原生控件主题一致；无偏好跟随系统，坏值和无系统能力安全回退", async () => {
  const explicit = await browser({ saved: "light", dark: true });
  assert.equal(explicit.root.dataset.theme, "light");
  assert.equal(explicit.root.style.colorScheme, "light");
  assert.equal(explicit.controller.getSnapshot().preference, "light");
  assert.equal((await browser({ dark: true })).root.dataset.theme, "dark");
  assert.equal((await browser({ saved: "bad", dark: true })).root.dataset.theme, "dark");
  assert.equal((await browser({ noSystem: true })).root.dataset.theme, "light");
});

test("S6-AC21：显式选择保存并跨标签同步，系统变化只影响跟随系统；取消订阅不泄漏", async () => {
  const page = await browser({ dark: true });
  const observed: string[] = [];
  const stop = page.controller.subscribe(state => observed.push(state.appearance));
  page.controller.setPreference("light");
  assert.equal(page.values.get(key), "light");
  page.system(false); page.system(true);
  assert.equal(page.root.dataset.theme, "light");
  page.controller.setPreference("system");
  assert.equal(page.root.dataset.theme, "dark");
  page.system(false);
  assert.equal(page.root.dataset.theme, "light");
  page.external("dark");
  assert.equal(page.root.dataset.theme, "dark");
  assert.equal(page.controller.getSnapshot().preference, "dark");
  page.external("light", {}); // sessionStorage / 其他存储不能改变外观。
  assert.equal(page.root.dataset.theme, "dark");
  page.external(null, page.storage, null); // 另一标签清除 localStorage。
  assert.equal(page.controller.getSnapshot().preference, "system");
  const count = observed.length; stop();
  page.controller.setPreference("dark");
  assert.equal(observed.length, count);
  assert.equal((await browser({ saved: page.values.get(key)! })).root.dataset.theme, "dark");
});

test("S6-AC21：存储获取、读取或写入失败仍保留会话内选择并报告无法保存", async () => {
  for (const storageFailure of ["get", "read", "write"] as const) {
    const page = await browser({ storageFailure, dark: false });
    page.controller.setPreference("dark");
    assert.equal(page.root.dataset.theme, "dark", storageFailure);
    assert.equal(page.controller.getSnapshot().persistent, false, storageFailure);
    page.controller.setPreference("light");
    assert.equal(page.root.dataset.theme, "light", storageFailure);
    page.controller.setPreference("invalid");
    assert.equal(page.controller.getSnapshot().preference, "light");
  }
});

test("S6-AC21：重复载入首帧脚本复用控制器，不重置未持久化选择或重复监听", async () => {
  const page = await browser({ storageFailure: "write" });
  page.controller.setPreference("dark");
  runInNewContext(page.source, { window: page.window });
  assert.equal(page.window.__boardroomTheme, page.controller);
  assert.equal(page.root.dataset.theme, "dark");
});
