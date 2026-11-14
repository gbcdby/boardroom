import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { storageFixture } from './helpers/decisions-fixture.mjs';
import { canonicalJson } from '../src/server/policy/canonical.ts';
import { validateDecisionStorageGraph } from '../src/server/decisions/storage-validation.ts';
import { StorageInvalid } from '../src/server/decisions/storage-error.ts';
import { commandDigest } from '../src/server/decisions/text-codec.ts';
test('Decision full graph binds immutable action, report, actual history/WorkEvent and raw legacy source',()=>{
  const {graph}=storageFixture();const before=canonicalJson(graph);validateDecisionStorageGraph(graph);assert.equal(canonicalJson(graph),before);
  const bad=[
    (g:typeof graph)=>{g['task_review_reports']![0]!['body']='changed';},
    (g:typeof graph)=>{g['task_history']![0]!['task_revision']=5;},
    (g:typeof graph)=>{const e=g['work_events']![0]!;e['payload']=JSON.stringify({...JSON.parse(e['payload']),revision:99});},
    (g:typeof graph)=>{const l=g['decision_legacy_records']![0]!;l['raw_text']=canonicalJson({...JSON.parse(l['raw_text']),detail:'changed'});l['raw_digest']=createHash('sha256').update(l['raw_text']).digest('hex');},
    (g:typeof graph)=>{g['decision_records']![0]!['required_authority']='auto';g['decision_resolutions']![0]!['authority']='auto';},
    (g:typeof graph)=>{g['decision_review_heads']=[];},
    (g:typeof graph)=>{g['decision_action_requests']!.push({...g['decision_action_requests']![0]!,id:'orphan'});},
  ];
  for(const mutate of bad){const changed=structuredClone(graph);mutate(changed);assert.throws(()=>validateDecisionStorageGraph(changed),StorageInvalid);}
});

test('R-157-A-001: stored receipt input ref is bound to the original command and resolution',()=>{
  const {graph}=storageFixture();validateDecisionStorageGraph(graph);
  for(const [field,value] of [['revision',99],['actionDigest','sha256:'+'0'.repeat(64)],['projectId','other-project'],['decisionId','other-decision']] as const){
    const bad=structuredClone(graph),row=bad['decision_command_receipts']![0]!,response=JSON.parse(row['response_json']);
    response.receipt.inputDecisionRef[field]=value;
    if(field==='revision')row['input_decision_revision']=value;
    if(field==='decisionId')row['input_decision_id']=value;
    // Deliberately corrupt persisted canonical bytes; no writer codec repairs the source.
    row['response_json']=canonicalJson(response);
    assert.throws(()=>validateDecisionStorageGraph(bad),StorageInvalid,field);
  }
});

test('R-157-A-002: committed Task snapshot matches execution.after, while live Task may advance',()=>{
  const {graph}=storageFixture();graph['tasks']![0]!['revision']=999;
  validateDecisionStorageGraph(graph);
  const row=graph['decision_command_receipts']![0]!,response=JSON.parse(row['response_json']);
  assert.equal(response.task.revision,4);assert.equal(response.receipt.execution.after.taskRevision,4);
  response.task.revision=999;row['response_json']=canonicalJson(response);
  assert.throws(()=>validateDecisionStorageGraph(graph),StorageInvalid);
});

/** Only historical fixture data is rebuilt; no command is executed or authority issued. */
function changeTerminalCommand(graph:ReturnType<typeof storageFixture>['graph'],command:Record<string,any>){
  const receipt=graph['decision_command_receipts']![0]!,response=JSON.parse(receipt['response_json']),event=graph['decision_user_events']![0]!,ui=JSON.parse(event['command_json']);
  const digest=commandDigest(command);
  response.receipt.command=command;response.receipt.operation=command['operation'];response.receipt.requestDigest=digest;receipt['operation']=command['operation'];
  ui.command=command;ui.kind=command['operation']==='legacy-decide'?'legacy-decide':'ui-decision-choice';event['command_kind']=ui.kind;event['command_json']=canonicalJson(ui);
  for(const rows of Object.values(graph))for(const row of rows)if(Object.hasOwn(row,'request_digest'))row['request_digest']=digest;
  receipt['response_json']=canonicalJson(response);
}

test('R-157-A-001: legacy command keeps nullable input, but a derived input must match its resolution',()=>{
  for(const nullable of [true,false]){
    const {graph}=storageFixture(),row=graph['decision_command_receipts']![0]!,response=JSON.parse(row['response_json']);
    const original=response.receipt.command;
    changeTerminalCommand(graph,{...original,operation:'legacy-decide',input:{expectedTaskRevision:3,expectedRoundRevision:5,verdict:'pass',reason:original.input.reason,override:true}});
    const changed=JSON.parse(row['response_json']);
    if(nullable){changed.receipt.inputDecisionRef=null;row['input_decision_id']=null;row['input_decision_revision']=null;row['response_json']=canonicalJson(changed);}
    validateDecisionStorageGraph(graph);
    if(!nullable){changed.receipt.inputDecisionRef.revision=2;row['input_decision_revision']=2;row['response_json']=canonicalJson(changed);assert.throws(()=>validateDecisionStorageGraph(graph),StorageInvalid);}
  }
});

test('R-157-A-001: historical pending and refreshed receipts retain fixed input/result refs after later resolution',()=>{
  const {graph}=storageFixture(),record=graph['decision_records']![0]!,terminal=graph['decision_command_receipts']![0]!;
  const original=JSON.parse(terminal['response_json']),decisionId=record['id'];
  // Existing terminal is now revision3: one prior refresh consumed revision1→2.
  const advance=(value:any):any=>Array.isArray(value)?value.map(advance):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='revision'&&value.decisionId===decisionId&&v===2?3:advance(v)])):value;
  for(const [table,column] of [['task_review_rounds','decision'],['task_history','detail'],['work_events','payload'],['decision_command_receipts','response_json']] as const)for(const row of graph[table]!){if(row[column]!==null)row[column]=canonicalJson(advance(JSON.parse(row[column])));}
  record['revision']=3;
  for(const table of ['decision_user_events','decision_local_initiations','decision_resolutions','decision_command_receipts'])graph[table]![0]!['input_decision_revision']=2;
  terminal['result_decision_revision']=3;graph['decision_changes']![0]!['decision_revision']=3;
  const current=JSON.parse(terminal['response_json']);current.receipt.inputDecisionRef.revision=2;terminal['response_json']=canonicalJson(current);
  changeTerminalCommand(graph,{...original.receipt.command,input:{...original.receipt.command.input,decisionRef:{...original.receipt.command.input.decisionRef,revision:2}}});
  const terminalSnapshot=JSON.parse(terminal['response_json']);
  const add=(operation:'request-review'|'refresh')=>{
    const snapshot=structuredClone(terminalSnapshot),command={...original.receipt.command,operation,input:operation==='refresh'?{decisionRef:original.receipt.inputDecisionRef}:{expectedTaskRevision:3,expectedRoundRevision:5,proposedVerdict:'pass',reason:original.receipt.command.input.reason,requestedPath:'management'}};
    const state=operation==='refresh'?'refreshed':'pending',revision=operation==='refresh'?2:1,input=operation==='refresh'?original.receipt.inputDecisionRef:null,id=`${operation}-historical`;
    snapshot.state=state;snapshot.reason=operation==='refresh'?'policy_changed':null;snapshot.task.revision=3;snapshot.task.state='review';snapshot.decisionRef={...snapshot.decisionRef,revision};
    Object.assign(snapshot.receipt,{receiptId:id,operation,command,requestDigest:commandDigest(command),inputDecisionRef:input,resultDecisionRef:snapshot.decisionRef,result:state,httpStatus:operation==='refresh'?409:202,resolutionId:null,execution:null});
    graph['decision_command_receipts']!.push({...terminal,id,operation,idempotency_key:id,request_digest:snapshot.receipt.requestDigest,input_decision_id:input?.decisionId??null,input_decision_revision:input?.revision??null,result_decision_revision:revision,result_state:state,http_status:snapshot.receipt.httpStatus,resolution_id:null,initiation_id:null,response_json:canonicalJson(snapshot)});
  };
  add('request-review');add('refresh');graph['tasks']![0]!['revision']=999;
  validateDecisionStorageGraph(graph);
  const refresh=graph['decision_command_receipts']!.at(-1)!,bad=JSON.parse(refresh['response_json']);bad.receipt.inputDecisionRef.actionDigest='sha256:'+'0'.repeat(64);refresh['response_json']=canonicalJson(bad);
  assert.throws(()=>validateDecisionStorageGraph(graph),StorageInvalid);
});
