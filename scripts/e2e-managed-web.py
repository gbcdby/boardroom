#!/usr/bin/env python3
"""#88/#89：真实 Chromium + 真实 HTTP/SQLite；不验证或模拟模型宿主成功。

先 npm run build，再 python scripts/e2e-managed-web.py [--ci]。
报告与截图默认写入 .agent-output/managed-web-e2e；CI 必须全部通过。
本地 Chromium 因环境限制无法启动时返回 2 / NOT_RUN_LOCAL，不冒充浏览器验收。
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from importlib.metadata import version
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright


ROOT = Path(__file__).resolve().parent.parent
PLAYWRIGHT_VERSION = "1.62.0"


def api(page, origin: str, endpoint: str) -> dict:
    response = page.request.get(origin + endpoint)
    assert response.status == 200, f"读取验收服务失败：{endpoint} / {response.status}"
    return response.json()


def mutation(page, method: str, url: str, click, status: int = 200) -> dict | None:
    with page.expect_response(lambda response: response.url == url and response.request.method == method) as pending:
        click()
    response = pending.value
    assert response.status == status, f"页面提交失败：{method} / {response.status}"
    return None if status == 204 else response.json()


def check_layout(page, label: str) -> dict:
    measured = page.evaluate("""() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        headingVisible: !!document.querySelector('h1')?.getBoundingClientRect().width
    })""")
    assert measured["headingVisible"], f"{label}：页面标题缺失"
    assert max(measured["document"], measured["body"]) <= measured["viewport"] + 1, f"{label}：页面横向溢出 {measured}"
    return {"viewport": label, **measured}


def exercise(page, fixture: dict, artifacts: Path, report: dict) -> None:
    origin = fixture["url"]
    errors: list[dict] = []
    outside_requests: list[str] = []
    page.on("pageerror", lambda error: errors.append({"kind": "pageerror", "message": str(error)[:1500]}))
    page.on("console", lambda message: errors.append({"kind": "console", "message": message.text[:1500]}) if message.type == "error" else None)

    def route_request(route):
        parsed = urlsplit(route.request.url)
        if parsed.scheme in ("http", "https") and f"{parsed.scheme}://{parsed.netloc}" != origin:
            outside_requests.append(parsed.hostname or "unknown")
            route.abort()
        else:
            route.continue_()

    page.route("**/*", route_request)
    report["browserErrors"] = errors
    report["outsideRequests"] = outside_requests
    report["checks"] = []
    report["layouts"] = []

    def passed(key: str, detail: str) -> None:
        report["checks"].append({"id": key, "status": "PASS", "detail": detail})
        print(f"PASS {key}: {detail}", flush=True)

    def screenshot(name: str) -> None:
        page.screenshot(path=str(artifacts / name), full_page=True, animations="disabled")
        report.setdefault("screenshots", []).append(name)

    page.goto(f"{origin}/runtimes?projectId={fixture['projectId']}&groupId={fixture['groupId']}")
    expect(page.get_by_role("heading", name="托管 Agent", exact=True)).to_be_visible()
    page.get_by_test_id("open-runtime-create").click()
    form = page.get_by_test_id("runtime-create-form")
    expect(form).to_be_visible()
    page.get_by_test_id("runtime-name").fill("浏览器托管助手")
    expect(page.get_by_test_id("runtime-backend")).to_have_value("claude-code")
    page.locator("#runtime-create-workdir").fill(fixture["workdir"])
    page.locator("#runtime-create-model").fill("baseline-model")
    expect(form.get_by_test_id("runtime-advanced")).to_have_count(0)
    result = mutation(page, "POST", origin + "/api/runtimes", page.get_by_test_id("runtime-create").click, 201)
    runtime = result["runtime"]
    runtime_id = runtime["runtime"]["id"]
    binding = runtime["bindings"][0]
    binding_id = binding["binding"]["id"]
    member_id = binding["binding"]["memberId"]
    binding_url = origin + f"/api/runtime-bindings/{binding_id}"
    runtime_url = origin + f"/api/runtimes/{runtime_id}"
    card = page.locator(f'[data-binding-id="{binding_id}"]')
    expect(form).to_have_count(0)
    expect(card.get_by_test_id("runtime-summary")).to_have_text("已停止")
    assert binding["binding"]["desiredState"] == "stopped"
    assert binding["binding"]["projectId"] == fixture["projectId"] and binding["binding"]["groupId"] == fixture["groupId"]
    assert binding["runner"]["applied"] is None and binding["runner"]["generation"] == 0
    assert binding["binding"]["advanced"] is None and binding["binding"]["overrides"] == {}
    passed("R5-1-create-stopped", "浏览器创建真实记录；初始 stopped、无应用快照、无高级授权。")
    screenshot("01-created-desktop.png")

    card.get_by_test_id("runtime-edit-binding").click()
    expect(page.locator("#runtime-binding-model")).to_be_disabled()
    expect(page.get_by_role("checkbox", name="模型：单独设置", exact=True)).not_to_be_checked()
    expect(page.get_by_test_id("runtime-advanced")).not_to_be_checked()
    page.get_by_role("checkbox", name="模型：单独设置", exact=True).check()
    page.locator("#runtime-binding-model").fill("group-override")
    page.get_by_test_id("runtime-advanced").check()
    saved = mutation(page, "PUT", binding_url, page.get_by_test_id("runtime-save-config").click)["binding"]
    assert saved["binding"]["overrides"]["model"] == "group-override"
    assert saved["binding"]["advanced"]["bindingRevision"] == saved["binding"]["revision"]
    assert saved["pendingChanges"] is True and saved["runner"]["applied"] is None
    expect(card.get_by_test_id("runtime-pending")).to_be_visible()
    passed("R5-2-save-is-candidate", "群组覆盖保存为待应用；没有启动或替换已应用快照。")

    card.get_by_test_id("runtime-edit-binding").click()
    expect(page.get_by_test_id("runtime-advanced")).not_to_be_checked()
    cleared = mutation(page, "PUT", binding_url, page.get_by_test_id("runtime-save-config").click)["binding"]
    assert cleared["binding"]["advanced"] is None
    passed("R5-2-advanced-revision", "高级选择绑定修订；重新打开编辑默认关闭，保存新修订清除旧选择。")

    page.get_by_role("button", name="全局默认", exact=True).click()
    page.locator("#runtime-default-model").fill("next-default")
    updated = mutation(page, "PUT", runtime_url, page.get_by_test_id("runtime-save-config").click)["runtime"]
    assert updated["runtime"]["name"] == "浏览器托管助手" and updated["runtime"]["backend"] == "claude-code"
    assert updated["runtime"]["defaults"]["model"] == "next-default"
    assert updated["bindings"][0]["effective"]["config"]["model"] == "group-override"
    assert updated["bindings"][0]["runner"]["applied"] is None
    card.get_by_role("button", name="配置与运行观测", exact=True).click()
    model_row = card.locator("tbody tr").filter(has_text="模型").first
    expect(model_row).to_contain_text("group-override")
    expect(model_row).to_contain_text("本群覆盖")
    expect(card.get_by_test_id("runtime-usage-unknown")).to_be_visible()
    expect(card.get_by_text("累计投递记录", exact=True)).to_be_visible()
    expect(card.get_by_text("唤醒记录", exact=True)).to_be_visible()
    passed("R5-2-inheritance", "默认值更新保留显式群组覆盖；有效来源可见，name/backend 保持稳定。")
    passed("R5-3-R5-4-observation", "运行、MCP、成员、唤醒及 ACK 分层显示；未采得用量显示未知。")
    report["layouts"].append(check_layout(page, "desktop-1440"))
    screenshot("02-configuration-desktop.png")

    card.get_by_test_id("runtime-edit-binding").click()
    page.get_by_role("checkbox", name="模型：单独设置", exact=True).uncheck()
    expect(page.locator("#runtime-binding-model")).to_be_disabled()
    expect(page.locator("#runtime-binding-model")).to_have_value("next-default")
    inherited = mutation(page, "PUT", binding_url, page.get_by_test_id("runtime-save-config").click)["binding"]
    assert "model" not in inherited["binding"]["overrides"]
    assert inherited["effective"]["config"]["model"] == "next-default" and inherited["effective"]["sources"]["model"] == "default"
    assert inherited["runner"]["applied"] is None
    passed("R5-2-restore-inheritance", "取消单独设置后恢复当前默认值，仍保持待应用。")

    page.set_viewport_size({"width": 390, "height": 844})
    report["layouts"].append(check_layout(page, "mobile-390"))
    screenshot("03-configuration-mobile.png")
    card.get_by_test_id("runtime-edit-binding").click()
    expect(page.get_by_test_id("runtime-advanced")).not_to_be_checked()
    report["layouts"].append(check_layout(page, "mobile-editor-390"))
    screenshot("04-editor-mobile.png")
    page.get_by_test_id("runtime-config-form").get_by_role("button", name="取消", exact=True).click()
    page.set_viewport_size({"width": 1440, "height": 1000})

    mutation(page, "POST", binding_url + "/actions", card.get_by_test_id("runtime-start").click)
    expect(card.locator(".capability-notice").first).to_be_visible(timeout=20_000)
    state = api(page, origin, f"/api/runtime-bindings/{binding_id}")["binding"]
    assert state["binding"]["desiredState"] == "running"
    assert state["status"]["capability"]["supported"] is False
    assert state["status"]["capability"]["reason"] == "host_version_unknown"
    assert state["runner"]["state"] == "stopped" and state["runner"]["generation"] == 0 and state["runner"]["pid"] is None
    assert state["runner"]["applied"] is None and state["status"]["summary"] != "running"
    expect(page.get_by_role("button", name="删除配置", exact=True)).to_be_disabled()
    passed("R5-3-production-unsupported", "真实生产 launcher 拒绝缺失的 CLI 安装；显示原因，无 CLI 模型轮次或受管进程。")
    screenshot("05-unsupported-desktop.png")

    mutation(page, "POST", binding_url + "/actions", card.get_by_test_id("runtime-stop").click)
    expect(card.get_by_test_id("runtime-summary")).to_have_text("已停止")
    stopped = api(page, origin, f"/api/runtime-bindings/{binding_id}")["binding"]
    assert stopped["binding"]["desiredState"] == "stopped" and stopped["runner"]["exitConfirmed"] is True

    # 全局 Runtime 可复用到显式选择的项目，同一身份与其他绑定保持不变。
    created_project = page.request.post(origin + "/api/projects", data={"name": "复用托管身份的项目"})
    assert created_project.status == 201
    other_project_id = created_project.json()["project"]["id"]
    created_group = page.request.post(origin + f"/api/projects/{other_project_id}/groups", data={"name": "复用验收群", "participantMemberIds": []})
    assert created_group.status == 201
    other_group_id = created_group.json()["group"]["id"]
    page.goto(f"{origin}/runtimes?projectId={other_project_id}")
    page.get_by_test_id("runtime-reuse-open").click()
    expect(page.get_by_test_id("runtime-existing-select")).to_have_value(runtime_id)
    expect(page.get_by_test_id("runtime-binding-project")).to_have_value(other_project_id)
    page.set_viewport_size({"width": 390, "height": 844})
    report["layouts"].append(check_layout(page, "mobile-reuse-390"))
    screenshot("06-reuse-existing-mobile.png")
    reused = mutation(page, "POST", runtime_url + "/bindings", page.get_by_test_id("runtime-add-binding").click, 201)["binding"]
    assert reused["binding"]["runtimeId"] == runtime_id
    assert reused["binding"]["projectId"] == other_project_id and reused["binding"]["groupId"] == other_group_id
    assert reused["binding"]["memberId"] != member_id and reused["binding"]["desiredState"] == "stopped"
    bindings = api(page, origin, f"/api/runtimes/{runtime_id}")["runtime"]["bindings"]
    assert len(bindings) == 2 and any(item["binding"]["id"] == binding_id for item in bindings)
    passed("R5-cross-project-reuse", "在新项目选择已有全局身份，新增停止的独立绑定并保留原项目绑定。")

    page.goto(origin + "/collaboration/connections?view=all#runtime-scope")
    expect(page.get_by_test_id("runtime-project-filter")).to_have_value("")
    expect(page.locator("[data-binding-id]")).to_have_count(2)
    page.get_by_test_id("runtime-project-filter").select_option(other_project_id)
    expect(page.locator("[data-binding-id]")).to_have_count(1)
    expect(page.locator(f'[data-binding-id="{reused["binding"]["id"]}"]')).to_be_visible()
    page.get_by_test_id("runtime-group-filter").select_option(other_group_id)
    page.get_by_test_id("runtime-scope-clear").click()
    expect(page.get_by_test_id("runtime-project-filter")).to_have_value("")
    expect(page.get_by_test_id("runtime-group-filter")).to_have_value("")
    expect(page.locator("[data-binding-id]")).to_have_count(2)
    scope_url = urlsplit(page.url)
    assert parse_qs(scope_url.query) == {"view": ["all"]} and scope_url.fragment == "runtime-scope"
    page.get_by_test_id("open-runtime-create").click()
    expect(page.get_by_test_id("runtime-create-project")).to_have_value("")
    expect(page.get_by_test_id("runtime-create")).to_be_disabled()
    page.get_by_test_id("runtime-name").fill("全局范围未保存的配置")
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.get_by_test_id("runtime-project-filter").select_option(fixture["projectId"])
    expect(page.get_by_test_id("runtime-project-filter")).to_have_value("")
    expect(page.get_by_test_id("runtime-name")).to_have_value("全局范围未保存的配置")
    page.get_by_test_id("runtime-create-form").get_by_role("button", name="取消", exact=True).click()
    assert len(api(page, origin, "/api/runtimes")["runtimes"]) == 1
    screenshot("06-global-runtime-scope.png")
    passed("S6-visible-runtime-scope", "全局入口显示跨项目绑定，显式筛选可清空并保留query/hash；新建需选择项目，取消切换保留草稿。")

    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(f"{origin}/runtimes?projectId={fixture['projectId']}")
    expect(card.get_by_test_id("runtime-summary")).to_have_text("已停止")
    remove = page.get_by_role("button", name="删除配置", exact=True)
    remove.click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible()
    assert len(api(page, origin, "/api/runtimes")["runtimes"]) == 1
    screenshot("06-delete-confirmation.png")
    dialog.get_by_role("button", name="取消", exact=True).click()
    expect(dialog).not_to_be_visible()
    assert len(api(page, origin, "/api/runtimes")["runtimes"]) == 1
    remove.click()
    mutation(page, "DELETE", runtime_url, page.get_by_test_id("runtime-confirm").click, 204)
    expect(card).to_have_count(0)
    assert api(page, origin, "/api/runtimes")["runtimes"] == []
    participants = api(page, origin, f"/api/groups/{fixture['groupId']}/participants")["participants"]
    assert any(member["id"] == member_id for member in participants)
    passed("R5-3-stop-delete", "停止后才可删除；取消确认保留配置，确认移除后成员身份保留。")
    assert not errors, f"浏览器控制台或页面错误：{errors}"
    assert not outside_requests, f"页面尝试请求验收服务外的地址：{outside_requests}"
    passed("R5-5-browser-clean", "真实 Chromium 完成 DOM 交互；桌面/窄屏无页面横向溢出，控制台无错误。")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ci", action="store_true", help="浏览器不可用也必须判定失败")
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/managed-web-e2e")
    args = parser.parse_args()
    ci = args.ci or os.environ.get("CI", "").lower() == "true"
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    report = {"status": "FAIL", "startedAt": datetime.now(timezone.utc).isoformat(), "mode": "ci" if ci else "local",
              "playwright": version("playwright"), "modelInvocation": "NOT_RUN", "hostSupport": "unsupported",
              "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()}
    fixture_process = None
    browser = None
    page = None
    exit_code = 1
    try:
        assert report["playwright"] == PLAYWRIGHT_VERSION, f"需要 Playwright {PLAYWRIGHT_VERSION}"
        fixture_process = subprocess.Popen(["node", "scripts/managed-web-fixture.mjs"], cwd=ROOT,
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready, _, _ = select.select([fixture_process.stdout], [], [], 20)
        assert ready, "临时验收服务启动超时"
        line = fixture_process.stdout.readline()
        assert line, "临时验收服务启动失败"
        fixture = json.loads(line)
        parsed = urlsplit(fixture["url"])
        assert parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port
        assert fixture["hostScenario"] == "missing-configured-cli"
        report["hostScenario"] = fixture["hostScenario"]
        with sync_playwright() as playwright:
            try:
                browser = playwright.chromium.launch(headless=True)
            except PlaywrightError as error:
                if not ci and re.search(r"Operation not permitted|Permission denied|Executable doesn't exist", str(error), re.I):
                    report.update(status="NOT_RUN_LOCAL", reason="browser_launch_environment_blocked", detail=str(error)[:2500])
                    exit_code = 2
                else:
                    raise
            if browser:
                report["chromium"] = browser.version
                context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="zh-CN", timezone_id="UTC")
                page = context.new_page()
                page.set_default_timeout(15_000)
                try:
                    exercise(page, fixture, artifacts, report)
                    report["status"] = "PASS"
                    exit_code = 0
                except Exception:
                    if not page.is_closed():
                        page.screenshot(path=str(artifacts / "failure.png"), full_page=True, animations="disabled")
                    raise
                finally:
                    context.close()
                    browser.close()
    except Exception as error:
        report.update(status="FAIL", errorType=type(error).__name__, detail=str(error)[:3500])
    finally:
        if fixture_process:
            if fixture_process.stdin:
                try:
                    fixture_process.stdin.close()
                except OSError:
                    pass
            try:
                fixture_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                fixture_process.terminate()
                try:
                    fixture_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    fixture_process.kill()
                    fixture_process.wait(timeout=5)
            if fixture_process.returncode != 0 and report["status"] == "PASS":
                report.update(status="FAIL", reason="fixture_cleanup_failed")
                exit_code = 1
            report["fixtureExitCode"] = fixture_process.returncode
            if fixture_process.returncode != 0 and fixture_process.stderr:
                report["fixtureError"] = fixture_process.stderr.read(2000)
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        (artifacts / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "checks": len(report.get("checks", [])), "report": str(artifacts / "report.json")}, ensure_ascii=False), flush=True)
        if report["status"] != "PASS":
            print(json.dumps({key: report[key] for key in ("reason", "errorType", "detail", "fixtureError") if key in report}, ensure_ascii=False), flush=True)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
