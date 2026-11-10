#!/usr/bin/env python3
"""真实 Chromium + 临时 SQLite：WebUI 布局、键盘和聊天交互回归。

沿用 e2e-managed-web.py 的 Playwright 环境。--capture-only 仅保存改进前截图，
不会把基线截图当成新候选通过证据；不启动真实模型、不触碰用户数据。
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import select
import subprocess
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent

def request(page, origin, method, path, body=None):
    response = page.request.fetch(origin + path, method=method, data=body)
    assert response.ok, f"{method} {path}: {response.status} {response.text()[:400]}"
    return response.json() if response.status != 204 else None

def seed(page, origin):
    records = []
    for name in ["Boardroom 产品迭代", "设计系统与体验优化", "很长的项目名称用于验证窄窗口内容增长与换行"]:
        project = request(page, origin, "POST", "/api/projects", {"name": name})["project"]
        pid = project["id"]
        members = [request(page, origin, "POST", f"/api/projects/{pid}/members", {"kind": "human", "displayName": label})["member"] for label in ["林可", "陈一"]]
        request(page, origin, "POST", f"/api/projects/{pid}/members", {"kind": "human", "displayName": "尚未加入群组的成员"})
        root_node = request(page, origin, "POST", f"/api/projects/{pid}/org/nodes", {"name": "项目统筹", "role": "top_manager"})["node"]
        child = request(page, origin, "POST", f"/api/projects/{pid}/org/nodes", {"name": "产品设计", "role": "member", "parentId": root_node["id"]})["node"]
        request(page, origin, "PUT", f"/api/org/nodes/{root_node['id']}/assignee", {"memberId": members[0]["id"]})
        request(page, origin, "PUT", f"/api/org/nodes/{child['id']}/assignee", {"memberId": members[1]["id"]})
        groups = [request(page, origin, "POST", f"/api/projects/{pid}/groups", {"name": label, "participantMemberIds": [m["id"] for m in members]})["group"] for label in ["产品协作", "设计讨论"]]
        for group, text in zip(groups, ["新的协作从这里开始。\n先整理目标，再一起推进。", "这条消息只属于设计讨论。"]):
            request(page, origin, "POST", f"/api/groups/{group['id']}/messages", {"senderMemberId": members[0]["id"], "text": text})
        records.append({"project": project, "members": members, "groups": groups})
    return records

def layout(page, label, strict=True):
    dimensions = page.evaluate("""() => ({ viewport: innerWidth,
      document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      title: document.querySelector('h1')?.textContent })""")
    assert dimensions["title"], f"{label}: 缺少标题"
    if strict:
        assert max(dimensions["document"], dimensions["body"]) <= dimensions["viewport"] + 1, f"{label}: 整页溢出 {dimensions}"
    return {"view": label, **dimensions}

def exercise(page, origin, records, output, report, capture_only):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    report["pageErrors"] = errors
    project_id = records[0]["project"]["id"]
    group_a, group_b = [g["id"] for g in records[0]["groups"]]
    paths = {"home": "/", "projects": "/projects", "chat": f"/chat?projectId={project_id}&groupId={group_a}", "status": f"/status?projectId={project_id}", "org": "/org", "audit": "/audit", "runtimes": "/runtimes"}
    report["layouts"] = []
    report["screenshots"] = []
    report["checks"] = []
    for width, height, theme in [(1440, 1000, "light"), (768, 1000, "light"), (390, 844, "light"), (1440, 1000, "dark")]:
        page.set_viewport_size({"width": width, "height": height})
        page.emulate_media(color_scheme=theme, reduced_motion="reduce")
        for name, path in paths.items():
            page.goto(origin + path)
            expect(page.locator("h1")).to_be_visible()
            page.wait_for_timeout(450)
            if name == "org":
                page.get_by_label("项目", exact=True).select_option(project_id)
            elif name == "audit":
                page.get_by_test_id("audit-project-select").select_option(project_id)
            elif name == "projects":
                page.get_by_test_id("project-list").get_by_role("button", name=records[0]["project"]["name"], exact=True).click()
            if name in ("org", "audit", "projects"):
                page.wait_for_timeout(250)
            key = f"{name}-{width}-{theme}"
            report["layouts"].append(layout(page, key, strict=not capture_only))
            page.screenshot(path=str(output / f"{key}.png"), full_page=True, animations="disabled")
            report["screenshots"].append(f"{key}.png")
    if capture_only:
        report["status"] = "CAPTURED_BASELINE"
        return
    report["checks"].append("UI-01/02: 7个路由×4种视口/主题，标题与页面无横向溢出")

    page.set_viewport_size({"width": 390, "height": 844})
    page.emulate_media(color_scheme="light")
    page.goto(origin + "/")
    toggle = page.get_by_role("button", name="展开导航", exact=True)
    toggle.focus()
    page.keyboard.press("Enter")
    expect(page.get_by_role("navigation", name="主导航")).to_be_visible()
    page.keyboard.press("Escape")
    expect(toggle).to_be_focused()
    expect(page.get_by_role("navigation", name="主导航")).not_to_be_visible()
    toggle.click()
    page.get_by_role("navigation", name="主导航").get_by_role("link", name="状态看板", exact=True).click()
    expect(page.locator("h1")).to_be_focused()
    expect(page.get_by_role("navigation", name="主导航")).not_to_be_visible()
    report["checks"].append("UI-03: 窄窗菜单键盘展开/Escape还焦、导航后标题焦点")

    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(origin + paths["status"])
    target_id = records[1]["project"]["id"]
    target = page.get_by_test_id(f"overview-item-{target_id}")
    expect(target).to_have_js_property("tagName", "BUTTON")
    target.focus()
    page.keyboard.press("Space")
    expect(target).to_have_attribute("aria-pressed", "true")
    expect(page.get_by_test_id("project-select")).to_have_value(target_id)
    report["checks"].append("UI-03: 状态概览原生按钮可用Space选择，并同步当前项目")

    page.goto(origin + paths["chat"])
    draft = page.get_by_test_id("chat-input")
    send = page.get_by_test_id("chat-send")
    expect(draft).to_be_visible()
    expect(draft).to_have_js_property("tagName", "TEXTAREA")
    expect(page.get_by_test_id("chat-sender")).not_to_have_value("")
    expect(draft).to_be_enabled()
    expect(page.get_by_test_id("chat-sender").locator("option")).to_have_count(2)
    def fail_participants(route):
        route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"code": "ui_test_unavailable", "message": "测试参与者读取失败"}}))
    participant_url = f"**/api/groups/{group_b}/participants"
    page.route(participant_url, fail_participants)
    page.get_by_test_id("chat-group").select_option(group_b)
    expect(page.get_by_test_id("chat-error")).to_be_visible()
    expect(draft).to_be_disabled()
    page.unroute(participant_url, fail_participants)
    page.get_by_role("button", name="重新加载", exact=True).click()
    expect(draft).to_be_enabled()
    page.get_by_test_id("chat-group").select_option(group_a)
    expect(draft).to_be_enabled()
    report["checks"].append("UI-04: 发送身份仅含群参与者，读取失败不可发送且支持重试")
    before = request(page, origin, "GET", f"/api/groups/{group_a}/messages")["messages"]
    draft.fill("输入法确认不应发送")
    draft.dispatch_event("compositionstart", {"data": "确认"})
    draft.press("Enter")
    draft.dispatch_event("compositionend", {"data": "确认"})
    page.wait_for_timeout(100)
    assert len(request(page, origin, "GET", f"/api/groups/{group_a}/messages")["messages"]) == len(before)
    draft.fill("第一行")
    draft.press("End")
    draft.press("Shift+Enter")
    draft.press("x")
    expect(draft).to_have_value("第一行\nx")
    report["checks"].append("UI-04: 输入法确认不发送，Shift+Enter保留换行")

    held = []
    def hold_send(route):
        if route.request.method == "POST":
            held.append(route)
        else:
            route.continue_()
    page.route("**/api/groups/*/messages", hold_send)
    draft.fill("只发送一次的消息")
    draft.press("Enter")
    expect(send).to_be_disabled()
    draft.fill("发送期间新输入的草稿")
    draft.press("Enter")
    assert len(held) == 1, f"重复提交: {len(held)}"
    with page.expect_response(lambda r: r.request.method == "POST" and "/messages" in r.url):
        held.pop().continue_()
    expect(send).not_to_be_disabled()
    expect(draft).to_have_value("发送期间新输入的草稿")
    page.unroute("**/api/groups/*/messages", hold_send)
    report["checks"].append("UI-04: pending时防重复，成功保留期间的新草稿")

    def fail_send(route):
        if route.request.method == "POST":
            route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"code": "ui_test_write_unavailable", "message": "测试写入失败"}}))
        else:
            route.continue_()
    page.route("**/api/groups/*/messages", fail_send)
    draft.fill("失败后仍应保留")
    send.click()
    expect(page.get_by_test_id("chat-error")).to_be_visible()
    expect(draft).to_have_value("失败后仍应保留")
    page.unroute("**/api/groups/*/messages", fail_send)
    report["checks"].append("UI-04: 写入失败保留草稿并显示错误")

    held.clear()
    page.route("**/api/groups/*/messages", hold_send)
    draft.fill("发送后立即切换群组")
    draft.press("Enter")
    expect(send).to_be_disabled()
    page.get_by_test_id("chat-group").select_option(group_b)
    expect(page.get_by_test_id("chat-messages")).to_contain_text("这条消息只属于设计讨论。")
    with page.expect_response(lambda r: r.request.method == "POST" and "/messages" in r.url):
        held.pop().continue_()
    page.wait_for_timeout(100)
    expect(page.get_by_test_id("chat-messages")).not_to_contain_text("发送后立即切换群组")
    page.unroute("**/api/groups/*/messages", hold_send)
    report["checks"].append("UI-04: 旧群发送回包不会污染切换后的群组")

    page.goto(origin + "/projects")
    name = page.get_by_test_id("new-project-name")
    expect(name).to_be_visible()
    assert name.evaluate("el => !!(el.labels?.length || el.getAttribute('aria-label'))"), "项目名称缺少标签"
    name.fill("浏览器操作创建的项目")
    page.get_by_test_id("create-project").click()
    expect(page.get_by_test_id("project-detail")).to_contain_text("浏览器操作创建的项目")
    expect(page.get_by_test_id("notice")).to_be_visible()
    member = page.get_by_test_id("new-member-name")
    member.fill("可访问性验证成员")
    page.get_by_test_id("add-member").click()
    expect(page.get_by_test_id("member-list")).to_contain_text("可访问性验证成员")
    expect(page.get_by_test_id("notice")).to_be_visible()
    page.get_by_test_id("new-group-name").fill("浏览器创建群组")
    page.get_by_test_id("participant-picker").get_by_role("checkbox").first.check()
    page.get_by_test_id("create-group").click()
    expect(page.get_by_test_id("group-list")).to_contain_text("浏览器创建群组")
    page.get_by_test_id("project-actions").locator("summary").click()
    page.get_by_test_id("purge-project").click()
    expect(page.get_by_test_id("project-purge-confirm")).to_be_visible()
    page.get_by_test_id("cancel-purge-project").click()
    expect(page.get_by_test_id("project-detail")).to_contain_text("浏览器操作创建的项目")
    report["checks"].append("UI-05: 真实项目/成员/群组创建、成功反馈与取消永久删除")
    page.goto(origin + "/org")
    page.get_by_label("项目", exact=True).select_option(project_id)
    page.get_by_test_id("org-edit-node").first.click()
    editor = page.get_by_role("region", name="编辑岗位：项目统筹", exact=True)
    editor.get_by_label("岗位名称", exact=True).fill("协作统筹")
    editor.get_by_role("button", name="改名", exact=True).click()
    expect(page.get_by_test_id("notice")).to_contain_text("岗位已改名")
    expect(page.get_by_test_id("org-node-list")).to_contain_text("协作统筹")
    page.goto(origin + "/audit")
    page.get_by_test_id("audit-project-select").select_option(project_id)
    page.get_by_test_id("audit-revoke").first.click()
    expect(page.get_by_test_id("audit-notice")).to_contain_text("已撤销")
    report["checks"].append("UI-05: 组织按需编辑、实际改名与审计撤销")
    assert not errors, f"页面JavaScript错误: {errors}"
    report["status"] = "PASS"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-only", action="store_true")
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/webui-e2e")
    parser.add_argument("--web-root", type=Path)
    args = parser.parse_args()
    output = args.artifacts.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "FAIL", "at": datetime.now(timezone.utc).isoformat(), "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "scope": "real Chromium / temporary SQLite / no model invocation"}
    env = os.environ.copy()
    if args.web_root:
        env["AGENT_STUDIO_WEBUI_TEST_ROOT"] = str(args.web_root.resolve())
    fixture = None
    try:
        fixture = subprocess.Popen(["node", "scripts/managed-web-fixture.mjs"], cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready, _, _ = select.select([fixture.stdout], [], [], 20)
        assert ready, "临时服务启动超时"
        line = fixture.stdout.readline()
        assert line, "临时服务未返回地址"
        origin = json.loads(line)["url"]
        parsed = urlsplit(origin)
        assert parsed.hostname == "127.0.0.1" and parsed.scheme == "http"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            report["chromium"] = browser.version
            context = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai")
            page = context.new_page()
            page.set_default_timeout(15000)
            try:
                records = seed(page, origin)
                exercise(page, origin, records, output, report, args.capture_only)
            except Exception:
                if not page.is_closed(): page.screenshot(path=str(output / "failure.png"), full_page=True)
                raise
            finally:
                context.close()
                browser.close()
    except Exception as error:
        report["error"] = str(error)[:5000]
    finally:
        if fixture:
            fixture.stdin.close()
            try: fixture.wait(timeout=10)
            except subprocess.TimeoutExpired:
                fixture.terminate()
                fixture.wait(timeout=5)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] in ("PASS", "CAPTURED_BASELINE") else 1

if __name__ == "__main__":
    raise SystemExit(main())
