import assert from 'node:assert/strict';
import test from 'node:test';
import { newP0State,catchP0,P0_LIMITS,p0State,chargeState } from '../src/server/identity/internal/m2-p0-budget.ts';
import type { P0State } from '../src/server/identity/internal/m2-p0-budget.ts';
import { scanM2OwnedHistory } from '../src/server/identity/internal/m2-owned-json.ts';
import { validateHistoryObservationValue,validateM2OwnedHistoryObservation,historyValueFailure } from '../src/server/identity/internal/m2-history-observation-core.ts';
import { typedObservationFixture,commonTypedMutations,sqliteTypedMutations,pgTypedMutations } from './helpers/m2-owned-observation-fixture.ts';
import { createM2HistoryRequest } from '../src/server/identity/internal/m2-p0-request.ts';
import { M2_HISTORY_TABLES } from '../src/server/identity/m2-history-contracts.ts';
import { p0ArtifactFixture } from './helpers/m2-p0-f-fixture.ts';

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

for(const phase of ['p0','p1'] as const)for(const fits of [false,true]){
  test(`M2-BUDGET-REQ-002: ${phase} catalog allocation ${fits?'is prepaid at the exact tuple limit':'fails before allocation and poisons the same request'}`,()=>{
    const admitted=createM2HistoryRequest(JSON.stringify(p0ArtifactFixture()));assert(admitted.ok);
    const state=p0State(admitted.value),value=scanM2OwnedHistory(state,JSON.stringify(typedObservationFixture('sqlite',phase)),state.rootSite);
    // A genuine admitted request owns this scanner tree. Only its remaining
    // tuple allowance is placed at the boundary by this private test control.
    state.usage.tuples=P0_LIMITS.tuples-(fits?M2_HISTORY_TABLES.length+2:1);
    const filter=Array.prototype.filter;let calls=0,atAllocation:number|undefined;
    Array.prototype.filter=function(this:unknown[],predicate:(value:unknown,index:number,array:unknown[])=>unknown,thisArg?:unknown){
      if(this===M2_HISTORY_TABLES){calls++;atAllocation=state.usage.tuples;}
      return filter.call(this,predicate,thisArg);
    } as typeof filter;
    try{
      if(fits){
        assert.equal(validateM2OwnedHistoryObservation(state,value,state.rootSite),value);
        assert.equal(calls,1);assert.equal(atAllocation,P0_LIMITS.tuples);
        assert.equal(state.usage.tuples,P0_LIMITS.tuples);assert.equal(state.poisoned,null);
      }else{
        let first:unknown;
        try{validateM2OwnedHistoryObservation(state,value,state.rootSite);}catch(error){first=error;}
        assert.notEqual(first,undefined,'tuple-exhausted request must be refused');
        assert.equal(catchP0(state,first).code,'resource_limit');assert.equal(calls,0,'no catalog array allocated before refusal');
        assert.equal(state.poisoned,first);const stopped={...state.usage};
        assert.throws(()=>chargeState(state,{work:0}),error=>error===first);
        assert.throws(()=>validateM2OwnedHistoryObservation(state,value,state.rootSite),error=>error===first);
        assert.equal(calls,0);assert.deepEqual(state.usage,stopped);
      }
    }finally{Array.prototype.filter=filter;}
  });
}
