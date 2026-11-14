import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/server/policy/canonical.ts';
import { planLegacyImport } from '../src/server/decisions/legacy.ts';
const at='2026-11-13T00:00:00.000Z';
const first={verdict:'pass',reason:'原\0\ud800',override:true,actor:{kind:'human',actorId:'human:local',displayName:'用户'},taskRevision:4};
const second={...first,verdict:'changes_requested',taskRevision:5};
const history=(id:string,revision:number,decision:unknown,previousDecision:unknown)=>({id,project_id:'p',task_id:'t',task_revision:revision,action:'task.review_decided',actor:JSON.stringify(first.actor),detail:JSON.stringify({roundId:'r',decision,previousDecision}),created_at:at});
const round={id:'r',project_id:'p',task_id:'t',revision:8,decision:JSON.stringify(second)};
test('legacy chain follows real revisions, keeps full raw bytes and never creates approval',()=>{
  const histories=[history('late-sort',5,second,first),history('early-sort',4,first,null)];
  const result=planLegacyImport({projectId:'p',taskId:'t',histories,rounds:[round],at,liveHistoryIds:new Set()});
  assert.equal(result.rows.length,2);assert.ok(result.rows.every(r=>r.chain_status==='verified'));assert.equal(result.projections.length,1);
  for(const source of histories)assert.equal(result.rows.find(r=>r.source_id===source.id)?.raw_text,canonicalJson(source));
  assert.equal(result.projections[0]?.source_kind,'legacy');assert.equal(result.projections[0]?.execution_id,null);
});
test('legacy duplicate revision/bad JSON/missing round are retained diagnostic rows with true null',()=>{
  const bad={...history('bad',6,second,null),detail:'broken'};
  const result=planLegacyImport({projectId:'p',taskId:'t',histories:[history('a',4,first,null),history('b',4,first,null),bad],rounds:[round],at,liveHistoryIds:new Set()});
  assert.equal(result.projections.length,0);assert.equal(result.rows.find(r=>r.source_id==='bad')?.round_id,null);assert.equal(result.rows.find(r=>r.source_id==='bad')?.chain_status,'malformed');
  assert.ok(result.rows.filter(r=>r.source_table==='task_history'&&r.source_id!=='bad').every(r=>r.chain_status==='ambiguous'));
});
test('missing final projection cannot verify a historical chain; live histories are not reimported',()=>{
  const source=history('a',4,first,null);
  const result=planLegacyImport({projectId:'p',taskId:'t',histories:[source],rounds:[{...round,decision:null}],at,liveHistoryIds:new Set()});
  assert.equal(result.rows[0]?.chain_status,'ambiguous');assert.match(String(result.rows[0]?.diagnostics_json),/final_projection_missing/);assert.equal(result.projections.length,0);
  assert.equal(planLegacyImport({projectId:'p',taskId:'t',histories:[source],rounds:[],at,liveHistoryIds:new Set(['a'])}).rows.length,0);
});
