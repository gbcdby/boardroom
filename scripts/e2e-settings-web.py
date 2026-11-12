#!/usr/bin/env python3
"""生产 HTTP + 临时 SQLite + 真实 Chromium 的只读设置页验收。"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import select
import subprocess
import traceback
from urllib.parse import urlsplit
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent


def fixture_command(process, action):
    command_id = str(uuid4())
    process.stdin.write(json.dumps({"id": command_id, "action": action}) + "\n")
    process.stdin.flush()
    ready, _, _ = select.select([process.stdout], [], [], 15)
    assert ready, "设置夹具命令超时"
    line = process.stdout.readline()
    assert line, "设置夹具未返回结果"
    result = json.loads(line)
    assert result["id"] == command_id
    return result["result"]


def read_settings(page, origin):
    response = page.request.get(origin + "/api/settings")
    assert response.ok, (response.status, response.text())
    assert response.headers["cache-control"] == "no-store"
    assert not re.search(r"secret-canary|query-canary|unknown-config-canary|environment-canary|private-db", response.text())
    return response.json()["settings"]


def row(page, label):
    return page.locator(".settings-values > div").filter(has=page.get_by_text(label, exact=True))


def capture(page, output, report, name):
    dimensions = page.evaluate("() => ({viewport:innerWidth, document:document.documentElement.scrollWidth, body:document.body.scrollWidth})")
    assert max(dimensions["document"], dimensions["body"]) <= dimensions["viewport"] + 1, (name, dimensions)
    page.screenshot(path=str(output / f"{name}.png"), full_page=True, animations="disabled")
    report["layouts"].append({"name": name, **dimensions})
    report["screenshots"].append(f"{name}.png")


def contrast(page):
    return page.evaluate("""() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', {willReadFrequently:true});
      const rgba = value => {ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
      const blend = (front, back) => front.slice(0,3).map((v,i)=>v*(front[3]/255)+back[i]*(1-front[3]/255));
      const luminance = color => color.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      return ['.settings-page h2','.settings-page .page-description','.settings-values dt','.settings-values dd','.settings-values code','.settings-status .badge'].map(selector=>{
        const element = document.querySelector(selector); if (!element) throw new Error('missing contrast target: '+selector);
        const ancestors=[]; for(let node=element;node;node=node.parentElement) ancestors.unshift(node);
        let background=[255,255,255]; for(const node of ancestors) background=blend(rgba(getComputedStyle(node).backgroundColor),background);
        const color=blend(rgba(getComputedStyle(element).color),background); const values=[luminance(color),luminance(background)].sort((a,b)=>a-b);
        return {selector, foreground:color, background, ratio:(values[1]+.05)/(values[0]+.05)};
      });
    }""")


def refresh(page, origin, control="settings-refresh"):
    with page.expect_response(lambda response: response.url == origin + "/api/settings" and response.request.method == "GET") as response:
        page.get_by_test_id(control).click()
    assert response.value.ok
    expect(page.get_by_test_id("settings-refresh")).to_be_enabled()


def exercise(page, context, fixture, process, output, report):
    origin = fixture["url"]
    report.update({"checks": [], "screenshots": [], "layouts": [], "contrast": [], "pageErrors": [], "consoleErrors": []})
    page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
    page.on("console", lambda message: report["consoleErrors"].append({"text": message.text, "location": message.location}) if message.type == "error" else None)
    writes = []
    page.on("request", lambda request: writes.append({"url": request.url, "method": request.method}) if "/api/" in request.url and request.method not in ("GET", "HEAD") else None)
    assert page.request.get(origin + "/api/projects").json()["projects"] == []
    actual = read_settings(page, origin)
    assert actual["service"]["httpBaseUrl"] == origin
    assert actual["service"]["port"] == urlsplit(origin).port
    assert actual["storage"]["dataDirectory"] == fixture["dataDirectory"]
    assert actual["configuration"]["filePath"] == fixture["configFile"]
    assert actual["heartbeat"]["intervalMs"] == fixture["initial"]["heartbeatIntervalMs"]
    assert actual["memory"] == page.request.get(origin + "/api/memory-settings").json()["settings"]

    for theme in ("light", "dark"):
        for width, height in [(1440, 1000), (768, 1000), (390, 844)]:
            page.set_viewport_size({"width": width, "height": height})
            page.emulate_media(color_scheme=theme, reduced_motion="reduce")
            page.goto(origin + "/settings")
            expect(page.get_by_role("heading", level=1, name="设置", exact=True)).to_be_visible()
            expect(page.get_by_test_id("settings-http")).to_have_text(origin)
            expect(page.get_by_test_id("settings-mcp")).to_have_text(origin + "/mcp")
            expect(page.get_by_test_id("settings-websocket")).to_have_text(actual["service"]["websocketUrl"])
            expect(page.get_by_test_id("settings-data-directory")).to_have_text(fixture["dataDirectory"])
            expect(page.get_by_test_id("settings-file")).to_have_text(fixture["configFile"])
            expect(row(page, "消息总结阈值")).to_contain_text(f"{fixture['initial']['messageThreshold']} 条")
            expect(page.get_by_test_id("settings-last-read")).to_be_visible()
            expect(page.get_by_test_id("current-project")).to_have_count(0)
            expect(page.get_by_text("暂无当前项目", exact=False)).to_have_count(0)
            expect(page.locator(".settings-page input, .settings-page textarea, .settings-page select, .settings-page form")).to_have_count(0)
            expect(page.locator(".settings-page").get_by_role("button", name=re.compile("保存|重启"))).to_have_count(0)
            expect(page.locator(".settings-page img, .settings-page script")).to_have_count(0)
            assert page.evaluate("() => typeof globalThis.settingsXss") == "undefined"
            assert not re.search(r"secret-canary|query-canary|unknown-config-canary|environment-canary", page.locator("body").inner_text())
            if width == 390:
                for test_id in ("settings-refresh", "settings-copy-mcp"):
                    assert page.get_by_test_id(test_id).bounding_box()["height"] >= 44
            name = f"settings-{width}-{theme}"
            capture(page, output, report, name)
            for sample in contrast(page):
                assert sample["ratio"] >= 4.5, (name, sample)
                report["contrast"].append({"view": name, **sample})
    report["checks"].append("S5-CONFIG-01/WEBUI：真实无项目服务可读；1440/768/390浅深色、长路径无横溢出、移动触控≥44px、文字对比≥4.5；只读且普通文本安全")

    page.set_viewport_size({"width": 1440, "height": 1000})
    page.emulate_media(color_scheme="light")
    page.goto(origin + "/projects")
    expect(page.get_by_test_id("current-project")).to_have_count(0)
    page.get_by_role("link", name="设置", exact=True).focus()
    page.keyboard.press("Enter")
    expect(page).to_have_url(origin + "/settings")
    expect(page.get_by_role("heading", level=1, name="设置", exact=True)).to_be_focused()
    expect(page.get_by_test_id("settings-refresh")).to_be_enabled()
    page.keyboard.press("Tab")
    expect(page.get_by_test_id("settings-refresh")).to_be_focused()
    outline = page.get_by_test_id("settings-refresh").evaluate("element => ({style:getComputedStyle(element).outlineStyle,width:parseFloat(getComputedStyle(element).outlineWidth)})")
    assert outline["style"] != "none" and outline["width"] >= 2, outline
    report["keyboardFocus"] = outline
    with page.expect_response(lambda response: response.url == origin + "/api/settings") as response:
        page.keyboard.press("Enter")
    assert response.value.ok
    expect(page.get_by_test_id("settings-refresh")).to_be_enabled()
    # 刷新结束后从刷新控件继续检查正常的 Tab 顺序。
    page.get_by_test_id("settings-refresh").focus()
    for preference in ("system", "light", "dark"):
        page.keyboard.press("Tab")
        expect(page.get_by_test_id(f"theme-{preference}")).to_be_focused()
    page.keyboard.press("Tab")
    expect(page.get_by_test_id("settings-copy-mcp")).to_be_focused()
    context.grant_permissions(["clipboard-read", "clipboard-write"], origin=origin)
    page.keyboard.press("Enter")
    expect(page.get_by_test_id("settings-copy-notice")).to_contain_text("已复制 MCP HTTP 地址")
    assert page.evaluate("() => navigator.clipboard.readText()") == origin + "/mcp"
    report["checks"].append("S5-CONFIG-04：键盘从导航进入设置并聚焦标题，Tab/Enter刷新和复制，可见焦点；真实浏览器剪贴板内容等于实际 MCP 地址")

    page.evaluate("""() => {
      globalThis.originalSettingsClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      Object.defineProperty(navigator.clipboard, 'writeText', {configurable:true, value:async()=>{throw new DOMException('controlled clipboard denial','NotAllowedError');}});
    }""")
    page.get_by_test_id("settings-copy-mcp").click()
    expect(page.get_by_test_id("settings-copy-error")).to_contain_text("手动复制")
    expect(page.get_by_test_id("settings-copy-notice")).to_have_count(0)
    expect(page.get_by_test_id("settings-mcp")).to_have_text(origin + "/mcp")
    page.set_viewport_size({"width": 390, "height": 844})
    capture(page, output, report, "settings-copy-failed-390-light")
    page.evaluate("""() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {configurable:true, value:globalThis.originalSettingsClipboardWrite});
      delete globalThis.originalSettingsClipboardWrite;
    }""")
    page.get_by_test_id("settings-copy-mcp").click()
    expect(page.get_by_test_id("settings-copy-notice")).to_contain_text("已复制 MCP HTTP 地址")
    expect(page.get_by_test_id("settings-copy-error")).to_have_count(0)
    report["checks"].append("S5-CONFIG-04：受控剪贴板拒绝显示手动复制反馈，无假成功；恢复真实剪贴板后可重试")

    last_read = page.get_by_test_id("settings-last-read").get_attribute("datetime")
    pattern = "**/api/settings"
    def unavailable(route):
        route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"code": "controlled_unavailable", "message": "受控的临时读取失败"}}))
    page.route(pattern, unavailable)
    page.get_by_test_id("settings-refresh").click()
    expect(page.get_by_test_id("settings-error")).to_contain_text("以下仍为上次成功读取的值")
    expect(page.get_by_test_id("settings-last-read")).to_have_attribute("datetime", last_read)
    expect(page.get_by_test_id("settings-http")).to_have_text(origin)
    expect(page.get_by_test_id("settings-data-directory")).to_have_text(fixture["dataDirectory"])
    capture(page, output, report, "settings-refresh-failed-390-light")
    page.unroute(pattern, unavailable)
    refresh(page, origin, "settings-retry")
    expect(page.get_by_test_id("settings-error")).to_have_count(0)
    assert page.get_by_test_id("settings-last-read").get_attribute("datetime") != last_read
    page.route(pattern, unavailable)
    page.reload()
    expect(page.get_by_test_id("settings-error")).to_contain_text("受控的临时读取失败")
    expect(page.get_by_test_id("settings-http")).to_have_count(0)
    expect(page.get_by_test_id("settings-last-read")).to_have_count(0)
    page.unroute(pattern, unavailable)
    refresh(page, origin, "settings-retry")
    expect(page.get_by_test_id("settings-http")).to_have_text(origin)
    report["checks"].append("S5-CONFIG-04：受控503刷新保留旧值及原成功时间；首次失败不显示虚构默认值，重试恢复真实数据")

    assert fixture_command(process, "change-config")["changed"]
    refresh(page, origin)
    expect(row(page, "消息总结阈值")).to_contain_text(f"{fixture['initial']['messageThreshold']} 条")
    assert read_settings(page, origin) == actual
    assert fixture_command(process, "restart")["url"] == origin
    refresh(page, origin)
    expect(row(page, "消息总结阈值")).to_contain_text(f"{fixture['updated']['messageThreshold']} 条")
    expect(row(page, "心跳超时")).to_contain_text("24 秒")
    current = read_settings(page, origin)
    assert current["configuration"]["startedAt"] != actual["configuration"]["startedAt"]
    assert current["memory"] == page.request.get(origin + "/api/memory-settings").json()["settings"]
    expect(page.get_by_text("环境变量优先于配置文件，配置文件优先于默认值。", exact=True)).to_be_visible()
    expect(page.get_by_text(re.compile("正常停止服务.*重新启动"))).to_be_visible()
    expect(page.locator(".settings-page").get_by_role("button", name=re.compile("保存|重启"))).to_have_count(0)
    assert page.request.get(origin + "/api/health").ok
    report["checks"].append("S5-CONFIG-01/04：真实修改配置文件后刷新仍是旧快照；夹具正常停止/重启后页面刷新显示新值，memory API一致；页面从不提供重启动作")
    assert not writes, writes
    assert not report["pageErrors"], report["pageErrors"]
    unexpected = [entry for entry in report["consoleErrors"] if "status of 503" not in entry["text"] and "favicon.ico" not in entry.get("location", {}).get("url", "")]
    assert not unexpected, unexpected
    report["uiWriteRequests"] = writes
    report["status"] = "PASS"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/settings-web-e2e")
    parser.add_argument("--chromium", type=Path, help="可选已有 Chromium；CI 默认使用 Playwright 安装版本")
    args = parser.parse_args()
    output = args.artifacts.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "FAIL", "at": datetime.now(timezone.utc).isoformat(), "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "worktree": subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True).strip(), "scope": "real Chromium / production HTTP / temporary SQLite / no model invocation"}
    fixture = None
    try:
        report["phase"] = "fixture_start"
        fixture = subprocess.Popen(["node", "scripts/settings-web-fixture.mjs"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready, _, _ = select.select([fixture.stdout], [], [], 45)
        assert ready, "设置浏览器临时服务启动超时"
        line = fixture.stdout.readline()
        assert line, "设置临时服务未返回地址：" + fixture.stderr.read(3000)
        data = json.loads(line)
        parsed = urlsplit(data["url"])
        assert parsed.hostname == "127.0.0.1" and parsed.scheme == "http"
        report["fixtureScope"] = data["scope"]
        with sync_playwright() as playwright:
            report["phase"] = "browser_start"
            launch = {"headless": True}
            if args.chromium: launch["executable_path"] = str(args.chromium)
            browser = playwright.chromium.launch(**launch)
            report["chromium"] = browser.version
            context = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai")
            context.tracing.start(screenshots=True, snapshots=True, sources=True)
            page = context.new_page()
            page.set_default_timeout(15000)
            report["phase"] = "exercise"
            try: exercise(page, context, data, fixture, output, report)
            except Exception:
                if not page.is_closed(): page.screenshot(path=str(output / "failure.png"), full_page=True)
                raise
            finally:
                context.tracing.stop(path=str(output / "trace.zip"))
                context.close(); browser.close()
    except Exception as error:
        report["error"] = str(error)[:5000]
        report["traceback"] = traceback.format_exc()
        if report["phase"] in ("fixture_start", "browser_start") and any(text in str(error) for text in ("Operation not permitted", "Permission denied", "Executable doesn't exist")):
            report["status"] = "BLOCKED"
    finally:
        if fixture:
            fixture.stdin.close()
            try: fixture.wait(timeout=10)
            except subprocess.TimeoutExpired: fixture.terminate(); fixture.wait(timeout=5)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__": raise SystemExit(main())
