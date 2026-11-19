import test from 'node:test';
import assert from 'node:assert/strict';
import { createP0Request, chargeP0, p0Usage, withP0Guard } from '../src/server/identity/internal/m2-p0.ts';
import { fState } from '../src/server/identity/internal/m2-p0-artifacts-common.ts';
import { beginP0FArtifactPass, endP0FArtifactPass, p0FCodecSyntaxFrame, withP0FNativeConsumer,
  encodeP0FNativeShell,type P0FArtifactSyntaxFrame } from '../src/server/identity/internal/m2-p0-artifacts-frame.ts';
import { canonicalJson,digestJson } from '../src/server/storage/maintenance/canonical.ts';
import { digestRowMultiset } from '../src/server/storage/maintenance/manifests.ts';
import type { Json } from '../src/server/storage/maintenance/types.ts';
import { parsePlan } from '../src/server/storage/maintenance/parse.ts';
import { controlVector } from './fixtures/maintenance-control-candidate.ts';
import { p0Fixture } from './helpers/m2-p0-a-fixture.ts';

function owned() {
  const made = createP0Request(JSON.stringify(p0Fixture())); assert(made.ok);
  const request = made.value, f = fState(request), plan = controlVector().plan;
  f.freeze(plan); beginP0FArtifactPass(f, request.original);
  return {request, f, plan, frame: p0FCodecSyntaxFrame(f, plan)};
}

test('F native cost: nested and throwing scopes restore the exact prior request without reflecting unknown failures', () => {
  const a = owned(), b = owned(); let traps = 0;
  const unknown = new Proxy({}, {get(){traps++;throw null;},ownKeys(){traps++;throw null;},getPrototypeOf(){traps++;throw null;}});
  try {
    assert.throws(() => withP0FNativeConsumer(unknown as P0FArtifactSyntaxFrame, () => assert.fail()), value => value !== undefined);
    withP0FNativeConsumer(a.frame, () => {
      const first = p0Usage(a.request); parsePlan(a.plan); assert(p0Usage(a.request).nodes > first.nodes);
      const aBeforeNested = p0Usage(a.request), bBeforeNested = p0Usage(b.request);
      assert.throws(() => withP0FNativeConsumer(b.frame, () => {parsePlan(b.plan); throw unknown;}), error => error === unknown);
      assert.deepEqual(p0Usage(a.request), aBeforeNested); assert(p0Usage(b.request).nodes > bBeforeNested.nodes);
      const bAfterNested = p0Usage(b.request); parsePlan(a.plan);
      assert(p0Usage(a.request).nodes > aBeforeNested.nodes); assert.deepEqual(p0Usage(b.request), bAfterNested);
    });
    const aDone = p0Usage(a.request), bDone = p0Usage(b.request);
    assert.equal(canonicalJson({a: [1, 'x']}), '{"a":[1,"x"]}'); parsePlan(a.plan);
    assert.deepEqual(p0Usage(a.request), aDone); assert.deepEqual(p0Usage(b.request), bDone);
    assert.equal(traps, 0);
  } finally { endP0FArtifactPass(a.f); endP0FArtifactPass(b.f); }
});

test('F native cost: a real codec cannot clone with zero nodes and a resource throw leaves ordinary consumers unaffected', () => {
  const a = owned();
  try {
    chargeP0(a.request, {nodes: 250_000 - p0Usage(a.request).nodes});
    const result = withP0Guard(a.request, () => withP0FNativeConsumer(a.frame, () => parsePlan(a.plan)));
    assert(!result.ok); assert.equal(result.error.code, 'resource_limit');
    const after = p0Usage(a.request); assert.equal(after.nodes, 250_000);
    assert.deepEqual(parsePlan(a.plan), a.plan); assert.deepEqual(p0Usage(a.request), after);
  } finally { endP0FArtifactPass(a.f); }
});

test('F native cost: recursive native canonical joins are reserved before materialization', () => {
  const a = owned(); let value: unknown = 'q'.repeat(40_000);
  for (let i = 0; i < 24; i++) value = {a: value, b: 0};
  const original = Array.prototype.join; let joins = 0;
  try {
    chargeP0(a.request, {bytes: 67_108_864 - p0Usage(a.request).bytes - 500_000});
    Array.prototype.join = function(this: unknown[], separator?: string) { joins++; return original.call(this, separator); };
    const result = withP0Guard(a.request, () => withP0FNativeConsumer(a.frame, () => canonicalJson(value)));
    assert(!result.ok); assert.equal(result.error.code, 'resource_limit'); assert.equal(joins, 0);
    Array.prototype.join = original;
    const after = p0Usage(a.request); assert.equal(canonicalJson(value).length, 40_002 + 24 * 12);
    assert.deepEqual(p0Usage(a.request), after);
  } finally { Array.prototype.join = original; endP0FArtifactPass(a.f); }
});

test('F native data: framed multiset and digest agree with the actual unframed native algorithms',()=>{
  const a=owned(),shared='same-prefix-'.repeat(300);
  const cases:Json[][]=[[],[[]],[['é','\ud800','\u{10000}','\ue000','\0\t\n"\\']],[['duplicate'],['duplicate'],['a'],['z']],
    [[shared+'b'],[shared+'a'],[shared],[]],[[1.25,1e-7,null,false],[-2.5e-8,9007199254740991,true]]];
  try{
    for(const rows of cases){
      const expected=digestRowMultiset(rows),expectedDigest=digestJson({a:rows});
      a.f.freeze(rows);
      withP0FNativeConsumer(a.frame,()=>{
        const projected=rows.map(row=>encodeP0FNativeShell([...(row as readonly Json[])]));
        assert.deepEqual(digestRowMultiset(projected),expected);
        assert.equal(digestJson(encodeP0FNativeShell({a:rows})),expectedDigest);
      });
    }
    const child={text:'before'},value={child};
    withP0FNativeConsumer(a.frame,()=>{
      encodeP0FNativeShell(value);assert.equal(Object.isFrozen(value),false);assert.equal(Object.isFrozen(child),false);
      const first=digestJson(value);child.text='after';assert.notEqual(digestJson(value),first);
    });
    const after=p0Usage(a.request);assert.deepEqual(digestRowMultiset([['x'],['x']]),digestRowMultiset([['x'],['x']]));assert.deepEqual(p0Usage(a.request),after);
  }finally{endP0FArtifactPass(a.f);}
});

test('F encoding metadata: a new eight-key list is refused before Object.keys at zero or one-short capacity',()=>{
  for(const left of [0,8]){
    const a=owned(),value={h:0,g:0,f:0,e:0,d:0,c:0,b:0,a:0};let calls=0;
    const original=Object.keys;
    try{
      // The empty key trie first creates eight exact edges (record/Map/binding).
      // Leave zero or eight units at the actual nine-unit key-list producer.
      chargeP0(a.request,{tuples:250_000-p0Usage(a.request).tuples-24-left});
      Object.keys=function(target:object){if(target===value)calls++;return original(target);};
      const result=withP0Guard(a.request,()=>a.f.encode(value));
      assert(!result.ok);assert.equal(result.error.code,'resource_limit');assert.equal(calls,0);
    }finally{Object.keys=original;endP0FArtifactPass(a.f);}
  }
});

test('F encoding metadata: every flatten reference is prepaid and insufficient capacity never reaches join',()=>{
  for(const left of [0,1,12]){
    const a=owned(),encoded=a.f.encode({a:1,b:2,c:3});let pushes=0,joins=0;
    const push=Array.prototype.push,join=Array.prototype.join;
    try{
      chargeP0(a.request,{tuples:250_000-p0Usage(a.request).tuples-left});
      Array.prototype.push=function(...values:unknown[]){if(values.length===1&&typeof values[0]==='string')pushes++;return push.apply(this,values);};
      Array.prototype.join=function(separator?:string){joins++;return join.call(this,separator);};
      const result=withP0Guard(a.request,()=>a.f.encodedText(encoded));
      assert(!result.ok);assert.equal(result.error.code,'resource_limit');
      assert.equal(pushes,Math.max(0,left-1));assert.equal(joins,0);assert.equal(encoded.flat,undefined);
    }finally{Array.prototype.push=push;Array.prototype.join=join;endP0FArtifactPass(a.f);}
  }
});

test('F encoding key data: exact key sequences share data while changed values and new keys are re-encoded',()=>{
  const a=owned(),first={z:1,a:'before'},second={z:2,a:'after'},extra={z:2,a:'after',b:true};
  const original=Object.keys;let secondLists=0,extraLists=0;
  try{
    assert.equal(a.f.canonical(first),canonicalJson(first));
    Object.keys=function(target:object){if(target===second)secondLists++;if(target===extra)extraLists++;return original(target);};
    assert.equal(a.f.canonical(second),'{"a":"after","z":2}');assert.equal(secondLists,0);
    assert.equal(a.f.canonical(extra),'{"a":"after","b":true,"z":2}');assert.equal(extraLists,1);
    second.a='changed';assert.equal(a.f.canonical(second),'{"a":"changed","z":2}');
    const rejected=withP0Guard(a.request,()=>a.f.canonical({z:Infinity,a:'after'}));
    assert(!rejected.ok);assert.equal(rejected.error.code,'artifact_semantic_mismatch');
  }finally{Object.keys=original;endP0FArtifactPass(a.f);}
});

test('F encoding key sort: in-place UTF16 order agrees with the old native algorithm without native sort',()=>{
  const a=owned(),prefix='shared-'.repeat(300);
  const value=Object.fromEntries(['2','10','\ue000','\u{10000}','\ud800','\udc00',prefix+'z',prefix+'a','\0\t\n"\\'].map((key,i)=>[key,i]));
  const expected=canonicalJson(value),sort=Array.prototype.sort;
  try{
    Array.prototype.sort=function(){throw new Error('unexpected native sort in private encoding');};
    assert.equal(a.f.canonical(value),expected);
  }finally{Array.prototype.sort=sort;endP0FArtifactPass(a.f);}
});

test('F encoding size data: a cached primitive needs no new tuple but an unseen primitive still reserves a record',()=>{
  const a=owned();a.f.encode('known scalar');a.f.encode(7);
  try{
    chargeP0(a.request,{tuples:250_000-p0Usage(a.request).tuples});
    assert.equal(a.f.size('known scalar').encoded,14);assert.equal(a.f.size(7).encoded,1);
    const rejected=withP0Guard(a.request,()=>a.f.size('unseen scalar'));
    assert(!rejected.ok);assert.equal(rejected.error.code,'resource_limit');
  }finally{endP0FArtifactPass(a.f);}
});
