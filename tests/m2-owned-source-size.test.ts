import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { newP0State } from '../src/server/identity/internal/m2-p0-budget.ts';
import { scanM2OwnedCanonical,scanM2OwnedHistory,m2OwnedCanonicalSource } from '../src/server/identity/internal/m2-owned-json.ts';
import { createP0Request } from '../src/server/identity/internal/m2-p0-request.ts';
import { fState } from '../src/server/identity/internal/m2-p0-artifacts-common.ts';
import { p0ArtifactFixture } from './helpers/m2-p0-f-fixture.ts';
import { originCanonical } from './helpers/m2-origin-fixture-store.ts';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
test('one owned scan retains exact original Size and UTF8 root/payload bytes without eager child encodings',()=>{
  const original=createP0Request(JSON.stringify(p0ArtifactFixture()));assert(original.ok);const f=fState(original.value);
  const vectors=[
    {formatVersion:1,kind:'sample',payload:{plain:'text',astral:'é𐀀',controls:'\u0000\b\t\n\f\r',quote:'"\\'}},
    {a:'é𐀀',payload:{nested:{payload:['é','𐀀',0,9007199254740991,null,true]},empty:[]},z:'trailing'},
    JSON.parse('{"__proto__":{"own":"𐀀"},"payload":{"__proto__":{"safe":true},"toString":"own"}}'),
    {payload:Array.from({length:8},(_,i)=>({['field'+i]:['x'.repeat(i),'é'.repeat(i),'𐀀'.repeat(i)]}))},
    {payload:{empty:{},nothing:null,number:-9007199254740991}},
  ];
  for(const value of vectors){
    const wire=originCanonical(value),state=newP0State(),parsed=scanM2OwnedCanonical(state,wire,state.rootSite) as Record<string,unknown>;
    const root=m2OwnedCanonicalSource(state,parsed);assert(root);assert(Object.isFrozen(root));
    const expected=f.size(parsed);
    assert.deepEqual({nodes:root.nodes,text:root.text,encoded:root.encoded,sortWork:root.sortWork,sortBytes:root.sortBytes},expected);
    assert.equal(root.encoded,Buffer.byteLength(wire));assert.equal(root.byteStart,0);assert.equal(root.unitEnd,wire.length);
    const payload=m2OwnedCanonicalSource(state,parsed.payload);assert(payload);assert(Object.isFrozen(payload));
    const payloadExpected=f.size(parsed.payload);
    assert.deepEqual({nodes:payload.nodes,text:payload.text,encoded:payload.encoded,sortWork:payload.sortWork,sortBytes:payload.sortBytes},payloadExpected);
    const bytes=Buffer.from(wire).subarray(payload.byteStart,payload.byteStart+payload.encoded),text=wire.slice(payload.unitStart,payload.unitEnd);
    assert.equal(text,originCanonical(parsed.payload));assert.equal(bytes.toString('utf8'),text);
    assert.equal(sha(bytes),sha(text));assert.equal(payload.byteStart,Buffer.byteLength(wire.slice(0,payload.unitStart)));
    if(wire.startsWith('{"a":"é𐀀"'))assert(payload.byteStart>payload.unitStart);
    assert.equal(m2OwnedCanonicalSource(newP0State(),parsed),undefined);
    assert.equal(m2OwnedCanonicalSource(state,structuredClone(parsed)),undefined);
  }
});
test('source byte metadata is withheld for noncanonical text and non-ASCII key ordering',()=>{
  for(const value of [{payload:{'é':'value'}},{'𐀀':0,'\ue000':1,payload:[]}] as const){
    const state=newP0State(),parsed=scanM2OwnedCanonical(state,originCanonical(value),state.rootSite);
    assert.equal(m2OwnedCanonicalSource(state,parsed),undefined);
  }
  const state=newP0State(),parsed=scanM2OwnedHistory(state,' { "payload" : {"a":"\\u0061"} } ',state.rootSite) as Record<string,unknown>;
  assert.equal(m2OwnedCanonicalSource(state,parsed),undefined);assert.equal(m2OwnedCanonicalSource(state,parsed.payload),undefined);
});
