import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/decisions-fixture.mjs';
import { encode, decode, TEXT_COLUMNS, commandDigest, validateCopyRow, StorageInvalid } from '../src/server/decisions/text-codec.ts';
import { validateRawDecisionRow } from '../src/server/decisions/row-validation.ts';

test('Decision TEXT preserves existing normalized reason code units, canonical object and command digest',()=>{
  for(const value of ['中文😀','x\0y','\ud800','\udc00','看似"JSON"','\\u0000','e\u0301','\0'.repeat(2000)]) {
    const f=fixture(value); const digest=commandDigest(f.command);
    for(const column of TEXT_COLUMNS) { const raw=encode(column,f.values[column]);assert.deepEqual(decode(column,raw),f.values[column]);assert.equal(raw,f.raw[column]); }
    assert.equal(commandDigest(f.command),digest); for(const [table,rows] of Object.entries(f.rows))for(const row of rows)validateCopyRow(table,row);
  }
});
test('raw Decision Row validation covers receipt pairs, status codes and actor/effect CHECKs before target writes',()=>{
  const f=fixture();
  const cases:[string,Record<string,unknown>][]=[
    ['decision_command_receipts',{http_status:201}],
    ['decision_command_receipts',{input_decision_revision:null}],
    ['decision_command_receipts',{result_state:'pending',http_status:202}],
    ['decision_command_receipts',{result_state:'refreshed',http_status:409}],
    ['decision_command_receipts',{resolution_id:null}],
    ['decision_resolutions',{actor_id:'not-the-local-human'}],
    ['decision_resolutions',{actor_kind:'agent',initiation_id:null,authority:'human'}],
    ['decision_resolutions',{choice_id:'reject',actual_execution_path:'management'}],
    ['decision_resolutions',{actual_execution_path:'no-effect'}],
  ];
  for(const [table,change] of cases){const row={...f.rows[table]![0]!,...change};assert.throws(()=>validateRawDecisionRow(table,row),StorageInvalid,`${table}: ${JSON.stringify(change)}`);}
});
test('Decision TEXT rejects noncanonical, malformed, extra keys, changed digest and incomplete raw Rows',()=>{
  const f=fixture(); const row=f.rows['decision_action_requests']![0]!;
  for(const changed of [{...row,extra:'x'},{...row,expected_task_revision:'01'},{...row,expected_task_revision:'9007199254740992'},{...row,round_id:null},{...row,action_digest:'sha256:'+'0'.repeat(64)}]) assert.throws(()=>validateCopyRow('decision_action_requests',changed),StorageInvalid);
  const missing={...row};delete missing['created_at'];assert.throws(()=>validateCopyRow('decision_action_requests',missing),StorageInvalid);
  for(const raw of [' {}','null','{"x":1,"x":2}','" padded "','"\\ud800" '])assert.throws(()=>decode('decision_resolutions.reason_json',raw),StorageInvalid);
  assert.throws(()=>encode('decision_action_requests.action_json',{...(f.values['decision_action_requests.action_json'] as object),extra:true}),StorageInvalid);
  assert.throws(()=>validateCopyRow('not_a_decision_table',{}),StorageInvalid);
});
