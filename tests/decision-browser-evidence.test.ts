import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Decision browser evidence consumer rejects false timing, phase and incomplete originals (synthetic controls, no browser)', () => {
  const program = String.raw`
import copy, importlib.util, json
from pathlib import Path
source=importlib.util.spec_from_file_location('decision_probe',Path('scripts/e2e-decision-web.py'))
module=importlib.util.module_from_spec(source);source.loader.exec_module(module)
spec={'id':'1440-http-hint','scenario':'http-hint','projectId':'project','taskId':'task','taskRevision':3,'marker':'actual-choice',
 'mutation':'http','fallback':False,'decisionRef':{'decisionId':'decision','projectId':'project','revision':1,'actionDigest':'sha256:'+'a'*64},
 'choicePath':'/api/projects/project/decisions/decision/choices','readPath':'/api/projects/project/decisions?taskId=task'}
ref={**spec['decisionRef'],'revision':2}
receipt={'receiptId':'receipt','resolutionId':'resolution','inputDecisionRef':spec['decisionRef'],'resultDecisionRef':ref,
 'execution':{'id':'execution','status':'not_required'},'httpStatus':200}
body={'schemaVersion':'decision-response/v1','state':'not_required','decisionRef':ref,'receipt':receipt,
 'task':{'id':'task','state':'review','revision':3},'current':{'ref':ref,'status':'resolved','resolution':{'choiceId':'reject','reason':'actual-choice'}}}
raw={'schema':'decision-browser-observation/v1','caseId':spec['id'],'pageUrl':'http://127.0.0.1/projects/project/tasks/task',
 'clock':{'kind':'performance.now','native':True,'timeOrigin':1},'armedAt':1,'mutationStartedAt':10000,'receiptReceivedAt':10020,
 'domObservedAt':10200,'visibleFrameAt':10220,'visibility':[],'phase':None,
 'initial':{'stateVisible':True,'visibility':'visible','focus':True},'response':{'status':200,'body':body},
 'command':{'decisionRef':spec['decisionRef'],'choiceId':'reject','reason':spec['marker']},
 'visibleFrame':{'stateVisible':True,'markerVisible':True,'visibility':'visible','focus':True,'state':'选择已记录 · 决定版本 2','marker':'actual-choice'}}
facts={'records':[{'id':'decision','project_id':'project','task_id':'task','action_digest':ref['actionDigest'],'status':'resolved','revision':2}],
 'resolutions':[{'id':'resolution','command_receipt_id':'receipt'}],'executions':[{'id':'execution','status':'not_required'}],
 'receipts':[{'id':'receipt','response_json':json.dumps({'receipt':receipt})}],
 'userEvents':[{'id':'event','decision_id':'decision'}],'initiations':[{'decision_id':'decision','user_event_id':'event','consumed_receipt_id':'receipt'}]}
hint={'kind':'ws.forwarded','frame':{'type':'resource.changed','entity':'decision','projectId':'project','id':'decision','revision':2}}
current_get={'kind':'http.response','method':'GET','path':spec['readPath'],'requestId':3,'status':200,'rawBody':json.dumps({'decisions':[body['current']]})}
network={'events':[{'kind':'http.request','method':'POST','path':spec['choicePath'],'requestId':2},
 {'kind':'http.response','method':'POST','path':spec['choicePath'],'requestId':2,'status':200,'rawBody':json.dumps(body)},current_get,hint]}
base=(spec,raw,network,facts)
def valid(values=base):return module.validate_observation(*values)
def rejects(mutate):
 values=copy.deepcopy(base);mutate(*values)
 try:valid(values)
 except (ValueError,KeyError,TypeError):return
 raise AssertionError('invalid browser evidence accepted')
assert valid()['status']=='PASS'
for frame,expected in [(15000,'PASS'),(15010,'INCONCLUSIVE_COMMIT_WINDOW'),(15021,'FAIL_LATENCY')]:
 values=copy.deepcopy(base);values[1]['visibleFrameAt']=frame
 result=valid(values);assert result['status']==expected,result
 assert result['latencyLowerMs']==frame-10020 and result['latencyUpperMs']==frame-10000
for deadline,expected in [(15020,'INCONCLUSIVE_COMMIT_WINDOW'),(15021,'FAIL_LATENCY')]:
 values=copy.deepcopy(base);values[1]['visibleFrameAt']=None;values[1]['domObservedAt']=None;values[1]['deadlineObservedAt']=deadline
 values[1]['final']={'stateVisible':True,'visibility':'visible','focus':True,'state':'提案待决','marker':''}
 assert valid(values)['status']==expected
values[1]['domObservedAt']=10200
assert valid(values)['status']=='INCONCLUSIVE_RENDER_OBSERVATION','missing frame cannot prove late DOM that was already observed early'
rejects(lambda s,r,n,f:n.update(events=[]))
rejects(lambda s,r,n,f:f.update(receipts=[]))
rejects(lambda s,r,n,f:f['receipts'].append(copy.deepcopy(f['receipts'][0])))
rejects(lambda s,r,n,f:f.pop('initiations'))
rejects(lambda s,r,n,f:r['clock'].update(native=False))
rejects(lambda s,r,n,f:r['visibleFrame'].update(markerVisible=False))
rejects(lambda s,r,n,f:r['visibleFrame'].update(marker='different choice'))
rejects(lambda s,r,n,f:r['response']['body']['decisionRef'].update(revision=99))
rejects(lambda s,r,n,f:f['initiations'][0].update(consumed_receipt_id='foreign-receipt'))
rejects(lambda s,r,n,f:n['events'].remove(n['events'][2]))
# A full, adverse conditional-read phase is valid; late selection, missing
# conditional request, and forwarded packets in the dropped case are not.
fallback=copy.deepcopy(base);s,r,n,f=fallback
s.update(id='1440-http-dropped-fallback',scenario='http-dropped-fallback',fallback=True);r['caseId']=s['id']
r['phase']={'read':{'name':'http://127.0.0.1'+s['readPath'],'initiatorType':'fetch','startTime':9950,'responseEnd':9980},
 'previous':{'name':'http://127.0.0.1'+s['readPath'],'initiatorType':'fetch','startTime':4950,'responseEnd':4980}}
r['reads']=[r['phase']['previous'],r['phase']['read']]
n['events']=[{'kind':'http.request','method':'GET','path':s['readPath'],'requestId':0,'ifNoneMatch':'etag'},
 {'kind':'http.response','method':'GET','path':s['readPath'],'requestId':0,'status':304,'etag':'etag'},
 {'kind':'http.request','method':'GET','path':s['readPath'],'requestId':1,'ifNoneMatch':'etag'},
 {'kind':'http.response','method':'GET','path':s['readPath'],'requestId':1,'status':304,'etag':'etag'},*n['events']]
n['events'][-1]['kind']='ws.dropped';assert valid(fallback)['status']=='PASS'
for mutate in [lambda s,r,n,f:r['phase']['read'].update(responseEnd=9949),
               lambda s,r,n,f:n['events'][0].update(ifNoneMatch=None),lambda s,r,n,f:n['events'][-1].update(kind='ws.forwarded'),
               lambda s,r,n,f:r.update(reads=[])]:
 values=copy.deepcopy(fallback);mutate(*values)
 try:valid(values)
 except ValueError:pass
 else:raise AssertionError('invalid adverse phase/hint accepted')
# Actual stdio has no HTTP choice or in-process notification and no human source.
stdio=copy.deepcopy(fallback);s,r,n,f=stdio;s.update(id='1440-stdio-fallback',scenario='stdio-fallback',mutation='stdio');r['caseId']=s['id']
n['fixturePid']=100;n['stdioPid']=101;n['events']=n['events'][:4]+[
 {'kind':'mcp.started','request':{'decisionId':'decision'}},
 {'kind':'mcp.committed','transport':'stdio','request':{'decisionId':'decision'},'response':r['response']['body']},current_get]
f['userEvents']=[];f['initiations']=[];assert valid(stdio)['status']=='PASS'
print(json.dumps({'status':'PASS','scope':'synthetic consumer controls only; no browser/latency qualification',
 'positive':['hint','conditional fallback','independent stdio'],'boundaries':['upper <=5000','straddling','lower >5000','negative DOM observation'],
 'negative':['empty transport','empty/duplicate receipt','missing source collection','fake clock','invisible/wrong DOM','wrong ref','wrong source binding','late phase','nonconditional phase','forwarded dropped hint']}))
`;
  const result = spawnSync('python3', ['-B', '-c', program], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'PASS');
});
