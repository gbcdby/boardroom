import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { newP0State,catchP0,throwP0,p0State,withP0Guard } from '../src/server/identity/internal/m2-p0-budget.ts';
import { scanP0Json } from '../src/server/identity/internal/m2-p0-lexical.ts';
import { scanM2OwnedS4Canonical,m2OwnedS4Source,m2OwnedCanonicalSource } from '../src/server/identity/internal/m2-owned-json.ts';
import { canonicalJson } from '../src/server/storage/maintenance/canonical.ts';
import { createM2DurableRequest } from '../src/server/identity/internal/m2-p0-request.ts';
import { fState } from '../src/server/identity/internal/m2-p0-artifacts-common.ts';
import { m2OriginFixture } from './helpers/m2-origin-fixture.ts';
import { originCanonical } from './helpers/m2-origin-fixture-store.ts';

function read(wire:string,next:boolean){
  const state=newP0State();try{
    const value=next?scanM2OwnedS4Canonical(state,wire,state.rootSite):scanP0Json(state,wire,state.rootSite,{outer:false,policy:'finite'});
    if(!next){
      let encoded:string|undefined;try{encoded=canonicalJson(value);}catch{}
      if(encoded!==wire)throwP0(state,{code:'artifact_semantic_mismatch',rule:'PC1B-ART01',condition:'format-mismatch',site:state.rootSite});
    }
    return {ok:true as const,value,state};
  }catch(error){return {ok:false as const,error:catchP0(state,error),state};}
}
function same(wire:string){
  const old=read(wire,false),next=read(wire,true),label=wire.slice(0,100);
  assert.equal(next.ok,old.ok,label);
  if(old.ok&&next.ok){
    assert.deepEqual(next.value,old.value,label);assert.equal(next.state.usage.nodes,old.state.usage.nodes,label);
    assert.equal(canonicalJson(next.value),wire,label);
    if(next.value!==null&&typeof next.value==='object'){
      assert(Object.isFrozen(next.value));const source=m2OwnedS4Source(next.state,next.value);assert(source);
      assert.equal(source.encoded,Buffer.byteLength(wire));assert.equal(source.byteStart,0);
      assert.equal(m2OwnedCanonicalSource(next.state,next.value),undefined,'S4 metadata must not identify R3 provenance');
      assert.equal(m2OwnedS4Source(newP0State(),next.value),undefined);
    }
  }else if(!old.ok&&!next.ok)assert.equal(next.error.code,old.error.code,label);
}

test('owned S4 retains finite fractions, UTF16 key order, escaped lone surrogates and strict failure precedence',()=>{
  const values=[{fraction:1.25,small:0.000001,tiny:1e-7,zero:0,min:-9007199254740991,max:9007199254740991},
    {'\ue000':'bmp','𐀀':'astral',payload:['é','𐀀','\ud800','\udc00','\ud800a','a\udc00','\ud800\ud800','\udc00\udc00','\ud800\udc00']},
    JSON.parse('{"__proto__":{"own":"\\ud800"},"payload":{"constructor":"é𐀀","toString":1.25}}')];
  for(const value of values)same(canonicalJson(value));
  for(const wire of ['0.1','1.25','1e-7','-0','1.0','1e0','1E-7','1e+100','1e999','9007199254740992',
    ' {"a":1}','{"a":1}\n','{"b":0,"a":1}','{"":1,"𐀀":2}',
    String.raw`{"a":"\ud800"}`,String.raw`{"a":"\udc00"}`,String.raw`{"a":"\uD800"}`,
    String.raw`{"a":"\ud800\udc00"}`,String.raw`{"a":"\u000a"}`,String.raw`{"a":"\/"}`,
    String.raw`{"a":"\u0061"}`,String.raw`{"a":"\ud800𐀀"}`,String.raw`{"a":"𐀀\udc00"}`,
    '{"a":"\ud800"}','{"a":"\udc00"}',String.raw`{"a":1,"\u0061":2}`,String.raw`{"b":"\u0041","a":`,
    '{"b":1,"a":0,"a":2}','[1,]','{"a":1,}',String.raw`"\uXXYY"`])same(wire);
  for(let i=0;i<120;i++){
    const value={payload:{['key'+i]:[i%2?i+0.125:i,['plain','é𐀀','\ud800','\udc00','\u0000\n'][i%5]]},['𐀀'+i]:i};
    const wire=canonicalJson(value);same(wire);same(wire+'\n');same(wire.slice(0,-1));
  }
});

test('S4 nested metadata uses actual UTF8 bytes and never upgrades a fractional or lone-surrogate domain',()=>{
  for(const value of [{a:'é𐀀',payload:{fraction:1.25,inner:{text:'𐀀'}}},{a:'é𐀀',payload:{lone:'\ud800'}},
    {'a':'é𐀀',payload:{safe:[1,'𐀀']},'𐀀':'astral','\ue000':'bmp'}]){
    const wire=canonicalJson(value),state=newP0State(),parsed=scanM2OwnedS4Canonical(state,wire,state.rootSite) as Record<string,unknown>;
    const check=(node:unknown):void=>{
      if(node===null||typeof node!=='object')return;
      const span=m2OwnedS4Source(state,node);assert(span);assert(Object.isFrozen(span));
      const text=wire.slice(span.unitStart,span.unitEnd),bytes=Buffer.from(wire).subarray(span.byteStart,span.byteStart+span.encoded);
      assert.equal(text,canonicalJson(node));assert.equal(bytes.toString('utf8'),text);
      assert.equal(span.byteStart,Buffer.byteLength(wire.slice(0,span.unitStart)));
      for(const child of Object.values(node))check(child);
    };check(parsed);
    const root=m2OwnedS4Source(state,parsed)!;
    assert.equal(root.r3,false);
  }
});

test('the actual M2 artifact owner preserves S4 bytes but independently rejects them in an R3 role',async()=>{
  const fixture=await m2OriginFixture();
  for(const payload of [{fraction:1.25},{lone:'\ud800'},{'𐀀':1,'\ue000':2}]){
    const input=structuredClone(fixture.durableInput),wire=canonicalJson({formatVersion:1,kind:'verification',payload});
    const bytes=Buffer.from(wire),sha256=createHash('sha256').update(bytes).digest('hex');
    const artifact={ref:`snapshots/${sha256}/verification.json`,sha256,bytes:String(bytes.length)};
    input.selectedArtifacts.push({kind:'verification',artifact,bytesHex:bytes.toString('hex')});
    const request=createM2DurableRequest(originCanonical(input));assert(request.ok);const f=fState(request.value);
    const parsed=f.json(f.select(artifact,'verification'));
    assert.equal(f.canonical(parsed),wire);assert.equal(f.digest(parsed),sha256);
    assert.equal(m2OwnedS4Source(p0State(request.value),parsed)?.r3,false);
    const result=withP0Guard(request.value,()=>f.digestCr3(parsed));assert(!result.ok);assert.equal(result.error.code,'artifact_semantic_mismatch');
  }
});

test('owned S4 performs no JSON.parse or separate UTF8 measurement on its successful path',()=>{
  const wire=canonicalJson({payload:{fraction:1.25,value:'é𐀀'.repeat(1000),lone:'\ud800'}}),old=read(wire,false);assert(old.ok);
  const parse=JSON.parse,byteLength=Buffer.byteLength;
  try{
    JSON.parse=()=>{throw Error('removed native parse');};Buffer.byteLength=()=>{throw Error('removed size scan');};
    const next=read(wire,true);assert(next.ok);assert.deepEqual(next.value,old.value);
    assert(next.state.usage.bytes<old.state.usage.bytes);
  }finally{JSON.parse=parse;Buffer.byteLength=byteLength;}
});
