#!/usr/bin/env python3
"""正式验收之后的首次聊天单次隔离诊断；不修改正式结果、不产生产品 PASS。"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import select
import subprocess
import tarfile
import tempfile
import traceback
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
PATCH = ROOT / "scripts/diagnostics/chat-follow.patch"
PRODUCT_FILES = ("src/web/src/views/ChatView.vue", "src/web/src/composables/useChatViewport.ts")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(directory, output, report):
    source = directory / "source"
    source.mkdir()
    archive = directory / "source.tar"
    with archive.open("wb") as target:
        subprocess.run(["git", "archive", "HEAD"], cwd=ROOT, stdout=target, check=True, timeout=30)
    with tarfile.open(archive) as content:
        content.extractall(source, filter="data")
    report["sourceFiles"] = {name: digest(source / name) for name in PRODUCT_FILES}
    patch = PATCH.read_bytes()
    (output / "instrumentation.patch").write_bytes(patch)
    report["diagnosticPatchSha256"] = hashlib.sha256(patch).hexdigest()
    subprocess.run(["git", "apply", "--check", str(PATCH)], cwd=source, check=True, timeout=10)
    subprocess.run(["git", "apply", str(PATCH)], cwd=source, check=True, timeout=10)
    report["diagnosticFiles"] = {name: digest(source / name) for name in PRODUCT_FILES}
    (source / "node_modules").symlink_to((ROOT / "node_modules").resolve(), target_is_directory=True)
    with (output / "build.log").open("w") as log:
        subprocess.run(["npm", "run", "build:web"], cwd=source, stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=60)
    return source


class CapturedFirstEntry(Exception):
    """只结束本次独立诊断，不影响已经结束的正式验收。"""


def observe_first_entry(original, report):
    def observe(page, name, exercise_report):
        assert name == "chat-1440-light", f"诊断路径意外改变：{name}"
        observation = {"view": name, "outcome": "visible", "sampleCount": 1}
        try:
            original(page, name, exercise_report)
        except Exception as error:
            observation.update(outcome="assertion_error", error=str(error), traceback=traceback.format_exc())
        finally:
            # 原 helper 已保存最终几何；这里仅读取有界 JS 日志，不增加布局读取。
            observation["events"] = page.evaluate("() => globalThis.__chatFollowDiagnostic ?? null")
            report["observation"] = observation
        assert observation["events"] and observation["events"]["events"], "诊断构建没有产生内部事件"
        raise CapturedFirstEntry()
    return observe


def exercise_once(source, output, report, chromium=None):
    from playwright.sync_api import sync_playwright
    spec = importlib.util.spec_from_file_location("diagnostic_theme_fixture", source / "scripts/e2e-theme-web.py")
    theme = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(theme)
    # 复用原 exercise 的数据、全部先行导航、双页主题与 viewport 操作，首个聊天后即停止。
    theme.chat_entry_latest = observe_first_entry(theme.chat_entry_latest, report)
    fixture = subprocess.Popen(["node", "scripts/managed-web-fixture.mjs"], cwd=source,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        ready, _, _ = select.select([fixture.stdout], [], [], 30)
        assert ready, "隔离诊断 fixture 启动超时"
        line = fixture.stdout.readline()
        assert line, "隔离诊断 fixture 未返回地址"
        data = json.loads(line)
        assert urlsplit(data["url"]).hostname == "127.0.0.1"
        with sync_playwright() as playwright:
            launch = {"headless": True}
            if chromium:
                launch["executable_path"] = str(chromium)
            browser = playwright.chromium.launch(**launch)
            report["chromium"] = browser.version
            try:
                try:
                    theme.exercise(browser, data["url"], data["workdir"], output, report)
                except CapturedFirstEntry:
                    report["status"] = "DIAGNOSTIC_ONLY"
                else:
                    raise AssertionError("未捕获首次聊天，诊断不得继续其他样本")
            finally:
                browser.close()
    finally:
        fixture.stdin.close()
        try:
            fixture.wait(timeout=10)
        except subprocess.TimeoutExpired:
            fixture.terminate()
            fixture.wait(timeout=5)
        (output / "fixture-stderr.log").write_text(fixture.stderr.read())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-report", type=Path)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/chat-follow-diagnostic")
    parser.add_argument("--chromium", type=Path)
    parser.add_argument("--prepare-only", action="store_true", help="仅验证隔离归档、补丁和构建；不启动浏览器")
    args = parser.parse_args()
    output = args.artifacts.resolve()
    if args.original_report and output == args.original_report.resolve().parent:
        parser.error("诊断产物必须使用独立目录，不能覆盖原验收报告或 trace")
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "INCONCLUSIVE", "diagnosticOnly": True, "sampleLimit": 1,
              "at": datetime.now(timezone.utc).isoformat(),
              "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "sourceTree": subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT, text=True).strip(),
              "scope": "isolated instrumented copy; cannot replace original uninstrumented acceptance",
              "checks": [], "screenshots": [], "layouts": [], "contrast": [], "pageErrors": []}
    try:
        if not args.prepare_only:
            assert args.original_report, "必须提供原正式验收报告"
            original_path = args.original_report.resolve()
            original = json.loads(original_path.read_text())
            assert original["status"] in ("PASS", "FAIL") and original["commit"] == report["sourceCommit"], "只诊断同一候选已结束的正式验收"
            entries = original.get("chatEntries", [])
            if entries:
                assert entries[0]["view"] == "chat-1440-light", "正式验收首次聊天路径意外改变"
            report["originalAcceptance"] = {"path": str(original_path), "sha256": digest(original_path),
                                            "status": original["status"], "error": original.get("error"),
                                            "chatEntry": entries[0] if entries else None}
        with tempfile.TemporaryDirectory(prefix="boardroom-chat-diagnostic-") as temporary:
            source = prepare(Path(temporary), output, report)
            if args.prepare_only:
                report["status"] = "PREPARED_NOT_RUN"
            else:
                exercise_once(source, output, report, args.chromium)
        # 独立 exercise 的异常收尾截图仅属于诊断样本，避免误读成原验收截图。
        failure_image = output / "failure.png"
        if failure_image.exists():
            failure_image.rename(output / "diagnostic-first-entry.png")
    except Exception as error:
        report.update(error=str(error), traceback=traceback.format_exc())
    finally:
        if "originalAcceptance" in report:
            unchanged = digest(args.original_report.resolve()) == report["originalAcceptance"]["sha256"]
            report["originalAcceptance"]["unchangedAfter"] = unchanged
            if not unchanged:
                report.update(status="INCONCLUSIVE", error="原验收报告发生改变")
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "diagnosticOnly": True, "report": str(output / "report.json")}, ensure_ascii=False))
    return 0 if report["status"] in ("DIAGNOSTIC_ONLY", "PREPARED_NOT_RUN") and "error" not in report else 1


if __name__ == "__main__":
    raise SystemExit(main())
