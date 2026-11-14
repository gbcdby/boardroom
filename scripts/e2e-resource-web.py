#!/usr/bin/env python3
"""#173：真实 Chromium、HTTP/MCP/stdio、故障代理与 390/1440 草稿验收。"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from queue import Queue, Empty
import signal
import subprocess
import sys
from threading import Thread
from time import monotonic
import traceback
from playwright.sync_api import expect, Error as PlaywrightError
sys.dont_write_bytecode = True  # 不把本入口的辅助模块缓存写进候选工作树。
from resource_native_desktop import NativeDesktop
from resource_browser_binding import load_profile, load_runtime_binding
from resource_browser_session import (bounded_playwright, native_page, runtime_identity,
                                      sdk_cleanup, validate_native_observations)

ROOT = Path(__file__).resolve().parent.parent


def candidate():
    tracked = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT).decode().split("\0")
    digest = hashlib.sha256()
    for name in sorted(set(filter(None, tracked))):
        path = ROOT / name
        digest.update(name.encode() + b"\0")
        digest.update(path.read_bytes() if path.is_file() else b"<deleted>")
        digest.update(b"\0")
    return {
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "tree": subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT, text=True).strip(),
        "worktreeSha256": digest.hexdigest(),
        "status": subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True).strip(),
    }


class Fixture:
    """串行 stdin 控制；保存原始 stdout/stderr，不能伪造业务响应。"""
    def __init__(self, output, *, decision_probes=False):
        self.output, self.messages, self.serial = output, Queue(), 0
        self.stderr = (output / "fixture-stderr.log").open("w")
        self.stdout = (output / "fixture-stdout.jsonl").open("w")
        self.process = subprocess.Popen(
            ["node", "scripts/resource-web-fixture.mjs", *(["--decision-probes"] if decision_probes else [])], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
            text=True, bufsize=1)
        self.reader = Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        for line in self.process.stdout:
            self.stdout.write(line); self.stdout.flush()
            try: self.messages.put(json.loads(line))
            except json.JSONDecodeError: self.messages.put({"protocolError": line})
        self.messages.put({"eof": True})

    def receive(self, timeout=15):
        try: message = self.messages.get(timeout=timeout)
        except Empty: raise AssertionError("临时服务控制响应超时；见 fixture-stderr.log")
        assert not message.get("protocolError"), message
        assert not message.get("eof"), "临时服务提前退出；见 fixture-stderr.log"
        return message

    def start(self):
        self.ready = self.receive(45)
        assert self.ready.get("event") == "ready", self.ready
        assert self.ready["stdioPid"] != self.ready["fixturePid"], self.ready
        return self.ready

    def command(self, op, **fields):
        self.serial += 1
        self.process.stdin.write(json.dumps({"id": self.serial, "op": op, **fields}) + "\n")
        self.process.stdin.flush()
        result = self.receive()
        assert result.get("id") == self.serial and result.get("ok") is True, result
        return result["result"]

    def snapshot(self):
        return self.command("snapshot")

    def close(self):
        if not self.process.stdin.closed: self.process.stdin.close()
        forced = False
        try: self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            forced = True; self.process.terminate()
            try: self.process.wait(timeout=5)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait(timeout=5)
        self.reader.join(timeout=2)
        messages = []
        while not self.messages.empty(): messages.append(self.messages.get_nowait())
        self.stdout.close(); self.stderr.close()
        closed = next((item for item in messages if item.get("event") == "closed"), None)
        result = {"exitCode": self.process.returncode, "forced": forced, "closed": closed,
                  "temporaryRootRemoved": hasattr(self, "ready") and not Path(self.ready["root"]).exists()}
        assert not forced and result["exitCode"] == 0 and closed and not closed["failures"], result
        assert result["temporaryRootRemoved"], result
        return result


def api(page, origin, method, path, body=None, status=200):
    response = page.request.fetch(origin + path, method=method, data=body, timeout=15000)
    assert response.status == status, f"{method} {path}: {response.status} {response.text()[:500]}"
    return response.json() if status != 204 else None


def check(report, width, key, message, **evidence):
    report["checks"].append({"width": width, "id": key, "status": "PASS", "message": message, **evidence})


def wait_fixture(page, fixture, predicate, timeout=5000):
    deadline = monotonic() + timeout / 1000
    while monotonic() < deadline:
        snapshot = fixture.snapshot()
        if predicate(snapshot): return snapshot
        page.wait_for_timeout(40)
    raise AssertionError("等待真实 fixture 事件超时")


def connected(page):
    expect(page.get_by_test_id("resource-sync-status").first).to_contain_text("更新提示已连接")
    expect(page.get_by_test_id("resource-sync-status").first.locator("time")).to_have_count(1)


def screenshot(page, output, report, name):
    page.screenshot(path=str(output / name), full_page=True, animations="disabled")
    report["screenshots"].append(name)


def resource_gets(snapshot, path):
    return [event for event in snapshot["events"] if event["kind"] == "http.request"
            and event.get("method") == "GET" and event.get("path") == path]


def hints(snapshot, task_id):
    return [event for event in snapshot["events"] if event["kind"] in ("ws.forwarded", "ws.dropped")
            and event.get("frame", {}).get("type") == "resource.changed"
            and event["frame"].get("id") == task_id]


def native_snapshot(page, cdp, window, width, phase, report):
    """有界旁录；自身失败不得取代原断言/异常，也不能伪造 visibility。"""
    item = {"width": width, "phase": phase, "at": datetime.now(timezone.utc).isoformat(), "windowId": window}
    try:
        item["bounds"] = cdp.send("Browser.getWindowBounds", {"windowId": window}) if window is not None else None
        item["page"] = page.evaluate("""() => ({visibility:document.visibilityState, focus:document.hasFocus(),
          visibilityEvents:window.resourceVisibilityEvidence, windowEvents:window.resourceWindowEvidence})""")
    except Exception as error:
        item["observationError"] = str(error)[:512]
    report.setdefault("nativeWindowEvidence", []).append(item)


def native_hidden_recovery(page, context, fixture, data, task, path, width, report):
    """控制 Chromium 窗口；仅读取原生 visibility/isTrusted，绝不改写页面可见性。"""
    cdp = context.new_cdp_session(page)
    window = None
    page.evaluate("""() => {
      window.resourceVisibilityEvidence = [];
      document.addEventListener('visibilitychange', event => {
        window.resourceVisibilityEvidence.push({
          state: document.visibilityState, trusted: event.isTrusted, at: Date.now()
        });
      });
      window.resourceWindowEvidence = [];
      for (const type of ['focus', 'blur']) window.addEventListener(type, event => {
        if (window.resourceWindowEvidence.length < 128) window.resourceWindowEvidence.push({
          type, visibility:document.visibilityState, trusted:event.isTrusted, at:Date.now()
        });
      });
    }""")
    try:
        # Playwright 默认模拟 focused/active；关闭该模拟后检查真正的窗口可见性。
        try:
            cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": False})
            window = cdp.send("Browser.getWindowForTarget")["windowId"]
            native_snapshot(page, cdp, window, width, "before-minimize", report)
            cdp.send("Browser.setWindowBounds", {"windowId": window, "bounds": {"windowState": "minimized"}})
            page.wait_for_function("document.visibilityState === 'hidden'", polling=100, timeout=5000)
        except PlaywrightError as error:
            native_snapshot(page, cdp, window, width, "hidden-wait-failed", report)
            report["unverified"].append({"width": width, "id": "S5-AC07-native-hidden",
                                         "status": "INCONCLUSIVE", "reason": str(error),
                                         "observed": page.evaluate("document.visibilityState")})
            return task
        native_snapshot(page, cdp, window, width, "hidden-confirmed", report)
        page.wait_for_timeout(200)  # 完成隐藏之前已经发出的请求。
        before = fixture.snapshot()
        read_count = len(resource_gets(before, path))
        previous = task
        task = api(page, data["writeUrl"], "PATCH", path, {
            "expectedRevision": task["revision"], "title": f"隐藏时已提交 {width}"})["task"]
        page.wait_for_timeout(16000)  # 超过真实 15 秒周期，不使用虚拟时钟。
        hidden = fixture.snapshot()
        assert page.evaluate("document.visibilityState") == "hidden"
        assert len(resource_gets(hidden, path)) == read_count, "原生隐藏期间仍产生周期读取"
        assert page.locator("h1").text_content() == previous["title"], "隐藏期间不应自动对账"
        restored_at = monotonic()
        cdp.send("Browser.setWindowBounds", {"windowId": window, "bounds": {"windowState": "normal"}})
        page.bring_to_front()
        page.wait_for_function("document.visibilityState === 'visible'", polling=100, timeout=5000)
        expect(page.locator("h1")).to_have_text(task["title"], timeout=5000)
        elapsed = round((monotonic() - restored_at) * 1000)
        visibility = page.evaluate("window.resourceVisibilityEvidence")
        assert any(item["state"] == "hidden" and item["trusted"] for item in visibility), visibility
        assert any(item["state"] == "visible" and item["trusted"] for item in visibility), visibility
        native_snapshot(page, cdp, window, width, "visible-confirmed", report)
        check(report, width, "S5-AC07-native-hidden",
              "Chromium 原生隐藏超过15秒不读取，恢复可见后立即对账",
              hiddenDurationMs=16000, requestCountBefore=read_count,
              requestCountHidden=len(resource_gets(hidden, path)), recoveryMs=elapsed, visibility=visibility)
        return task
    finally:
        native_snapshot(page, cdp, window, width, "before-restore-cleanup", report)
        if window is not None:
            cdp.send("Browser.setWindowBounds", {"windowId": window, "bounds": {"windowState": "normal"}})
        page.bring_to_front()
        native_snapshot(page, cdp, window, width, "after-restore-cleanup", report)
        cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
        cdp.detach()


def exercise(page, context, fixture, data, width, output, report):
    origin, writer = data["url"], data["writeUrl"]
    first, second = data["records"]
    pid, other_pid = first["project"]["id"], second["project"]["id"]
    collection = f"/api/projects/{pid}/tasks"
    other_collection = f"/api/projects/{other_pid}/tasks"
    create = lambda target, title, member=None: api(page, writer, "POST", target, {
        "title": title, "body": "原始目标", "assigneeMemberId": member, "reviewerMemberId": None}, 201)["task"]
    # 足够长的真实列表，禁止以 scrollY=0 冒充滚动保持。
    for index in range(28): create(collection, f"滚动样本 {width} · {index:02}")
    task = create(collection, f"资源刷新原稿 {width}")
    path = collection + "/" + task["id"]
    page.goto(origin + f"/projects/{pid}/tasks")
    expect(page.get_by_test_id("task-board")).to_contain_text(task["title"])
    connected(page)
    page.get_by_test_id("task-list-mode").click()
    page.get_by_test_id("task-state-filter").select_option("todo")
    page.get_by_test_id("task-state-filter").focus()
    page.evaluate("scrollTo({top: 740, behavior: 'instant'})")
    before_scroll = page.evaluate("scrollY")
    assert before_scroll > 400, before_scroll
    task = api(page, writer, "PATCH", path, {
        "expectedRevision": task["revision"], "title": f"HTTP刷新新稿 {width}"})["task"]
    expect(page.get_by_test_id("task-board")).to_contain_text(task["title"], timeout=5000)
    expect(page.get_by_test_id("task-state-filter")).to_have_value("todo")
    expect(page.get_by_test_id("task-state-filter")).to_be_focused()
    expect(page.get_by_test_id("task-list-mode")).to_have_attribute("aria-pressed", "true")
    after_scroll = page.evaluate("scrollY")
    assert abs(after_scroll - before_scroll) <= 2, (before_scroll, after_scroll)
    check(report, width, "S5-AC06/08-list", "HTTP 提交刷新已打开列表，筛选、焦点及非零滚动保持",
          beforeScrollY=before_scroll, afterScrollY=after_scroll)
    screenshot(page, output, report, f"resource-list-{width}.png")

    page.goto(origin + f"/projects/{pid}/tasks/{task['id']}")
    expect(page.locator("h1")).to_have_text(task["title"]); connected(page)
    page.get_by_test_id("task-edit-open").click()
    page.get_by_test_id("task-title").fill(f"我的未保存标题 {width}")
    page.get_by_test_id("task-comment-body").fill("评论草稿保留")
    page.get_by_test_id("task-transition-reason").fill("阻塞理由草稿保留")
    page.get_by_test_id("task-title").focus()
    base = task["revision"]
    task = api(page, writer, "PATCH", path, {
        "expectedRevision": base, "title": f"远端事实 {width}", "body": "远端补齐的目标"})["task"]
    expect(page.get_by_test_id("task-remote-changes")).to_be_visible(timeout=5000)
    expect(page.get_by_test_id("task-draft-base")).to_contain_text(f"版本 {base}")
    expect(page.get_by_test_id("task-title")).to_have_value(f"我的未保存标题 {width}")
    expect(page.get_by_test_id("task-title")).to_be_focused()
    expect(page.get_by_test_id("task-comment-body")).to_have_value("评论草稿保留")
    expect(page.get_by_test_id("task-transition-reason")).to_have_value("阻塞理由草稿保留")
    expect(page.get_by_test_id("task-save")).to_be_disabled()
    screenshot(page, output, report, f"resource-draft-{width}.png")
    page.get_by_test_id("task-rebase").click()
    expect(page.get_by_test_id("task-body")).to_have_value("远端补齐的目标")
    expect(page.get_by_test_id("task-draft-base")).to_contain_text(f"版本 {task['revision']}")
    page.get_by_test_id("task-save").click()
    expect(page.locator("h1")).to_have_text(f"我的未保存标题 {width}")
    expect(page.get_by_test_id("task-comment-body")).to_have_value("评论草稿保留")
    expect(page.get_by_test_id("task-transition-reason")).to_have_value("阻塞理由草稿保留")
    check(report, width, "S5-AC08-drafts", "刷新保持 draft/baseRevision/焦点/评论和理由；明确采用后保存")

    # 真实并发：先捕获浏览器自己的旧 CAS 请求，再让其他客户端提交。
    task = api(page, writer, "GET", path)["task"]
    page.get_by_test_id("task-edit-open").click()
    page.get_by_test_id("task-title").fill(f"409 后保留的标题 {width}")
    held_save, submitted = [], []
    def hold_save(route):
        if route.request.method == "PATCH":
            submitted.append(route.request.post_data_json); held_save.append(route)
        else: route.continue_()
    page.route(origin + path, hold_save)
    try:
        with page.expect_request(lambda request: request.method == "PATCH" and request.url == origin + path):
            page.get_by_test_id("task-save").click()
        assert len(held_save) == 1 and submitted[0]["expectedRevision"] == task["revision"], submitted
        rival = api(page, writer, "PATCH", path, {
            "expectedRevision": task["revision"], "title": f"并发远端标题 {width}", "body": "并发后权威目标"})["task"]
        with page.expect_response(lambda response: response.request.method == "PATCH" and response.url == origin + path and response.status == 409):
            held_save.pop().continue_()
    finally:
        for route in held_save: route.abort()
        page.unroute(origin + path, hold_save)
    expect(page.get_by_test_id("task-conflict")).to_contain_text("保留")
    expect(page.get_by_test_id("task-title")).to_have_value(f"409 后保留的标题 {width}")
    expect(page.get_by_test_id("task-draft-base")).to_contain_text(f"版本 {task['revision']}")
    page.get_by_test_id("task-reload").click()
    expect(page.get_by_test_id("task-notice")).to_contain_text("已载入最新版本")
    expect(page.get_by_test_id("task-save")).to_be_disabled()
    expect(page.get_by_test_id("task-remote-changes")).to_contain_text("并发后权威目标")
    page.get_by_test_id("task-rebase").click()
    with page.expect_request(lambda request: request.method == "PATCH" and request.url == origin + path) as resubmitted:
        page.get_by_test_id("task-save").click()
    submitted.append(resubmitted.value.post_data_json)
    expect(page.locator("h1")).to_have_text(f"409 后保留的标题 {width}")
    saved = api(page, writer, "GET", path)["task"]
    assert saved["body"] == "并发后权威目标"
    assert submitted[-1] == {"expectedRevision": rival["revision"], "title": f"409 后保留的标题 {width}"}, submitted
    expect(page.get_by_test_id("task-comment-body")).to_have_value("评论草稿保留")
    expect(page.get_by_test_id("task-transition-reason")).to_have_value("阻塞理由草稿保留")
    check(report, width, "S5-AC08-409", "实际 409 保留旧基准；比较采用后仅提交本地改动", requests=submitted)
    blocked = api(page, writer, "POST", path + "/transitions", {
        "expectedRevision": saved["revision"], "state": "blocked", "reason": "其他客户端标记受阻"})["task"]
    expect(page.get_by_test_id("task-state")).to_contain_text("受阻")
    expect(page.get_by_test_id("task-transition-reason")).to_have_value("阻塞理由草稿保留")
    expect(page.get_by_test_id("task-reason-rebase")).to_be_visible()
    expect(page.get_by_test_id("task-start")).to_be_disabled()
    page.get_by_test_id("task-reason-rebase").click()
    expect(page.get_by_test_id("task-transition-reason")).to_have_value("阻塞理由草稿保留")
    expect(page.get_by_test_id("task-reason-rebase")).to_have_count(0)
    page.get_by_test_id("task-reason-discard").click()
    expect(page.get_by_test_id("task-transition-reason")).to_have_count(0)
    expect(page.get_by_test_id("task-comment-body")).to_have_value("评论草稿保留")
    check(report, width, "S5-AC08-blocked-reason", "远端进入 blocked 后理由草稿仍可明确采用或单独丢弃",
          remoteRevision=blocked["revision"])
    page.get_by_test_id("task-comment-body").fill("")

    # 同进程真实 MCP 修改已打开的乙项目，检查提示只是 id/revision。
    other = create(other_collection, f"HTTP MCP 原稿 {width}", second["memberId"])
    other_path = other_collection + "/" + other["id"]
    page.goto(origin + f"/projects/{other_pid}/tasks/{other['id']}")
    expect(page.locator("h1")).to_have_text(other["title"]); connected(page)
    other = fixture.command("mcp", transport="http", name="update_task",
                            args={"taskId": other["id"], "expectedRevision": other["revision"], "title": f"HTTP MCP 已提交 {width}"})["task"]
    expect(page.locator("h1")).to_have_text(other["title"], timeout=5000)
    fixture.command("mcp", transport="http", name="comment_task",
                    args={"taskId": other["id"], "body": f"MCP 私有评论 {width}"})
    expect(page.get_by_test_id("task-comments")).to_contain_text(f"MCP 私有评论 {width}", timeout=5000)
    frames = hints(fixture.snapshot(), other["id"])
    assert frames
    for event in frames:
        assert set(event["frame"]) == {"type", "projectId", "entity", "id", "revision"}, event
    check(report, width, "S5-AC06-mcp", "HTTP MCP 提交后已打开页面更新；提示仅携带标识和版本",
          frames=frames)

    # 独立 stdio 和丢包兜底均等待真实 15 秒周期，无手工刷新、虚拟时钟或假响应。
    task = create(collection, f"stdio 原稿 {width}", first["memberId"])
    path = collection + "/" + task["id"]
    page.goto(origin + f"/projects/{pid}/tasks/{task['id']}")
    expect(page.locator("h1")).to_have_text(task["title"]); connected(page)
    before = fixture.snapshot()
    hint_count = len(hints(before, task["id"]))
    get_count = len(resource_gets(before, path))
    started = monotonic()
    task = fixture.command("mcp", transport="stdio", name="update_task",
                           args={"taskId": task["id"], "expectedRevision": task["revision"], "title": f"stdio 新稿 {width}"})["task"]
    expect(page.locator("h1")).to_have_text(task["title"], timeout=20000)
    elapsed = round((monotonic() - started) * 1000)
    after = fixture.snapshot()
    assert len(hints(after, task["id"])) == hint_count, "独立进程不能借用 HTTP 内存通知"
    polled = resource_gets(after, path)[get_count:]
    assert polled and all(event["ifNoneMatch"] for event in polled), polled
    check(report, width, "S5-AC07-stdio", "独立 stdio 写同库由可见页真实周期条件 GET 发现",
          elapsedMs=elapsed, fixturePid=data["fixturePid"], stdioPid=data["stdioPid"], reads=polled)

    fixture.command("network", dropResources=True)
    start = len(fixture.snapshot()["events"])
    started = monotonic()
    task = api(page, writer, "PATCH", path, {
        "expectedRevision": task["revision"], "title": f"掉包后新稿 {width}"})["task"]
    wait_fixture(page, fixture, lambda snapshot: any(event["kind"] == "ws.dropped" and event.get("frame", {}).get("id") == task["id"] for event in snapshot["events"][start:]))
    expect(page.locator("h1")).to_have_text(task["title"], timeout=20000)
    check(report, width, "S5-AC07-dropped", "代理确实丢弃 resource.changed，周期兜底仍读到新值",
          elapsedMs=round((monotonic() - started) * 1000))
    fixture.command("network", dropResources=False)

    # 关闭真实 WS 并拒绝重连；最后成功值/时间必须保留，恢复后主动对账。
    previous, last_read = task, page.get_by_test_id("resource-sync-status").first.locator("time").get_attribute("datetime")
    fixture.command("network", blocked=True)
    expect(page.get_by_test_id("resource-sync-status").first).to_contain_text("离线", timeout=1500)
    task = api(page, writer, "PATCH", path, {
        "expectedRevision": task["revision"], "title": f"重连后新稿 {width}"})["task"]
    page.wait_for_timeout(2300)
    expect(page.locator("h1")).to_have_text(previous["title"])
    assert page.get_by_test_id("resource-sync-status").first.locator("time").get_attribute("datetime") == last_read
    disconnected = fixture.snapshot()
    assert any(event["kind"] == "ws.rejected" for event in disconnected["events"]), disconnected
    started = monotonic()
    fixture.command("network", blocked=False)
    expect(page.locator("h1")).to_have_text(task["title"], timeout=6000); connected(page)
    assert page.get_by_test_id("resource-sync-status").first.locator("time").get_attribute("datetime") != last_read
    check(report, width, "S5-AC07-reconnect", "断线保留上次值与读取时间，真实 WS 重连后立即对账",
          retainedReadAt=last_read, recoveryMs=round((monotonic() - started) * 1000))
    task = native_hidden_recovery(page, context, fixture, data, task, path, width, report)

    # 延迟的真实旧详情不得覆盖之后的 mutation；比较的字节来自真实上游。
    page.get_by_test_id("task-edit-open").click()
    page.get_by_test_id("task-title").fill(f"本地提交较新版本 {width}")
    fixture.command("network", holdPath=path)
    api(page, writer, "POST", path + "/comments", {"body": f"触发一次真实旧读取 {width}"}, 201)
    held_snapshot = wait_fixture(page, fixture, lambda snapshot: path in snapshot["heldPaths"])
    held_request = [event for event in held_snapshot["events"] if event["kind"] == "http.held" and event["path"] == path][-1]
    save_started = monotonic()
    page.get_by_test_id("task-save").click()
    expect(page.locator("h1")).to_have_text(f"本地提交较新版本 {width}")
    save_elapsed = round((monotonic() - save_started) * 1000)
    held_response = [event for event in held_snapshot["events"] if event["kind"] == "http.response"
                     and event["requestId"] == held_request["requestId"]]
    assert len(held_response) == 1 and held_response[0]["status"] == 200, held_response
    assert held_request["ifNoneMatch"], "旧详情仍须由原 URL 的应用 ETag 条件读取取得"
    saved_snapshot = fixture.snapshot()
    saved_requests = [event for event in saved_snapshot["events"] if event["kind"] == "http.request"
                      and event["method"] == "PATCH" and event["path"] == path
                      and event["requestId"] > held_request["requestId"]]
    assert len(saved_requests) == 1 and path in saved_snapshot["heldPaths"], saved_snapshot
    saved_response = [event for event in saved_snapshot["events"] if event["kind"] == "http.response"
                      and event["requestId"] == saved_requests[0]["requestId"]]
    assert len(saved_response) == 1 and saved_response[0]["status"] == 200, saved_response
    assert fixture.command("release") == [path]
    page.wait_for_timeout(300)
    expect(page.locator("h1")).to_have_text(f"本地提交较新版本 {width}")
    released = [event for event in fixture.snapshot()["events"] if event["kind"] == "http.released" and event["path"] == path][-1]
    check(report, width, "S5-AC07-late-detail", "同 URL 的旧 GET 扣留时真实 PATCH 成功；原释放点之后新值保持",
          heldRequest=held_request, heldResponse=held_response[0], patchRequest=saved_requests[0], patchResponse=saved_response[0],
          saveMs=save_elapsed, release=released,
          oldResponseOutcome="cancelled-before-release" if released["browserCancelled"] else "release-attempted-delivery-not-proven")

    # 同一 TasksView 切换项目后，释放旧项目响应不能污染新项目。
    page.goto(origin + f"/projects/{pid}/tasks")
    expect(page.get_by_test_id("task-board")).to_contain_text(f"本地提交较新版本 {width}"); connected(page)
    fixture.command("network", holdPath=collection)
    task = api(page, writer, "GET", path)["task"]
    task = api(page, writer, "PATCH", path, {"expectedRevision": task["revision"], "title": f"旧项目迟到值 {width}"})["task"]
    wait_fixture(page, fixture, lambda snapshot: collection in snapshot["heldPaths"])
    page.get_by_test_id("current-project").select_option(other_pid)
    expect(page.get_by_test_id("task-board")).to_contain_text(other["title"])
    assert fixture.command("release") == [collection]
    page.wait_for_timeout(300)
    expect(page.get_by_test_id("current-project")).to_have_value(other_pid)
    expect(page.get_by_test_id("task-board")).not_to_contain_text(task["title"])
    check(report, width, "S5-AC07-scope", "切项目后释放旧项目真实响应，当前视图与作用域保持")
    snapshot = fixture.snapshot()
    receipts = [entry for entry in snapshot["workEvents"] if entry["task_id"] in (task["id"], other["id"])]
    assert len(receipts) >= 2 and all(entry["acked_at"] is None for entry in receipts), receipts
    check(report, width, "S5-AC06-no-ack", "浏览器读取、重连与刷新未 ACK Agent WorkEvent", receipts=receipts)
    dimensions = page.evaluate("({width:innerWidth,document:document.documentElement.scrollWidth})")
    assert dimensions["document"] <= width + 1, dimensions
    screenshot(page, output, report, f"resource-final-{width}.png")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/resource-web-e2e")
    parser.add_argument("--chromium")
    parser.add_argument("--native-desktop", action="store_true", help="创建自有 Xvfb/Openbox 并运行已资格化的原生 Chromium")
    parser.add_argument("--runtime-binding", type=Path, default=ROOT / ".agent-output/resource-web-e2e/runtime-binding.json",
                        help="本轮 CI consumer 已核实的 source/producer 绑定；不回退旧资格产物")
    args = parser.parse_args()
    output = args.artifacts.resolve(); output.mkdir(parents=True, exist_ok=True)
    report = {"status": "NOT_RUN", "at": datetime.now(timezone.utc).isoformat(),
              "candidate": candidate(), "scope": "real Chromium / HTTP / MCP HTTP + independent stdio / temporary SQLite",
              "checks": [], "screenshots": [], "unverified": [], "pageErrors": [], "requests": [],
              "nativeCases": [], "cleanupErrors": []}
    fixture = None
    desktop = NativeDesktop(output / "native-desktop") if args.native_desktop else None
    try:
        report["status"] = "FAIL"
        assert desktop is not None, "完整资源原生验收要求 --native-desktop；不能以 headless 冒充资格"
        binding = load_runtime_binding(args.runtime_binding)
        profile = load_profile()["browser"]
        if args.chromium:
            assert Path(args.chromium).resolve() == Path(profile["executable"]).resolve(), "Chromium executable 与已资格 profile 不符"
        report["runtimeBinding"] = binding
        report["runtime"] = runtime_identity(binding)
        report["chromiumExecutable"] = profile["executable"]
        browser_env = desktop.start()
        fixture = Fixture(output); data = fixture.start()
        report["fixture"] = data
        with bounded_playwright(report) as p:
            for width, height in [(1440, 1000), (390, 844)]:
                desktop.check_alive()
                case_report = {"width": width, "height": height, "status": "NOT_RUN", "cleanupErrors": []}
                report["nativeCases"].append(case_report)
                with native_page(p, browser_env, width, height, output / f"native-{width}",
                                 output / f"trace-{width}.zip", case_report, binding) as (page, context):
                    report["headed"] = True
                    report["chromium"] = case_report["browserVersion"]["product"].split("/", 1)[1]
                    if "browserArguments" not in report:
                        # 兼容原报告的首个实际 browser 记录；两宽的完整身份都在 nativeCases。
                        report["browserArguments"] = case_report["argumentComparison"]["actual"]
                        report["browserProcesses"] = case_report["browserProcesses"]
                        report["browserIdentityScope"] = "first width; all actual identities in nativeCases"
                    page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
                    page.on("request", lambda request: report["requests"].append({
                        "at": datetime.now(timezone.utc).isoformat(), "method": request.method, "url": request.url,
                        **({"body": request.post_data} if request.method in ("POST", "PATCH", "PUT") else {})}))
                    try:
                        exercise(page, context, fixture, data, width, output, report)
                        desktop.check_alive()
                        assert not report["pageErrors"], report["pageErrors"]
                        case_report["status"] = validate_native_observations(report, width)
                    except Exception:
                        case_report["status"] = "FAIL"
                        sdk_cleanup(case_report, "failure screenshot",
                                    lambda: screenshot(page, output, report, f"failure-{width}.png") if not page.is_closed() else None)
                        raise
                if case_report["chromeCleanup"]["status"] != "PASS" or case_report["cleanupErrors"]:
                    raise RuntimeError("Chrome/SDK 清理未合格；不得开始下一宽或覆盖原失败")
        assert not report["cleanupErrors"], report["cleanupErrors"]
        report["status"] = "INCONCLUSIVE" if report["unverified"] else "PASS"
    except (KeyboardInterrupt, SystemExit):
        report["status"] = "FAIL"
        report["interrupted"] = True
        raise
    except Exception as error:
        report["status"] = "FAIL"
        report["error"] = str(error)[:10000]
        report["traceback"] = traceback.format_exc()
    finally:
        if fixture:
            try:
                if fixture.process.poll() is None and hasattr(fixture, "ready"):
                    snapshot = fixture.snapshot()
                    (output / "fixture-events.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2))
            except Exception as error: report["snapshotError"] = str(error)
            try: report["cleanup"] = fixture.close()
            except Exception as error:
                report["cleanupError"] = str(error); report["status"] = "FAIL"
        if desktop:
            try: report["nativeDesktop"] = desktop.close()
            except Exception as error:
                report["desktopCleanupError"] = str(error); report["status"] = "FAIL"
        report["candidateAfter"] = candidate()
        if report["candidateAfter"] != report["candidate"]:
            report["candidateChanged"] = True
            if report["status"] != "FAIL": report["status"] = "INCONCLUSIVE"
        if report["cleanupErrors"] or any(case["status"] == "FAIL" for case in report["nativeCases"]):
            report["status"] = "FAIL"
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({key: value for key, value in report.items() if key not in ("requests", "traceback")}, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    def terminate(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, terminate)
    raise SystemExit(main())
