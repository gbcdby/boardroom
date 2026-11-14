#!/usr/bin/env python3
"""#112 / S5-AUDIT-16 / NFR-03/04：真实 Chromium、HTTP/MCP、SQLite/PG 逐次时序。

npm run build:web
python scripts/e2e-v1-load-web.py --ci --db sqlite
AGENT_STUDIO_PG_TEST_URL=... python scripts/e2e-v1-load-web.py --ci --db postgres
本地已知浏览器受限时使用 --fixture-only；仅协议自检，明确不计 DOM 验收通过。
两档分别使用新临时数据库和进程，每档六次翻转；默认防环与超时阈值保持不变。
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from importlib.metadata import version
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import subprocess
import sys
import traceback
from urllib.parse import urlsplit
from uuid import uuid4

ROOT = Path(__file__).resolve().parent.parent
LIMITS = {"mutationMs": 500, "mcpMs": 2000, "webDomMs": 1000, "flips": 6}

# 首先记录浏览器单调时钟，再安装 MutationObserver；包含 Python/stdio 调度开销。
# DOM 精确文本匹配后等待真实渲染帧及可见交集，不用 HTTP 完成或 sleep 冒充展示。
ARM_OBSERVER = """token => {
  const list = document.querySelector('[data-testid="chat-messages"]');
  if (!list) throw new Error('chat message DOM missing');
  if ([...list.querySelectorAll('.message-text')].some(node => node.textContent === token))
    throw new Error('measurement token already exists');
  globalThis.__v1LoadObservation?.observer?.disconnect();
  const state = {token, startedAt: performance.now(), domFoundAt:null, result:null, frame:null};
  const check = () => {
    if (state.result) return;
    const node = [...list.querySelectorAll('.message-text')].find(item => item.textContent === token);
    if (!node) return;
    state.domFoundAt ??= performance.now();
    const r=node.getBoundingClientRect(), box=list.getBoundingClientRect(), style=getComputedStyle(node);
    if (r.width > 0 && r.height > 0 && r.bottom > Math.max(0,box.top) &&
        r.top < Math.min(innerHeight,box.bottom) && style.visibility !== 'hidden' && style.display !== 'none') {
      const visibleAt=performance.now();
      state.result={token, startedAt:state.startedAt, domFoundAt:state.domFoundAt, visibleAt,
        domElapsedMs:state.domFoundAt-state.startedAt, elapsedMs:visibleAt-state.startedAt,
        documentVisibility:document.visibilityState, renderedText:node.textContent};
      state.observer.disconnect();
      if (state.frame) cancelAnimationFrame(state.frame);
    } else state.frame=requestAnimationFrame(check);
  };
  state.observer=new MutationObserver(() => {
    if (state.frame === null) state.frame=requestAnimationFrame(() => {state.frame=null;check();});
  });
  state.observer.observe(list,{childList:true,subtree:true,characterData:true});
  globalThis.__v1LoadObservation=state;
  return {startedAt:state.startedAt,token};
}"""


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class Fixture:
    def __init__(self, engine: str, count: int, artifacts: Path):
        self.raw_path = artifacts / f"{engine}-{count}-protocol.jsonl"
        self.raw = self.raw_path.open("w", encoding="utf-8")
        self.stderr = (artifacts / f"{engine}-{count}-stderr.log").open("w", encoding="utf-8")
        self.process = subprocess.Popen(["node", "scripts/v1-load-web-fixture.mjs", "--db", engine, "--history", str(count)],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True, bufsize=1)
        self.closed = False

    def read(self, timeout: float = 30) -> dict:
        ready, _, _ = select.select([self.process.stdout], [], [], timeout)
        if not ready:
            raise TimeoutError("fixture protocol timeout; pending database work is not reported as cancelled")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"fixture exited before response ({self.process.poll()}); inspect isolated stderr artifact")
        self.raw.write(line)
        self.raw.flush()
        return json.loads(line)

    def command(self, action: str, **fields) -> dict:
        command = {"id": str(uuid4()), "action": action, **fields}
        self.raw.write(json.dumps({"stdin": command}, ensure_ascii=False) + "\n")
        self.raw.flush()
        self.process.stdin.write(json.dumps(command) + "\n")
        self.process.stdin.flush()
        response = self.read()
        assert response["id"] == command["id"], response
        assert response["ok"] is True, response
        return response["result"]

    def close(self) -> dict:
        if self.closed:
            return {}
        self.closed = True
        cleanup = {}
        error = None
        try:
            if self.process.poll() is None:
                cleanup = self.command("close")
        except Exception as caught:
            error = caught
        finally:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                # 这是失败清理；绝不把 terminate/kill 当作 DB 已回滚的证据。
                self.process.terminate()
                try:
                    self.process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
                error = error or RuntimeError("fixture graceful cleanup timed out")
            self.raw.close()
            self.stderr.close()
        if error:
            raise error
        assert self.process.returncode == 0, f"fixture cleanup exit {self.process.returncode}"
        assert cleanup["clientSessionsTerminated"] == 3 and cleanup["serverClosed"] and cleanup["temporaryDirectoryRemoved"]
        return cleanup


def scenario(engine, count, artifacts, browser, fixture_only):
    result = {"historyCount": count, "status": "FAIL", "rounds": [], "screenshots": [], "browserErrors": [], "outsideRequests": []}
    fixture = Fixture(engine, count, artifacts)
    context = None
    page = None
    try:
        info = fixture.read(timeout=60)
        assert info["type"] == "ready" and info["protocol"] == "boardroom-v1-load/v1"
        assert info["historyCount"] == count and info["engine"] == engine
        assert info["limits"] == LIMITS and info["activeMcpConnections"] == 3
        parsed = urlsplit(info["url"])
        assert parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port
        result["fixture"] = info
        if not fixture_only:
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="zh-CN", timezone_id="UTC")
            page = context.new_page()
            page.set_default_timeout(15_000)
            page.on("pageerror", lambda error: result["browserErrors"].append({"kind": "pageerror", "message": str(error)}))
            page.on("console", lambda message: result["browserErrors"].append({"kind": "console", "message": message.text}) if message.type == "error" else None)

            def restrict(route):
                target = urlsplit(route.request.url)
                if target.scheme in ("http", "https") and f"{target.scheme}://{target.netloc}" != info["url"]:
                    result["outsideRequests"].append(target.hostname)
                    route.abort()
                else:
                    route.continue_()

            page.route("**/*", restrict)
            page.goto(f"{info['url']}/projects/{info['projectId']}/chat/{info['groupId']}")
            page.get_by_test_id("chat-messages").wait_for(state="visible")
            page.wait_for_function("() => document.querySelector('[data-testid=chat-ws]')?.textContent.includes('实时已连接') && document.querySelectorAll('[data-testid=chat-messages] .message-text').length === 200")
            assert page.get_by_test_id("chat-error").count() == 0
            page.screenshot(path=str(artifacts / f"{engine}-{count}-before.png"), full_page=True, animations="disabled")
            result["screenshots"].append(f"{engine}-{count}-before.png")
        for index in range(LIMITS["flips"]):
            token = f"v1-load-{engine}-{count}-{index}-{uuid4().hex}"
            if page:
                page.get_by_test_id("chat-messages").evaluate("node => {node.scrollTop=node.scrollHeight}")
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                result.setdefault("observerArmed", []).append(page.evaluate(ARM_OBSERVER, token))
            # Observer 已先记录 performance.now；从这里到 stdin 发出造成的开销也包含在 DOM 指标。
            measured = fixture.command("round", index=index, token=token)
            result["rounds"].append(measured)
            if page:
                try:
                    page.wait_for_function("() => globalThis.__v1LoadObservation?.result != null", timeout=15_000)
                    dom = page.evaluate("() => globalThis.__v1LoadObservation.result")
                    measured["webDom"] = dom
                    assert dom["token"] == token and dom["renderedText"] == token
                    assert dom["documentVisibility"] == "visible"
                    assert dom["elapsedMs"] <= LIMITS["webDomMs"], f"DOM {dom['elapsedMs']:.3f}ms 超出固定 1000ms 门限"
                except Exception as error:
                    measured["status"] = "FAIL"
                    measured.setdefault("errors", []).append({"kind": "web-dom", "message": str(error)})
                    name = f"{engine}-{count}-round-{index}-failure.png"
                    page.screenshot(path=str(artifacts / name), full_page=True, animations="disabled")
                    result["screenshots"].append(name)
            else:
                measured["webDom"] = {"status": "NOT_RUN", "reason": "fixture-only does not launch Chromium"}
            if page and measured["status"] == "FAIL":
                name = f"{engine}-{count}-round-{index}-failure.png"
                if name not in result["screenshots"]:
                    page.screenshot(path=str(artifacts / name), full_page=True, animations="disabled")
                    result["screenshots"].append(name)
            # 单次慢请求保留 FAIL 并继续剩余真实翻转，不能用后续较快结果抵消它。
            # 业务/审计链失败则不能再假装执行下一次合法补偿。
            assert measured["functionalStatus"] == "PASS", measured["errors"]
            write_json(artifacts / f"{engine}-{count}-partial.json", result)
        inspection = fixture.command("inspect")
        assert inspection["rounds"] == 6 and inspection["allRoundsFunctionalPassed"] and inspection["activeMcpConnections"] == 3
        assert inspection["history"] == info["history"]
        assert inspection["totalMessages"] == count + 6
        result["finalInspection"] = inspection
        if page:
            assert not result["browserErrors"], result["browserErrors"]
            assert not result["outsideRequests"], result["outsideRequests"]
            page.screenshot(path=str(artifacts / f"{engine}-{count}-after.png"), full_page=True, animations="disabled")
            result["screenshots"].append(f"{engine}-{count}-after.png")
        if all(row["status"] == "PASS" for row in result["rounds"]):
            result["status"] = "PROTOCOL_PASS_BROWSER_NOT_RUN" if fixture_only else "PASS"
    except Exception as error:
        result.update(status="FAIL", errorType=type(error).__name__, detail=str(error)[:5000], traceback=traceback.format_exc())
        if page and not page.is_closed():
            try:
                name = f"{engine}-{count}-failure.png"
                page.screenshot(path=str(artifacts / name), full_page=True, animations="disabled")
                result["screenshots"].append(name)
            except Exception as screenshot_error:
                result["screenshotError"] = str(screenshot_error)
    finally:
        if context:
            try:
                context.close()
            except Exception as error:
                result.update(status="FAIL", browserCleanupError=str(error))
        try:
            result["cleanup"] = fixture.close()
            if engine == "postgres":
                assert result["cleanup"]["schemaDropped"] is True
        except Exception as error:
            result.update(status="FAIL", cleanupError=str(error))
        write_json(artifacts / f"{engine}-{count}.json", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", choices=("sqlite", "postgres"), default="sqlite")
    parser.add_argument("--ci", action="store_true")
    parser.add_argument("--fixture-only", action="store_true", help="仅运行真实服务及 stdin 协议，DOM 明确 NOT_RUN")
    parser.add_argument("--artifacts", type=Path)
    args = parser.parse_args()
    if (args.ci or os.environ.get("CI", "").lower() == "true") and args.fixture_only:
        parser.error("CI 验收不能用 --fixture-only 替代 Chromium")
    artifacts = (args.artifacts or ROOT / ".agent-output/v1-load-web" / args.db).resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    worktree_status = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True)
    report = {"status": "FAIL", "startedAt": datetime.now(timezone.utc).isoformat(), "engine": args.db,
        "acceptance": ["S5-AUDIT-16", "NFR-03", "NFR-04"], "limits": LIMITS, "modelInvocation": "NOT_RUN",
        "os": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "tree": subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT, text=True).strip(),
        "dirty": bool(worktree_status.strip()),
        "worktreeStatus": worktree_status.splitlines(),
        "trackedChanges": subprocess.check_output(["git", "diff", "--name-status", "HEAD"], cwd=ROOT, text=True).splitlines(),
        "harnessSha256": {name: hashlib.sha256((ROOT / "scripts" / name).read_bytes()).hexdigest()
            for name in ("v1-load-web-fixture.mjs", "e2e-v1-load-web.py")},
        "scenarios": [], "scope": "两个独立固定规模临时实例；每档六次翻转，默认防环不变；Linux 证据不外推 macOS。",
        "resourceAccounting": "此脚本计实际 HTTP/MCP/DOM；SQL/返回行/字节预算由同候选资源验收另行取证。"}
    try:
        if args.fixture_only:
            report["browser"] = "NOT_RUN"
            report["scenarios"] = [scenario(args.db, count, artifacts, None, True) for count in (1000, 10000)]
        else:
            from playwright.sync_api import sync_playwright
            report["playwright"] = version("playwright")
            with sync_playwright() as playwright:
                # 已知受限的本机应显式选 fixture-only；CI 启动失败始终 FAIL，不能静默跳过。
                browser = playwright.chromium.launch(headless=True)
                report["chromium"] = browser.version
                try:
                    report["scenarios"] = [scenario(args.db, count, artifacts, browser, False) for count in (1000, 10000)]
                finally:
                    browser.close()
        expected = "PROTOCOL_PASS_BROWSER_NOT_RUN" if args.fixture_only else "PASS"
        if all(result["status"] == expected for result in report["scenarios"]):
            report["status"] = expected
    except Exception as error:
        report.update(status="FAIL", errorType=type(error).__name__, detail=str(error)[:5000], traceback=traceback.format_exc())
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    write_json(artifacts / "report.json", report)
    print(json.dumps({"status": report["status"], "engine": args.db, "scenarios": len(report["scenarios"]),
        "report": str(artifacts / "report.json")}, ensure_ascii=False), flush=True)
    return 1 if report["status"] == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main())
