import assert from 'node:assert/strict';
import test from 'node:test';
import { createM2DurableRequest } from '../src/server/identity/internal/m2-p0-request.ts';
import { p0State,withP0Guard,newP0State,makeP0Site,catchP0 } from '../src/server/identity/internal/m2-p0-budget.ts';
import { fState } from '../src/server/identity/internal/m2-p0-artifacts-common.ts';
import { M2Graph } from '../src/server/identity/internal/m2-durable-graph.ts';
import { scanM2OwnedCanonical,m2OwnedUnicode,m2OwnedCanonicalSource,scanM2OwnedS4Canonical,scanM2OwnedHistory } from '../src/server/identity/internal/m2-owned-json.ts';
import { beginP0FArtifactPass,endP0FArtifactPass } from '../src/server/identity/internal/m2-p0-artifacts-frame.ts';
import type { RawRow } from '../src/server/identity/m2-history-contracts.ts';
import { m2Definition } from '../src/server/identity/internal/m2-durable-schema.ts';
import { m2OriginFixture } from './helpers/m2-origin-fixture.ts';

const base=m2OriginFixture();
test('canonical equality reuses only this request own byte identity, preserving slow paths and domain checks',async()=>{
  const fixture=await base,a=createM2DurableRequest(fixture.durableWire),b=createM2DurableRequest(fixture.durableWire);assert(a.ok&&b.ok);
  const f=fState(a.value),other=fState(b.value),left={fraction:1.25,nested:{raw:'é𐀀'.repeat(200)}},right=structuredClone(left);
  f.freeze(left);f.freeze(right);f.encode(left);assert(f.copyEncoding(left,right));
  const before={...p0State(a.value).usage},sameText=f.sameText;
  try{f.sameText=()=>{throw Error('a proved byte identity should not rescan strings');};assert.equal(f.equal(left,right),true);}
  finally{f.sameText=sameText;}
  assert.equal(p0State(a.value).usage.bytes,before.bytes);assert(p0State(a.value).usage.work>before.work);
  assert.equal(f.ownedM2Equal(left,Object.freeze(structuredClone(left))),undefined);
  other.freeze(right);other.encode(right);assert.equal(other.ownedM2Equal(left,right),undefined);
  assert.equal(f.ownedM2Equal(Object.freeze({kind:'source',bytes:1,r3:true}),left),undefined);
  let traps=0;const hostile=new Proxy({},{get(){traps++;throw Error('hidden');},ownKeys(){traps++;throw Error('hidden');}});
  assert.equal(f.ownedM2Equal(hostile,left),undefined);assert.equal(traps,0);
  const changed={fraction:1.25,nested:{raw:'different'}};f.freeze(changed);assert.equal(f.equal(left,changed),false);
  const invalid={fraction:-0,nested:{raw:'different'}};f.freeze(invalid);assert.equal(withP0Guard(a.value,()=>f.equal(invalid,invalid)).ok,false);
  assert.equal(withP0Guard(a.value,()=>f.digestCr3(left)).ok,false,'same canonical S4 bytes do not establish R3');
});

test('strict Unicode subtree data is private to its scanner request and keeps each role own pattern checks',async()=>{
  const fixture=await base,admitted=createM2DurableRequest(fixture.durableWire);assert(admitted.ok);
  const state=p0State(admitted.value),f=fState(admitted.value);
  const value=scanM2OwnedCanonical(state,'{"payload":{"ref":{"artifactId":"bad-id","digest":"'+'a'.repeat(64)+'"}}}',state.rootSite) as {payload:{ref:{artifactId:string;digest:string}}};
  assert(m2OwnedUnicode(state,value.payload.ref));assert.equal(m2OwnedCanonicalSource(state,value.payload.ref),undefined);
  assert.equal(m2OwnedUnicode(newP0State(),value.payload.ref),false);assert.equal(m2OwnedUnicode(state,Object.freeze({...value.payload.ref})),false);
  f.freeze(value);assert.equal(m2Definition(f,'EvidenceRef',value.payload.ref),value.payload.ref);
  const wrong=scanM2OwnedCanonical(state,'{"payload":{"artifactId":"bad-id","digest":"wrong"}}',state.rootSite) as {payload:unknown};f.freeze(wrong);
  assert(m2OwnedUnicode(state,wrong.payload));assert.equal(withP0Guard(admitted.value,()=>m2Definition(f,'EvidenceRef',wrong.payload)).ok,false);
  const s4=scanM2OwnedS4Canonical(state,'{"nested":{"lone":"\\ud800"}}',state.rootSite) as {nested:unknown};
  assert.equal(m2OwnedUnicode(state,s4),false);assert.equal(m2OwnedUnicode(state,s4.nested),false);
});

test('owned canonical subtree metadata never resets the actual occurrence depth',()=>{
  const wire='{"payload":{"nested":{"value":"é𐀀"}}}',shallow=newP0State(),root=scanM2OwnedCanonical(shallow,wire,shallow.rootSite);
  assert(m2OwnedCanonicalSource(shallow,root));
  const deep=makeP0Site(shallow,{depth:62,phase:'input',location:shallow.rootSite.location});
  try{scanM2OwnedCanonical(shallow,wire,deep);assert.fail('deeper actual parse must not borrow shallow admission');}
  catch(error){assert.equal(catchP0(shallow,error).code,'resource_limit');}
});

test('Graph raw text data reuse does not cross graph/request ownership or accept a different storage class',async()=>{
  const fixture=await base,admitted=createM2DurableRequest(fixture.durableWire);assert(admitted.ok);
  const g=new M2Graph(admitted.value),cell=admitted.value.input.graph.observation.tables.find(t=>t.name==='agents')!.rows[0]!.cells[0]!;
  assert.equal(cell[0],'text');const expected=g.text(cell),before={...p0State(admitted.value).usage};
  assert.equal(g.text(cell),expected);assert.equal(p0State(admitted.value).usage.bytes,before.bytes);
  const next=new M2Graph(admitted.value),start=p0State(admitted.value).usage.bytes;assert.equal(next.text(cell),expected);assert(p0State(admitted.value).usage.bytes>start);
  assert.equal(withP0Guard(admitted.value,()=>g.text(['blob',cell[1]!])).ok,false);
});
test('the same row bytes at a deeper occurrence rerun the original embedded JSON depth gate',async()=>{
  const fixture=await base,admitted=createM2DurableRequest(fixture.durableWire);assert(admitted.ok);
  const g=new M2Graph(admitted.value),state=p0State(admitted.value),wire=JSON.stringify(fixture.preB.tables.find(t=>t.name==='config_snapshots')!.rows[0]!);
  const shallow=scanM2OwnedHistory(state,wire,state.rootSite) as RawRow;g.f.freeze(shallow);
  beginP0FArtifactPass(g.f,admitted.value.original);
  try{
    assert.equal(g.row('config_snapshots',shallow,'sqlite').table,'config_snapshots');
    const site=makeP0Site(state,{depth:60,phase:'input',location:state.rootSite.location}),deep=scanM2OwnedHistory(state,wire,site) as RawRow;
    g.f.freeze(deep);assert.deepEqual(deep,shallow);
    const result=withP0Guard(admitted.value,()=>g.row('config_snapshots',deep,'sqlite'));
    assert(!result.ok,'the shallower row syntax cache must not accept a deeper embedded JSON source');assert.equal(result.error.code,'resource_limit');
  }finally{endP0FArtifactPass(g.f);}
});
