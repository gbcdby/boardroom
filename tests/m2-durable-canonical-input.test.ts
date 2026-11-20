import assert from 'node:assert/strict';
import test from 'node:test';
import { newP0State, catchP0 } from '../src/server/identity/internal/m2-p0-budget.ts';
import { scanM2CanonicalJson, scanP0Json } from '../src/server/identity/internal/m2-p0-lexical.ts';

function canonical(text:string):{ok:true;value:unknown}|{ok:false;code:string}{
  const state=newP0State();try{return {ok:true,value:scanM2CanonicalJson(state,text,state.rootSite)};}
  catch(error){return {ok:false,code:catchP0(state,error).code};}
}
test('EG canonical scan accepts C-R3 codepoint key order and exact JSON string spelling',()=>{
  const value=canonical('{"a":1,"z":[true,null],"":"B","𐀀":"A"}');assert(value.ok);
  for(const text of [String.raw`{"a":"\b\f\n\r\t\\\"/"}`,String.raw`{"a":"\u0000\u0001\u001f"}`,'{"a":"é𐀀"}'])assert(canonical(text).ok,text);
});
test('EG canonical scan rejects every noncanonical lexical representation without a second hex carrier',()=>{
  for(const text of [' {"a":1}','{"a":1}\n','{"a": 1}','{"b":1,"a":2}','{"𐀀":1,"":2}',
    String.raw`{"a":"\/"}`,String.raw`{"a":"\u0061"}`,String.raw`{"a":"\ud800\udc00"}`,String.raw`{"a":"\u001F"}`,
    String.raw`{"a":"\u000a"}`,'{"a":-0}','{"a":1e0}','{"a":1.0}','{"a":1,"a":2}',
    '{"a":9007199254740993}','['.repeat(65)+'0'+']'.repeat(65)])assert.equal(canonical(text).ok,false,text);
});
test('original scanner retains its noncanonical accepted carrier behavior',()=>{
  const state=newP0State();assert.deepEqual(scanP0Json(state,' {"a":1.0} \n',state.rootSite,{policy:'reference',outer:true}),{a:1});
});
