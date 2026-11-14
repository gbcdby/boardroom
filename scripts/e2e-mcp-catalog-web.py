#!/usr/bin/env python3
"""#182 Stage A：真实目录服务、故障回执、版本冲突与原生浏览器证据。"""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import select
import subprocess
import sys
from time import monotonic
import traceback
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect
sys.dont_write_bytecode = True
from resource_native_desktop import NativeDesktop
from resource_browser_binding import load_runtime_binding
from resource_browser_session import bounded_playwright, native_page, runtime_identity

ROOT = Path(__file__).resolve().parent.parent
COLLECTION = "/api/mcp/connections"
SHARED_TOOL = "shared_tool"
LONG_TOOL = "long_" + "name_" * 35


class Fixture:
    def __init__(self, output):
        self.output, self.serial = output, 0
        self.log = (output / "fixture-stderr.log").open("w")
        self.process = subprocess.Popen(["node", "scripts/mcp-catalog-web-fixture.mjs"], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True)
        self.data = self.receive(30)

    def receive(self, timeout=15):
        ready, _, _ = select.select([self.process.stdout], [], [], timeout)
        assert ready, "MCP 浏览器夹具响应超时"
        line = self.process.stdout.readline()
        assert line, "MCP 浏览器夹具退出；见 fixture-stderr.log"
        return json.loads(line)

    def command(self, action, **value):
        self.serial += 1
        self.process.stdin.write(json.dumps({"id": self.serial, "action": action, "value": value}) + "\n")
        self.process.stdin.flush()
        response = self.receive()
        assert response["id"] == self.serial
        return response["result"]

    def close(self):
        self.process.stdin.close()
        forced = False
        try: self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            forced = True; self.process.terminate()
            try: self.process.wait(timeout=5)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait(timeout=5)
        self.log.close()
        result = {"exitCode": self.process.returncode, "forced": forced, "temporaryRootRemoved": not Path(self.data["directory"]).exists()}
        assert result == {"exitCode": 0, "forced": False, "temporaryRootRemoved": True}, result
        return result


def api(page, origin, method, path, body=None, status=200):
    response = page.request.fetch(origin + path, method=method, data=body, timeout=15000)
    assert response.status == status, (method, path, response.status, response.text()[:500])
    assert response.headers.get("cache-control") == "no-store"
    return response.json()


def catalog_tool(snapshot, connection, name):
    assert snapshot["connection"]["connectionId"] == connection
    matches = [tool for tool in snapshot["tools"] if tool["ref"]["name"] == name]
    assert len(matches) == 1, ("unique catalog tool", connection, name)
    tool = matches[0]
    assert tool["ref"]["connectionId"] == connection
    assert tool["ref"]["connectionRevision"] == snapshot["connection"]["revision"]
    return tool


def tool_row(page, tool):
    return page.locator(f'[data-tool-key="{tool["toolKey"]}"]')


def refresh(page, origin):
    expect(page.get_by_test_id("mcp-refresh")).to_be_enabled()
    with page.expect_response(lambda r: r.url == origin + COLLECTION and r.request.method == "GET"):
        page.get_by_test_id("mcp-refresh").click()
    expect(page.get_by_test_id("mcp-refresh")).to_be_enabled()


def save(page):
    page.get_by_test_id("mcp-save").click()
    expect(page.get_by_test_id("mcp-editor")).to_have_count(0)


def discover(page, origin, connection):
    with page.expect_response(lambda r: r.url == origin + COLLECTION + f"/{connection}/discover" and r.request.method == "POST", timeout=15000) as response:
        page.get_by_test_id("mcp-discover").click()
    assert response.value.ok
    expect(page.get_by_test_id("mcp-discover")).to_be_enabled()
    return response.value.json()["attempt"]


def capture(page, output, report, name):
    dimensions = page.evaluate("() => ({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth})")
    assert max(dimensions["document"], dimensions["body"]) <= dimensions["viewport"] + 1, (name, dimensions)
    page.screenshot(path=str(output / f"{name}.png"), full_page=True, animations="disabled")
    report["screenshots"].append(f"{name}.png")
    report["layouts"].append({"name": name, **dimensions})


def wait_fixture(page, fixture, predicate):
    deadline = monotonic() + 8
    while monotonic() < deadline:
        result = fixture.command("stats")
        if predicate(result): return result
        page.wait_for_timeout(40)
    raise AssertionError("实际 MCP 请求未到达指定边界")


def activate_for_input(page, report, step):
    page.bring_to_front()
    page.wait_for_function("document.visibilityState === 'visible'", polling=100, timeout=5000)
    observed = page.evaluate("() => ({visibility:document.visibilityState, focused:document.hasFocus()})")
    assert observed["visibility"] == "visible", (step, observed)
    report.setdefault("pageActivations", []).append({"step": step, "url": page.url, **observed})


def visibility_recovery(page, context, origin, requests, report):
    cdp = context.new_cdp_session(page)
    window = None
    page.evaluate("""() => { window.mcpVisibility=[]; document.addEventListener('visibilitychange', e =>
        window.mcpVisibility.push({state:document.visibilityState,trusted:e.isTrusted,at:performance.now()})); }""")
    try:
        cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": False})
        window = cdp.send("Browser.getWindowForTarget")["windowId"]
        cdp.send("Browser.setWindowBounds", {"windowId": window, "bounds": {"windowState": "minimized"}})
        page.wait_for_function("document.visibilityState === 'hidden'", polling=100, timeout=5000)
        page.wait_for_timeout(250)
        count = len([r for r in requests if r["url"] == origin + COLLECTION])
        page.wait_for_timeout(16000)
        assert page.evaluate("document.visibilityState") == "hidden"
        assert len([r for r in requests if r["url"] == origin + COLLECTION]) == count
        with page.expect_response(lambda r: r.url == origin + COLLECTION, timeout=5000):
            cdp.send("Browser.setWindowBounds", {"windowId": window, "bounds": {"windowState": "normal"}})
            page.bring_to_front()
        page.wait_for_function("document.visibilityState === 'visible'", timeout=5000)
        events = page.evaluate("window.mcpVisibility")
        assert any(e["state"] == "hidden" and e["trusted"] for e in events), events
        assert any(e["state"] == "visible" and e["trusted"] for e in events), events
        report["visibility"] = {"hiddenMs": 16000, "requestCountWhileHidden": count, "events": events}
    finally:
        if window is not None: cdp.send("Browser.setWindowBounds", {"windowId": window, "bounds": {"windowState": "normal"}})
        page.bring_to_front(); cdp.detach()


def exercise(page, context, fixture, output, report, native):
    origin, endpoint = fixture.data["url"], fixture.data["endpoint"]
    requests = report["requests"]
    page.on("request", lambda r: requests.append({"url": r.url, "method": r.method, "body": r.post_data, "at": monotonic()}) if "/api/mcp/connections" in r.url else None)
    page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
    page.goto(origin + "/collaboration/mcp", wait_until="domcontentloaded")
    expect(page.get_by_test_id("mcp-empty")).to_be_visible()
    assert api(page, origin, "GET", "/api/projects")["projects"] == []
    report["checks"].append("A01: 无项目的全局深链进入真实空连接列表")

    page.get_by_test_id("mcp-create").click()
    expect(page.get_by_test_id("mcp-name")).to_be_focused()
    page.get_by_test_id("mcp-name").fill("研发工具目录")
    page.get_by_test_id("mcp-endpoint").fill(endpoint)
    page.emulate_media(color_scheme="dark")
    expect(page.locator("html")).to_have_attribute("data-theme", "dark")
    expect(page.get_by_test_id("mcp-name")).to_have_value("研发工具目录")
    capture(page, output, report, "mcp-editor-1440-dark")
    save(page)
    records = api(page, origin, "GET", COLLECTION)["connections"]
    assert len(records) == 1 and fixture.command("stats")["methods"] == []
    connection = records[0]["connection"]["connectionId"]
    expect(page.get_by_test_id("mcp-undiscovered")).to_be_visible()
    fixture.command("restart"); page.reload()
    expect(page.get_by_test_id("mcp-connection")).to_have_value(connection)
    assert fixture.command("stats")["methods"] == []
    report["checks"].append("A02: 真保存及服务重启后持久存在；没有隐式 initialize/tools/list")

    attempt = discover(page, origin, connection)
    assert attempt["status"] == "succeeded" and attempt["pages"] == 2
    first = api(page, origin, "GET", COLLECTION + "/" + connection)["currentSnapshot"]
    assert len(first["tools"]) == 2
    first_shared = catalog_tool(first, connection, SHARED_TOOL)
    first_long = catalog_tool(first, connection, LONG_TOOL)
    first_digest, first_key = first["snapshotDigest"], first_shared["toolKey"]
    expect(tool_row(page, first_shared)).to_be_visible()
    expect(tool_row(page, first_long)).to_be_visible()
    assert fixture.command("stats")["methods"].count("tools/list") == 2
    fixture.command("mode", mode="fail")
    failed = discover(page, origin, connection)
    assert failed["status"] == "discovery_failed"
    assert api(page, origin, "GET", COLLECTION + "/" + connection)["currentSnapshot"]["snapshotDigest"] == first_digest
    expect(tool_row(page, first_shared)).to_be_visible()
    expect(tool_row(page, first_long)).to_be_visible()
    fixture.command("mode", mode="schema2"); discover(page, origin, connection)
    changed = api(page, origin, "GET", COLLECTION + "/" + connection)["currentSnapshot"]
    changed_shared = catalog_tool(changed, connection, SHARED_TOOL)
    assert changed_shared["ref"]["schemaDigest"] != first_shared["ref"]["schemaDigest"]
    assert changed_shared["toolKey"] != first_key
    fixture.command("mode", mode="empty"); discover(page, origin, connection)
    expect(page.get_by_test_id("mcp-empty-catalog")).to_be_visible()
    page.locator(".catalog-history summary").click()
    page.get_by_test_id("mcp-history-digest").fill(first_digest)
    page.get_by_test_id("mcp-load-history").click()
    expect(page.get_by_role("heading", name="已知历史目录", exact=True)).to_be_visible()
    expect(tool_row(page, first_shared)).to_have_attribute("data-tool-key", first_key)
    expect(tool_row(page, first_long)).to_be_visible()
    report["catalogIdentities"] = {"firstDigest": first_digest, "firstShared": first_shared["ref"],
        "firstSharedKey": first_key, "changedShared": changed_shared["ref"], "longToolKey": first_long["toolKey"]}
    report["checks"].append("A03/A04: 真实 initialize/分页/完整空目录/部分失败保留旧完整快照；schema变化和精确历史摘要")

    for width, height in [(1440, 1000), (390, 844)]:
        page.set_viewport_size({"width": width, "height": height})
        for theme in ("light", "dark"):
            page.emulate_media(color_scheme=theme)
            expect(page.locator("html")).to_have_attribute("data-theme", theme)
            long_row = tool_row(page, first_long)
            long_row.focus(); page.keyboard.press("Enter")
            details = page.get_by_test_id("mcp-tool-drawer") if width == 390 else page.locator(".tool-inspector")
            expect(details).to_contain_text(connection)
            expect(details).to_contain_text(LONG_TOOL)
            expect(details).to_contain_text("<img src=x onerror=globalThis.mcpXss=1>")
            assert page.evaluate("typeof globalThis.mcpXss") == "undefined"
            capture(page, output, report, f"mcp-catalog-{width}-{theme}")
            if width == 390:
                for _ in range(9):
                    page.keyboard.press("Tab")
                    assert page.evaluate("document.querySelector('[data-testid=mcp-tool-drawer]').contains(document.activeElement)")
                page.keyboard.press("Escape")
                expect(page.get_by_test_id("mcp-tool-drawer")).to_have_count(0)
                expect(long_row).to_be_focused()
    report["checks"].append("A08: 390/1440 light/dark截图、长不可信文本、工具精确来源、键盘抽屉焦点循环及关闭恢复")
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.get_by_role("button", name="返回当前目录", exact=True).click()

    second = context.new_page()
    try:
        second.goto(origin + "/collaboration/mcp")
        activate_for_input(second, report, "cas-second-loaded")
        expect(second.get_by_test_id("mcp-connection")).to_have_value(connection)
        activate_for_input(page, report, "cas-first-draft")
        page.get_by_test_id("mcp-edit").click()
        expect(page.get_by_test_id("mcp-endpoint")).to_have_value(endpoint)
        page.get_by_test_id("mcp-name").fill("保留本窗口草稿")
        activate_for_input(second, report, "cas-second-update")
        second.get_by_test_id("mcp-edit").click()
        second.get_by_test_id("mcp-name").fill("另一窗口的新版本"); save(second)
        activate_for_input(page, report, "cas-first-conflict")
        page.get_by_test_id("mcp-save").click()
        expect(page.get_by_test_id("mcp-editor")).to_contain_text("编辑稿保留")
        expect(page.get_by_test_id("mcp-name")).to_have_value("保留本窗口草稿")
        page.get_by_test_id("mcp-adopt-revision").click()
        expect(page.get_by_test_id("mcp-editor")).to_contain_text("编辑基准：v2")
        save(page)
    finally: second.close()
    activate_for_input(page, report, "cas-first-after-close")
    assert api(page, origin, "GET", COLLECTION + "/" + connection)["connection"]["revision"] == 3
    expect(page.get_by_test_id("mcp-undiscovered")).to_be_visible()
    report["checks"].append("A02/A05: 两真实窗口CAS冲突保留稿，显式采用v2后保存v3；旧配置目录不当当前")

    # Actual save COMMIT is performed; only its response is replaced with a controlled 503.
    saved_requests = []
    def lost_save(route):
        if route.request.method != "POST": route.continue_(); return
        saved_requests.append(route.request.post_data)
        response = route.fetch(); assert response.ok
        route.fulfill(status=503, content_type="application/json", body='{"error":{"code":"fixture_response_lost"}}')
    page.route(origin + COLLECTION, lost_save)
    page.get_by_test_id("mcp-create").click(); page.get_by_test_id("mcp-name").fill("同名工具的第二个来源")
    page.get_by_test_id("mcp-endpoint").fill(endpoint); page.get_by_test_id("mcp-save").click()
    expect(page.get_by_test_id("mcp-save-unknown")).to_be_visible()
    expect(page.get_by_test_id("mcp-name")).to_be_disabled()
    page.unroute(origin + COLLECTION, lost_save)
    assert len(api(page, origin, "GET", COLLECTION)["connections"]) == 2
    page.get_by_test_id("mcp-recover-save").click(); expect(page.get_by_test_id("mcp-editor")).to_have_count(0)
    create_writes = [r["body"] for r in requests if r["method"] == "POST" and r["url"] == origin + COLLECTION]
    assert create_writes[-2] == create_writes[-1] == saved_requests[0]
    assert len(api(page, origin, "GET", COLLECTION)["connections"]) == 2
    other = page.get_by_test_id("mcp-connection").input_value()
    fixture.command("mode", mode="pages"); discover(page, origin, other)
    other_snapshot = api(page, origin, "GET", COLLECTION + "/" + other)["currentSnapshot"]
    other_shared = catalog_tool(other_snapshot, other, SHARED_TOOL)
    assert other != connection and other_shared["ref"]["name"] == first_shared["ref"]["name"]
    assert other_shared["ref"]["schemaDigest"] == first_shared["ref"]["schemaDigest"]
    assert other_shared["toolKey"] != first_key
    report["catalogIdentities"]["otherShared"] = other_shared["ref"]
    report["catalogIdentities"]["otherSharedKey"] = other_shared["toolKey"]
    report["checks"].append("A04/A05: 保存真实提交后丢回执保持unknown，同key恢复无重复连接；同名工具不同来源身份不同")

    # Drop a real discovery receipt, then commit a different request from a second HTTP client.
    discover_url = origin + COLLECTION + f"/{other}/discover"
    original = {}
    def lost_discovery(route):
        original["body"] = route.request.post_data
        response = route.fetch(); assert response.ok
        original["attempt"] = response.json()["attempt"]
        route.fulfill(status=503, content_type="application/json", body='{}')
    page.route(discover_url, lost_discovery); page.get_by_test_id("mcp-discover").click()
    expect(page.get_by_test_id("mcp-discovery-unknown")).to_be_visible(); page.unroute(discover_url, lost_discovery)
    foreign = api(page, origin, "POST", COLLECTION + f"/{other}/discover", {"requestId": str(uuid4()), "expectedRevision": 1})["attempt"]
    refresh(page, origin)
    expect(page.get_by_test_id("mcp-discovery-unknown")).to_be_visible()
    assert foreign["attemptId"] != original["attempt"]["attemptId"]
    expect(page.get_by_test_id("mcp-latest-attempt")).to_contain_text(foreign["attemptId"])
    page.get_by_test_id("mcp-recover-discovery").click()
    expect(page.get_by_test_id("mcp-discovery-unknown")).to_have_count(0)
    expect(page.get_by_test_id("mcp-owned-attempt").filter(has_text=original["attempt"]["attemptId"])).to_be_visible()
    assert [r["body"] for r in requests if r["url"] == discover_url and r["method"] == "POST"][-1] == original["body"]
    report["checks"].append("A05: 真实发现回执丢失与另一请求latest并存；不误认所有权，只显式重试原key恢复")

    fixture.command("mode", mode="hold")
    before = fixture.command("stats")["listRequests"]
    page.get_by_test_id("mcp-discover").click()
    wait_fixture(page, fixture, lambda s: s["listRequests"] > before and s["pendingPages"] > 0)
    page.get_by_test_id("mcp-stop-wait").click()
    expect(page.get_by_test_id("mcp-discovery-unknown")).to_be_visible()
    fixture.command("mode", mode="pages")
    page.get_by_test_id("mcp-recover-discovery").click()
    expect(page.get_by_test_id("mcp-discovery-unknown")).to_have_count(0)
    refresh(page, origin)
    report["checks"].append("A06: 真实在途tools/list停止等待成为unknown，原key核查；不推断取消或清理")

    foreign_old = fixture.command("orphan-attempt", connectionId=other,
        input={"requestId": str(uuid4()), "expectedRevision": 1})
    refresh(page, origin)
    expect(page.get_by_test_id("mcp-latest-attempt")).to_contain_text(foreign_old["attemptId"])
    page.get_by_test_id("mcp-new-attempt").click(); page.get_by_test_id("confirm-submit").click()
    expect(page.get_by_test_id("mcp-discover")).to_be_enabled()
    retained_foreign = page.get_by_test_id("mcp-known-attempt").filter(has_text=foreign_old["attemptId"])
    expect(retained_foreign).to_contain_text("发现进行中")
    expect(retained_foreign).to_contain_text("远端清理结果未知")
    expect(retained_foreign.get_by_test_id("mcp-cancel-attempt")).to_have_count(0)
    assert api(page, origin, "GET", COLLECTION + f"/{other}/discoveries/{foreign_old['attemptId']}")["attempt"]["status"] == "running"
    report["checks"].append("A06/STD-001: 明示foreign无worker旧记录；独立新发现后旧记录仍显示且不授予本页取消权")

    seeded = {}
    def orphaned_request(route):
        seeded.update(fixture.command("orphan-attempt", connectionId=other, input=json.loads(route.request.post_data)))
        route.fulfill(status=503, content_type="application/json", body='{}')
    page.route(discover_url, orphaned_request); page.get_by_test_id("mcp-discover").click()
    expect(page.get_by_test_id("mcp-discovery-unknown")).to_be_visible(); page.unroute(discover_url, orphaned_request)
    page.get_by_test_id("mcp-recover-discovery").click()
    expect(page.get_by_test_id("mcp-discovery-unknown")).to_have_count(0)
    owned = page.get_by_test_id("mcp-owned-attempt").filter(has_text=seeded["attemptId"])
    owned.get_by_test_id("mcp-cancel-attempt").click()
    expect(owned).to_contain_text("已请求取消，结果待核实")
    expect(owned).to_contain_text("远端清理结果未知")
    page.get_by_test_id("mcp-new-attempt").click(); page.get_by_test_id("confirm-submit").click()
    expect(page.get_by_test_id("mcp-discover")).to_be_enabled()
    expect(owned).to_contain_text("已请求取消，结果待核实")
    old = api(page, origin, "GET", COLLECTION + f"/{other}/discoveries/{seeded['attemptId']}")["attempt"]
    assert old["status"] == "cancel_requested" and old["cleanup"] == "remote_unknown"
    report["checks"].append("A06: 明示构造无worker持久running记录；真实精确GET/cancel保留cancel_requested，显式新发现后旧记录未洗白")

    # A late GET is actual server data held past the logical deadline, never a manufactured successful payload.
    held = []
    def late_read(route): held.append((route, route.fetch()))
    page.route(origin + COLLECTION, late_read); page.get_by_test_id("mcp-refresh").click()
    expect(page.get_by_test_id("mcp-read-error")).to_contain_text("读取超时", timeout=12000)
    expect(page.get_by_test_id("mcp-tool-0")).to_be_visible()
    for route, response in held: route.fulfill(response=response)
    page.unroute(origin + COLLECTION, late_read); refresh(page, origin)
    expect(page.get_by_test_id("mcp-read-error")).to_have_count(0)
    before_rpc = fixture.command("stats")["methods"]
    before_requests = len(requests)
    with page.expect_response(lambda r: r.url == origin + COLLECTION, timeout=17000): page.wait_for_timeout(16000)
    assert all(r["method"] == "GET" for r in requests[before_requests:])
    assert fixture.command("stats")["methods"] == before_rpc
    if native: visibility_recovery(page, context, origin, requests, report)
    else: report["unverified"].append("A07 原生隐藏恢复未执行；headless不能替代")
    report["checks"].append("A07: 10秒总读取超时保留原目录；真实可见周期只GET、不发现或调用工具")

    for kind, transport in [("stdio", {"type": "stdio", "command": "private-command-canary", "args": ["private-argv-canary"]}),
                            ("credentialed", {"type": "streamable-http", "endpoint": endpoint, "credentialRef": "private-credential-canary"})]:
        created = api(page, origin, "POST", COLLECTION, {"requestId": str(uuid4()), "name": kind, "enabled": True, "transport": transport}, 201)["connection"]
        refresh(page, origin); page.get_by_test_id("mcp-connection").select_option(created["connectionId"])
        expect(page.get_by_test_id("mcp-edit")).to_have_count(0)
        expect(page.get_by_test_id("mcp-discover")).to_be_disabled()
        assert "private-" not in page.locator("body").inner_text()
        assert "private-" not in json.dumps(api(page, origin, "GET", COLLECTION))
    page.get_by_test_id("mcp-connection").select_option(other)
    page.get_by_test_id("mcp-disable").click(); save(page)
    expect(page.get_by_test_id("mcp-discover")).to_be_disabled()
    assert api(page, origin, "GET", COLLECTION + "/" + other)["connection"]["enabled"] is False
    report["checks"].append("A02/A04: 真实停用；已有stdio/凭据连接只读投影，无地址/argv/credentialRef泄露")

    def forbidden(route): route.fulfill(status=403, content_type="application/json", body='{}')
    page.route(origin + COLLECTION, forbidden); page.get_by_test_id("mcp-refresh").click()
    expect(page.get_by_test_id("mcp-read-error")).to_contain_text("没有读取或管理")
    expect(page.get_by_test_id("mcp-create")).to_be_disabled()
    expect(page.locator(".connection-summary")).to_have_count(0)
    page.unroute(origin + COLLECTION, forbidden); refresh(page, origin)
    report["checks"].append("A07: 403撤销清空连接/目录/配置能力，恢复后重新读取")
    assert not report["pageErrors"], report["pageErrors"]
    assert "tools/call" not in fixture.command("stats")["methods"]
    report["upstream"] = fixture.command("stats")


@contextmanager
def headless_page(args, output, report):
    with sync_playwright() as p:
        launch = {"headless": True}
        if args.chromium: launch["executable_path"] = args.chromium
        browser = p.chromium.launch(**launch)
        context = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai", viewport={"width": 1440, "height": 1000})
        context.tracing.start(screenshots=True, snapshots=True, sources=True)
        page = context.new_page(); page.set_default_timeout(15000)
        try: yield page, context
        finally:
            context.tracing.stop(path=str(output / "trace.zip")); context.close(); browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/mcp-catalog-web-e2e")
    parser.add_argument("--chromium")
    parser.add_argument("--native-desktop", action="store_true")
    parser.add_argument("--runtime-binding", type=Path, default=ROOT / ".agent-output/resource-web-e2e/runtime-binding.json")
    args = parser.parse_args(); output = args.artifacts.resolve(); output.mkdir(parents=True, exist_ok=True)
    report = {"status": "FAIL", "at": datetime.now(timezone.utc).isoformat(), "phase": "fixture_start",
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "tree": subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT, text=True).strip(),
        "worktree": subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True).strip(),
        "checks": [], "screenshots": [], "layouts": [], "requests": [], "unverified": [], "pageErrors": [], "cleanupErrors": []}
    tracked = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT).decode().split("\0")
    report["sourceSha256"] = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(set(filter(None, tracked))) if (ROOT / p).is_file()}
    fixture = desktop = None
    try:
        fixture = Fixture(output); report["fixture"] = fixture.data
        report["phase"] = "browser_start"
        if args.native_desktop:
            binding = load_runtime_binding(args.runtime_binding); report["runtime"] = runtime_identity(binding)
            desktop = NativeDesktop(output / "native-desktop"); env = desktop.start()
            case = {"cleanupErrors": []}; report["nativeCase"] = case
            with bounded_playwright(report) as p:
                with native_page(p, env, 1440, 1000, output / "native", output / "trace.zip", case, binding) as (page, context):
                    report["phase"] = "exercise"
                    try: exercise(page, context, fixture, output, report, True); case["status"] = "PASS"
                    except Exception:
                        if not page.is_closed(): page.screenshot(path=str(output / "failure.png"), full_page=True)
                        raise
            assert not case["cleanupErrors"] and case["chromeCleanup"]["status"] == "PASS"
        else:
            with headless_page(args, output, report) as (page, context):
                report["phase"] = "exercise"
                try: exercise(page, context, fixture, output, report, False)
                except Exception:
                    if not page.is_closed(): page.screenshot(path=str(output / "failure.png"), full_page=True)
                    raise
        report["status"] = "INCONCLUSIVE" if report["unverified"] else "PASS"
    except Exception as error:
        report["error"] = str(error)[:8000]; report["traceback"] = traceback.format_exc()
        if report["phase"] in ("fixture_start", "browser_start") and any(x in str(error) for x in ("Operation not permitted", "Permission denied", "Executable doesn't exist")):
            report["status"] = "BLOCKED"
    finally:
        for label, owner in [("fixture", fixture), ("desktop", desktop)]:
            if owner:
                try: report[label + "Cleanup"] = owner.close()
                except Exception as error: report["cleanupErrors"].append(label + ": " + str(error)); report["status"] = "FAIL"
        if report["cleanupErrors"]: report["status"] = "FAIL"
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({key: value for key, value in report.items() if key not in ("sourceSha256", "requests")}, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__": raise SystemExit(main())
