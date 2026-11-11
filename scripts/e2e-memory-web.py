#!/usr/bin/env python3
"""真实 Chromium + 临时 SQLite 的记忆 UI 回归。合成总结不计真实模型验收。"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import select
import subprocess
import traceback
from urllib.parse import urlsplit
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent


def request(page, origin, method, path, body=None):
    response = page.request.fetch(origin + path, method=method, data=body)
    assert response.ok, f"{method} {path}: {response.status} {response.text()[:500]}"
    return response.json() if response.status != 204 else None


def fixture_command(process, action):
    command_id = str(uuid4())
    process.stdin.write(json.dumps({"id": command_id, "action": action}) + "\n")
    process.stdin.flush()
    ready, _, _ = select.select([process.stdout], [], [], 15)
    assert ready, "可信测试夹具命令超时"
    line = process.stdout.readline()
    assert line, "夹具命令未返回结果"
    result = json.loads(line)
    assert result["commandId"] == command_id
    return result["result"]


def capture(page, output, report, name):
    dimensions = page.evaluate("() => ({viewport:innerWidth, document:document.documentElement.scrollWidth, body:document.body.scrollWidth})")
    assert max(dimensions["document"], dimensions["body"]) <= dimensions["viewport"] + 1, (name, dimensions)
    report["layouts"].append({"view": name, **dimensions})
    page.screenshot(path=str(output / f"{name}.png"), full_page=True, animations="disabled")
    report["screenshots"].append(f"{name}.png")


def contrast(page):
    return page.evaluate("""() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', {willReadFrequently:true});
      const rgba = value => {ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
      const blend = (front, back) => front.slice(0,3).map((v,i)=>v*(front[3]/255)+back[i]*(1-front[3]/255));
      const luminance = color => color.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      return ['.memory-document h2','.memory-document .memory-meta','.summary-state-conflicted','.summary-reason'].flatMap(selector=>{
        const element = document.querySelector(selector); if (!element) return [];
        const ancestors=[]; for(let node=element;node;node=node.parentElement) ancestors.unshift(node);
        let background=[255,255,255]; for(const node of ancestors) background=blend(rgba(getComputedStyle(node).backgroundColor),background);
        const color=blend(rgba(getComputedStyle(element).color),background); const values=[luminance(color),luminance(background)].sort((a,b)=>a-b);
        return [{selector, foreground:color, background, ratio:(values[1]+.05)/(values[0]+.05)}];
      });
    }""")


def exercise(page, fixture, process, output, report):
    origin = fixture["url"]
    first, second = fixture["records"]
    pid, other = first["project"]["id"], second["project"]["id"]
    primary = first["members"]["primary"]["agentId"]
    alternate = first["members"]["second"]["agentId"]
    disabled = first["members"]["disabled"]["agentId"]
    removed = first["members"]["removed"]["agentId"]
    ids = fixture["requestIds"]
    shared_url = f"/api/projects/{pid}/memories/shared"
    member_url = f"/api/projects/{pid}/memories/agents/{primary}"
    shared_page = f"/projects/{pid}/knowledge"
    member_page = shared_page + f"?scope=members&agentId={primary}"
    report.update({"checks": [], "screenshots": [], "layouts": [], "contrast": [], "pageErrors": [], "consoleErrors": []})
    page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
    page.on("console", lambda message: report["consoleErrors"].append({"text": message.text, "location": message.location}) if message.type == "error" else None)

    for width, height, theme in [(1440, 1000, "light"), (768, 1000, "light"), (390, 844, "light"), (1440, 1000, "dark"), (390, 844, "dark")]:
        page.set_viewport_size({"width": width, "height": height})
        page.emulate_media(color_scheme=theme, reduced_motion="reduce")
        for name, route in [("shared", shared_page), ("member", member_page)]:
            page.goto(origin + route)
            expect(page.get_by_test_id("memory-editor")).to_be_enabled()
            if name == "member":
                expect(page.get_by_test_id(f"memory-summary-request-{ids['completed']}")).to_contain_text("已保存为版本 2")
                for state, label in [("pending", "待处理"), ("running", "Agent 已接手"), ("failed", "失败"), ("conflicted", "版本冲突"), ("cancelled", "已取消")]:
                    expect(page.get_by_test_id(f"memory-summary-request-{ids[state]}")).to_contain_text(label)
            capture(page, output, report, f"memory-{name}-{width}-{theme}")
            for sample in contrast(page):
                assert sample["ratio"] >= 4.5, (theme, name, sample)
                report["contrast"].append({"view": name, "theme": theme, **sample})
    report["checks"].append("WEBUI-01/03/04：共享/成员页面在1440、768、390和浅/深色下无整页横溢出；正文/辅助文字/警示色对比≥4.5")

    page.set_viewport_size({"width": 1440, "height": 1000})
    page.emulate_media(color_scheme="light")
    page.goto(origin + f"/memory?projectId={pid}")
    expect(page).to_have_url(origin + shared_page)
    expect(page.get_by_test_id("current-project")).to_have_count(1)
    expect(page.get_by_test_id("current-project")).to_have_value(pid)
    page.get_by_test_id("memory-scope-shared").focus()
    page.keyboard.press("Tab")
    expect(page.get_by_test_id("memory-scope-members")).to_be_focused()
    page.keyboard.press("Enter")
    expect(page.get_by_test_id("memory-agent")).to_be_visible()
    page.keyboard.press("Tab")
    expect(page.get_by_test_id("memory-agent")).to_be_focused()
    outline = page.get_by_test_id("memory-agent").evaluate("element => ({style:getComputedStyle(element).outlineStyle,width:parseFloat(getComputedStyle(element).outlineWidth)})")
    assert outline["style"] != "none" and outline["width"] >= 2, outline
    report["keyboardFocus"] = outline
    documents = request(page, origin, "GET", f"/api/projects/{pid}/memories")["documents"]
    assert all(document["key"]["scope"] != "global" for document in documents)
    assert fixture["privateSentinel"] not in json.dumps(documents)
    assert fixture["privateSentinel"] not in page.locator("body").inner_text()
    expect(page.get_by_text("查看全局记忆", exact=True)).to_have_count(0)
    denied = page.request.get(origin + f"/api/projects/{pid}/memories/global")
    assert denied.status == 404 and fixture["privateSentinel"] not in denied.text()
    report["checks"].append("唯一项目选择、旧深链重定向、键盘切区/可见焦点；有真实global种子的默认owner列表/页面无其正文或metadata")

    page.goto(origin + shared_page)
    held = []
    pattern = f"**{shared_url}"
    page.route(pattern, lambda route: held.append(route) if route.request.method == "PUT" else route.continue_())
    first_draft = "浏览器手动保存：中文🙂"
    continued_draft = first_draft + "\n保存过程中继续输入"
    page.get_by_test_id("memory-editor").fill(first_draft)
    page.get_by_test_id("memory-save").click()
    expect(page.get_by_test_id("memory-save")).to_be_disabled()
    page.get_by_test_id("memory-editor").fill(continued_draft)
    assert len(held) == 1
    held[0].continue_()
    page.unroute(pattern)
    expect(page.get_by_test_id("memory-notice")).to_contain_text("你继续输入的内容仍在草稿中")
    expect(page.get_by_test_id("memory-editor")).to_have_value(continued_draft)
    first_saved = request(page, origin, "GET", shared_url)["document"]
    assert first_saved["markdown"] == first_draft
    page.get_by_test_id("memory-save").click()
    expect(page.get_by_test_id("memory-notice")).to_contain_text(f"版本 {first_saved['version'] + 1}")
    saved = request(page, origin, "GET", shared_url)["document"]
    assert saved["markdown"] == continued_draft and saved["byteLength"] == len(continued_draft.encode("utf-8"))

    sent = []
    def lose_first_response(route):
        if route.request.method != "PUT": return route.continue_()
        sent.append(route.request.post_data_json)
        if len(sent) == 1:
            response = route.fetch()
            assert response.ok
            route.abort("failed")
        else: route.continue_()
    page.route(pattern, lose_first_response)
    page.get_by_test_id("memory-editor").fill("已提交但响应丢失的正文")
    page.get_by_test_id("memory-save").click()
    expect(page.get_by_test_id("memory-error")).to_contain_text("草稿已保留")
    page.get_by_test_id("memory-save").click()
    expect(page.get_by_test_id("memory-notice")).to_contain_text(f"版本 {saved['version'] + 1}")
    page.unroute(pattern)
    after_retry = request(page, origin, "GET", shared_url)["document"]
    assert after_retry["version"] == saved["version"] + 1
    assert len(sent) == 2 and sent[0] == sent[1]
    report["checks"].append("AC-MEM-05：真实HTTP保存/UTF8字节一致；在途继续输入保留；提交后丢响应重放同mutation不增加版本")

    local_draft = "409后必须保留的本地草稿"
    page.get_by_test_id("memory-editor").fill(local_draft)
    request(page, origin, "PUT", shared_url, {"expectedVersion": after_retry["version"], "clientMutationId": str(uuid4()), "markdown": "另一次操作已确认的最新正文"})
    page.get_by_test_id("memory-save").click()
    expect(page.get_by_test_id("memory-conflict")).to_contain_text("本地草稿已保留")
    expect(page.get_by_test_id("memory-editor")).to_have_value(local_draft)
    page.get_by_test_id("memory-read-latest").click()
    expect(page.get_by_test_id("memory-latest-text")).to_contain_text("另一次操作已确认")
    expect(page.get_by_test_id("memory-editor")).to_have_value(local_draft)
    expect(page.get_by_test_id("memory-save")).to_be_disabled()
    page.set_viewport_size({"width": 390, "height": 844})
    capture(page, output, report, "memory-conflict-390-light")
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.get_by_test_id("memory-rebase").click()
    expect(page.get_by_test_id("memory-editor")).to_be_focused()
    page.get_by_test_id("memory-editor").fill(local_draft + " + 已核对最新正文")
    page.get_by_test_id("memory-save").click()
    expect(page.get_by_test_id("memory-notice")).to_contain_text(f"版本 {after_retry['version'] + 2}")
    page.get_by_test_id("memory-history-open").click()
    page.get_by_test_id("memory-history-number").fill("2")
    page.get_by_test_id("memory-history-jump").click()
    expect(page.get_by_test_id("memory-history-text")).to_have_text(fixture["oldMarkdown"])
    expect(page.locator(".memory-history script")).to_have_count(0)
    assert page.evaluate("() => typeof globalThis.memoryXss") == "undefined"
    page.get_by_test_id("memory-history-more").click()
    expect(page.get_by_test_id("memory-history-version-1")).to_have_count(1)
    before_restore = request(page, origin, "GET", shared_url)
    page.get_by_test_id("memory-history-use").click()
    expect(page.get_by_test_id("memory-editor")).to_have_value(fixture["oldMarkdown"])
    assert request(page, origin, "GET", shared_url)["version"] == before_restore["version"]
    page.get_by_test_id("memory-save").click()
    expect(page.get_by_test_id("memory-notice")).to_contain_text(f"版本 {before_restore['version'] + 1}")
    page.get_by_test_id("memory-editor").fill("")
    page.get_by_test_id("memory-save").click()
    expect(page.get_by_test_id("memory-notice")).to_contain_text(f"版本 {before_restore['version'] + 2}")
    assert request(page, origin, "GET", shared_url)["document"]["markdown"] == ""
    report["checks"].append("AC-MEM-05/06：真实409保草稿/读取对照/明确新基准；20条之外版本读取与历史分页、安全文本恢复、新CAS保存、显式空正文")

    page.get_by_test_id("memory-editor").fill("切区前的共享草稿")
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.get_by_test_id("memory-scope-members").click()
    expect(page).to_have_url(origin + shared_page)
    expect(page.get_by_test_id("memory-editor")).to_have_value("切区前的共享草稿")
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_test_id("memory-scope-members").click()
    page.get_by_test_id("memory-agent").select_option(primary)
    page.get_by_test_id("memory-editor").fill("成员切换前的草稿")
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.get_by_test_id("memory-agent").select_option(alternate)
    expect(page.get_by_test_id("memory-agent")).to_have_value(primary)
    expect(page.get_by_test_id("memory-editor")).to_have_value("成员切换前的草稿")
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_test_id("memory-agent").select_option(alternate)
    expect(page.get_by_test_id("memory-editor")).to_have_value("暮川在本项目中保留的事实与协作约定。")
    page.get_by_test_id("memory-agent").select_option(removed)
    expect(page.get_by_test_id("memory-editor")).to_have_value("此前的协作者在本项目中保留的事实与协作约定。")
    page.get_by_test_id("memory-agent").select_option(disabled)
    expect(page.get_by_test_id("memory-editor")).to_be_enabled()
    expect(page.get_by_test_id(f"memory-summary-retry-{ids['disabled']}")).to_be_disabled()
    page.get_by_test_id("memory-agent").select_option(primary)
    page.get_by_test_id(f"memory-summary-retry-{ids['failed']}").click()
    expect(page.get_by_test_id("memory-summary-notice")).to_contain_text("已安排新请求，当前待处理")
    actual_requests = request(page, origin, "GET", member_url + "/summary-requests")["requests"]
    retries = [entry for entry in actual_requests if entry["retryOfRequestId"] == ids["failed"]]
    assert len(retries) == 1 and retries[0]["state"] == "pending"
    page.get_by_test_id("memory-editor").fill("人工优先：浏览器确认的新事实")
    page.get_by_test_id("memory-save").click()
    expect(page.get_by_test_id("memory-notice")).to_contain_text("已保存为版本")
    result = fixture_command(process, "begin-pending-after-manual-edit")
    assert result["state"] == "conflicted"
    page.get_by_test_id("memory-summary-refresh").click()
    expect(page.get_by_test_id(f"memory-summary-request-{ids['pending']}")).to_contain_text("版本冲突")
    expect(page.get_by_test_id("memory-editor")).to_have_value("人工优先：浏览器确认的新事实")
    report["checks"].append("成员切换取消/确认、停用/已离开文档可达；实际HTTP重试创建pending；人工保存后可信Agent begin持久conflicted（合成通道，不计真实模型）")

    page.get_by_test_id("memory-editor").fill("跨项目前未保存的草稿")
    previous_url = page.url
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.get_by_test_id("current-project").select_option(other)
    expect(page).to_have_url(previous_url)
    expect(page.get_by_test_id("current-project")).to_have_value(pid)
    expect(page.get_by_test_id("memory-editor")).to_have_value("跨项目前未保存的草稿")
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_test_id("current-project").select_option(other)
    expect(page.get_by_test_id("memory-editor")).to_have_value("乙项目的独立记忆")
    held = []
    page.route(pattern, lambda route: held.append(route))
    page.get_by_test_id("current-project").select_option(pid)
    expect(page.get_by_test_id("memory-editor")).to_be_disabled()
    page.get_by_test_id("current-project").select_option(other)
    expect(page.get_by_test_id("memory-editor")).to_have_value("乙项目的独立记忆")
    assert held
    for route in held: route.continue_()
    page.unroute(pattern)
    page.wait_for_timeout(100)
    expect(page.get_by_test_id("memory-editor")).to_have_value("乙项目的独立记忆")
    other_pattern = f"**/api/projects/{other}/memories/shared"
    page.route(other_pattern, lambda route: route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"code": "synthetic_read_failure", "message": "受控的临时读取失败"}})))
    page.reload()
    expect(page.get_by_test_id("memory-error")).to_contain_text("受控的临时读取失败")
    expect(page.get_by_test_id("memory-save")).to_be_disabled()
    page.unroute(other_pattern)
    page.get_by_test_id("memory-error").get_by_role("button", name="重新读取（保留草稿）", exact=True).click()
    expect(page.get_by_test_id("memory-editor")).to_have_value("乙项目的独立记忆")
    report["checks"].append("项目切换取消/确认与迟到读取隔离；受控503故障有明确重试且失败读取不开写入")

    page.goto(origin + f"/projects/{pid}/overview")
    page.get_by_test_id("project-actions").locator("summary").click()
    page.get_by_test_id("purge-project").click()
    expect(page.get_by_test_id("project-purge-confirm")).to_contain_text(f"记忆文档：{len(documents)}")
    expect(page.get_by_test_id("project-purge-confirm")).to_contain_text("全局私有记忆保留")
    page.get_by_test_id("cancel-purge-project").click()
    page.get_by_test_id("group-list").locator("details").first.locator("summary").click()
    page.get_by_test_id("purge-group").first.click()
    expect(page.get_by_test_id("group-purge-confirm")).to_contain_text("记忆正文与版本历史全部保留")
    page.get_by_test_id("cancel-purge-group").click()
    request(page, origin, "POST", f"/api/projects/{pid}/archive")
    page.goto(origin + member_page)
    expect(page.get_by_test_id("memory-editor")).to_be_disabled()
    expect(page.get_by_test_id("memory-save")).to_be_disabled()
    expect(page.get_by_test_id(f"memory-summary-retry-{ids['cancelled']}")).to_be_disabled()
    expect(page.get_by_text("项目已归档，记忆与历史可查看，无法修改。", exact=True)).to_be_visible()
    page.get_by_test_id("memory-history-open").click()
    page.get_by_test_id("memory-history-version-1").click()
    expect(page.get_by_test_id("memory-history-use")).to_be_disabled()
    before = request(page, origin, "GET", member_url)
    denied = page.request.put(origin + member_url, data={"expectedVersion": before["version"], "clientMutationId": str(uuid4()), "markdown": "不应保存"})
    assert denied.status == 409
    assert request(page, origin, "GET", member_url)["version"] == before["version"]
    report["checks"].append("实际purge预览计数与保留政策；归档仍可读历史，UI及真实HTTP均拒绝修改")

    assert not report["pageErrors"], report["pageErrors"]
    expected_network_errors = ("status of 409", "status of 503", "net::ERR_FAILED", "favicon.ico")
    unexpected = [entry for entry in report["consoleErrors"] if not any(text in entry["text"] + entry.get("location", {}).get("url", "") for text in expected_network_errors)]
    assert not unexpected, unexpected
    report["status"] = "PASS"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/memory-web-e2e")
    parser.add_argument("--chromium", type=Path, help="使用已有 Chromium 可执行文件；CI 默认用 Playwright 安装的版本")
    args = parser.parse_args()
    output = args.artifacts.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "FAIL", "at": datetime.now(timezone.utc).isoformat(), "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "worktree": subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True).strip(), "scope": "real Chromium / real HTTP / temporary SQLite / synthetic summary content / no model invocation"}
    fixture = None
    try:
        report["phase"] = "fixture_start"
        fixture = subprocess.Popen(["node", "scripts/memory-web-fixture.mjs"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready, _, _ = select.select([fixture.stdout], [], [], 45)
        assert ready, "记忆浏览器临时服务启动超时"
        line = fixture.stdout.readline()
        assert line, "临时服务未返回地址：" + fixture.stderr.read(3000)
        data = json.loads(line)
        parsed = urlsplit(data["url"])
        assert parsed.hostname == "127.0.0.1" and parsed.scheme == "http"
        report["fixtureScope"] = data["evidenceScope"]
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
            try: exercise(page, data, fixture, output, report)
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
