import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { identityFixture } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { initializePolicyConfiguration, createPolicyConfiguration } from '../src/server/policy/configuration.ts';
import { createTaskApi } from '../src/server/tasks/api.ts';
import { createLogger } from '../src/server/logger.ts';
import { createDecisionService } from '../src/server/decisions/service.ts';
import { actorForMember } from '../src/server/authz/actors.ts';
import { withPage, byTestId, input, submit, settle, textOf, find, json } from './helpers/web-ui.ts';
import type { ResourceBrowser } from '../src/web/src/composables/useResourceReconciliation.ts';
import type { DecisionCommandResult } from '../src/shared/decisions.ts';

// Real SQLite + real loopback HTTP + compiled production SFC. The clock/renderer
// model browser scheduling; native Chromium/focus/layout remain separate gates.
function browserClock() {
  let now = 0, visible = true;
  const timers = new Set<{ next: number; ms: number; repeat: boolean; callback: () => void }>();
  const visibility = new Set<() => void>(), focus = new Set<() => void>();
  const add = (callback: () => void, ms: number, repeat: boolean) => { const row = { next: now + ms, ms, repeat, callback }; timers.add(row); return () => timers.delete(row); };
  const browser: ResourceBrowser = { isVisible: () => visible,
    onVisibility: f => { visibility.add(f); return () => { visibility.delete(f); }; }, onFocus: f => { focus.add(f); return () => { focus.delete(f); }; },
    interval: (f, ms) => add(f, ms, true), timeout: (f, ms) => add(f, ms, false), connect: () => ({ send() {}, close() {} }) };
  return { browser, intervals: () => [...timers].filter(t => t.repeat).map(t => t.ms).sort((a,b) => a-b),
    advance(ms: number) { now += ms; for (const t of [...timers]) if (t.next <= now) { if (t.repeat) t.next = now + t.ms; else timers.delete(t); t.callback(); } },
    visible(value: boolean) { visible = value; visibility.forEach(f => f()); }, focus() { focus.forEach(f => f()); } };
}
async function uiFixture(body: (f: Awaited<ReturnType<typeof identityFixture>>, p: Awaited<ReturnType<typeof decisionDomainFixture>>,
  harness: { base: string; nativeFetch: typeof fetch }) => Promise<void>) {
  const f = await identityFixture(); let close: (() => Promise<void>) | undefined;
  try {
    await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos);
    const api = createTaskApi({ db: f.db, logger: createLogger({ write() {} }) });
    const server = createServer((req,res) => { void api.handle(req,res,new URL(req.url ?? '/', 'http://127.0.0.1').pathname).then(done => { if (!done) { res.statusCode=404; res.end(); } }); });
    await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
    close = () => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    await body(f,p,{ base:`http://127.0.0.1:${address.port}`, nativeFetch:globalThis.fetch.bind(globalThis) });
  } finally { await close?.(); await f.close(); }
}
function bridge(p: Awaited<ReturnType<typeof decisionDomainFixture>>, h: { base: string; nativeFetch: typeof fetch }, loseOnce = false) {
  const pending = new Set<Promise<Response>>(), calls: Array<{url: string; method: string; body: string | undefined}> = [];
  return { calls, async flush() {
    for (let n=0;n<12;n++) { await Promise.allSettled([...pending]); await settle(); if (!pending.size) return; }
    throw new Error('UI reads did not settle within the bounded producer/consumer cycle');
  }, respond(url: string, init?: RequestInit) {
    calls.push({url,method:init?.method ?? 'GET',body:typeof init?.body==='string'?init.body:undefined});
    if (url.endsWith('/org')) return json({members:[p.worker,p.reviewer,p.manager],nodes:[],roles:[]});
    if (!url.includes('/tasks/') && !url.includes('/decisions')) return json({projects:[{...p.project,manager:null}]});
    const promise = h.nativeFetch(h.base+url,init).then(async response => {
      if (loseOnce && init?.method==='POST' && url.endsWith('/choices')) { loseOnce=false; assert.equal(response.status,200); await response.arrayBuffer(); throw new Error('response lost after actual commit'); }
      return response;
    }); pending.add(promise); void promise.finally(() => pending.delete(promise)).catch(() => {}); return promise;
  }};
}

test('Decision SFC actual HTTP: virtual 4s fallback is independent of Task default 15s; current terminal cannot replace a pinned choice draft', async () => uiFixture(async (f,p,h) => {
  const clock = browserClock(), b = bridge(p,h);
  await withPage('TaskDetailView',b.respond,async container => {
    await b.flush(); assert.deepEqual(clock.intervals(),[4000,15000]);
    await input(byTestId(container,'decision-choice-reason'),'原决定草稿');
    const taskReads = () => b.calls.filter(c => c.method==='GET' && c.url.endsWith(`/tasks/${p.task.id}`)).length;
    const decisionReads = () => b.calls.filter(c => c.method==='GET' && c.url.includes('/decisions?')).length;
    const oldTaskReads=taskReads(), oldDecisionReads=decisionReads();
    const service=createDecisionService(f.db), manager={actor:actorForMember(p.manager)};
    const current=(await service.list(manager,p.project.id)).decisions.find(d => d.recordKind==='live-review-decision')!;
    if(current.recordKind!=='live-review-decision')throw new Error('missing');
    await service.resolve(manager,p.project.id,current.ref.decisionId,{decisionRef:current.ref,choiceId:'reject',reason:'另一个真实入口拒绝提案',idempotencyKey:'ui-external'});
    clock.advance(3999);await b.flush();assert.equal(decisionReads(),oldDecisionReads);
    clock.advance(1);await b.flush();assert.equal(decisionReads(),oldDecisionReads+1);assert.equal(taskReads(),oldTaskReads);
    assert.match(textOf(byTestId(container,'decision-state')),/选择已记录/);
    assert.equal(byTestId(container,'decision-choice-reason').value,'原决定草稿');
    assert.equal(byTestId(container,'decision-submit').props.disabled,true);
    for(let n=0;n<2;n++){clock.advance(4000);await b.flush();assert.equal(decisionReads(),oldDecisionReads+n+2);assert.equal(taskReads(),oldTaskReads);}
    clock.advance(2999);await b.flush();assert.equal(taskReads(),oldTaskReads);
    clock.advance(1);await b.flush();assert.equal(taskReads(),oldTaskReads+1,'Task keeps its own 15s fallback');
    const hidden=decisionReads(),hiddenTask=taskReads();clock.visible(false);clock.advance(15_000);await b.flush();
    assert.equal(decisionReads(),hidden);assert.equal(taskReads(),hiddenTask);
    clock.visible(true);await b.flush();assert.ok(decisionReads()>hidden);
    const focused=decisionReads();clock.focus();await b.flush();assert.ok(decisionReads()>focused);
  },{path:`/projects/${p.project.id}/tasks/${p.task.id}`,resourceBrowser:clock.browser});
}));

test('Decision SFC actual HTTP: response lost after commit locks original command across virtual 4s reconciliation; exact retry has one effect/source', async () => uiFixture(async (f,p,h) => {
  const clock=browserClock(),b=bridge(p,h,true);
  await withPage('TaskDetailView',b.respond,async container => {
    await b.flush();await input(byTestId(container,'decision-choice-reason'),'保留原选择及唯一请求');
    assert.equal(byTestId(container,'decision-submit').props.disabled,false,'fresh producer refs must permit the explicit human choice');
    await submit(byTestId(container,'decision-submit'));await b.flush();
    assert.match(textOf(container),/结果尚未确认/);
    assert.equal(byTestId(container,'decision-choice').props.disabled,true);
    assert.equal(byTestId(container,'decision-choice-reason').props.disabled,true);
    assert.equal(byTestId(container,'task-decision-reason').props.disabled,true);
    const command=b.calls.find(c => c.method==='POST'&&c.url.endsWith('/choices'))!;
    assert.ok(JSON.parse(command.body!).clientMutationId);
    clock.advance(4000);await b.flush();assert.match(textOf(byTestId(container,'decision-state')),/选择已记录/);
    assert.equal(byTestId(container,'decision-choice-reason').value,'保留原选择及唯一请求');
    await byTestId(container,'decision-retry').props.onClick();await b.flush();
    const posted=b.calls.filter(c => c.method==='POST'&&c.url.endsWith('/choices'));
    assert.equal(posted.length,2);assert.equal(posted[1]!.body,command.body);assert.equal(posted[1]!.url,command.url);
    assert.equal(find(container,n=>n.props['data-testid']==='decision-retry'),undefined);
    assert.match(textOf(container),/裁决已保存并应用/);
    for(const table of ['decision_user_events','decision_local_initiations','decision_resolutions','decision_executions']) assert.equal((await f.db.query(`SELECT * FROM ${table}`)).length,1);
  },{path:`/projects/${p.project.id}/tasks/${p.task.id}`,resourceBrowser:clock.browser});
}));

test('Decision SFC actual HTTP: committed policy_changed 409 retains old ref/choice/reason; explicit rebase creates a new command', async () => uiFixture(async (f,p,h) => {
  const clock=browserClock(),b=bridge(p,h);
  await withPage('TaskDetailView',b.respond,async container => {
    await b.flush();await input(byTestId(container,'decision-choice-reason'),'核对新的策略前不批准');
    const policy=createPolicyConfiguration({repos:f.repos}),current=await policy.getGlobal(p.owner);
    await policy.updateGlobal(p.owner,{expectedRevision:current.ref.revision,rules:current.document.rules.map(r=>r.ruleId==='default.review.decide'?{...r,reason:'修改后的真实规则'}:r)});
    await submit(byTestId(container,'decision-submit'));await b.flush();
    assert.match(textOf(container),/本次只更新了评估/);
    assert.equal(byTestId(container,'decision-choice-reason').value,'核对新的策略前不批准');
    assert.equal(byTestId(container,'decision-submit').props.disabled,true);
    assert.equal((await f.db.query('SELECT * FROM decision_local_initiations')).length,0);
    assert.equal((await f.db.query('SELECT * FROM decision_executions')).length,0);
    const old=JSON.parse(b.calls.find(c=>c.method==='POST'&&c.url.endsWith('/choices'))!.body!);
    await byTestId(container,'decision-choice-rebase').props.onClick();await settle();
    await submit(byTestId(container,'decision-submit'));await b.flush();
    const next=JSON.parse(b.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/choices')).at(-1)!.body!);
    assert.notEqual(next.clientMutationId,old.clientMutationId);assert.equal(next.decisionRef.revision,old.decisionRef.revision+1);
    assert.equal(next.reason,old.reason);assert.equal((await f.db.query('SELECT * FROM decision_executions')).length,1);
  },{path:`/projects/${p.project.id}/tasks/${p.task.id}`,resourceBrowser:clock.browser});
}));

test('R-157-REQ-002 actual HTTP: first refresh conflict preserves an editable draft and permits explicit rebase', async () => uiFixture(async (f,p,h) => {
  const clock=browserClock(),b=bridge(p,h); let raced=false;
  const replies:Array<{status:number;body:any}>=[];
  await withPage('TaskDetailView',async (url,init)=>{
    if(init?.method==='POST'&&url.endsWith('/refresh')&&!raced){
      raced=true;const command=JSON.parse(String(init.body));
      const competing=await h.nativeFetch(h.base+url,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({...command,idempotencyKey:'competing-refresh'})});
      assert.equal(competing.status,409);assert.equal((await competing.json() as DecisionCommandResult).state,'refreshed');
    }
    const response=await b.respond(url,init);
    if(init?.method==='POST')replies.push({status:response.status,body:await response.clone().json()});
    return response;
  },async container=>{
    await b.flush();await input(byTestId(container,'decision-choice-reason'),'并发刷新后仍可核对的草稿');
    const policy=createPolicyConfiguration({repos:f.repos}),global=await policy.getGlobal(p.owner);
    await policy.updateGlobal(p.owner,{expectedRevision:global.ref.revision,rules:global.document.rules.map(r=>r.ruleId==='default.review.decide'?{...r,reason:'实际规则改变'}:r)});
    clock.advance(4000);await b.flush();
    const refresh=find(container,n=>n.type==='button'&&textOf(n)==='读取当前策略并刷新提案');assert.ok(refresh);
    await refresh.props.onClick();await b.flush();
    assert.equal(replies[0]!.status,409);assert.equal(replies[0]!.body.error.code,'decision_revision_conflict');
    assert.equal(byTestId(container,'decision-choice-reason').value,'并发刷新后仍可核对的草稿');
    assert.equal(byTestId(container,'decision-choice-reason').props.disabled,false);
    assert.equal(find(container,n=>n.props['data-testid']==='decision-retry'),undefined,'明确首次无效果409不能锁成未知重试');
    clock.advance(4000);await b.flush();
    assert.equal(byTestId(container,'decision-choice-rebase').props.disabled,false);
    await byTestId(container,'decision-choice-rebase').props.onClick();await settle();
    assert.equal(byTestId(container,'decision-submit').props.disabled,false);
    const receipts=await f.db.query('SELECT * FROM decision_command_receipts');assert.equal(receipts.length,1);assert.equal(receipts[0]!.idempotency_key,'competing-refresh');
    for(const table of ['decision_user_events','decision_local_initiations','decision_resolutions','decision_executions'])assert.deepEqual(await f.db.query(`SELECT * FROM ${table}`),[]);
  },{path:`/projects/${p.project.id}/tasks/${p.task.id}`,resourceBrowser:clock.browser});
}));

test('R-157-REQ-002 actual HTTP: lost refresh receipt remains locked through 403/409 retries until the original receipt returns', async () => uiFixture(async (f,p,h) => {
  const clock=browserClock(),b=bridge(p,h);let lost=false,denial:403|409|null=null;
  const attempts:Array<{url:string;body:string}>=[];let originalReceipt:unknown;
  await withPage('TaskDetailView',async (url,init)=>{
    if(init?.method==='POST'&&url.endsWith('/refresh')){
      attempts.push({url,body:String(init.body)});
      // A controlled admission rejection on retry reveals nothing about the
      // first real committed command, which remains frozen in the component.
      if(denial)return new Response(JSON.stringify({error:{code:denial===403?'forbidden':'decision_revision_conflict',message:'拒绝当前重试；未读取原回执'}}),{status:denial,headers:{'content-type':'application/json'}});
      const response=await b.respond(url,init),result=await response.clone().json() as DecisionCommandResult;
      assert.equal(response.status,409);assert.equal(result.state,'refreshed');
      if(!lost){lost=true;originalReceipt=result.receipt;await response.arrayBuffer();throw new Error('refresh reply lost after real commit');}
      assert.deepEqual(result.receipt,originalReceipt);return response;
    }
    return b.respond(url,init);
  },async container=>{
    await b.flush();await input(byTestId(container,'decision-choice-reason'),'刷新未知时保留原理由');
    const policy=createPolicyConfiguration({repos:f.repos}),global=await policy.getGlobal(p.owner);
    await policy.updateGlobal(p.owner,{expectedRevision:global.ref.revision,rules:global.document.rules.map(r=>r.ruleId==='default.review.decide'?{...r,reason:'真实策略更新'}:r)});
    clock.advance(4000);await b.flush();
    const refresh=find(container,n=>n.type==='button'&&textOf(n)==='读取当前策略并刷新提案');assert.ok(refresh);
    await refresh.props.onClick();await b.flush();assert.equal(byTestId(container,'decision-choice-reason').props.disabled,true);
    clock.advance(4000);await b.flush();
    for(const status of [403,409] as const){denial=status;await byTestId(container,'decision-retry').props.onClick();await b.flush();
      assert.equal(byTestId(container,'decision-choice-reason').props.disabled,true);assert.equal(byTestId(container,'decision-choice-rebase').props.disabled,true);
      assert.equal(byTestId(container,'decision-choice-reason').value,'刷新未知时保留原理由');}
    denial=null;await byTestId(container,'decision-retry').props.onClick();await b.flush();
    assert.equal(attempts.length,4);for(const attempt of attempts)assert.deepEqual(attempt,attempts[0]);
    assert.equal(find(container,n=>n.props['data-testid']==='decision-retry'),undefined);
    assert.equal(byTestId(container,'decision-choice-reason').props.disabled,false);assert.equal(byTestId(container,'decision-choice-rebase').props.disabled,false);
    assert.equal((await f.db.query('SELECT * FROM decision_command_receipts')).length,1);
    for(const table of ['decision_user_events','decision_local_initiations','decision_resolutions','decision_executions'])assert.deepEqual(await f.db.query(`SELECT * FROM ${table}`),[]);
  },{path:`/projects/${p.project.id}/tasks/${p.task.id}`,resourceBrowser:clock.browser});
}));
