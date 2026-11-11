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

def confirmation_flows(page, origin, project_id, org_project_id, output, report):
    """真实操作与数据结果；仅对拒绝/响应丢失场景注入传输故障。"""
    observed = []
    toast_target_checked = False
    def collect(req):
        if req.method in ("POST", "DELETE"):
            observed.append({"path": urlsplit(req.url).path, "method": req.method, "body": json.loads(req.post_data) if req.post_data else None})
    page.on("request", collect)
    def writes(path, method):
        return [item for item in observed if item["path"] == path and item["method"] == method]
    def committed_purges(path):
        return [item for item in writes(path, "DELETE") if item["body"] and item["body"].get("confirm")]
    def toast(message):
        nonlocal toast_target_checked
        item = page.get_by_test_id("toast").filter(has_text=message)
        expect(item).to_have_count(1)
        close = item.get_by_role("button")
        if not toast_target_checked:
            close.focus()  # 暂停提示计时，测量真实桌面和窄屏命中区。
            previous_viewport = page.viewport_size
            for width, height, minimum in [(1440, 1000, 38), (390, 844, 44)]:
                page.set_viewport_size({"width": width, "height": height})
                rect = close.bounding_box()
                assert rect and rect["width"] >= minimum and rect["height"] >= minimum, f"Toast关闭命中区不足：{width}px {rect}"
                filename = f"toast-close-target-{width}-light.png"
                page.screenshot(path=str(output / filename), animations="disabled")
                report["screenshots"].append(filename)
            page.set_viewport_size(previous_viewport)
            report["checks"].append("S6-AC04/05: Toast关闭按钮桌面38px/窄屏44px命中区与焦点暂停计时")
            toast_target_checked = True
        close.click()
    def cancel_with_keyboard(trigger, cancel_id="confirm-cancel"):
        dialog = page.get_by_test_id("confirmation-dialog")
        expect(dialog).to_be_visible()
        assert dialog.evaluate("el => el.tagName === 'DIALOG' && el.open"), "必须使用原生模态 dialog"
        expect(page.get_by_test_id(cancel_id)).to_be_focused()
        for _ in range(3):
            page.keyboard.press("Tab")
            assert dialog.evaluate("el => el.contains(document.activeElement)"), "焦点离开模态窗口"
        page.keyboard.press("Escape")
        expect(dialog).not_to_be_visible()
        expect(trigger).to_be_focused()

    page.goto(origin + f"/projects/{project_id}/overview?archived=1")
    expect(page.get_by_test_id("member-list")).to_contain_text("可访问性验证成员")
    member = request(page, origin, "GET", f"/api/projects/{project_id}/members")["members"][0]
    member_path = f"/api/projects/{project_id}/members/{member['id']}"
    member_row = page.get_by_test_id("member-list").locator("li").filter(has_text=member["displayName"])
    member_row.locator("summary").click()
    remove = member_row.get_by_role("button", name="移除", exact=True)
    page.get_by_test_id("new-member-name").fill("删除成员期间保留的草稿")
    remove.click()
    expect(page.get_by_test_id("confirmation-dialog")).to_contain_text(member["displayName"])
    cancel_with_keyboard(remove)
    assert not writes(member_path, "DELETE"), "取消成员移除产生了写请求"
    assert any(item["id"] == member["id"] for item in request(page, origin, "GET", f"/api/projects/{project_id}/members")["members"])

    held = []
    def hold_remove(route):
        if route.request.method == "DELETE": held.append(route)
        else: route.continue_()
    route_pattern = "**" + member_path
    page.route(route_pattern, hold_remove)
    remove.click()
    confirm = page.get_by_test_id("confirm-submit")
    confirm.click()
    expect(confirm).to_be_disabled()
    expect(page.get_by_test_id("confirm-cancel")).to_be_disabled()
    confirm.dispatch_event("click")
    page.keyboard.press("Escape")
    expect(page.get_by_test_id("confirmation-dialog")).to_be_visible()
    assert len(held) == 1, "pending 中重复提交成员移除"
    held.pop().fulfill(status=409, content_type="application/json", body=json.dumps({"error": {"code": "ui_test_conflict", "message": "测试：成员关系已变化，请核对后重试"}}))
    expect(page.get_by_test_id("confirmation-error")).to_contain_text("成员关系已变化")
    expect(confirm).to_be_enabled()
    confirm.click()
    expect(confirm).to_be_disabled()
    assert len(held) == 1
    failed_response = held.pop()
    actual = failed_response.fetch()
    assert actual.status == 204, f"真实移除未完成：{actual.status}"
    failed_response.abort("failed")  # 服务端已提交，但浏览器没有可信完成回执。
    expect(page.get_by_test_id("confirmation-error")).to_contain_text("操作结果未知")
    expect(confirm).to_be_disabled()
    page.unroute(route_pattern, hold_remove)
    page.get_by_test_id("confirmation-reconcile").click()
    expect(page.get_by_test_id("confirmation-dialog")).not_to_be_visible()
    expect(page.locator("h1")).to_be_focused()
    expect(page.get_by_test_id("new-member-name")).to_have_value("删除成员期间保留的草稿")
    page.get_by_test_id("new-member-name").fill("")
    assert len(writes(member_path, "DELETE")) == 2, "一次被拒绝、一次明确重试后，不应再次发送移除"
    assert not request(page, origin, "GET", f"/api/projects/{project_id}/members")["members"]
    toast(f"成员「{member['displayName']}」已移除。")
    report["checks"].append("S6-AC01/02/05: 成员取消/Escape与还焦；pending单飞；注入409拒绝与提交后响应丢失，权威核对完成且保留草稿")

    group = request(page, origin, "GET", f"/api/projects/{project_id}/groups")["groups"][0]
    group_path = f"/api/groups/{group['id']}"
    page.get_by_test_id("group-management").locator("summary").click()
    archive_group = page.get_by_test_id("archive-group")
    archive_group.click()
    cancel_with_keyboard(archive_group)
    assert not writes(group_path + "/archive", "POST")
    archive_group.click()
    page.get_by_test_id("confirm-submit").click()
    expect(page.get_by_test_id("group-archived-badge")).to_be_visible()
    assert len(writes(group_path + "/archive", "POST")) == 1
    toast(f"群组「{group['name']}」已归档")
    page.get_by_test_id("restore-group").click()
    expect(page.get_by_test_id("group-archived-badge")).to_have_count(0)
    toast(f"群组「{group['name']}」已恢复")

    purge_group = page.get_by_test_id("purge-group")
    purge_group.click()
    expect(page.get_by_test_id("group-purge-confirm")).to_contain_text("记忆正文与版本历史全部保留")
    expect(page.get_by_test_id("confirm-purge-group")).to_be_enabled()
    cancel_with_keyboard(purge_group, "cancel-purge-group")
    assert not committed_purges(group_path), "预览取消不能发送确认 token"
    assert len(request(page, origin, "GET", f"/api/projects/{project_id}/groups")["groups"]) == 1
    with page.expect_response(lambda r: r.url.endswith(group_path) and r.request.method == "DELETE") as preview_response:
        purge_group.click()
    previous_token = preview_response.value.json()["confirmation"]["token"]
    def changed_confirmation(route):
        if route.request.method == "DELETE" and route.request.post_data:
            route.fulfill(status=409, content_type="application/json", body=json.dumps({"error": {"code": "confirmation_changed", "message": "测试：删除影响已变化，请重新预览"}}))
        else: route.continue_()
    group_pattern = "**" + group_path
    page.route(group_pattern, changed_confirmation)
    page.get_by_test_id("confirm-purge-group").click()
    expect(page.get_by_test_id("confirmation-error")).to_contain_text("删除影响已变化")
    expect(page.get_by_test_id("confirm-purge-group")).to_be_disabled()
    page.unroute(group_pattern, changed_confirmation)
    with page.expect_response(lambda r: r.url.endswith(group_path) and r.request.method == "DELETE") as latest_response:
        page.get_by_test_id("confirmation-preview").click()
    latest_token = latest_response.value.json()["confirmation"]["token"]
    assert previous_token != latest_token
    assert len(committed_purges(group_path)) == 1, "重新预览不能自动删除"
    page.get_by_test_id("confirm-purge-group").click()
    expect(page.get_by_test_id("confirmation-dialog")).not_to_be_visible()
    assert len(committed_purges(group_path)) == 2
    assert committed_purges(group_path)[-1]["body"]["confirm"] == latest_token
    assert not request(page, origin, "GET", f"/api/projects/{project_id}/groups?includeArchived=true")["groups"]
    toast(f"群组「{group['name']}」已永久删除")
    report["checks"].append("S6-AC01/03: 群归档取消/确认/恢复；群purge取消；注入confirmation_changed后重新预览及再次确认，实际删除仅使用新token（不作为后端CAS证据）")

    page.get_by_test_id("project-actions").locator("summary").click()
    archive_project = page.get_by_test_id("archive-project")
    archive_project.click()
    cancel_with_keyboard(archive_project)
    assert not writes(f"/api/projects/{project_id}/archive", "POST")
    archive_project.click()
    page.get_by_test_id("confirm-submit").click()
    expect(page.get_by_test_id("project-archived-badge")).to_be_visible()
    expect(page.get_by_test_id("new-member-name")).to_be_disabled()
    assert len(writes(f"/api/projects/{project_id}/archive", "POST")) == 1
    toast("项目「浏览器操作创建的项目」已归档")
    page.get_by_test_id("restore-project").click()
    expect(page.get_by_test_id("project-archived-badge")).to_have_count(0)
    toast("项目「浏览器操作创建的项目」已恢复")
    project_path = f"/api/projects/{project_id}"
    purge_project = page.get_by_test_id("purge-project")
    purge_project.click()
    expect(page.get_by_test_id("project-purge-confirm")).to_contain_text("组织岗位")
    expect(page.get_by_test_id("confirm-purge-project")).to_be_enabled()
    for width, height in [(1440, 1000), (390, 844)]:
        page.set_viewport_size({"width": width, "height": height})
        dialog = page.get_by_test_id("confirmation-dialog")
        body = dialog.locator(".confirm-dialog-body")
        if width == 390:
            assert body.evaluate("el => el.scrollHeight > el.clientHeight"), "窄窗长清单应在正文内滚动"
            body.evaluate("el => { el.scrollTop = el.scrollHeight; }")
        rect = dialog.bounding_box()
        assert rect and rect["x"] >= 0 and rect["y"] >= 0 and rect["x"] + rect["width"] <= width + 1 and rect["y"] + rect["height"] <= height + 1
        expect(page.get_by_test_id("confirm-purge-project")).to_be_in_viewport()
        expect(page.get_by_test_id("cancel-purge-project")).to_be_in_viewport()
        filename = f"confirmation-project-purge-{width}-light.png"
        page.screenshot(path=str(output / filename), animations="disabled")
        report["screenshots"].append(filename)
        report["layouts"].append(layout(page, f"confirmation-{width}"))
    cancel_with_keyboard(purge_project, "cancel-purge-project")
    assert not committed_purges(project_path)
    assert any(item["id"] == project_id for item in request(page, origin, "GET", "/api/projects?includeArchived=true")["projects"])
    page.set_viewport_size({"width": 1440, "height": 1000})
    purge_project.click()
    page.get_by_test_id("confirm-purge-project").click()
    expect(page.get_by_test_id("confirmation-dialog")).not_to_be_visible()
    expect(page.locator("h1")).to_be_focused()
    assert len(committed_purges(project_path)) == 1
    assert not any(item["id"] == project_id for item in request(page, origin, "GET", "/api/projects?includeArchived=true")["projects"])
    toast("项目「浏览器操作创建的项目」已永久删除。")
    report["checks"].append("S6-AC01/03/04/05: 项目归档/恢复与只读保护，purge长清单390/1440截图、取消与单次确认，目标消失后标题还焦及全局Toast")

    org = request(page, origin, "GET", f"/api/projects/{org_project_id}/org")
    target = next(node for node in org["nodes"] if node["name"] == "产品设计")
    child = request(page, origin, "POST", f"/api/projects/{org_project_id}/org/nodes", {"name": "验证下级提升", "role": "member", "parentId": target["id"]})["node"]
    page.goto(origin + f"/projects/{org_project_id}/org")
    page.locator(f"button[aria-controls='node-editor-{target['id']}']").click()
    editor = page.get_by_role("region", name="编辑岗位：产品设计", exact=True)
    delete_node = editor.get_by_role("button", name="删除岗位", exact=True)
    delete_node.click()
    expect(page.get_by_test_id("confirmation-dialog")).to_contain_text("下级岗位会移交给上级")
    cancel_with_keyboard(delete_node)
    node_path = f"/api/org/nodes/{target['id']}"
    assert not writes(node_path, "DELETE")
    delete_node.click()
    page.get_by_test_id("confirm-submit").click()
    expect(page.get_by_test_id("confirmation-dialog")).not_to_be_visible()
    expect(page.locator("h1")).to_be_focused()
    assert len(writes(node_path, "DELETE")) == 1
    latest_org = request(page, origin, "GET", f"/api/projects/{org_project_id}/org")
    assert not any(node["id"] == target["id"] for node in latest_org["nodes"])
    assert next(node for node in latest_org["nodes"] if node["id"] == child["id"])["parentId"] == target["parentId"]
    assert len(latest_org["members"]) == len(org["members"]), "删除岗位不能删除成员"
    toast("岗位「产品设计」已删除，成员与历史保留。")
    report["checks"].append("S6-AC01/05: 岗位删除取消/确认、下级提升与成员保留，目标消失后可用焦点")
    report["confirmationRequests"] = {"member": len(writes(member_path, "DELETE")), "groupArchive": len(writes(group_path + "/archive", "POST")), "groupPurgeWithToken": len(committed_purges(group_path)), "projectArchive": len(writes(project_path + "/archive", "POST")), "projectPurgeWithToken": len(committed_purges(project_path)), "orgDelete": len(writes(node_path, "DELETE"))}
    page.remove_listener("request", collect)

def purge_snapshot_flows(page, origin, output, report):
    """#130：实际HTTP写入改变快照；不拦截或伪造确认响应。"""
    page.set_viewport_size({"width": 1440, "height": 1000})
    project = request(page, origin, "POST", "/api/projects", {"name": "删除快照真实集成"})["project"]
    project_id = project["id"]
    member = request(page, origin, "POST", f"/api/projects/{project_id}/members", {"kind": "human", "displayName": "另一入口的发信人"})["member"]
    groups = [request(page, origin, "POST", f"/api/projects/{project_id}/groups", {"name": name, "participantMemberIds": [member["id"]]})["group"] for name in ["快照目标群", "项目确认时的群"]]
    page.goto(origin + f"/projects/{project_id}/overview")
    expect(page.get_by_test_id("group-list")).to_contain_text(groups[0]["name"])
    report["purgeSnapshotFlows"] = []
    for kind, group in zip(["group", "project"], groups):
        target = f"/api/groups/{group['id']}" if kind == "group" else f"/api/projects/{project_id}"
        if kind == "group":
            row = page.get_by_test_id("group-list").locator("li").filter(has_text=group["name"])
            row.get_by_test_id("group-management").locator("summary").click()
            trigger = row.get_by_test_id("purge-group")
        else:
            details = page.get_by_test_id("project-actions")
            if not details.evaluate("el => el.open"): details.locator("summary").click()
            trigger = page.get_by_test_id("purge-project")
        with page.expect_response(lambda r: r.url.endswith(target) and r.request.method == "DELETE") as initial_response:
            trigger.click()
        assert initial_response.value.status == 409
        initial = initial_response.value.json()["confirmation"]
        message = request(page, origin, "POST", f"/api/groups/{group['id']}/messages", {"senderMemberId": member["id"], "text": f"{kind}预览之后由另一HTTP入口写入"})["message"]
        confirm = page.get_by_test_id(f"confirm-purge-{kind}")
        with page.expect_response(lambda r: r.url.endswith(target) and r.request.method == "DELETE") as refused_response:
            confirm.click()
        refused = refused_response.value.json()
        assert refused_response.value.status == 409 and refused["error"]["code"] == "confirmation_changed"
        expect(page.get_by_test_id("confirmation-error")).to_contain_text("影响范围已变化")
        expect(confirm).to_be_disabled()
        assert page.request.get(origin + target).status == 200
        assert any(item["id"] == message["id"] for item in request(page, origin, "GET", f"/api/groups/{group['id']}/messages")["messages"]), "被拒确认清掉了新事实"
        consumed = page.request.delete(origin + target, data={"confirm": initial["token"]})
        assert consumed.status == 400 and consumed.json()["error"]["code"] == "invalid_confirmation"
        filename = f"purge-snapshot-{kind}-changed-1440-light.png"
        page.screenshot(path=str(output / filename), animations="disabled")
        report["screenshots"].append(filename)
        with page.expect_response(lambda r: r.url.endswith(target) and r.request.method == "DELETE") as latest_response:
            page.get_by_test_id("confirmation-preview").click()
        latest = latest_response.value.json()["confirmation"]
        assert latest["token"] != initial["token"]
        assert latest["cascade"]["messages"] == initial["cascade"]["messages"] + 1
        assert page.request.get(origin + target).status == 200, "重新预览不能自动删除"
        expect(confirm).to_be_enabled()
        with page.expect_response(lambda r: r.url.endswith(target) and r.request.method == "DELETE") as deleted_response:
            confirm.click()
        assert deleted_response.value.status == 204
        assert json.loads(deleted_response.value.request.post_data)["confirm"] == latest["token"]
        expect(page.get_by_test_id("confirmation-dialog")).not_to_be_visible()
        assert page.request.get(origin + target).status == 404
        if kind == "group":
            assert any(item["id"] == member["id"] for item in request(page, origin, "GET", f"/api/projects/{project_id}/members")["members"])
            assert page.request.get(origin + f"/api/groups/{groups[1]['id']}").status == 200
        report["purgeSnapshotFlows"].append({"kind": kind, "target": target, "newMessageId": message["id"], "before": initial["cascade"], "after": latest["cascade"], "rejection": refused, "consumedTokenStatus": consumed.status, "confirmedStatus": deleted_response.value.status, "preservedBeforeReconfirmation": True})
    report["checks"].append("S6-AC03 / #130: 项目与群均走真实预览→另一HTTP入口新增消息→409 confirmation_changed且完整保留→旧token作废→重预览不自动删除→再次点击才204；群成员与其他群保留")

def exercise(page, origin, records, output, report, capture_only):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    report["pageErrors"] = errors
    project_id = records[0]["project"]["id"]
    group_a, group_b = [g["id"] for g in records[0]["groups"]]
    paths = {"home": "/", "projects": "/projects", "chat": f"/chat?projectId={project_id}&groupId={group_a}", "status": f"/status?projectId={project_id}", "org": f"/org?projectId={project_id}", "audit": f"/audit?projectId={project_id}", "runtimes": f"/runtimes?projectId={project_id}", "tasks": f"/tasks?projectId={project_id}"}
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
            if name == "projects":
                page.get_by_test_id("project-list").get_by_role("button", name=records[0]["project"]["name"], exact=True).click()
            if name in ("org", "audit", "projects"):
                page.wait_for_timeout(250)
            if name == "projects" and not capture_only:
                expect(page.get_by_test_id("group-readonly-badge")).to_have_count(0)
            key = f"{name}-{width}-{theme}"
            report["layouts"].append(layout(page, key, strict=not capture_only))
            page.screenshot(path=str(output / f"{key}.png"), full_page=True, animations="disabled")
            report["screenshots"].append(f"{key}.png")
    if capture_only:
        report["status"] = "CAPTURED_BASELINE"
        return
    report["checks"].append("UI-01/02: 8个路由×4种视口/主题，标题与页面无横向溢出")

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
    target = page.get_by_test_id("current-project")
    expect(target).to_have_js_property("tagName", "SELECT")
    target.focus()
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    selected_id = target.input_value()
    expect(page).to_have_url(origin + f"/projects/{selected_id}/status")
    target.select_option(target_id)
    expect(page).to_have_url(origin + f"/projects/{target_id}/status")
    expect(target).to_have_value(target_id)
    report["checks"].append("UI-03/#39: 顶栏项目原生选择器可键盘操作，URL和页面同步")

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
    page.once("dialog", lambda dialog: dialog.accept())
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
    expect(page.get_by_test_id("toast-message").filter(has_text="项目「浏览器操作创建的项目」已创建。")).to_have_count(1)
    created_project_id = page.get_by_test_id("current-project").input_value()
    member = page.get_by_test_id("new-member-name")
    member.fill("可访问性验证成员")
    page.get_by_test_id("add-member").click()
    expect(page.get_by_test_id("member-list")).to_contain_text("可访问性验证成员")
    expect(page.get_by_test_id("toast-message").filter(has_text="成员「可访问性验证成员」已添加。")).to_have_count(1)
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
    page.goto(origin + f"/projects/{project_id}/org")
    page.get_by_test_id("org-edit-node").first.click()
    editor = page.get_by_role("region", name="编辑岗位：项目统筹", exact=True)
    editor.get_by_label("岗位名称", exact=True).fill("协作统筹")
    editor.get_by_role("button", name="改名", exact=True).click()
    expect(page.get_by_test_id("toast-message").filter(has_text="岗位已改名")).to_have_count(1)
    expect(page.get_by_test_id("org-node-list")).to_contain_text("协作统筹")
    page.goto(origin + f"/projects/{project_id}/audit")
    page.get_by_test_id("audit-revoke").first.click()
    expect(page.get_by_test_id("audit-notice")).to_contain_text("已撤销")
    nodes = request(page, origin, "GET", f"/api/projects/{project_id}/org")["nodes"]
    assert any(node["name"] == "项目统筹" and node["parentId"] is None for node in nodes), "岗位改名没有被真正撤销"
    report["checks"].append("UI-05: 组织按需编辑、实际改名与审计撤销")
    confirmation_flows(page, origin, created_project_id, project_id, output, report)
    purge_snapshot_flows(page, origin, output, report)
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
