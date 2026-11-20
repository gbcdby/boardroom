import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { newP0State,catchP0,P0_LIMITS } from '../src/server/identity/internal/m2-p0-budget.ts';
import { scanM2OwnedHistory,m2OwnedSelectedBytes } from '../src/server/identity/internal/m2-owned-json.ts';
import { createM2HistoryRequest } from '../src/server/identity/internal/m2-p0-request.ts';
import { m2OriginFixture } from './helpers/m2-origin-fixture.ts';

const item=(hex='00ff',bytes=String(hex.length/2))=>({artifact:{ref:'selected',sha256:createHash('sha256').update(Buffer.from(hex,'hex')).digest('hex'),bytes},kind:'sample',bytesHex:hex});
const envelope=(selected=item())=>({contract:'m2-history-closure-input/r2',graph:{kind:'m2-observation',observation:{phase:'p1'}},artifacts:[selected]});
function parsed(wire:string){const state=newP0State(),value=scanM2OwnedHistory(state,wire,state.rootSite) as ReturnType<typeof envelope>;return {state,value,bytes:m2OwnedSelectedBytes(state,value.artifacts[0])};}

test('same M2 scan produces only complete lowercase selected bytes with the exact owner identity',()=>{
  const plain=parsed(JSON.stringify(envelope()));assert.deepEqual(plain.bytes,Buffer.from('00ff','hex'));
  const empty=parsed(JSON.stringify(envelope(item('','0'))));assert.equal(empty.bytes?.length,0);
  assert.equal(m2OwnedSelectedBytes(newP0State(),plain.value.artifacts[0]),undefined);
  assert.equal(m2OwnedSelectedBytes(plain.state,Object.freeze({...plain.value.artifacts[0]})),undefined);
  let traps=0;const foreign=new Proxy({},{get(){traps++;throw Error('hidden');},ownKeys(){traps++;throw Error('hidden');},getPrototypeOf(){traps++;throw Error('hidden');}});
  assert.equal(m2OwnedSelectedBytes(plain.state,foreign),undefined);assert.equal(traps,0);
  for(const [hex,bytes] of [['00Ff','2'],['00x0','2'],['00f','2'],['00ff','1'],['00ff','9']] as const){
    const result=parsed(JSON.stringify(envelope(item(hex,bytes))));assert.equal(result.bytes,undefined,hex+' / '+bytes);
  }
  const invalid=parsed(JSON.stringify(envelope(item('00Ff','2'))));
  assert.equal(invalid.state.usage.bytes,plain.state.usage.bytes,'a discarded partially filled buffer keeps its actual prepaid bytes');
});
test('escaped hex, early bytesHex and early artifacts keep the exact old data without borrowing a partial buffer',()=>{
  const base=envelope(),selected=base.artifacts[0]!;
  const variants=[
    JSON.stringify(base).replace('"bytesHex":"00ff"','"bytesHex":"\\u0030\\u0030ff"'),
    JSON.stringify({...base,artifacts:[{bytesHex:selected.bytesHex,kind:selected.kind,artifact:selected.artifact}]}),
    JSON.stringify({artifacts:base.artifacts,contract:base.contract,graph:base.graph}),
  ];
  for(const wire of variants){const result=parsed(wire);assert.deepEqual(result.value,base);assert.equal(result.bytes,undefined);}
  const duplicate=JSON.stringify(base).replace('"bytesHex":"00ff"','"bytesHex":"00ff","bytesHex":"00ff"'),state=newP0State();
  try{scanM2OwnedHistory(state,duplicate,state.rootSite);assert.fail('duplicate accepted');}
  catch(error){assert.equal(catchP0(state,error).code,'invalid_value');}
});
test('the fixed buffer is charged before allocation and does not activate for a P0 carrier',()=>{
  const wire=JSON.stringify(envelope(item('00'.repeat(32_768)))),state=newP0State(),allocate=Buffer.allocUnsafe;let allocations=0;
  state.usage.bytes=P0_LIMITS.bytes-wire.length*2-10_000;
  try{
    Buffer.allocUnsafe=(size:number)=>{allocations++;return allocate(size);};
    try{scanM2OwnedHistory(state,wire,state.rootSite);assert.fail('budget bypassed');}
    catch(error){assert.equal(catchP0(state,error).code,'resource_limit');}
  }finally{Buffer.allocUnsafe=allocate;}
  assert.equal(allocations,0);
  const p0=envelope();p0.graph.observation.phase='p0';assert.equal(parsed(JSON.stringify(p0)).bytes,undefined);
});
test('full M2 admission still checks declared lengths and actually reads the selected SHA after the shared scan',async()=>{
  const fixture=await m2OriginFixture();assert(createM2HistoryRequest(JSON.stringify(fixture.pcInput)).ok);
  for(const kind of ['length','hash'] as const){
    const input=structuredClone(fixture.pcInput),selected=input.artifacts[0]!;
    if(kind==='length')selected.artifact={...selected.artifact,bytes:String(Number(selected.artifact.bytes)+1)};
    else selected.artifact={...selected.artifact,sha256:'f'.repeat(64)};
    const result=createM2HistoryRequest(JSON.stringify(input));assert(!result.ok);
    assert.equal(result.error.code,'artifact_bytes_mismatch',kind);
  }
});
