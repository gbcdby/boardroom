import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { newP0State,catchP0,P0_LIMITS } from '../src/server/identity/internal/m2-p0-budget.ts';
import { scanP0Json,scanM2CanonicalJson } from '../src/server/identity/internal/m2-p0-lexical.ts';
import { scanM2OwnedCanonical,scanM2OwnedHistory } from '../src/server/identity/internal/m2-owned-json.ts';
import { canonicalJson } from '../src/server/storage/maintenance/canonical.ts';
import { createM2DurableRequest,createM2HistoryRequest,createP0Request } from '../src/server/identity/internal/m2-p0-request.ts';
import { p0ArtifactFixture } from './helpers/m2-p0-f-fixture.ts';
import { m2OriginFixture } from './helpers/m2-origin-fixture.ts';
import { originCanonical } from './helpers/m2-origin-fixture-store.ts';

function read(text:string,owned:boolean,canonical=false){
  const state=newP0State();try{
    const value=owned?(canonical?scanM2OwnedCanonical:scanM2OwnedHistory)(state,text,state.rootSite)
      :canonical?scanM2CanonicalJson(state,text,state.rootSite):scanP0Json(state,text,state.rootSite,{outer:true,policy:'reference'});
    return {ok:true as const,value,state};
  }catch(error){return {ok:false as const,error:catchP0(state,error),state};}
}
function same(text:string,canonical=false){
  const old=read(text,false,canonical),next=read(text,true,canonical);assert.equal(next.ok,old.ok,text.slice(0,120));
  if(old.ok&&next.ok){assert.deepEqual(next.value,old.value);assert.equal(next.state.usage.nodes,old.state.usage.nodes);
    const a=canonicalJson(old.value),b=canonicalJson(next.value);assert.equal(a,b);
    assert.equal(createHash('sha256').update(a).digest('hex'),createHash('sha256').update(b).digest('hex'));
    if(next.value!==null&&typeof next.value==='object')assert(Object.isFrozen(next.value));
  }else if(!old.ok&&!next.ok)assert.equal(next.error.code,old.error.code,text.slice(0,120));
  return next;
}

test('M2 owned carrier retains exact old values, node counts, canonical bytes and hashes',()=>{
  for(const text of ['null','true','false','0','9007199254740991','-9007199254740991','1e0','100e-2','0e999999999',
    ' {"z":1.0,"a":[true,null,"é𐀀"]} \r\n',String.raw`{"slash":"\/","a":"\b\f\n\r\t\\\""}`,
    String.raw`{"a":"\ud800\udc00","b":"\u0000\u001f"}`,String.raw`{"\u0061":1,"b":2}`,
    String.raw`{"__proto__":{"safe":true},"constructor":{"prototype":1},"toString":"own"}`,
    '['.repeat(64)+'0'+']'.repeat(64)])same(text);
  for(let count=0;count<40;count++){
    const value={['k'+count]:Array.from({length:count%7},(_,i)=>({value:i-count,text:['plain','é','𐀀','"\\\n','\u0000'][i%5]})),
      raw:'0123456789abcdef'.repeat(count*17)};same(JSON.stringify(value));same(originCanonical(value),true);
  }
  const proto=same(String.raw`{"__proto__":{"polluted":true}}`);assert(proto.ok);
  assert.equal(Object.getPrototypeOf(proto.value),Object.prototype);assert(Object.hasOwn(proto.value as object,'__proto__'));
  assert.equal(({} as Record<string,unknown>).polluted,undefined);
});

test('M2 owned strict and canonical grammars reject the same malformed original carriers',()=>{
  const malformed=['','{','[1,]','{"a":1,}','{"a" 1}','01','+1','NaN','Infinity','0.1','1e-1','-0','-0.0','-0e2',
    '9007199254740993','9007199254740992.0','{"a":1,"a":2}',String.raw`{"a":1,"\u0061":2}`,
    '"\ud800"','"\udfff"',String.raw`"\ud800"`,String.raw`"\udfff"`,String.raw`"\uXXYY"`,String.raw`"\x00"`,
    '"raw\ncontrol"','{}{}','['.repeat(65)+'0'+']'.repeat(65)];
  for(const text of malformed)same(text);
  for(const text of [' {"a":1}','{"a":1}\n','{"a": 1}','{"b":1,"a":2}','{"𐀀":1,"":2}',
    String.raw`{"a":"\/"}`,String.raw`{"a":"\u0061"}`,String.raw`{"a":"\ud800\udc00"}`,String.raw`{"a":"\u001F"}`,
    String.raw`{"a":"\u000a"}`,'{"a":-0}','{"a":1e0}','{"a":1.0}'])same(text,true);
  same('{"a":1,"":"B","𐀀":"A"}',true);
});

test('owned parser preserves UTF8 size priority even for a syntax error before the oversized suffix',()=>{
  const oversized='x'+'é'.repeat(P0_LIMITS.outerBytes/2);same(oversized);
  const result=read(oversized,true);assert(!result.ok);assert.equal(result.error.code,'resource_limit');
  const boundary='"'+'é'.repeat((P0_LIMITS.outerBytes-2)/2)+'"';const value=same(boundary);assert(value.ok);
  same('"'+'é'.repeat(P0_LIMITS.outerBytes/2)+'"');
});

test('normal owned parsing removes both JSON.parse and UTF8 measurement calls, with real lower cost',()=>{
  const text='{"a":"'+'ab'.repeat(100_000)+'","b":[1,2,3]}',old=read(text,false);
  assert(old.ok);const parse=JSON.parse,byteLength=Buffer.byteLength;
  try{
    JSON.parse=()=>{throw Error('the deleted JSON.parse pass was invoked');};
    Buffer.byteLength=()=>{throw Error('the deleted UTF8 measurement pass was invoked');};
    const next=read(text,true);assert(next.ok);assert.deepEqual(next.value,old.value);
    assert(next.state.usage.bytes<old.state.usage.bytes-100_000);
  }finally{JSON.parse=parse;Buffer.byteLength=byteLength;}
});

test('M2 facade-owned P0 input retains its original fixed data and original request factory',()=>{
  const wire=JSON.stringify(p0ArtifactFixture()),old=createP0Request(wire),next=createM2HistoryRequest(wire);
  assert(old.ok);assert(next.ok);assert.deepEqual(next.value.input,old.value.input);
});

test('fixed M2 hexadecimal decode checks lowercase spelling, complete byte length and SHA before graph use',async()=>{
  const fixture=await m2OriginFixture();assert(createM2DurableRequest(fixture.durableWire).ok);
  for(const mutation of ['odd','uppercase','bad-nibble','hash'] as const){
    const input=structuredClone(fixture.durableInput),selected=input.selectedArtifacts[0]!;
    if(mutation==='odd')selected.bytesHex=selected.bytesHex.slice(1);
    else if(mutation==='uppercase')selected.bytesHex=selected.bytesHex.replace(/[a-f]/,x=>x.toUpperCase());
    else if(mutation==='bad-nibble')selected.bytesHex='x'+selected.bytesHex.slice(1);
    else selected.bytesHex=(selected.bytesHex[0]==='0'?'1':'0')+selected.bytesHex.slice(1);
    const result=createM2DurableRequest(originCanonical(input));assert(!result.ok,mutation);
    assert.equal(result.error.code,mutation==='hash'?'artifact_bytes_mismatch':'invalid_value',mutation);
  }
});
