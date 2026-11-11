#!/usr/bin/env python3
"""S6-T3：真实 Chromium、隔离 SQLite 的导航、作用域、创建与草稿回归。"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import traceback
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
helpers_spec = importlib.util.spec_from_file_location("navigation_web_helpers", ROOT / "scripts/e2e-webui.py")
helpers = importlib.util.module_from_spec(helpers_spec)
helpers_spec.loader.exec_module(helpers)


def exercise(page, origin, output, report):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    records = helpers.seed(page, origin)
    pid = records[0]["project"]["id"]
    gid = records[0]["groups"][0]["id"]
    second = records[1]["project"]["id"]
    report["checks"] = []
    page.goto(origin + "/")
    expect(page.get_by_role("heading", name="协作总览", exact=True)).to_be_visible()
    expect(page.get_by_test_id("current-project")).to_have_count(0)
    page.goto(origin + "/projects")
    expect(page.get_by_test_id("current-project")).to_have_count(0)
    expect(page.get_by_test_id("project-detail")).to_have_count(0)
    expect(page.get_by_test_id("new-project-name")).to_have_count(0)
    report["checks"].append("全局总览/项目列表不强制项目、不展开项目长表单")

    page.get_by_test_id("open-create-project").click()
    expect(page.get_by_test_id("new-project-name")).to_be_focused()
    page.keyboard.press("Shift+Tab")
    expect(page.get_by_test_id("create-project")).to_be_focused()
    page.keyboard.press("Tab")
    expect(page.get_by_test_id("new-project-name")).to_be_focused()
    page.keyboard.press("Escape")
    expect(page.get_by_test_id("creation-dialog")).to_have_count(0)
    expect(page.get_by_test_id("open-create-project")).to_be_focused()
    page.get_by_test_id("open-create-project").click()
    page.get_by_test_id("new-project-name").fill("尚未保存的项目草稿")
    page.keyboard.press("Escape")
    expect(page.get_by_test_id("creation-dialog")).to_contain_text("放弃未保存的内容")
    page.get_by_role("button", name="继续编辑", exact=True).click()
    expect(page.get_by_test_id("new-project-name")).to_have_value("尚未保存的项目草稿")
    page.get_by_test_id("new-project-name").fill("导航回归创建的项目")
    page.get_by_test_id("create-project").click()
    expect(page.get_by_test_id("creation-dialog")).to_have_count(0)
    expect(page.get_by_test_id("project-detail")).to_contain_text("导航回归创建的项目")
    created = urlsplit(page.url).path.split("/")[2]
    assert created != pid
    page.get_by_test_id("open-add-member").click()
    page.get_by_test_id("new-member-name").fill("导航成员")
    page.get_by_test_id("add-member").click()
    expect(page.get_by_test_id("member-list")).to_contain_text("导航成员")
    page.get_by_test_id("open-create-group").click()
    page.get_by_test_id("new-group-name").fill("导航验证群")
    page.get_by_test_id("participant-picker").get_by_label("导航成员", exact=True).check()
    page.get_by_test_id("create-group").click()
    expect(page.get_by_test_id("creation-dialog")).to_have_count(0)
    expect(page.get_by_test_id("group-list")).to_contain_text("导航验证群")
    expect(page.get_by_test_id("sidebar-project-tree")).to_contain_text("导航验证群")
    report["checks"].append("创建弹窗初焦/正反Tab/Esc/还焦、脏草稿继续、真实项目成员群创建与侧栏更新")

    group_row = page.get_by_test_id("group-list").locator("li.group-item").filter(has_text="导航验证群")
    group_management = group_row.get_by_test_id("group-management")
    def open_group_management():
        if group_management.get_attribute("open") is None:
            group_management.locator("summary").click()
    open_group_management()
    group_row.get_by_test_id("archive-group").click()
    page.get_by_test_id("confirm-cancel").click()
    expect(page.get_by_test_id("sidebar-project-tree")).to_contain_text("导航验证群")
    group_row.get_by_test_id("archive-group").click()
    page.get_by_test_id("confirm-submit").click()
    expect(page.get_by_test_id("sidebar-project-tree")).not_to_contain_text("导航验证群")
    page.get_by_test_id("toggle-archived").click()
    open_group_management()
    group_row.get_by_role("button", name="恢复群组", exact=True).click()
    expect(page.get_by_test_id("sidebar-project-tree")).to_contain_text("导航验证群")
    open_group_management()
    group_row.get_by_test_id("purge-group").click()
    page.get_by_test_id("confirm-purge-group").click()
    expect(page.get_by_test_id("sidebar-project-tree")).not_to_contain_text("导航验证群")
    expect(page.get_by_test_id("group-list")).to_have_count(0)
    expect(page.get_by_test_id("member-list")).to_contain_text("导航成员")
    report["checks"].append("群归档取消不变更；确认归档/恢复/永久删除后侧栏与主列表同步，项目成员保留")

    for entry, target, tab in [("tasks", "tasks", None), ("chat", "chat", None), ("groups", "chat", None),
                               ("members", "members", None), ("org", "members", "organization"),
                               ("status", "members", "status"), ("audit", "activity", None), ("memory", "knowledge", None)]:
        for legacy in [f"/{entry}?projectId={pid}", f"/projects/{pid}/{entry}?projectId={second}"]:
            suffix = f"&groupId={gid}" if entry in ("chat", "groups") else ""
            page.goto(origin + legacy + suffix + "&filter=active#saved-anchor")
            path = f"/projects/{pid}/{target}" + (f"/{gid}" if entry in ("chat", "groups") else "")
            # 显式项目路径在首次文档加载时已匹配；项目读取完成后守卫才会清理 query。
            page.wait_for_url(lambda url: (
                urlsplit(str(url)).path == path
                and "projectId" not in parse_qs(urlsplit(str(url)).query, keep_blank_values=True)
            ))
            actual = urlsplit(page.url)
            query = parse_qs(actual.query)
            assert query.get("filter") == ["active"] and actual.fragment == "saved-anchor", page.url
            assert "projectId" not in query, page.url
            if tab:
                assert query.get("tab") == [tab], page.url
            expect(page.get_by_test_id("current-project")).to_have_value(pid)
    page.goto(origin + f"/runtimes?projectId={pid}&groupId={gid}#runtime")
    page.wait_for_url(lambda url: urlsplit(str(url)).path == "/collaboration/connections")
    query = parse_qs(urlsplit(page.url).query)
    assert query["projectId"] == [pid] and query["groupId"] == [gid]
    assert urlsplit(page.url).fragment == "runtime"
    expect(page.get_by_test_id("current-project")).to_have_count(0)
    report["checks"].append("全部旧入口和显式项目深链兼容；对象/query/hash保留；连接全局入口不强制项目")

    page.goto(origin + f"/projects/{pid}/members")
    page.get_by_test_id("open-add-member").click()
    page.get_by_test_id("new-member-name").fill("切换前保留的草稿")
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.locator(".project-section-nav").get_by_role("link", name="知识", exact=True).click()
    expect(page.get_by_test_id("new-member-name")).to_have_value("切换前保留的草稿")
    assert urlsplit(page.url).path == f"/projects/{pid}/members"
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.get_by_test_id("current-project").select_option(second)
    expect(page.get_by_test_id("current-project")).to_have_value(pid)
    expect(page.get_by_test_id("new-member-name")).to_have_value("切换前保留的草稿")
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_test_id("current-project").select_option(second)
    page.wait_for_url(lambda url: urlsplit(str(url)).path == f"/projects/{second}/members")
    expect(page.get_by_test_id("new-member-name")).to_have_value("")
    page.locator(".subview-tabs").get_by_role("link", name="组织与岗位", exact=True).click()
    expect(page.get_by_role("heading", name="组织与角色", exact=True)).to_be_visible()
    page.get_by_test_id("current-project").select_option(pid)
    page.wait_for_url(lambda url: urlsplit(str(url)).path == f"/projects/{pid}/members")
    assert parse_qs(urlsplit(page.url).query).get("tab") == ["organization"]
    report["checks"].append("取消路由/项目切换保留草稿与作用域，确认后切换；组织标签随项目切换保留")

    page.goto(origin + "/projects")
    page.get_by_test_id("project-search").fill("Boardroom 产品迭代")
    page.wait_for_url(lambda url: parse_qs(urlsplit(str(url)).query).get("q") == ["Boardroom 产品迭代"])
    page.get_by_test_id("project-list").get_by_role("button", name="Boardroom 产品迭代", exact=True).click()
    expect(page.get_by_test_id("project-detail")).to_contain_text("Boardroom 产品迭代")
    page.go_back()
    expect(page.get_by_test_id("project-search")).to_have_value("Boardroom 产品迭代")
    report["checks"].append("项目列表筛选随浏览器返回恢复；进入项目不在列表下展开")

    for width, theme in [(1440, "light"), (390, "light"), (1440, "dark"), (390, "dark")]:
        page.set_viewport_size({"width": width, "height": 900})
        page.emulate_media(color_scheme=theme, reduced_motion="reduce")
        for name, path in [("home", "/"), ("projects", "/projects"), ("overview", f"/projects/{pid}/overview"),
                           ("members", f"/projects/{pid}/members"), ("groups", f"/projects/{pid}/chat?manage=groups"),
                           ("settings", f"/projects/{pid}/settings")]:
            page.goto(origin + path)
            expect(page.locator("main h1")).to_be_visible()
            helpers.settle_viewport(page, width, 900)
            helpers.layout(page, f"{name}-{width}-{theme}")
            page.screenshot(path=str(output / f"{name}-{width}-{theme}.png"), full_page=True)
        page.goto(origin + "/projects")
        page.get_by_test_id("open-create-project").click()
        expect(page.get_by_test_id("new-project-name")).to_be_focused()
        helpers.settle_viewport(page, width, 900)
        dialog = page.get_by_test_id("creation-dialog")
        bounds = dialog.bounding_box()
        assert bounds and bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= width + 1
        expect(page.get_by_test_id("cancel-create")).to_be_in_viewport(ratio=1)
        expect(page.get_by_test_id("create-project")).to_be_in_viewport(ratio=1)
        page.screenshot(path=str(output / f"create-project-{width}-{theme}.png"), full_page=True)
        page.keyboard.press("Escape")
        if width == 390:
            page.get_by_role("button", name="展开导航", exact=True).click()
            expect(page.get_by_test_id("sidebar-project-tree")).to_be_visible()
            page.keyboard.press("Escape")
            expect(page.get_by_role("button", name="展开导航", exact=True)).to_be_focused()
    assert not errors, errors
    report["checks"].append("1440/390浅深页面与创建弹窗真实截图，无整页溢出，窄屏导航Esc还焦")
    report["status"] = "PASS"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/navigation-web")
    parser.add_argument("--web-root", type=Path)
    args = parser.parse_args()
    output = args.artifacts.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "FAIL", "at": datetime.now(timezone.utc).isoformat(), "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "scope": "S6-T3 real Chromium / temporary SQLite / no model invocation"}
    env = os.environ.copy()
    if args.web_root:
        env["AGENT_STUDIO_WEBUI_TEST_ROOT"] = str(args.web_root.resolve())
    fixture = None
    try:
        fixture = subprocess.Popen(["node", "scripts/managed-web-fixture.mjs"], cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready, _, _ = select.select([fixture.stdout], [], [], 20)
        assert ready, "临时服务启动超时"
        info = json.loads(fixture.stdout.readline())
        origin = info["url"]
        assert urlsplit(origin).hostname == "127.0.0.1"
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            report["chromium"] = browser.version
            context = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai", viewport={"width": 1440, "height": 1000})
            page = context.new_page()
            page.set_default_timeout(15000)
            try:
                exercise(page, origin, output, report)
            except Exception:
                if not page.is_closed():
                    page.screenshot(path=str(output / "failure.png"), full_page=True)
                raise
            finally:
                context.close()
                browser.close()
    except Exception as error:
        report["error"] = str(error)[:5000]
        report["traceback"] = traceback.format_exc()
    finally:
        if fixture:
            fixture.stdin.close()
            try:
                fixture.wait(timeout=10)
            except subprocess.TimeoutExpired:
                fixture.terminate()
                fixture.wait(timeout=5)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
