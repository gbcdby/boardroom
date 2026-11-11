#!/usr/bin/env python3
"""#144：真实 Chromium / 临时 SQLite 的主题、首帧和状态保持验收。"""
from __future__ import annotations
import argparse
import base64
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import select
import subprocess
import traceback
from urllib.parse import urlsplit
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
KEY = "boardroom:appearance"
spec = importlib.util.spec_from_file_location("webui_fixture", ROOT / "scripts/e2e-webui.py")
webui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(webui)


def appearance(page, value):
    expect(page.locator("html")).to_have_attribute("data-theme", value)
    assert page.evaluate("getComputedStyle(document.documentElement).colorScheme") == value


def capture(page, output, report, name):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    dimensions = webui.layout(page, name)
    page.screenshot(path=str(output / f"{name}.png"), full_page=True, animations="disabled")
    report["screenshots"].append(f"{name}.png")
    report["layouts"].append(dimensions)


def chat_entry_latest(page, name, report):
    # 只观察真实布局，不预置scrollTop；首次历史加载须自行把最后一条带到视口内。
    measure = """() => {
      const list=document.querySelector('[data-testid="chat-messages"]');
      const last=list?.querySelector('.message:last-child .message-text');
      if(!list||!last)return null;
      const box=list.getBoundingClientRect(), r=last.getBoundingClientRect(), style=getComputedStyle(last);
      return {text:last.textContent,scrollTop:list.scrollTop,scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,
        maxHeight:getComputedStyle(list).maxHeight,bottomGap:list.scrollHeight-list.scrollTop-list.clientHeight,
        list:{top:box.top,bottom:box.bottom},last:{top:r.top,bottom:r.bottom},viewport:{width:innerWidth,height:innerHeight},
        visible:r.width>0&&r.height>0&&style.visibility==='visible'&&style.display!=='none'
          &&r.top>=Math.max(0,box.top)-1&&r.bottom<=Math.min(innerHeight,box.bottom)+1
          &&r.left>=Math.max(0,box.left)-1&&r.right<=Math.min(innerWidth,box.right)+1};
    }"""
    try:
        page.wait_for_function("expected => { const value=(" + measure + ")(); return value&&value.text===expected&&value.visible&&Math.abs(value.bottomGap)<=2; }",
                               arg="主题验收历史消息 24：保持阅读位置与上下文。")
    finally:
        report.setdefault("chatEntries", []).append({"view": name, "geometry": page.evaluate(measure)})


def chat_entry_held_history(page, origin, path, group_id, name, output, report):
    held = []
    pattern = f"**/api/groups/{group_id}/messages"
    def hold(route):
        held.append(route)
    page.route(pattern, hold)
    try:
        page.goto(origin + path, wait_until="domcontentloaded")
        page.get_by_test_id("chat-messages").wait_for(state="visible")
        expect(page.get_by_role("log", name="群聊消息")).to_have_attribute("aria-busy", "true")
        page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        assert held, "必须确实持有首次历史GET，不能以已完成的读取冒充延迟到达"
    finally:
        page.unroute(pattern, hold)
        for route in held:
            route.continue_()
    page.wait_for_load_state("networkidle")
    chat_entry_latest(page, name, report)
    capture(page, output, report, name)


def selected_choice(page, selected_id, other_id, name, report, accessible_name=None):
    selected = page.get_by_test_id(selected_id)
    other = page.get_by_test_id(other_id)
    expect(selected).to_have_attribute("aria-pressed", "true")
    expect(other).to_have_attribute("aria-pressed", "false")
    mark = selected.locator(".selection-mark")
    expect(mark).to_be_visible()
    expect(mark).to_have_text("✓")
    expect(mark).to_have_attribute("aria-hidden", "true")
    expect(other.locator(".selection-mark")).to_be_hidden()
    if accessible_name:
        expect(selected).to_have_accessible_name(accessible_name)
    # 检查实际渲染的勾选和轮廓，不能只凭 aria-pressed 或底色不同判定可辨。
    expect(selected).to_have_css("border-top-color", selected.evaluate("el => getComputedStyle(el).color"))
    measure = "el => { const s=getComputedStyle(el); return {border:s.borderTopColor,borderWidth:parseFloat(s.borderTopWidth),borderStyle:s.borderTopStyle,shadow:s.boxShadow}; }"
    current, inactive = selected.evaluate(measure), other.evaluate(measure)
    assert current["borderWidth"] >= 1 and current["borderStyle"] == "solid", (name, current)
    assert current["shadow"] != "none" and current["shadow"] != inactive["shadow"], (name, current, inactive)
    control_box, mark_box = selected.bounding_box(), mark.bounding_box()
    assert control_box and mark_box and mark_box["width"] > 0 and mark_box["height"] > 0, name
    assert (mark_box["x"] >= control_box["x"] and mark_box["y"] >= control_box["y"]
            and mark_box["x"] + mark_box["width"] <= control_box["x"] + control_box["width"] + 1
            and mark_box["y"] + mark_box["height"] <= control_box["y"] + control_box["height"] + 1), (name, control_box, mark_box)
    report.setdefault("selectionStates", []).append({"view": name, "selected": selected_id, "other": other_id,
                                                    "current": current, "inactive": inactive, "mark": mark_box})


def selection_states(page, controls, origin, project_id, output, report):
    page.goto(origin + f"/projects/{project_id}/tasks"); page.wait_for_load_state("networkidle")
    for width, height in [(1440, 1000), (390, 844)]:
        page.set_viewport_size({"width": width, "height": height})
        for theme in ("light", "dark"):
            controls.get_by_test_id(f"theme-{theme}").click(); appearance(page, theme)
            for mode, other, title in [("board", "list", "看板"), ("list", "board", "列表")]:
                page.get_by_test_id(f"task-{mode}-mode").click()
                name = f"task-selected-{mode}-{width}-{theme}"
                selected_choice(page, f"task-{mode}-mode", f"task-{other}-mode", name, report, title)
                capture(page, output, report, name); contrast(page, name, report)

    page.goto(origin + f"/projects/{project_id}/knowledge")
    expect(page.get_by_test_id("memory-editor")).to_be_enabled()
    expect(page.get_by_test_id("memory-version")).to_have_text("版本 2")
    for width, height in [(1440, 1000), (390, 844)]:
        page.set_viewport_size({"width": width, "height": height})
        for theme in ("light", "dark"):
            controls.get_by_test_id(f"theme-{theme}").click(); appearance(page, theme)
            for scope, other, title in [("members", "shared", "成员记忆"), ("shared", "members", "项目共享")]:
                page.get_by_test_id(f"memory-scope-{scope}").click()
                name = f"memory-selected-{scope}-{width}-{theme}"
                selected_choice(page, f"memory-scope-{scope}", f"memory-scope-{other}", name, report, title)
                expect(page.get_by_test_id("memory-editor")).to_be_enabled()
                capture(page, output, report, name); contrast(page, name, report)
            expect(page.get_by_test_id("memory-editor")).to_be_enabled()
            page.get_by_test_id("memory-history-open").click()
            for version, other in [(2, 1), (1, 2)]:
                page.get_by_test_id(f"memory-history-version-{version}").click()
                expect(page.get_by_test_id("memory-history-text")).to_have_text(f"主题状态验收共识：版本 {version}")
                name = f"memory-selected-version-{version}-{width}-{theme}"
                selected_choice(page, f"memory-history-version-{version}", f"memory-history-version-{other}", name, report)
                capture(page, output, report, name); contrast(page, name, report)
    report["checks"].append("任务看板/列表、记忆共享/成员、历史两个版本均有真实可见勾选与描边；1440/390浅深主题可辨且保留无障碍名称")


def contrast(page, name, report):
    samples = page.evaluate("""() => {
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      const rgba=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
      const blend=(a,b)=>a.slice(0,3).map((v,i)=>v*a[3]/255+b[i]*(1-a[3]/255));
      const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const ratio=(a,b)=>{const l=[lum(a),lum(b)].sort((a,b)=>a-b);return (l[1]+.05)/(l[0]+.05);};
      const background=el=>{const parents=[];for(let n=el;n;n=n.parentElement)parents.unshift(n);let b=[255,255,255];for(const n of parents)b=blend(rgba(getComputedStyle(n).backgroundColor),b);return b;};
      const result=[];
      for(const el of document.querySelectorAll('main h1,main h2,main p,main label,main button,main input,main select,main textarea,main code,main a,main .badge,.toast > span,.toast > .app-icon')) {
        if(!el.getClientRects().length||el.matches(':disabled')||el.closest('[inert]'))continue;
        const s=getComputedStyle(el);if(s.visibility!=='visible')continue;
        const text=[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())||el.matches('input,select,textarea,button,.badge');
        const b=background(el),fg=blend(rgba(s.color),b);
        const id=el.dataset.testid||el.id||el.className||el.tagName;
        if(text)result.push({target:String(id),kind:'text',ratio:ratio(fg,b),minimum:parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18.66&&parseInt(s.fontWeight)>=700)?3:4.5,fg,background:b});
        if(el.matches('.toast > .app-icon'))result.push({target:'toast-status-icon',kind:'icon',ratio:ratio(fg,b),minimum:3,fg,background:b});
        if(el.matches('input:not([type=checkbox]):not([type=radio]),select,textarea')&&parseFloat(s.borderTopWidth)>0) {
          const outside=background(el.parentElement),border=blend(rgba(s.borderTopColor),outside);
          result.push({target:String(id),kind:'control-boundary',ratio:ratio(border,outside),minimum:3,fg:border,background:outside});
        }
      }
      return result;
    }""")
    assert samples, name
    report["contrast"].extend({"view": name, **sample} for sample in samples)
    failures = [sample for sample in samples if sample["ratio"] + .001 < sample["minimum"]]
    assert not failures, (name, failures)


def first_frame(browser, origin, report):
    context = browser.new_context(color_scheme="light", storage_state={"cookies": [], "origins": [
        {"origin": origin, "localStorage": [{"name": KEY, "value": "dark"}]}]})
    page = context.new_page()
    # 主应用模块尚未执行时读取首帧控制器；bootstrap 和实际 CSS 均由生产静态服务提供。
    page.route("**/assets/*.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body="window.__beforeAppTheme={theme:document.documentElement.dataset.theme,scheme:document.documentElement.style.colorScheme,appChildren:document.querySelector('#app').childElementCount};"))
    page.goto(origin + "/settings")
    value = page.evaluate("window.__beforeAppTheme")
    assert value == {"theme": "dark", "scheme": "dark", "appChildren": 0}, value
    report["firstFrame"] = value
    context.close()


def media_readability(page, output, report, name, theme, *, forced=False, more=False):
    # 只读当前页面；先取原生 viewport，避免仅凭祖先 computedStyle 漏掉 canvas 绘制错误。
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    geometry = page.evaluate("""() => {
      const main=document.querySelector('main'), root=getComputedStyle(document.documentElement), body=getComputedStyle(document.body);
      const rect=main.getBoundingClientRect(), style=getComputedStyle(main), forced=matchMedia('(forced-colors: active)').matches;
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      const rgba=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
      const texts=['h1','.page-description'].map(selector=>{
        const el=main.querySelector(selector), range=document.createRange(); range.selectNodeContents(el);
        const box=range.getBoundingClientRect();
        return {selector,text:el.textContent.trim(),foreground:rgba(getComputedStyle(el).color),
                box:{x:box.x,y:box.y,width:box.width,height:box.height}};
      });
      const points=texts.flatMap(({selector,box})=>[
        {x:rect.left+parseFloat(style.paddingLeft)/2,y:box.y+box.height/2,target:selector+' left'},
        {x:rect.right-parseFloat(style.paddingRight)/2,y:box.y+box.height/2,target:selector+' right'}
      ]).map(point=>{
        const hit=document.elementFromPoint(point.x,point.y);
        return {...point,unobstructed:hit===main,hit:hit?{tag:hit.tagName,id:hit.id,className:hit.className}:null};
      });
      return {theme:document.documentElement.dataset.theme,forced,more:matchMedia('(prefers-contrast: more)').matches,
              width:innerWidth,height:innerHeight,scrollY,rootBackground:root.backgroundColor,bodyBackground:body.backgroundColor,
              expectedBackground:rgba(forced?body.backgroundColor:root.getPropertyValue('--bg').trim()),texts,points};
    }""")
    filename = f"{name}-viewport.png"
    png = page.screenshot(path=str(output / filename))
    report["screenshots"].append(filename)
    pixels = page.evaluate("""async ({png,geometry}) => {
      const image=new Image(); image.src='data:image/png;base64,'+png; await image.decode();
      const canvas=document.createElement('canvas'); canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
      const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(image,0,0);
      const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      const sx=canvas.width/geometry.width, sy=canvas.height/geometry.height;
      const pixel=(x,y)=>[...data.slice((y*canvas.width+x)*4,(y*canvas.width+x)*4+4)];
      const delta=(a,b)=>Math.max(...a.slice(0,3).map((v,i)=>Math.abs(v-b[i])));
      const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const ratio=(a,b)=>{const l=[lum(a),lum(b)].sort((a,b)=>a-b);return (l[1]+.05)/(l[0]+.05);};
      const backgrounds=geometry.points.map(point=>{
        const x=Math.round(point.x*sx), y=Math.round(point.y*sy), patch=[];
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)patch.push(pixel(x+dx,y+dy));
        return {...point,pixelX:x,pixelY:y,rgba:pixel(x,y),patch,
                maximumDelta:Math.max(...patch.map(p=>delta(p,geometry.expectedBackground)))};
      });
      const texts=geometry.texts.map((text,index)=>{
        const box=text.box, background=backgrounds[index*2].rgba;
        const left=Math.ceil(box.x*sx),right=Math.floor((box.x+box.width)*sx);
        const top=Math.ceil(box.y*sy),bottom=Math.floor((box.y+box.height)*sy);
        let foreground=null, matchedPixels=0;
        for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
          const rgba=pixel(x,y), distance=delta(rgba,text.foreground);
          // 只认足够接近真实文字前景、又与背景不同的笔画像素；找不到必须失败。
          if(rgba[3]===255&&distance<=8&&delta(rgba,background)>8){
            matchedPixels++;
            if(!foreground||distance<foreground.distance)foreground={x,y,rgba,distance};
          }
        }
        return {...text,background,foreground,matchedPixels,ratio:foreground?ratio(foreground.rgba,background):null,
                computedForegroundRatio:ratio(text.foreground,background),minimum:4.5};
      });
      return {width:canvas.width,height:canvas.height,backgrounds,texts};
    }""", {"png": base64.b64encode(png).decode("ascii"), "geometry": geometry})
    report.setdefault("mediaReadability", []).append({"view": name, "viewport": filename, "geometry": geometry, **pixels})
    assert geometry["theme"] == theme and geometry["forced"] == forced and geometry["more"] == more, (name, geometry)
    assert geometry["scrollY"] == 0 and geometry["expectedBackground"][3] == 255, (name, geometry)
    for sample in pixels["backgrounds"]:
        assert sample["unobstructed"], (name, "background obscured", sample)
        assert all(p[3] == 255 for p in sample["patch"]) and sample["maximumDelta"] <= 2, (name, "painted background mismatch", sample, geometry["expectedBackground"])
    for sample in pixels["texts"]:
        box = sample["box"]
        assert sample["text"] and 0 <= box["x"] < box["x"] + box["width"] <= geometry["width"] and 0 <= box["y"] < box["y"] + box["height"] <= geometry["height"], (name, sample)
        assert sample["matchedPixels"] > 0 and sample["foreground"], (name, "rendered text pixels missing", sample)
        assert sample["ratio"] >= 4.5 and sample["computedForegroundRatio"] >= 4.5, (name, "rendered text contrast", sample)
    contrast(page, name, report)


def failure_modes(browser, origin, report):
    for failure, setup in [
        ("storage-get", "Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}})"),
        ("storage-read", "Storage.prototype.getItem=function(){throw new Error('blocked')};"),
        ("storage-write", "Storage.prototype.setItem=function(){throw new Error('quota')};"),
    ]:
        context = browser.new_context(color_scheme="light")
        context.add_init_script(setup)
        page = context.new_page(); page.goto(origin + "/settings")
        page.get_by_test_id("theme-dark").click(); appearance(page, "dark")
        expect(page.get_by_test_id("theme-storage-notice")).to_be_visible()
        page.get_by_test_id("theme-light").click(); appearance(page, "light")
        context.close(); report["checks"].append(f"{failure}：真实浏览器中仍可会话内切换，显示未持久化原因")
    context = browser.new_context()
    context.add_init_script("Object.defineProperty(window,'matchMedia',{value:undefined});")
    page = context.new_page(); page.goto(origin + "/settings"); appearance(page, "light")
    page.get_by_test_id("theme-dark").click(); appearance(page, "dark")
    context.close(); report["checks"].append("matchMedia 不可用时默认浅色，显式偏好仍有效")


def exercise(browser, origin, workdir, output, report):
    first_frame(browser, origin, report)
    context = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai", color_scheme="dark", reduced_motion="reduce")
    context.tracing.start(screenshots=True, snapshots=True, sources=True)
    page = context.new_page(); page.set_default_timeout(15000)
    page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
    controls = context.new_page(); controls.set_default_timeout(15000)
    controls.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
    try:
        controls.goto(origin + "/settings"); appearance(controls, "dark")
        expect(controls.get_by_test_id("theme-system")).to_have_attribute("aria-pressed", "true")
        controls.emulate_media(color_scheme="light"); appearance(controls, "light")
        controls.get_by_test_id("theme-dark").click(); appearance(controls, "dark")
        controls.emulate_media(color_scheme="dark"); controls.emulate_media(color_scheme="light"); appearance(controls, "dark")
        controls.reload(); appearance(controls, "dark")
        page.goto(origin + "/settings"); appearance(page, "dark")
        controls.get_by_test_id("theme-light").click(); appearance(page, "light")
        controls.get_by_test_id("theme-system").click(); appearance(page, "dark")
        page.emulate_media(color_scheme="light"); appearance(page, "light")
        controls.evaluate("key => localStorage.setItem(key,'broken')", KEY)
        expect(page.get_by_test_id("theme-system")).to_have_attribute("aria-pressed", "true")
        page.reload(); appearance(page, "light")
        report["checks"].append("默认系统、显式优先、系统改变、刷新、多标签同步及无效持久值回退")

        records = webui.seed(page, origin)
        project, group = records[0]["project"], records[0]["groups"][0]
        pid, gid = project["id"], group["id"]
        for version in (1, 2):
            webui.request(page, origin, "PUT", f"/api/projects/{pid}/memories/shared", {
                "expectedVersion": version - 1, "clientMutationId": str(uuid4()), "markdown": f"主题状态验收共识：版本 {version}"})
        for index in range(24):
            webui.request(page, origin, "POST", f"/api/groups/{gid}/messages", {"senderMemberId": records[0]["members"][0]["id"], "text": f"主题验收历史消息 {index + 1}：保持阅读位置与上下文。"})
        page.goto(origin + f"/runtimes?projectId={pid}&groupId={gid}")
        page.get_by_test_id("open-runtime-create").click()
        page.get_by_test_id("runtime-name").fill("外观验收助手")
        page.locator("#runtime-create-workdir").fill(workdir)
        page.locator("#runtime-create-model").fill("theme-check-no-invocation")
        for width, height in [(1440, 1000), (390, 844)]:
            page.set_viewport_size({"width": width, "height": height})
            for theme in ("light", "dark"):
                controls.get_by_test_id(f"theme-{theme}").click(); appearance(page, theme)
                capture(page, output, report, f"runtime-form-{width}-{theme}")
                contrast(page, f"runtime-form-{width}-{theme}", report)
        with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith("/api/runtimes")) as created:
            page.get_by_test_id("runtime-create").click()
        assert created.value.status == 201, created.value.text()
        expect(page.get_by_test_id("runtime-summary")).to_have_text("已停止")
        routes = [("settings", "/settings"), ("overview", "/"), ("projects", f"/projects/{pid}/overview"),
                  ("chat", f"/projects/{pid}/chat/{gid}"), ("tasks", f"/projects/{pid}/tasks"),
                  ("knowledge", f"/projects/{pid}/memory"), ("status", f"/projects/{pid}/status"),
                  ("organization", f"/projects/{pid}/org"), ("runtimes", f"/runtimes?projectId={pid}")]
        for theme in ("light", "dark"):
            controls.get_by_test_id(f"theme-{theme}").click()
            for width, height in [(1440, 1000), (390, 844)]:
                page.set_viewport_size({"width": width, "height": height})
                for name, path in routes:
                    page.goto(origin + path); page.wait_for_load_state("networkidle")
                    expect(page.locator("main h1")).to_be_visible(); appearance(page, theme)
                    label = f"{name}-{width}-{theme}"
                    if name == "chat":
                        chat_entry_latest(page, label, report)
                    capture(page, output, report, label); contrast(page, label, report)
                    if name == "chat":
                        chat_entry_held_history(page, origin, path, gid, f"{label}-held-history", output, report)
        report["checks"].append("现有概览/项目/聊天/任务/知识/状态/组织/托管/设置，1440与390双主题真实截图及渲染对比度")
        report["checks"].append("1440/390双主题首次进入聊天及持有GET后历史到达，末条真实可见且列表贴底；未由脚本预置滚动位置")

        page.goto(origin + f"/runtimes?projectId={pid}")
        page.get_by_role("button", name="删除配置", exact=True).click()
        runtime_dialog = page.get_by_role("dialog")
        expect(runtime_dialog).to_be_visible()
        for width, height in [(1440, 1000), (390, 844)]:
            page.set_viewport_size({"width": width, "height": height})
            for theme in ("light", "dark"):
                controls.get_by_test_id(f"theme-{theme}").click(); appearance(page, theme)
                capture(page, output, report, f"runtime-dialog-{width}-{theme}")
                contrast(page, f"runtime-dialog-{width}-{theme}", report)
        runtime_dialog.get_by_role("button", name="取消", exact=True).click()
        report["checks"].append("真实停止配置、托管表单和原生弹层双主题覆盖；未启动任何CLI或模型")

        page.set_viewport_size({"width": 1440, "height": 1000})
        page.goto(origin + f"/projects/{pid}/chat/{gid}")
        draft = page.get_by_test_id("chat-input"); expect(draft).to_be_enabled()
        expect(page.get_by_test_id("chat-ws")).to_contain_text("实时已连接")
        draft.fill("主题切换后仍在的未发送草稿")
        page.get_by_test_id("chat-messages").evaluate("el=>{el.scrollTop=120;window.__themeMessageList=el;window.__themeScroll=el.scrollTop;}")
        draft.focus(); draft.evaluate("el=>{window.__themeComposer=el;window.__themeFocus=document.activeElement;}")
        reads = []
        page.on("request", lambda request: reads.append(request.url) if request.method == "GET" and f"/groups/{gid}/messages" in request.url else None)
        controls.get_by_test_id("theme-light").click(); appearance(page, "light")
        expect(draft).to_have_value("主题切换后仍在的未发送草稿")
        assert page.evaluate("document.querySelector('[data-testid=chat-input]')===window.__themeComposer&&document.activeElement===window.__themeFocus")
        assert page.evaluate("document.querySelector('[data-testid=chat-messages]')===window.__themeMessageList&&Math.abs(window.__themeMessageList.scrollTop-window.__themeScroll)<=1")
        assert reads == [], reads
        capture(page, output, report, "chat-preserved-light")
        draft.fill("")
        report["checks"].append("跨标签切换保留真实聊天DOM、草稿、焦点和历史滚动，未重拉全量消息")

        page.goto(origin + f"/projects/{pid}/tasks"); page.wait_for_load_state("networkidle")
        task_filter = page.get_by_test_id("task-state-filter")
        expect(task_filter).to_be_visible()
        options = task_filter.locator("option").evaluate_all("nodes=>nodes.map(n=>n.value).filter(Boolean)")
        task_filter.select_option(options[0]); controls.get_by_test_id("theme-dark").click(); appearance(page, "dark")
        expect(task_filter).to_have_value(options[0])
        report["checks"].append("任务筛选在主题切换后保留")

        selection_states(page, controls, origin, pid, output, report)

        page.goto(origin + f"/projects/{pid}/overview"); page.wait_for_load_state("networkidle")
        page.get_by_test_id("project-actions").locator("summary").click()
        page.get_by_test_id("archive-project").click()
        dialog = page.get_by_test_id("confirmation-dialog"); expect(dialog).to_be_visible()
        for width, height in [(1440, 1000), (390, 844)]:
            page.set_viewport_size({"width": width, "height": height})
            for theme in ("light", "dark"):
                controls.get_by_test_id(f"theme-{theme}").click(); appearance(page, theme)
                expect(dialog).to_be_visible()
                capture(page, output, report, f"confirmation-{width}-{theme}")
                contrast(page, f"confirmation-{width}-{theme}", report)
        pending = []
        endpoint = f"**/api/projects/{pid}/archive"
        page.route(endpoint, lambda route: pending.append(route))
        with page.expect_request(lambda request: request.method == "POST" and request.url.endswith(f"/projects/{pid}/archive")):
            page.get_by_test_id("confirm-submit").click()
        expect(dialog).to_have_attribute("aria-busy", "true")
        dialog.evaluate("el=>{window.__themeDialog=el;window.__themeFocus=document.activeElement;}")
        controls.get_by_test_id("theme-light").click(); appearance(page, "light")
        assert page.evaluate("document.querySelector('[data-testid=confirmation-dialog]')===window.__themeDialog&&document.activeElement===window.__themeFocus")
        expect(dialog).to_have_attribute("aria-busy", "true")
        assert len(pending) == 1
        pending.pop().continue_(); page.unroute(endpoint)
        expect(dialog).to_have_count(0)
        expect(page.get_by_test_id("toast")).to_be_visible()
        page.get_by_test_id("toast").hover()
        for theme in ("light", "dark"):
            controls.get_by_test_id(f"theme-{theme}").click(); appearance(page, theme)
            capture(page, output, report, f"toast-{theme}")
            contrast(page, f"toast-{theme}", report)
        report["checks"].append("打开弹窗与在途确认保持同一DOM/焦点/请求，最终真实归档仅一次，双主题Toast可读")

        page.goto(origin + "/settings")
        page.emulate_media(forced_colors="active", reduced_motion="reduce")
        expect(page.get_by_test_id("theme-dark")).to_have_attribute("aria-pressed", "true")
        page.get_by_test_id("theme-light").focus()
        assert page.get_by_test_id("theme-light").evaluate("el=>getComputedStyle(el).outlineStyle") != "none"
        media_readability(page, output, report, "settings-forced-colors", "dark", forced=True)
        capture(page, output, report, "settings-forced-colors")
        page.emulate_media(forced_colors="none", contrast="more", reduced_motion="reduce")
        assert page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--border').trim()===getComputedStyle(document.documentElement).getPropertyValue('--control-border').trim()")
        media_readability(page, output, report, "settings-more-contrast", "dark", more=True)
        capture(page, output, report, "settings-more-contrast")
        page.emulate_media(forced_colors="none", contrast="no-preference", reduced_motion="reduce")
        media_readability(page, output, report, "settings-restored-dark", "dark")
        capture(page, output, report, "settings-restored-dark")
        controls.get_by_test_id("theme-light").click(); appearance(page, "light")
        page.emulate_media(forced_colors="none", contrast="more", reduced_motion="reduce")
        assert page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--border').trim()===getComputedStyle(document.documentElement).getPropertyValue('--control-border').trim()")
        media_readability(page, output, report, "settings-more-contrast-light", "light", more=True)
        capture(page, output, report, "settings-more-contrast-light")
        page.emulate_media(forced_colors="none", contrast="no-preference", reduced_motion="reduce")
        media_readability(page, output, report, "settings-restored-light", "light")
        capture(page, output, report, "settings-restored-light")
        report["checks"].append("forced-colors 保留选择/焦点指示，prefers-contrast 加强边界，减少动态仍可操作")
        report["checks"].append("不刷新切换 forced-colors→more→常规并恢复浅色；原始 viewport 背景像素符合主题，标题和说明的真实笔画像素与背景对比度至少 4.5:1")
        assert not report["pageErrors"], report["pageErrors"]
    except Exception:
        if not page.is_closed(): page.screenshot(path=str(output / "failure.png"), full_page=True)
        raise
    finally:
        context.tracing.stop(path=str(output / "trace.zip")); context.close()
    failure_modes(browser, origin, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/theme-web-e2e")
    parser.add_argument("--chromium", type=Path)
    args = parser.parse_args(); output = args.artifacts.resolve(); output.mkdir(parents=True, exist_ok=True)
    report = {"status": "FAIL", "at": datetime.now(timezone.utc).isoformat(),
              "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "worktree": subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True).strip(),
              "scope": "real Chromium / production HTTP / temporary SQLite / no model invocation", "checks": [], "screenshots": [], "layouts": [], "contrast": [], "pageErrors": []}
    fixture = None
    try:
        report["phase"] = "fixture_start"
        fixture = subprocess.Popen(["node", "scripts/managed-web-fixture.mjs"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready, _, _ = select.select([fixture.stdout], [], [], 30)
        assert ready, "主题验收临时服务启动超时"
        line = fixture.stdout.readline(); assert line, "临时服务未返回地址：" + fixture.stderr.read(2000)
        data = json.loads(line); assert urlsplit(data["url"]).hostname == "127.0.0.1"
        with sync_playwright() as playwright:
            report["phase"] = "browser_start"
            launch = {"headless": True}
            if args.chromium: launch["executable_path"] = str(args.chromium)
            browser = playwright.chromium.launch(**launch); report["chromium"] = browser.version
            try:
                report["phase"] = "exercise"
                exercise(browser, data["url"], data["workdir"], output, report)
                report["status"] = "PASS"
            finally: browser.close()
    except Exception as error:
        report["error"] = str(error)[:5000]; report["traceback"] = traceback.format_exc()
        if report["phase"] in ("fixture_start", "browser_start"): report["status"] = "BLOCKED"
    finally:
        if fixture:
            fixture.stdin.close()
            try: fixture.wait(timeout=10)
            except subprocess.TimeoutExpired: fixture.terminate(); fixture.wait(timeout=5)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"status": report["status"], "report": str(output / "report.json"), "error": report.get("error")}, ensure_ascii=False))
    raise SystemExit(0 if report["status"] == "PASS" else 1)


if __name__ == "__main__":
    main()
