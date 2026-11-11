#!/usr/bin/env python3
"""真实 Chromium 的任务与共享项目回归。合成报告只用于 UI 验收，不执行模型。"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import select
import subprocess
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent

def request(page, origin, method, path, body=None):
    response = page.request.fetch(origin + path, method=method, data=body)
    assert response.ok, f"{method} {path}: {response.status} {response.text()[:500]}"
    return response.json() if response.status != 204 else None

def exercise_quick_intake(page, fixture, output, report):
    origin = fixture["url"]
    page.emulate_media(color_scheme="light", reduced_motion="reduce")
    first = fixture["records"][0]
    pid = first["project"]["id"]
    collection = f"/api/projects/{pid}/tasks"
    # 原生弹窗的首字段、summary 键盘路径、窄屏滚动和内层放弃确认。
    for width, height in [(1440, 1000), (390, 844), (390, 560)]:
        page.set_viewport_size({"width": width, "height": height})
        page.goto(origin + f"/projects/{pid}/tasks")
        page.get_by_test_id("task-create-open").click()
        expect(page.get_by_test_id("task-title")).to_be_focused()
        expect(page.get_by_test_id("task-create")).to_be_disabled()
        page.get_by_test_id("task-title").fill(f"待放弃的草稿 {width}×{height}")
        page.keyboard.press("Tab")
        expect(page.locator(".task-optional-fields > summary")).to_be_focused()
        page.keyboard.press("Enter")
        page.keyboard.press("Tab")
        expect(page.get_by_test_id("task-body")).to_be_focused()
        page.get_by_test_id("task-body").fill("可以稍后补齐，关闭前保留输入。")
        page.locator(".task-candidate-fields > summary").click()
        page.get_by_test_id("task-fixed-point").fill("main")
        dimensions = page.get_by_test_id("creation-dialog").evaluate("el => ({width:el.getBoundingClientRect().width, height:el.getBoundingClientRect().height, viewportWidth:innerWidth, viewportHeight:innerHeight, document:document.documentElement.scrollWidth, scrollHeight:el.querySelector('.creation-body').scrollHeight, clientHeight:el.querySelector('.creation-body').clientHeight})")
        assert dimensions["width"] <= width and dimensions["height"] <= height
        assert dimensions["document"] <= width + 1, dimensions
        if height == 560: assert dimensions["scrollHeight"] > dimensions["clientHeight"], dimensions
        key = f"task-quick-dialog-{width}x{height}"
        page.screenshot(path=str(output / f"{key}.png"), full_page=True, animations="disabled")
        report["screenshots"].append(f"{key}.png")
        report["layouts"].append({"view": key, **dimensions})
        page.keyboard.press("Escape")
        expect(page.get_by_role("heading", name="放弃未保存的内容？")).to_be_visible()
        page.get_by_role("button", name="继续编辑", exact=True).click()
        expect(page.get_by_test_id("task-title")).to_have_value(f"待放弃的草稿 {width}×{height}")
        page.get_by_test_id("cancel-create").click()
        page.get_by_test_id("discard-create").click()
        expect(page.get_by_test_id("creation-dialog")).to_have_count(0)
        expect(page.get_by_test_id("task-create-open")).to_be_focused()
    assert not any(r["method"] == "POST" and r["path"] == collection for r in report["taskRequests"])
    report["checks"].append("S5-T1: 1440/390×844/390×560快速弹窗、summary键盘路径、内部滚动、二次放弃与焦点恢复；取消不发送创建")

    page.set_viewport_size({"width": 1440, "height": 1000})
    # 延迟实际 POST；pending 时重复 submit 和 Escape 都不能形成第二次请求。
    held = []
    def hold_post(route):
        if route.request.method == "POST": held.append(route)
        else: route.continue_()
    page.route(origin + collection, hold_post)
    page.get_by_test_id("task-state-filter").select_option("todo")
    page.get_by_test_id("task-create-open").click()
    page.get_by_test_id("task-title").fill("仅标题快速录入")
    with page.expect_request(lambda req: req.method == "POST" and req.url == origin + collection):
        page.get_by_test_id("task-create").click()
    expect(page.get_by_test_id("task-create")).to_be_disabled()
    expect(page.get_by_test_id("cancel-create")).to_be_disabled()
    page.keyboard.press("Escape")
    expect(page.get_by_test_id("creation-dialog")).to_be_visible()
    page.evaluate("() => document.querySelector('[data-testid=task-create]').form.requestSubmit()")
    assert len(held) == 1
    held[0].continue_()
    expect(page.get_by_test_id("creation-dialog")).to_have_count(0)
    page.unroute(origin + collection, hold_post)
    expect(page.get_by_test_id("toast-host")).to_contain_text("已保存「仅标题快速录入」")
    expect(page.get_by_test_id("task-state-filter")).to_have_value("todo")
    quick = next(t for t in request(page, origin, "GET", collection)["tasks"] if t["title"] == "仅标题快速录入")
    assert quick["state"] == "todo" and quick["assigneeMemberId"] is None
    assert quick["body"] == "" and quick["acceptanceText"] == "" and quick["deliveryKind"] is None
    quick_writes = [r for r in report["taskRequests"] if r["method"] == "POST" and r["path"] == collection and r["body"].get("title") == quick["title"]]
    assert len(quick_writes) == 1
    page.reload()
    expect(page.get_by_test_id("task-board")).to_contain_text("仅标题快速录入")
    page.get_by_role("link", name="仅标题快速录入", exact=True).click()
    expect(page.get_by_test_id("task-start")).to_be_disabled()
    for issue in quick["materialStatus"]["startExecution"]["issues"]:
        expect(page.get_by_test_id("task-materials")).to_contain_text(issue["message"])
    expect(page.get_by_test_id("task-materials")).to_contain_text("不表示已创建执行实例")
    page.get_by_test_id("task-edit-open").click()
    page.get_by_test_id("task-body").fill("整理一份可复核的调查结论")
    page.get_by_test_id("task-acceptance").fill("包含来源、事实与剩余未知")
    page.get_by_test_id("task-delivery-kind").select_option("finding")
    page.get_by_test_id("task-assignee").select_option(first["members"][0]["id"])
    page.get_by_test_id("task-reviewer").select_option("__none__")
    page.get_by_test_id("task-save").click()
    expect(page.get_by_test_id("task-start")).to_be_enabled()
    page.get_by_test_id("task-start").click()
    expect(page.get_by_test_id("task-state")).to_have_text("进行中")
    expect(page.get_by_test_id("task-start-review")).to_be_disabled()
    expect(page.get_by_test_id("task-materials")).to_contain_text("分类产物评审尚未接入")
    completed = request(page, origin, "GET", f"{collection}/{quick['id']}")
    assert completed["task"]["reviewerMemberId"] is None and completed["rounds"] == []
    report["checks"].append("S5-T1: 标题持久化/刷新/待分派、真实慢响应仅一次POST、筛选保留、补齐可开始且缺reviewer不阻断；finding不能进入旧Git评审")

    # 真正的字段校验失败保留草稿，错误就地展示后可修正重试。
    page.goto(origin + f"/projects/{pid}/tasks")
    page.get_by_test_id("task-create-open").click()
    page.get_by_test_id("task-title").fill("字段错误仍保留的草稿")
    page.locator(".task-optional-fields > summary").click()
    page.get_by_test_id("task-labels").fill("字" * 41)
    page.get_by_test_id("task-create").click()
    expect(page.get_by_test_id("task-labels")).to_have_attribute("aria-invalid", "true")
    expect(page.get_by_test_id("task-title")).to_have_value("字段错误仍保留的草稿")
    expect(page.get_by_test_id("creation-dialog")).to_contain_text("标签超过允许的长度或数量")
    page.screenshot(path=str(output / "task-quick-field-error-1440.png"), full_page=True, animations="disabled")
    report["screenshots"].append("task-quick-field-error-1440.png")
    page.get_by_test_id("task-labels").fill("已修正")
    page.get_by_test_id("task-create").click()
    expect(page.get_by_test_id("creation-dialog")).to_have_count(0)
    report["checks"].append("S5-T1: 真实400字段错误绑定原字段并保留标题，修正后重试成功")

    # 服务已提交但响应丢失；403 读失败与关窗重开均不得解锁第二次 POST。
    unknown_writes = []
    fail_read = [False]
    def lose_response(route):
        if route.request.method == "POST":
            response = route.fetch()
            assert response.status == 201
            unknown_writes.append(response.json()["task"])
            route.abort("failed")
        elif fail_read[0]: route.fulfill(status=403, json={"error": {"code": "forbidden", "message": "读取当前任务暂时被拒绝"}})
        else: route.continue_()
    page.route(origin + collection, lose_response)
    page.get_by_test_id("task-create-open").click()
    page.get_by_test_id("task-title").fill("真实提交后响应丢失")
    page.get_by_test_id("task-create").click()
    expect(page.get_by_test_id("task-create-unknown")).to_be_visible()
    expect(page.get_by_test_id("task-create")).to_be_disabled()
    fail_read[0] = True
    page.get_by_role("button", name="读取当前任务（不再次保存）", exact=True).click()
    expect(page.get_by_test_id("task-create-unknown")).to_contain_text("读取当前任务暂时被拒绝")
    expect(page.get_by_test_id("task-create")).to_be_disabled()
    page.get_by_test_id("cancel-create").click()
    expect(page.get_by_test_id("creation-dialog")).to_have_count(0)
    page.get_by_test_id("task-create-open").click()
    expect(page.get_by_test_id("task-title")).to_have_value("真实提交后响应丢失")
    expect(page.get_by_test_id("task-create")).to_be_disabled()
    page.evaluate("() => document.querySelector('[data-testid=task-create]').form.requestSubmit()")
    assert len(unknown_writes) == 1
    fail_read[0] = False
    page.get_by_role("button", name="读取当前任务（不再次保存）", exact=True).click()
    expect(page.get_by_test_id("task-create-unknown")).to_contain_text(unknown_writes[0]["id"])
    expect(page.get_by_test_id("task-create")).to_be_disabled()
    page.screenshot(path=str(output / "task-quick-unknown-1440.png"), full_page=True, animations="disabled")
    report["screenshots"].append("task-quick-unknown-1440.png")
    page.unroute(origin + collection, lose_response)
    actual = [t for t in request(page, origin, "GET", collection)["tasks"] if t["title"] == "真实提交后响应丢失"]
    assert len(actual) == 1 and actual[0]["id"] == unknown_writes[0]["id"]
    # 查看候选仍会经过真实草稿离开守卫；无dialog handler时Playwright默认取消。
    # 先验证取消保留未知结果，再明确确认离开，不能绕过守卫或默清草稿。
    leave_confirmations = []
    def answer_unknown_leave(dialog, accepted):
        assert dialog.type == "confirm"
        assert "未保存的内容" in dialog.message and "是否继续" in dialog.message
        leave_confirmations.append({"type": dialog.type, "message": dialog.message, "accepted": accepted})
        if accepted: dialog.accept()
        else: dialog.dismiss()
    candidate_link = page.get_by_test_id("task-create-unknown").get_by_role("link", name="真实提交后响应丢失", exact=True)
    page.once("dialog", lambda dialog: answer_unknown_leave(dialog, False))
    candidate_link.click()
    expect(page).to_have_url(origin + f"/projects/{pid}/tasks")
    expect(page.get_by_test_id("task-title")).to_have_value("真实提交后响应丢失")
    expect(page.get_by_test_id("task-create")).to_be_disabled()
    assert len(leave_confirmations) == 1 and len(unknown_writes) == 1
    page.once("dialog", lambda dialog: answer_unknown_leave(dialog, True))
    candidate_link.click()
    expect(page.locator("h1")).to_have_text("真实提交后响应丢失")
    expect(page).to_have_url(origin + f"/projects/{pid}/tasks/{unknown_writes[0]['id']}")
    assert len(leave_confirmations) == 2 and len(unknown_writes) == 1
    report["unknownCreateNavigation"] = {"confirmations": leave_confirmations, "taskId": unknown_writes[0]["id"], "writes": len(unknown_writes)}
    report["checks"].append("S5-T1: POST已落库但丢响应、读403、关闭重开与成功核对均不会盲目重试；实际只创建一次")

def exercise_reopen(page, fixture, output, report):
    origin = fixture["url"]
    first = fixture["records"][0]
    pid = first["project"]["id"]
    for case in fixture["recoveryTasks"]:
        task_id, member_id, lifecycle = case["taskId"], case["assigneeMemberId"], case["lifecycle"]
        task_path = f"/api/projects/{pid}/tasks/{task_id}"
        if lifecycle == "disabled":
            request(page, origin, "POST", f"/api/projects/{pid}/members/{member_id}/disable")
        else:
            request(page, origin, "DELETE", f"/api/projects/{pid}/members/{member_id}")
        before = request(page, origin, "GET", task_path)
        assert before["task"]["state"] == "done" and len(before["reports"]) == 2
        missing = "assignee_invalid" if lifecycle == "disabled" else "assignee_required"
        assert before["task"]["materialStatus"]["startExecution"]["reasonCodes"] == [missing]
        width = 1440 if lifecycle == "disabled" else 390
        page.set_viewport_size({"width": width, "height": 1000 if width == 1440 else 844})
        page.emulate_media(color_scheme="light", reduced_motion="reduce")
        page.goto(origin + f"/projects/{pid}/tasks/{task_id}")
        expect(page.get_by_test_id("task-state")).to_have_text("已完成")
        expect(page.get_by_test_id("task-edit-open")).to_be_disabled()
        expect(page.get_by_test_id("task-block")).to_have_text("重新打开待办")
        expect(page.get_by_test_id("task-block")).to_be_disabled()
        reason = f"原负责人{lifecycle}，先退回待办重新安排"
        page.get_by_test_id("task-transition-reason").fill(reason)
        expect(page.get_by_test_id("task-block")).to_be_enabled()
        dimensions = page.evaluate("() => ({viewport:innerWidth, document:document.documentElement.scrollWidth})")
        assert dimensions["document"] <= width + 1, dimensions
        key = f"task-reopen-{lifecycle}-{width}"
        page.screenshot(path=str(output / f"{key}.png"), full_page=True, animations="disabled")
        report["screenshots"].append(f"{key}.png")
        page.get_by_test_id("task-block").click()
        expect(page.get_by_test_id("task-state")).to_have_text("待办")
        expect(page.get_by_test_id("toast-host")).to_contain_text("任务已重新打开为待办。")
        expect(page.get_by_test_id("task-edit-open")).to_be_enabled()
        expect(page.get_by_test_id("task-start")).to_be_disabled()
        expect(page.get_by_test_id("task-transition-reason")).to_have_value("")
        after = request(page, origin, "GET", task_path)
        assert after["task"]["revision"] == before["task"]["revision"] + 1
        assert after["task"]["currentReviewRoundId"] is None
        assert after["task"]["assigneeMemberId"] == before["task"]["assigneeMemberId"]
        assert after["rounds"] == before["rounds"] and after["reports"] == before["reports"]
        assert after["history"][:-1] == before["history"]
        assert after["history"][-1]["detail"] == {"from": "done", "to": "todo", "reason": reason}
        transitions = [r for r in report["taskRequests"] if r["path"] == task_path + "/transitions"]
        assert len(transitions) == 1
        assert transitions[0]["body"] == {"expectedRevision": before["task"]["revision"], "state": "todo", "reason": reason}
        page.get_by_test_id("task-edit-open").click()
        page.get_by_test_id("task-assignee").select_option(first["members"][2]["id"])
        page.get_by_test_id("task-acceptance").fill("后续处理补充验收，原候选与裁决仍然保留。")
        page.get_by_test_id("task-save").click()
        expect(page.get_by_test_id("task-save")).to_have_count(0)
        expect(page.get_by_test_id("task-start")).to_be_enabled()
        page.get_by_test_id("task-start").click()
        expect(page.get_by_test_id("task-state")).to_have_text("进行中")
        resumed = request(page, origin, "GET", task_path)
        assert resumed["task"]["assigneeMemberId"] == first["members"][2]["id"]
        assert resumed["rounds"] == before["rounds"] and resumed["reports"] == before["reports"]
        report["checks"].append(f"R-BR-COLLAB-137-REQ-001/STD-001 {lifecycle}: 真实成员生命周期后界面理由必填、重开待办请求与Toast一致，保留旧历史、改派补资料后才开始")

def exercise(page, fixture, output, report):
    origin = fixture["url"]
    first, second = fixture["records"]
    pid, other = first["project"]["id"], second["project"]["id"]
    review_id = fixture["reviewTaskId"]
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    report["pageErrors"], report["checks"], report["screenshots"] = errors, [], []
    report["layouts"] = []
    report["taskRequests"] = []
    def record_task_request(req):
        if "/tasks" in req.url and req.method in ["POST", "PATCH"]:
            report["taskRequests"].append({"method": req.method, "path": urlsplit(req.url).path, "body": req.post_data_json})
    page.on("request", record_task_request)
    for width, height, theme in [(1440, 1000, "light"), (768, 1000, "light"), (390, 844, "light"), (1440, 1000, "dark")]:
        page.set_viewport_size({"width": width, "height": height})
        page.emulate_media(color_scheme=theme, reduced_motion="reduce")
        for name, path in [("tasks", f"/projects/{pid}/tasks"), ("task-detail", f"/projects/{pid}/tasks/{review_id}")]:
            page.goto(origin + path)
            expect(page.locator("h1")).to_be_visible()
            expect(page.get_by_test_id("task-board" if name == "tasks" else "task-reviews")).to_contain_text("两轴报告" if name == "tasks" else "需求轴")
            dimensions = page.evaluate("() => ({viewport:innerWidth, document:document.documentElement.scrollWidth, body:document.body.scrollWidth})")
            assert max(dimensions["document"], dimensions["body"]) <= width + 1, (name, dimensions)
            key = f"{name}-{width}-{theme}"
            report["layouts"].append({"view": key, **dimensions})
            page.screenshot(path=str(output / f"{key}.png"), full_page=True, animations="disabled")
            report["screenshots"].append(f"{key}.png")
    report["checks"].append("任务板/详情×1440/768/390/深色，无整页横向溢出；390默认列表")

    exercise_quick_intake(page, fixture, output, report)

    page.set_viewport_size({"width": 1440, "height": 1000})
    page.emulate_media(color_scheme="light")
    page.goto(origin + f"/tasks?projectId={pid}")
    expect(page).to_have_url(origin + f"/projects/{pid}/tasks")
    expect(page.get_by_test_id("current-project")).to_have_value(pid)
    expect(page.get_by_test_id("current-project")).to_have_count(1)
    expect(page.locator(".task-column")).to_have_count(5)
    page.locator(".task-settings > summary").click()
    page.get_by_test_id("task-default-reviewer").select_option(first["members"][2]["id"])
    page.get_by_test_id("task-save-settings").click()
    expect(page.get_by_test_id("task-notice")).to_contain_text("默认 reviewer 已保存")
    page.get_by_test_id("task-create-open").click()
    page.get_by_test_id("task-title").fill("浏览器完整创建的任务")
    page.locator(".task-optional-fields > summary").click()
    page.get_by_test_id("task-body").fill("目标：简约清晰。\n验收：完整字段、明确反馈和独立评审。")
    page.get_by_test_id("task-acceptance").fill("完整字段持久化、独立两轴评审与明确反馈。")
    page.get_by_test_id("task-delivery-kind").select_option("code")
    page.get_by_test_id("task-assignee").select_option(first["members"][0]["id"])
    page.get_by_test_id("task-labels").fill("体验，任务,体验")
    page.locator(".task-candidate-fields > summary").click()
    page.get_by_test_id("task-repo-path").fill(fixture["repoPath"])
    page.get_by_test_id("task-fixed-point").fill(fixture["fixedPoint"])
    page.get_by_test_id("task-create").click()
    expect(page.get_by_test_id("creation-dialog")).to_have_count(0)
    expect(page.get_by_test_id("toast-host")).to_contain_text("已保存「浏览器完整创建的任务」")
    tasks = request(page, origin, "GET", f"/api/projects/{pid}/tasks")["tasks"]
    created = next(task for task in tasks if task["title"] == "浏览器完整创建的任务")
    assert created["labels"] == ["体验", "任务"]
    assert created["deliveryKind"] == "code" and created["acceptanceText"] == "完整字段持久化、独立两轴评审与明确反馈。"
    assert created["acceptanceSource"] == "explicit"
    assert created["reviewerMemberId"] == first["members"][2]["id"]
    assert created["repoPath"] == fixture["repoPath"] and created["fixedPoint"] == fixture["fixedPoint"]
    report["checks"].append("AC-TASK-01: UI保存默认reviewer、完整创建，HTTP持久化字段一致")

    page.get_by_role("link", name="浏览器完整创建的任务", exact=True).click()
    expect(page.locator("h1")).to_have_text("浏览器完整创建的任务")
    page.get_by_test_id("task-edit-open").click()
    page.get_by_test_id("task-title").fill("409后保留的任务标题")
    request(page, origin, "PATCH", f"/api/projects/{pid}/tasks/{created['id']}", {"expectedRevision": created["revision"], "title": "其他操作更新的标题", "body": "远端补充的目标，不应被旧草稿覆盖"})
    page.get_by_test_id("task-save").click()
    expect(page.get_by_test_id("task-conflict")).to_contain_text("保留")
    expect(page.get_by_test_id("task-title")).to_have_value("409后保留的任务标题")
    page.get_by_test_id("task-reload").click()
    expect(page.get_by_test_id("task-notice")).to_contain_text("已载入最新版本")
    expect(page.get_by_test_id("task-title")).to_have_value("409后保留的任务标题")
    expect(page.get_by_test_id("task-save")).to_be_disabled()
    expect(page.get_by_test_id("task-remote-changes")).to_contain_text("远端补充的目标")
    expect(page.get_by_test_id("task-draft-base")).to_contain_text(f"版本 {created['revision']}")
    page.get_by_test_id("task-rebase").click()
    expect(page.get_by_test_id("task-body")).to_have_value("远端补充的目标，不应被旧草稿覆盖")
    page.get_by_test_id("task-save").click()
    expect(page.locator("h1")).to_have_text("409后保留的任务标题")
    saved = request(page, origin, "GET", f"/api/projects/{pid}/tasks/{created['id']}")["task"]
    assert saved["body"] == "远端补充的目标，不应被旧草稿覆盖"
    saved_requests = [r for r in report["taskRequests"] if r["method"] == "PATCH" and r["path"].endswith(created["id"])]
    assert [r["body"]["expectedRevision"] for r in saved_requests] == [created["revision"], created["revision"] + 1]
    assert set(saved_requests[-1]["body"]) == {"expectedRevision", "title"}
    page.get_by_test_id("task-comment-body").fill("来自真实浏览器的协作评论")
    page.get_by_test_id("task-comment-send").click()
    expect(page.get_by_test_id("task-comments")).to_contain_text("来自真实浏览器的协作评论")
    page.get_by_test_id("task-start").click()
    expect(page.get_by_test_id("task-state")).to_have_text("进行中")
    page.get_by_test_id("task-start-review").click()
    expect(page.get_by_test_id("task-state")).to_have_text("评审中")
    expect(page.get_by_test_id("task-reviews")).to_contain_text("等待 reviewer 接手")
    actual = request(page, origin, "GET", f"/api/projects/{pid}/tasks/{created['id']}")
    assert actual["rounds"][-1]["candidate"]["baseCommit"] == fixture["fixedPoint"]
    report["checks"].append("AC-TASK-03/AC-REVIEW-01: 真实409保留原baseRevision，明确采用后仅提交本地修改；评论、开始与固定Git候选")

    page.goto(origin + f"/projects/{pid}/tasks/{review_id}")
    expect(page.get_by_test_id("task-report-spec")).to_contain_text("需求轴的浏览器合成报告")
    expect(page.get_by_test_id("task-report-standards")).to_contain_text("标准轴的浏览器合成报告")
    expect(page.get_by_test_id("task-decide")).to_be_disabled()
    page.get_by_test_id("task-decision-verdict").select_option("pass")
    page.get_by_test_id("task-decision-reason").fill("已逐项核对两轴报告，批准这次候选")
    page.get_by_test_id("task-decide").click()
    expect(page.get_by_test_id("task-state")).to_have_text("已完成")
    page.get_by_test_id("task-decision-verdict").select_option("changes_requested")
    page.get_by_test_id("task-decision-reason").fill("发现新的交付要求，保留原结论并继续修改")
    page.get_by_test_id("task-decide").click()
    expect(page.get_by_test_id("task-state")).to_have_text("进行中")
    decided = request(page, origin, "GET", f"/api/projects/{pid}/tasks/{review_id}")
    assert len(decided["reports"]) == 2
    assert "已逐项核对两轴报告" in json.dumps(decided["history"], ensure_ascii=False)
    report["checks"].append("AC-REVIEW-03: 两轴分别呈现，管理者必填原因覆盖与再次覆盖，原报告/裁决历史保留（合成UI报告）")

    page.goto(origin + f"/projects/{pid}/tasks/{created['id']}")
    page.get_by_test_id("task-edit-open").click()
    page.get_by_test_id("task-title").fill("切换前未保存的任务")
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.get_by_test_id("current-project").select_option(other)
    expect(page).to_have_url(origin + f"/projects/{pid}/tasks/{created['id']}")
    expect(page.get_by_test_id("current-project")).to_have_value(pid)
    expect(page.get_by_test_id("task-title")).to_have_value("切换前未保存的任务")
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_test_id("current-project").select_option(other)
    expect(page).to_have_url(origin + f"/projects/{other}/tasks")
    expect(page.get_by_test_id("task-title")).to_have_count(0)
    expect(page.get_by_test_id("task-board")).to_contain_text("乙项目独立任务")
    page.get_by_role("navigation", name="主导航").get_by_role("link", name="组织与角色", exact=True).click()
    expect(page).to_have_url(origin + f"/projects/{other}/org")
    page.reload()
    expect(page.get_by_test_id("current-project")).to_have_value(other)
    page.goto(origin + f"/tasks?projectId={pid}")
    expect(page.get_by_test_id("current-project")).to_have_value(pid)
    page.evaluate("id => { localStorage.setItem('agent-studio:lastProjectId', id); dispatchEvent(new StorageEvent('storage', {key:'agent-studio:lastProjectId', newValue:id})); }", other)
    expect(page.get_by_test_id("current-project")).to_have_value(pid)
    report["checks"].append("#39: 取消/确认切项目保护草稿，跨页/刷新保持，URL优先，storage事件不强迫跳转")

    held = []
    page.route(f"**/api/projects/{pid}/tasks", lambda route: held.append(route))
    page.goto(origin + f"/projects/{pid}/tasks")
    expect(page.get_by_test_id("current-project")).to_have_value(pid)
    page.get_by_test_id("current-project").select_option(other)
    expect(page.get_by_test_id("task-board")).to_contain_text("乙项目独立任务")
    for route in held: route.continue_()
    page.unroute(f"**/api/projects/{pid}/tasks")
    page.wait_for_timeout(100)
    expect(page.get_by_test_id("task-board")).not_to_contain_text("409后保留的任务标题")
    page.goto(origin + "/projects/project-does-not-exist/tasks")
    expect(page.get_by_test_id("context-notice")).to_contain_text("项目不存在或无权访问，已切换到")
    request(page, origin, "POST", f"/api/projects/{other}/archive")
    page.goto(origin + f"/projects/{other}/tasks")
    expect(page.get_by_test_id("task-create-open")).to_be_disabled()
    expect(page.get_by_text("项目已归档，可查看任务、评论与评审记录，无法修改。", exact=True)).to_be_visible()
    expect(page.get_by_test_id("task-board")).to_contain_text("乙项目独立任务")
    report["checks"].append("#39: 旧请求迟到不串项目、无效URL明确回退、归档深链只读")
    exercise_reopen(page, fixture, output, report)
    assert not errors, errors
    report["status"] = "PASS"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/tasks-web-e2e")
    output = parser.parse_args().artifacts.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "FAIL", "at": datetime.now(timezone.utc).isoformat(), "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "scope": "real Chromium / temporary SQLite / clean Git / synthetic reports / no model invocation"}
    fixture = None
    try:
        fixture = subprocess.Popen(["node", "scripts/tasks-web-fixture.mjs"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready, _, _ = select.select([fixture.stdout], [], [], 45)
        assert ready, "任务浏览器临时服务启动超时"
        line = fixture.stdout.readline()
        assert line, "临时服务未返回地址：" + fixture.stderr.read(3000)
        data = json.loads(line)
        parsed = urlsplit(data["url"])
        assert parsed.hostname == "127.0.0.1" and parsed.scheme == "http"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            report["chromium"] = browser.version
            context = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai")
            page = context.new_page()
            page.set_default_timeout(15000)
            try: exercise(page, data, output, report)
            except Exception:
                if not page.is_closed(): page.screenshot(path=str(output / "failure.png"), full_page=True)
                raise
            finally: context.close(); browser.close()
    except Exception as error: report["error"] = str(error)[:5000]
    finally:
        if fixture:
            fixture.stdin.close()
            try: fixture.wait(timeout=10)
            except subprocess.TimeoutExpired: fixture.terminate(); fixture.wait(timeout=5)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "PASS" else 1

if __name__ == "__main__": raise SystemExit(main())
