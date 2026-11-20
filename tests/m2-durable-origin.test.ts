import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/server/storage/maintenance/canonical.ts';
import { verifyM2DurableClosure } from '../src/server/identity/m2-durable-closure.ts';
import { validateM2HistoryClosure } from '../src/server/identity/m2-history-closure.ts';
import { m2OriginFixture, reanchorM2OriginFixture } from './helpers/m2-origin-fixture.ts';
import { originCanonical, originSet } from './helpers/m2-origin-fixture-store.ts';

const base=m2OriginFixture();
test('complete M2 origin replays the nonempty original ready/bridge/coordinator through A and B',async()=>{
  const fixture=await base,result=verifyM2DurableClosure(fixture.durableWire);
  assert(result.ok,JSON.stringify(result));assert.equal(result.value.coverage,'durable-m2-origin-values');
  assert.deepEqual(result.value.originCompletion,fixture.completion);assert.equal(result.value.checkedArtifacts,312);
  assert.equal(result.value.state.ownerGeneration,7);assert.equal(result.value.state.fenceEpoch,3);
  assert.equal(result.value.remaining.find(x=>x.check==='production_registration')?.status,'unproven');
  assert(Object.isFrozen(result.value.originCompletion.terminal.record));
});
test('the existing P-C facade consumes the complete exact B history and all 72 tables',async()=>{
  const fixture=await base,result=validateM2HistoryClosure(JSON.stringify(fixture.pcInput));
  assert(result.ok,JSON.stringify(result));assert.equal(result.value.phase,'p1');assert.equal(result.value.tables.length,72);
  assert.equal(result.value.checks.artifactSemantics,'verified');assert.equal(result.value.checks.m2SemanticGraph,'verified');
  assert.equal(result.value.ruleCoverage.filter(x=>x.status==='verified').length,47);
});
test('the same P-C root accepts the exact post-A/pre-B projection',async()=>{
  const fixture=await base,input=structuredClone(fixture.pcInput);input.graph.observation=structuredClone(fixture.preB);
  const result=validateM2HistoryClosure(JSON.stringify(input));assert(result.ok,JSON.stringify(result));
});
for(const ownerCount of [1,2] as const)test(`both complete roots consume ${ownerCount} real owner successor${ownerCount===1?'':'s'} and the exact original digest domains`,async()=>{
  const fixture=await m2OriginFixture({ownerCount}),durable=verifyM2DurableClosure(fixture.durableWire);
  assert(durable.ok,JSON.stringify(durable));assert.deepEqual(durable.value.originCompletion,fixture.completion);
  assert.equal(durable.value.state.ownerGeneration,7+ownerCount);assert.equal(durable.value.state.fenceEpoch,3);
  assert.equal(durable.value.originCompletion.terminal.sequence,7+ownerCount);
  assert.equal(durable.value.checkedArtifacts,312+ownerCount*8);
  const result=validateM2HistoryClosure(JSON.stringify(fixture.pcInput));assert(result.ok,JSON.stringify(result));
  const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
  assert.equal(result.value.inputDigest,digest(['m2-pc-closure-input/r2',fixture.pcInput]));
  for(const table of fixture.pcInput.graph.observation.tables){
    const frames=table.rows.map(row=>canonicalJson([row.rowid,row.cells])).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
    const expected=digest(['m2-pc-table-rows/r1','sqlite',table.name,table.columnContractValueDigest,table.count,frames]);
    assert.equal(result.value.tables.find(row=>row.table===table.name)?.rowMultisetDigest,expected,table.name);
  }
  assert.equal(result.value.ruleCoverage.filter(rule=>rule.status==='verified').length,47);
  const preB=structuredClone(fixture.pcInput);preB.graph.observation=structuredClone(fixture.preB);
  const before=validateM2HistoryClosure(JSON.stringify(preB));assert(before.ok,JSON.stringify(before));
});

for(const [name,change] of [
  ['seed omits a captured Agent',(label:string,value:any)=>{if(label==='seed')value.agents=[];}],
  ['source mapping swaps requested and applied references',(label:string,value:any)=>{if(label==='sourceToTarget')value.bindings[0].requested.legacyRef=value.bindings[0].applied.legacyRef;}],
  ['source mapping selects its own wrong seed',(label:string,value:any)=>{if(label==='sourceToTarget')value.seed=value.targetRows;}],
  ['source mapping selects its own wrong target rows',(label:string,value:any)=>{if(label==='sourceToTarget')value.targetRows=value.seed;}],
  ['upgrade changes the independent schema-after domain',(label:string,value:any)=>{if(label==='upgrade')value.schemaAfterDigest='b'.repeat(64);}],
  ['exact delta chooses a different source',(label:string,value:any)=>{if(label==='exactDelta')value.source.identityDigest='e'.repeat(64);}],
  ['proof omits a frozen-business table',(label:string,value:any)=>{if(label==='domain:frozen')value.tables.pop();}],
  ['A owner generation skips the replayed ready tail',(label:string,value:any)=>{if(label==='J_A'){value.ownerGeneration++;value.body.ownerGeneration++;}}],
  ['B requests an epoch jump',(label:string,value:any)=>{if(label==='J_B')value.body.after.fenceEpoch+=2;}],
  ['closure drops the actual ready node',(label:string,value:any)=>{if(label==='closure')value.nodes.splice(2,1);}],
  ['calendar-invalid seed timestamp',(label:string,value:any)=>{if(label==='seed')value.createdAt='2026-02-30T00:00:00Z';}],
] as const)test(`complete origin rejects byte-valid ${name}`,async()=>{
  const fixture=await reanchorM2OriginFixture(change),result=verifyM2DurableClosure(fixture.durableWire);
  assert.equal(result.ok,false,JSON.stringify(result));
  if(!result.ok)assert.notEqual(result.error.code,'resource_limit','semantic mutation must reach its actual rejection');
});

test('a spare valid selected history is an unused artifact, not an additional root',async()=>{
  const fixture=await base,input=structuredClone(fixture.durableInput);
  input.selectedArtifacts.push(fixture.selected.find(item=>item.artifact.ref===fixture.refs.history!.ref)!);
  const result=verifyM2DurableClosure(originCanonical(input));assert.equal(result.ok,false);
  if(!result.ok)assert.equal(result.error.code,'unused_artifact');
});
test('P-C refuses later ordinary rows under the old M2 snapshot window',async()=>{
  const fixture=await base,input=structuredClone(fixture.pcInput);
  originSet(input.graph.observation.tables.find(t=>t.name==='agents')!,'display_name','Later name');
  assert.equal(validateM2HistoryClosure(JSON.stringify(input)).ok,false);
});
test('P-C rejects a terminal value that does not expand from the actual selected B bytes',async()=>{
  const fixture=await base,input=structuredClone(fixture.pcInput),completion=structuredClone(fixture.completion);completion.terminal.sequence++;
  originSet(input.graph.observation.tables.find(t=>t.name==='storage_maintenance')!,'profile_takeover_terminal_json',originCanonical(completion));
  assert.equal(validateM2HistoryClosure(JSON.stringify(input)).ok,false);
});
test('known future durable roots stay explicit unsupported and object input stays unobserved',async()=>{
  const fixture=await base;const result=verifyM2DurableClosure(originCanonical({contract:'m2-durable-validation/r2',roots:{kind:'p1-window',snapshotLink:fixture.refs.history,observation:fixture.refs['preB:observation']},selectedArtifacts:[]}));
  assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'semantic_unsupported');
  let traps=0;const hostile=new Proxy({},{get(){traps++;throw Error('hidden');},ownKeys(){traps++;throw Error('hidden');}});
  assert.equal(verifyM2DurableClosure(hostile).ok,false);assert.equal(traps,0);
});
