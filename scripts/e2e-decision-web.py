#!/usr/bin/env python3
"""#157：真实 Chromium 的 Decision 提交到可见绘制证据，保留五秒门槛。"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import math
from pathlib import Path
import re
import signal
import sys
import traceback
from urllib.parse import urlsplit
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
LIMIT_MS = 5000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, name):
    require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value), name)
    return value


def one(rows, predicate, label):
    matches = [row for row in rows if predicate(row)]
    require(len(matches) == 1, label + " 必须有且只有一份原始事实")
    return matches[0]


def validate_observation(spec, raw, network, facts):
    """纯证据消费器；不修改证据、不重跑采样、不把时钟区间相交判作通过。"""
    require(raw["schema"] == "decision-browser-observation/v1" and raw["caseId"] == spec["id"], "case/schema mismatch")
    url = urlsplit(raw["pageUrl"])
    require(url.hostname in ("127.0.0.1", "localhost") and url.path == f"/projects/{spec['projectId']}/tasks/{spec['taskId']}", "页面对象不匹配")
    require(raw["clock"]["kind"] == "performance.now" and raw["clock"]["native"] is True, "必须使用页面原生单调时钟")
    number(raw["clock"]["timeOrigin"], "timeOrigin")
    start, received = number(raw["mutationStartedAt"], "mutationStartedAt"), number(raw["receiptReceivedAt"], "receiptReceivedAt")
    require(number(raw["armedAt"], "armedAt") <= start <= received, "提交窗口顺序无效")
    initial = raw["initial"]
    require(initial["stateVisible"] and initial["visibility"] == "visible" and initial["focus"], "提交前页面必须已打开且前台可见")
    for event in raw["visibility"]:
        if start <= event["at"] <= (raw.get("visibleFrameAt") or raw.get("deadlineObservedAt") or received):
            require(event["visibility"] == "visible" and event["focus"], "采样期间页面离开前台，不能签发五秒结果")

    body, response_status = raw["response"]["body"], raw["response"]["status"]
    receipt, result_ref = body["receipt"], body["decisionRef"]
    require(body["schemaVersion"] == "decision-response/v1" and body["state"] == "not_required", "本样本必须真实 reject 且无 Task 效果")
    require(response_status == receipt["httpStatus"] == 200, "真实回执状态错误")
    require(receipt["inputDecisionRef"] == spec["decisionRef"] and receipt["resultDecisionRef"] == result_ref, "回执 ref 不一致")
    require(result_ref["decisionId"] == spec["decisionRef"]["decisionId"] and result_ref["projectId"] == spec["projectId"]
            and result_ref["actionDigest"] == spec["decisionRef"]["actionDigest"]
            and result_ref["revision"] > spec["decisionRef"]["revision"], "结果未推进原决定")
    require(raw["command"]["decisionRef"] == spec["decisionRef"] and raw["command"]["choiceId"] == "reject"
            and raw["command"]["reason"] == spec["marker"], "提交对象、选择、唯一理由不匹配")
    current = body["current"]
    require(current["ref"] == result_ref and current["status"] == "resolved"
            and current["resolution"]["choiceId"] == "reject" and current["resolution"]["reason"] == spec["marker"], "回执没有本次终局")
    require(body["task"]["id"] == spec["taskId"] and body["task"]["state"] == "review"
            and body["task"]["revision"] == spec["taskRevision"], "reject 不得改变 Task")

    record = one(facts["records"], lambda row: row["id"] == result_ref["decisionId"], "Decision")
    require(len(facts["records"]) == 1 and record["project_id"] == spec["projectId"] and record["task_id"] == spec["taskId"]
            and record["action_digest"] == result_ref["actionDigest"] and record["status"] == "resolved"
            and int(record["revision"]) == result_ref["revision"], "实际数据库 Decision 与回执不一致")
    saved = one(facts["receipts"], lambda row: row["id"] == receipt["receiptId"], "命令回执")
    require(json.loads(saved["response_json"])["receipt"] == receipt, "持久回执原值不匹配")
    resolution = one(facts["resolutions"], lambda row: row["id"] == receipt["resolutionId"], "resolution")
    require(resolution["command_receipt_id"] == receipt["receiptId"], "resolution 回执绑定错误")
    execution = one(facts["executions"], lambda row: row["id"] == receipt["execution"]["id"], "execution")
    require(execution["status"] == receipt["execution"]["status"] == "not_required", "reject 必须持久无效果")
    require(len(facts["resolutions"]) == len(facts["executions"]) == 1, "同样本出现第二份终局/效果")
    if "reason_json" in resolution:
        require(json.loads(resolution["reason_json"]) == spec["marker"], "数据库理由不一致")
    if spec["mutation"] == "http":
        require(len(facts["userEvents"]) == len(facts["initiations"]) == 1, "可信本地选择必须只有一次来源消费")
        event, initiation = facts["userEvents"][0], facts["initiations"][0]
        require(event["decision_id"] == initiation["decision_id"] == result_ref["decisionId"]
                and initiation["user_event_id"] == event["id"] and initiation["consumed_receipt_id"] == receipt["receiptId"], "来源未绑定本次决定/回执")
    else:
        require(facts["userEvents"] == [] and facts["initiations"] == [], "MCP 不能生成本地人工来源")

    events = network["events"]
    if spec["mutation"] == "http":
        request_event = one(events, lambda event: event["kind"] == "http.request" and event.get("method") == "POST"
                            and event.get("path") == spec["choicePath"], "HTTP choice request")
        reply_event = one(events, lambda event: event["kind"] == "http.response" and event.get("requestId") == request_event["requestId"], "HTTP choice response")
        require(reply_event["status"] == response_status and json.loads(reply_event["rawBody"]) == body, "HTTP 原始正文不匹配")
    else:
        transport = "stdio" if spec["mutation"] == "stdio" else "http"
        request_event = one(events, lambda event: event["kind"] == "mcp.started" and event.get("request", {}).get("decisionId") == result_ref["decisionId"], "MCP started")
        reply_event = one(events, lambda event: event["kind"] == "mcp.committed" and event.get("transport") == transport
                          and event.get("request", {}).get("decisionId") == result_ref["decisionId"], "MCP committed")
        require(reply_event["response"] == body, "MCP 原始响应不匹配")
        if transport == "stdio":
            require(isinstance(network["stdioPid"], int) and isinstance(network["fixturePid"], int)
                    and network["stdioPid"] > 0 and network["fixturePid"] > 0
                    and network["stdioPid"] != network["fixturePid"], "stdio 必须来自独立真实进程")
    request_index = events.index(request_event)
    require(events.index(reply_event) > request_index, "传输提交顺序错误")
    reads = [event for event in events[request_index + 1:] if event["kind"] == "http.response" and event.get("method") == "GET"
             and event.get("path") == spec["readPath"] and event.get("status") == 200 and event.get("rawBody")]
    require(any(any(row.get("ref") == result_ref and (row.get("resolution") or {}).get("reason") == spec["marker"]
                    for row in json.loads(event["rawBody"])["decisions"]) for event in reads), "没有真实 GET 取得当前决定，不能以回执或提示冒充页面刷新")
    hints = [event for event in events if event["kind"] in ("ws.forwarded", "ws.dropped")
             and event.get("frame", {}).get("type") == "resource.changed" and event["frame"].get("entity") == "decision"
             and event["frame"].get("projectId") == spec["projectId"] and event["frame"].get("id") == result_ref["decisionId"]]
    if spec["fallback"]:
        require(not any(event["kind"] == "ws.forwarded" for event in hints), "兜底样本不能接收 Decision 提示")
        if spec["mutation"] == "http":
            require(any(event["kind"] == "ws.dropped" for event in hints), "丢提示样本没有真实丢弃证据")
        phase = raw["phase"]
        previous, latest = phase["previous"], phase["read"]
        observed_reads = raw["reads"]
        require(previous in observed_reads and latest in observed_reads, "缺少真实 PerformanceResourceTiming 原件")
        completed = sorted((read for read in observed_reads if read["responseEnd"] <= start), key=lambda read: read["startTime"])
        require(len(completed) >= 2 and completed[-2:] == [previous, latest], "必须紧随最近完整轮询，而不是挑有利相位")
        for read in (previous, latest):
            require(urlsplit(read["name"]).path + "?" + urlsplit(read["name"]).query == spec["readPath"]
                    and read["initiatorType"] == "fetch" and 0 <= read["startTime"] <= read["responseEnd"], "轮询原始时序错误")
        require(3000 <= latest["startTime"] - previous["startTime"] <= 6000
                and 0 <= start - latest["responseEnd"] <= 250, "未覆盖完整不利轮询相位")
        conditional = [event for event in events[:request_index] if event["kind"] == "http.request"
                       and event.get("method") == "GET" and event.get("path") == spec["readPath"]]
        require(len(conditional) >= 2, "缺两轮条件读取")
        for request in conditional[-2:]:
            require(isinstance(request.get("ifNoneMatch"), str) and bool(request["ifNoneMatch"]), "轮询不是条件请求")
            reply = one(events[:request_index], lambda event: event["kind"] == "http.response"
                        and event.get("requestId") == request["requestId"], "条件读取 response")
            require(reply["status"] == 304 and reply.get("etag") == request["ifNoneMatch"], "轮询必须真实无变化 304")
    else:
        require(any(event["kind"] == "ws.forwarded" for event in hints), "同进程提示样本缺真实通知")

    frame_at, dom_at = raw.get("visibleFrameAt"), raw.get("domObservedAt")
    if frame_at is not None:
        frame_at, dom_at = number(frame_at, "visibleFrameAt"), number(dom_at, "domObservedAt")
        require(start <= dom_at <= frame_at, "DOM/frame 时序错误")
        frame = raw["visibleFrame"]
        require(frame["stateVisible"] and frame["markerVisible"] and frame["visibility"] == "visible" and frame["focus"], "结果未在真实前台可见区域")
        require("选择已记录" in frame["state"] and re.search(r"决定版本\s+" + str(result_ref["revision"]) + r"(?:\s|$)", frame["state"])
                and frame["marker"] == spec["marker"], "可见 DOM 对象/版本/理由错误")
        lower, upper = max(0, frame_at - received), frame_at - start
        status = "PASS" if upper <= LIMIT_MS else "FAIL_LATENCY" if lower > LIMIT_MS else "INCONCLUSIVE_COMMIT_WINDOW"
    else:
        deadline = number(raw["deadlineObservedAt"], "deadlineObservedAt")
        require(deadline >= received, "没有提交后的负面观察")
        final = raw["final"]
        require(final["stateVisible"] and final["visibility"] == "visible" and final["focus"], "负面观察也必须保持前台")
        lower, upper = max(0, deadline - received), deadline - start
        if dom_at is not None:
            number(dom_at, "domObservedAt")
            status = "INCONCLUSIVE_RENDER_OBSERVATION"
        else:
            require("选择已记录" not in final["state"] or final["marker"] != spec["marker"], "结果已出现但观察器漏记，不能断言超时")
            status = "FAIL_LATENCY" if lower > LIMIT_MS else "INCONCLUSIVE_COMMIT_WINDOW"
    return {"caseId": spec["id"], "status": status, "limitMs": LIMIT_MS,
            "latencyLowerMs": lower, "latencyUpperMs": upper, "receiptId": receipt["receiptId"],
            "decisionRef": result_ref, "mutation": spec["mutation"], "fallback": spec["fallback"]}


# Observer only: never replaces fetch, clocks, timers, websocket delivery, or DOM.
ARM_OBSERVER = r"""spec => {
  const now = () => performance.now();
  const visible = node => !!node && node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true,contentVisibilityAuto:true})
    && (()=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;})();
  const snapshot = () => {
    const state=document.querySelector('[data-testid="decision-state"]');
    const marker=[...document.querySelectorAll('[data-testid="decision-panel"] p')]
      .find(node=>node.textContent.includes('已选择：')&&node.textContent.includes(spec.marker));
    return {stateVisible:visible(state),markerVisible:visible(marker),visibility:document.visibilityState,focus:document.hasFocus(),
      state:state?.textContent.trim()??'',marker:marker?.textContent.includes(spec.marker)?spec.marker:''};
  };
  const readEntries = () => performance.getEntriesByType('resource')
    .filter(r=>r.name===location.origin+spec.readPath&&r.initiatorType==='fetch'&&r.responseEnd>0)
    .map(r=>({name:r.name,initiatorType:r.initiatorType,startTime:r.startTime,responseEnd:r.responseEnd}));
  const raw={schema:'decision-browser-observation/v1',caseId:spec.id,pageUrl:location.href,
    clock:{kind:'performance.now',native:Function.prototype.toString.call(performance.now).includes('[native code]'),timeOrigin:performance.timeOrigin},
    armedAt:now(),initial:snapshot(),visibility:[],phase:null,reads:[],mutationStartedAt:null,receiptReceivedAt:null,
    domObservedAt:null,visibleFrameAt:null,visibleFrame:null,response:null,command:null};
  const onVisibility=()=>raw.visibility.push({at:now(),visibility:document.visibilityState,focus:document.hasFocus()});
  document.addEventListener('visibilitychange',onVisibility);window.addEventListener('focus',onVisibility);window.addEventListener('blur',onVisibility);
  let framePending=false;
  const observer=new MutationObserver(()=>{
    if(raw.mutationStartedAt===null||raw.visibleFrameAt!==null)return;
    const state=snapshot();
    if(state.state.includes('选择已记录')&&state.marker===spec.marker&&state.stateVisible&&state.markerVisible){
      raw.domObservedAt??=now();
      if(framePending)return;framePending=true;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        framePending=false;const next=snapshot();
        if(next.state.includes('选择已记录')&&next.marker===spec.marker&&next.stateVisible&&next.markerVisible&&next.visibility==='visible'&&next.focus){
          raw.visibleFrame=next;raw.visibleFrameAt=now();
        }
      }));
    }
  });
  observer.observe(document.querySelector('[data-testid="decision-panel"]'),{subtree:true,childList:true,characterData:true,attributes:true});
  window.decisionProbe={raw,readEntries,begin(command){
    raw.command=command;raw.reads=readEntries();
    if(spec.fallback){raw.phase={previous:raw.reads.at(-2),read:raw.reads.at(-1)};}
    raw.mutationStartedAt=now();
  },received(response){raw.receiptReceivedAt=now();raw.response=response;},finish(){
    raw.reads=readEntries();raw.final=snapshot();raw.deadlineObservedAt=now();observer.disconnect();
    document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('focus',onVisibility);window.removeEventListener('blur',onVisibility);
    return raw;
  }};
}"""


def exercise(page, fixture, data, spec, output):
    from playwright.sync_api import expect
    spec = dict(spec)
    spec["choicePath"] = f"/api/projects/{spec['projectId']}/decisions/{spec['decisionRef']['decisionId']}/choices"
    spec["readPath"] = f"/api/projects/{spec['projectId']}/decisions?taskId={spec['taskId']}"
    fixture.command("network", dropResources=spec["fallback"], blocked=False, holdPath=None)
    page.goto(data["url"] + f"/projects/{spec['projectId']}/tasks/{spec['taskId']}")
    expect(page.get_by_test_id("decision-state")).to_contain_text("提案待决")
    panel = page.get_by_test_id("decision-panel")
    expect(panel.get_by_test_id("resource-sync-status")).to_contain_text("更新提示已连接")
    page.get_by_test_id("decision-state").scroll_into_view_if_needed()
    page.bring_to_front()
    page.evaluate(ARM_OBSERVER, spec)
    if spec["fallback"]:
        # Wait through two completed native periodic conditional reads. Mutation
        # starts immediately after the latter: almost a full interval remains.
        page.wait_for_function("""() => {
          const reads=window.decisionProbe.readEntries();
          return reads.length>=3&&reads.at(-1).startTime-reads.at(-2).startTime>=3000
            &&performance.now()-reads.at(-1).responseEnd<=150;
        }""", timeout=15000, polling=20)
    command = {"decisionRef": spec["decisionRef"], "choiceId": "reject", "reason": spec["marker"]}
    if spec["mutation"] == "http":
        command["clientMutationId"] = str(uuid.uuid4())
        page.evaluate("""async ({path,command}) => {
          window.decisionProbe.begin(command);
          const response=await fetch(path,{method:'POST',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(command)});
          const body=await response.json();window.decisionProbe.received({status:response.status,body});
        }""", {"path": spec["choicePath"], "command": command})
    else:
        command["idempotencyKey"] = str(uuid.uuid4())
        page.evaluate("command=>window.decisionProbe.begin(command)", command)
        result = fixture.command("mcp", transport="stdio" if spec["mutation"] == "stdio" else "http", name="resolve_decision",
                                 args={"projectId": spec["projectId"], "decisionId": spec["decisionRef"]["decisionId"], **command})
        page.evaluate("body=>window.decisionProbe.received({status:body.receipt.httpStatus,body})", result)
    page.wait_for_function("() => window.decisionProbe.raw.visibleFrameAt!==null || performance.now()-window.decisionProbe.raw.mutationStartedAt>6000", timeout=8000, polling=25)
    raw = page.evaluate("() => window.decisionProbe.finish()")
    snapshot = fixture.snapshot()
    snapshot["fixturePid"] = data["fixturePid"]
    facts = fixture.command("decision-evidence", decisionId=spec["decisionRef"]["decisionId"])
    originals = {"spec": spec, "observation": raw, "network": snapshot, "facts": facts}
    (output / f"{spec['id']}-originals.json").write_text(json.dumps(originals, ensure_ascii=False, indent=2))
    page.screenshot(path=str(output / f"{spec['id']}.png"), full_page=True, animations="disabled")
    result = validate_observation(spec, raw, snapshot, facts)
    result["originals"] = f"{spec['id']}-originals.json"
    result["screenshot"] = f"{spec['id']}.png"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/decision-web-e2e")
    parser.add_argument("--native-desktop", action="store_true")
    parser.add_argument("--chromium")
    parser.add_argument("--runtime-binding", type=Path, default=ROOT / ".agent-output/resource-web-e2e/runtime-binding.json")
    args = parser.parse_args()
    output = args.artifacts.resolve(); output.mkdir(parents=True, exist_ok=True)
    # Deliberately deferred: the pure evidence consumer does not need a browser SDK.
    source = importlib.util.spec_from_file_location("resource_probe", ROOT / "scripts/e2e-resource-web.py")
    support = importlib.util.module_from_spec(source); source.loader.exec_module(support)
    report = {"status": "NOT_RUN", "at": datetime.now(timezone.utc).isoformat(), "candidate": support.candidate(),
              "scope": "真实 HTTP/MCP HTTP/独立 stdio 提交；已打开的前台 Decision 页面；无 Task 效果的 reject",
              "limitMs": LIMIT_MS, "cases": [], "nativeCases": [], "pageErrors": [], "cleanupErrors": []}
    fixture, desktop = None, None
    try:
        require(args.native_desktop, "真实原生验收要求 --native-desktop；headless 不能替代资格")
        binding = support.load_runtime_binding(args.runtime_binding)
        profile = support.load_profile()["browser"]
        if args.chromium:
            require(Path(args.chromium).resolve() == Path(profile["executable"]).resolve(), "Chromium executable 与资格不符")
        report["runtimeBinding"], report["runtime"] = binding, support.runtime_identity(binding)
        desktop = support.NativeDesktop(output / "native-desktop")
        browser_env = desktop.start()
        fixture = support.Fixture(output, decision_probes=True)
        data = fixture.start(); report["fixture"] = data
        require(len(data["decisionCases"]) == 8 and len({case["id"] for case in data["decisionCases"]}) == 8, "缺少两宽四路径真实样本")
        with support.bounded_playwright(report) as playwright:
            for width, height in ((1440, 1000), (390, 844)):
                desktop.check_alive()
                native = {"width": width, "height": height, "status": "NOT_RUN", "cleanupErrors": []}
                report["nativeCases"].append(native)
                with support.native_page(playwright, browser_env, width, height, output / f"native-{width}",
                                         output / f"trace-{width}.zip", native, binding) as (page, context):
                    page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
                    for spec in (case for case in data["decisionCases"] if case["width"] == width):
                        result = exercise(page, fixture, data, spec, output)
                        report["cases"].append(result)
                        require(not report["pageErrors"], "真实页面出现异常")
                    native["status"] = "PASS" if all(case["status"] == "PASS" for case in report["cases"] if case["caseId"].startswith(str(width))) else "INCONCLUSIVE"
                require(native["chromeCleanup"]["status"] == "PASS" and not native["cleanupErrors"], "Chrome/SDK 清理失败")
        statuses = [case["status"] for case in report["cases"]]
        report["status"] = "FAIL" if any(status.startswith("FAIL") for status in statuses) else "PASS" if len(statuses) == 8 and all(status == "PASS" for status in statuses) else "INCONCLUSIVE"
    except (KeyboardInterrupt, SystemExit):
        report["status"] = "FAIL"; report["interrupted"] = True
        raise
    except Exception as error:
        report["status"] = "FAIL"; report["error"] = str(error); report["traceback"] = traceback.format_exc()
    finally:
        if fixture:
            try: report["cleanup"] = fixture.close()
            except Exception as error: report["cleanupErrors"].append(str(error))
        if desktop:
            try: report["nativeDesktop"] = desktop.close()
            except Exception as error: report["cleanupErrors"].append(str(error))
        report["candidateAfter"] = support.candidate()
        if report["cleanupErrors"]: report["status"] = "FAIL"
        if report["candidateAfter"] != report["candidate"]:
            report["candidateChanged"] = True
            if report["status"] != "FAIL": report["status"] = "INCONCLUSIVE"
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({"status": report["status"], "cases": report["cases"], "report": str(output / "report.json")}, ensure_ascii=False))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda number, frame: (_ for _ in ()).throw(SystemExit(128 + number)))
    raise SystemExit(main())
