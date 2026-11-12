import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { byTestId, json, settle, textOf, withPage } from "./helpers/web-ui.ts";

test("S6-AC21：外观区使用首帧唯一控制器，点击更新选择/存储失败反馈，不请求后端保存", async () => {
  const globals = globalThis as any;
  const original = globals.__boardroomTheme;
  const values = new Map<string, string>();
  let fail = false;
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
  const host: any = {
    document: { documentElement: root },
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (fail) throw new Error("denied"); values.set(key, value); } },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    addEventListener() {},
  };
  runInNewContext(await readFile(new URL("../src/web/public/theme-bootstrap.js", import.meta.url), "utf8"), { window: host });
  globals.__boardroomTheme = host.__boardroomTheme;
  const requests: Array<{ url: string; method: string | undefined }> = [];
  try {
    await withPage("SettingsView", (url, init) => {
      requests.push({ url, method: init?.method });
      if (url.startsWith("/api/projects?")) return json({ projects: [] });
      return json({ error: { code: "unavailable", message: "服务配置暂不可读" } }, 503);
    }, async (container) => {
      assert.equal(byTestId(container, "theme-system").props["aria-pressed"], true);
      assert.match(textOf(byTestId(container, "theme-current")), /深色.*系统/);
      byTestId(container, "theme-light").props.onClick(); await settle();
      assert.equal(root.dataset.theme, "light");
      assert.equal(values.get("boardroom:appearance"), "light");
      assert.equal(byTestId(container, "theme-light").props["aria-pressed"], true);
      fail = true;
      byTestId(container, "theme-dark").props.onClick(); await settle();
      assert.equal(root.dataset.theme, "dark");
      assert.match(textOf(byTestId(container, "theme-storage-notice")), /无法保存.*仍可切换/);
      assert.ok(requests.every(request => request.method === "GET"));
      assert.equal(requests.filter(request => request.url === "/api/settings").length, 1);
    }, { path: "/settings" });
  } finally {
    if (original === undefined) delete globals.__boardroomTheme; else globals.__boardroomTheme = original;
  }
});
