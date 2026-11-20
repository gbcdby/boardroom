import assert from 'node:assert/strict';
import test from 'node:test';
import { newP0State,catchP0,P0_LIMITS } from '../src/server/identity/internal/m2-p0-budget.ts';
import type { P0State } from '../src/server/identity/internal/m2-p0-budget.ts';
import { scanM2OwnedHistory } from '../src/server/identity/internal/m2-owned-json.ts';
import { validateHistoryObservationValue,validateM2OwnedHistoryObservation,historyValueFailure } from '../src/server/identity/internal/m2-history-observation-core.ts';
import { typedObservationFixture,commonTypedMutations,sqliteTypedMutations,pgTypedMutations } from './helpers/m2-owned-observation-fixture.ts';

function checked(value:unknown,owned:boolean){
  const state=newP0State();
  try{const input=scanM2OwnedHistory(state,JSON.stringify(value),state.rootSite);
    return {ok:true as const,value:owned?validateM2OwnedHistoryObservation(state,input,state.rootSite):validateHistoryObservationValue(input)};}
  catch(error){return {ok:false as const,error:historyValueFailure(error)??catchP0(state,error)};}
}
for(const backend of ['sqlite','postgres'] as const)for(const phase of ['p0','p1','p1-bootstrap'] as const){
  test(`owned typed grammar preserves every ${backend} ${phase} column and exact failure path`,()=>{
    const base=typedObservationFixture(backend,phase),positive=checked(base,true);assert(positive.ok);assert.deepEqual(positive,checked(base,false));
    assert.equal(base.tables.length,phase==='p0'?61:72);assert(base.tables.every(t=>t.rows.length===1||t.name==='config_authority'));
    for(const [name,change] of [...commonTypedMutations,...backend==='sqlite'?sqliteTypedMutations:pgTypedMutations]){
      const value=structuredClone(base);change(value);const actual=checked(value,true),original=checked(value,false);
      assert.equal(actual.ok,false,name);assert.deepEqual(actual,original,name);
    }
    if(phase!=='p0'){
      const wrong=structuredClone(base),authority=wrong.tables.find(t=>t.name==='config_authority')!;
      authority.rows=phase==='p1'?[]:[{rowid:backend==='sqlite'?'1':null,cells:authority.columns.map(()=>['null'])}];authority.count=String(authority.rows.length);
      const result=checked(wrong,true);assert(!result.ok);assert.deepEqual(result,checked(wrong,false));
    }
  });
}
test('owned typed entry authenticates the actual state, site and scanner tree before reflection',()=>{
  let traps=0;const hostile=new Proxy({},{get(){traps++;throw Error('hidden');},ownKeys(){traps++;throw Error('hidden');},getPrototypeOf(){traps++;throw Error('hidden');}});
  const a=newP0State(),b=newP0State(),value=scanM2OwnedHistory(a,JSON.stringify(typedObservationFixture('sqlite','p0')),a.rootSite);
  assert.throws(()=>validateM2OwnedHistoryObservation(hostile as P0State,hostile,a.rootSite));
  assert.throws(()=>validateM2OwnedHistoryObservation(b,value,b.rootSite));
  assert.throws(()=>validateM2OwnedHistoryObservation(a,hostile,a.rootSite));
  assert.throws(()=>validateM2OwnedHistoryObservation(a,value,b.rootSite));assert.equal(traps,0);
});
test('owned typed admission removes full UTF8 measurements and Object.keys arrays, but keeps the original ledger',()=>{
  const state=newP0State(),value=scanM2OwnedHistory(state,JSON.stringify(typedObservationFixture('sqlite','p1')),state.rootSite);
  const byteLength=Buffer.byteLength,keys=Object.keys,start={...state.usage};
  try{
    Buffer.byteLength=()=>{throw Error('removed UTF8 preflight ran');};Object.keys=()=>{throw Error('removed key array allocation ran');};
    assert.equal(validateM2OwnedHistoryObservation(state,value,state.rootSite),value);
  }finally{Buffer.byteLength=byteLength;Object.keys=keys;}
  assert(state.usage.bytes>start.bytes);assert(state.usage.work>start.work);assert.equal(state.usage.nodes,start.nodes);
  state.usage.bytes=P0_LIMITS.bytes-1;
  try{validateM2OwnedHistoryObservation(state,value,state.rootSite);assert.fail('same exhausted ledger accepted');}
  catch(error){assert.equal(catchP0(state,error).code,'resource_limit');}
});
