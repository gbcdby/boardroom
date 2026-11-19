import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { createP0Request, chargeP0, p0Usage, withP0Guard } from '../src/server/identity/internal/m2-p0.ts';
import { fState } from '../src/server/identity/internal/m2-p0-artifacts-common.ts';
import { beginP0FArtifactPass, endP0FArtifactPass, p0FCodecSyntaxFrame, withP0FNativeConsumer,
  encodeP0FNativeShell,reserveP0FNativeClientEquality,bindP0FJournalContext,assertP0FJournalContext,releaseP0FJournalContext,reserveP0FJournalMetadata,type P0FArtifactSyntaxFrame } from '../src/server/identity/internal/m2-p0-artifacts-frame.ts';
import {runP0Journal,createP0FJournalContext} from '../src/server/identity/internal/m2-p0-artifacts-math.ts';
import {JOURNAL_VALUE_MATH} from '../src/server/storage/maintenance/journal-values.ts';
import type {JournalValueContext} from '../src/server/storage/maintenance/journal-values.ts';
import { canonicalJson,digestJson } from '../src/server/storage/maintenance/canonical.ts';
import { digestRowMultiset } from '../src/server/storage/maintenance/manifests.ts';
import type { Json } from '../src/server/storage/maintenance/types.ts';
import {sameSourceClientRow} from '../src/server/storage/maintenance/source-client-equality.ts';
import {sourceClientColumns} from '../src/server/storage/maintenance/source-clients-read.ts';
import {controlProofSchemaFor} from '../src/server/storage/maintenance/control-candidate/schema.ts';
import { parsePlan,parseManifests } from '../src/server/storage/maintenance/parse.ts';
import { controlVector } from './fixtures/maintenance-control-candidate.ts';
import { p0Fixture } from './helpers/m2-p0-a-fixture.ts';

function owned() {
  const made = createP0Request(JSON.stringify(p0Fixture())); assert(made.ok);
  const request = made.value, f = fState(request), plan = parsePlan(controlVector().plan);
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

test('F encoding scalar data: null and booleans use fixed tokens while numeric stringify remains prepaid',()=>{
  const a=owned(),stringify=JSON.stringify;let calls=0;
  try{
    chargeP0(a.request,{bytes:67_108_864-p0Usage(a.request).bytes});
    JSON.stringify=function(value:unknown,...rest:unknown[]){calls++;return Reflect.apply(stringify,JSON,[value,...rest]);} as typeof JSON.stringify;
    assert.equal(a.f.canonical(null),'null');assert.equal(a.f.canonical(true),'true');assert.equal(a.f.canonical(false),'false');assert.equal(calls,0);
    const rejected=withP0Guard(a.request,()=>a.f.canonical(1.25));
    assert(!rejected.ok);assert.equal(rejected.error.code,'resource_limit');assert.equal(calls,0);
  }finally{JSON.stringify=stringify;endP0FArtifactPass(a.f);}
});

test('F native fallback metadata: the four-key native object prepays all 21 explicit units',()=>{
  for(const left of [0,20,21]){
    const a=owned(),value={d:4,c:3,b:2,a:1};const keys=Object.keys;let produced=0;
    try{
      a.f.freeze(value);a.f.reserveCanonical(value); // cache only the cost data, never an encoding or semantic result
      chargeP0(a.request,{tuples:250_000-p0Usage(a.request).tuples-left});
      Object.keys=function(target:object){if(target===value)produced++;return keys(target);};
      const result=withP0Guard(a.request,()=>withP0FNativeConsumer(a.frame,()=>canonicalJson(value)));
      if(left<21){assert(!result.ok);assert.equal(result.error.code,'resource_limit');assert.equal(produced,0);}
      else{assert(result.ok);assert.equal(result.value,'{"a":1,"b":2,"c":3,"d":4}');assert.equal(produced,1);assert.equal(p0Usage(a.request).tuples,250_000);}
    }finally{Object.keys=keys;endP0FArtifactPass(a.f);}
  }
});

test('F native fallback sort preserves original UTF16 bytes without a native sort target',()=>{
  const a=owned(),prefix='common-'.repeat(200);
  const value=Object.fromEntries(['2','10','\ue000','\u{10000}','\ud800','\udc00',prefix+'z',prefix+'a','\0\t\n"\\'].map((key,i)=>[key,i]));
  const expected=canonicalJson(value),sort=Array.prototype.sort;
  try{
    Array.prototype.sort=function(){throw new Error('unexpected native sort in F fallback');};
    assert.equal(withP0FNativeConsumer(a.frame,()=>canonicalJson(value)),expected);
  }finally{Array.prototype.sort=sort;endP0FArtifactPass(a.f);}
});

test('F journal context is exact-pass bound, nested-request isolated, revoked explicitly, and never ambient',()=>{
  const a=owned(),b=owned(),root=controlVector().root;
  const ordinary:JournalValueContext={root:root.path,identity:root,math:JOURNAL_VALUE_MATH};
  const first=createP0FJournalContext(a.f,a.frame,root),second=createP0FJournalContext(b.f,b.frame,root);
  try{
    assert.throws(()=>createP0FJournalContext(a.f,b.frame,root));
    assert.throws(()=>bindP0FJournalContext(b.frame,first));
    assertP0FJournalContext(a.frame,first);assertP0FJournalContext(b.frame,second);
    assert.throws(()=>assertP0FJournalContext(b.frame,first));
    let beforeA=p0Usage(a.request),beforeB=p0Usage(b.request);
    reserveP0FJournalMetadata(first,7);assert.equal(p0Usage(a.request).tuples-beforeA.tuples,7);assert.deepEqual(p0Usage(b.request),beforeB);
    beforeA=p0Usage(a.request);reserveP0FJournalMetadata(second,5);assert.deepEqual(p0Usage(a.request),beforeA);assert.equal(p0Usage(b.request).tuples-beforeB.tuples,5);
    const marker={};assert.throws(()=>{try{reserveP0FJournalMetadata(second,1);throw marker;}finally{releaseP0FJournalContext(second);}},e=>e===marker);
    assert.throws(()=>reserveP0FJournalMetadata(second,1));assert.throws(()=>bindP0FJournalContext(b.frame,second));assertP0FJournalContext(a.frame,first);
    beforeA=p0Usage(a.request);beforeB=p0Usage(b.request);
    reserveP0FJournalMetadata(ordinary,1_000_000);parsePlan(a.plan);
    assert.deepEqual(p0Usage(a.request),beforeA);assert.deepEqual(p0Usage(b.request),beforeB);
    endP0FArtifactPass(a.f);assert.throws(()=>reserveP0FJournalMetadata(first,1));
  }finally{releaseP0FJournalContext(first);releaseP0FJournalContext(second);endP0FArtifactPass(a.f);endP0FArtifactPass(b.f);}
});

test('F journal binding refuses zero and one-short before publishing either actual index entry',()=>{
  for(const left of [0,1]){
    const a=owned(),root=controlVector().root,context=Object.freeze({root:root.path,identity:root,math:JOURNAL_VALUE_MATH});
    const set=WeakMap.prototype.set,add=WeakSet.prototype.add;let bindings=0;
    try{
      chargeP0(a.request,{tuples:250_000-p0Usage(a.request).tuples-left});
      WeakMap.prototype.set=function(key:object,value:unknown){if(key===context)bindings++;return set.call(this,key,value);};
      WeakSet.prototype.add=function(value:object){if(value===context)bindings++;return add.call(this,value);};
      const result=withP0Guard(a.request,()=>bindP0FJournalContext(a.frame,context));
      assert(!result.ok);assert.equal(result.error.code,'resource_limit');assert.equal(bindings,0);
    }finally{WeakMap.prototype.set=set;WeakSet.prototype.add=add;endP0FArtifactPass(a.f);}
  }
});

test('the closed journal driver revokes its real context on unknown throws without inspecting the error',()=>{
  const a=owned(),root=controlVector().root,freeze=Object.freeze,select=a.f.select;let context:JournalValueContext|undefined,traps=0;
  const unknown=new Proxy({}, {get(){traps++;throw null;},ownKeys(){traps++;throw null;},getPrototypeOf(){traps++;throw null;}});
  try{
    Object.freeze=function(value:unknown){if(value!==null&&typeof value==='object'&&Object.hasOwn(value,'math'))context=value as JournalValueContext;return freeze(value);} as typeof Object.freeze;
    a.f.select=()=>{throw unknown;};
    assert.throws(()=>runP0Journal(a.f,a.plan,root,{ref:'absent',sha256:'0'.repeat(64),bytes:'0'}),e=>e===unknown);
    a.f.select=select;Object.freeze=freeze;assert(context);assert.throws(()=>reserveP0FJournalMetadata(context!,1));assert.equal(traps,0);
    const after=p0Usage(a.request);parsePlan(a.plan);assert.deepEqual(p0Usage(a.request),after);
  }finally{a.f.select=select;Object.freeze=freeze;endP0FArtifactPass(a.f);}
});

function selectedSyntax(text:string) {
  const input=p0Fixture(),bytes=Buffer.from(text),sha256=createHash('sha256').update(bytes).digest('hex');
  const artifact={ref:`snapshots/${sha256}/verification.json`,sha256,bytes:String(bytes.length)};
  input.artifacts.push({kind:'verification',artifact,bytesHex:bytes.toString('hex')});
  const made=createP0Request(JSON.stringify(input));assert(made.ok);
  const request=made.value,f=fState(request);return {request,f,entry:f.select(artifact,'verification')};
}

test('F source strings: canonical Unicode and every escape are admitted without a speculative quoted copy',()=>{
  const values=['','plain','é','中','\u{10000}','\u{10ffff}','\u2028\u2029','"\\',
    '\0\b\t\n\f\r','\x01\x1f','\ud800','\udbff','\udc00','\udfff','\ud800x\udc00',
    'a'.repeat(65)+'"\n\u{1f642}','\ud800\ud800\udc00\udfff'];
  for(const value of values){
    const expected=canonicalJson({a:[value]}),a=selectedSyntax(expected),stringify=JSON.stringify;let quoted=0;
    try{
      JSON.stringify=function(item:unknown,...rest:unknown[]){if(typeof item==='string')quoted++;return Reflect.apply(stringify,JSON,[item,...rest]);} as typeof JSON.stringify;
      const decoded=a.f.json(a.entry);assert.deepEqual(decoded,{a:[value]});assert.equal(quoted,0);
      JSON.stringify=stringify;
      assert.equal(a.f.canonical(decoded),expected);assert.equal(a.f.digest(decoded),digestJson(decoded));
      assert.equal(a.f.digest(value),digestJson(value));assert.equal(a.f.canonical(value),canonicalJson(value));
    }finally{JSON.stringify=stringify;}
  }
});

test('F source strings: noncanonical equivalents and a late mismatch publish no source intervals',()=>{
  for(const text of ['"\\u00e9"','"\\/"','"\\uD800"','["\\u0000"] ','["\\ud800", "x"]']){
    const a=selectedSyntax(text),result=withP0Guard(a.request,()=>a.f.json(a.entry));
    assert(!result.ok);assert.equal(result.error.code,'artifact_semantic_mismatch');assert.equal(Object.hasOwn(a.entry,'parsed'),false);
    for(const encoded of a.f.strings.values())assert.equal(encoded.source,undefined);
  }
});

test('F string encoding: UTF8 production and deferred stringify each reject before an unpaid allocation',()=>{
  for(const value of ['é\u{10000}','"\n\ud800']){
    const flat=JSON.stringify(value),encodedBytes=Buffer.byteLength(flat),escaped=value.includes('"');
    const quoteCost=escaped?value.length*2+encodedBytes:0;
    const utf8Cost=escaped?flat.length*2+encodedBytes:value.length*2+encodedBytes-2;
    const fullCost=quoteCost+utf8Cost;
    const balances=escaped?[0,quoteCost-1,quoteCost,fullCost-1,fullCost]:[0,fullCost-1,fullCost];
    for(const left of balances){
      const a=owned(),encoded=a.f.encode(value),hash=createHash('sha256');let buffers=0,quotes=0;
      const from=Buffer.from,stringify=JSON.stringify;
      try{
        a.f.charge(1,encoded.bytes); // hashEncoding's caller owns the complete SHA input
        chargeP0(a.request,{bytes:67_108_864-p0Usage(a.request).bytes-left});
        Buffer.from=function(...args:Parameters<typeof Buffer.from>){buffers++;return Reflect.apply(from,Buffer,args);} as typeof Buffer.from;
        JSON.stringify=function(item:unknown,...rest:unknown[]){if(item===value)quotes++;return Reflect.apply(stringify,JSON,[item,...rest]);} as typeof JSON.stringify;
        const result=withP0Guard(a.request,()=>a.f.hashEncoding(hash,encoded));
        Buffer.from=from;JSON.stringify=stringify;
        if(left===fullCost){assert(result.ok);assert.equal(hash.digest('hex'),digestJson(value));assert.equal(buffers,1);assert.equal(p0Usage(a.request).bytes,67_108_864);}
        else{assert(!result.ok);assert.equal(result.error.code,'resource_limit');assert.equal(buffers,0);}
        assert.equal(quotes,escaped&&left>=quoteCost?1:0);
      }finally{Buffer.from=from;JSON.stringify=stringify;endP0FArtifactPass(a.f);}
    }
  }
});

test('F string encoding: raw and later quoted UTF8 caches are distinct and every actual SHA input is charged',()=>{
  const a=owned(),value='é\u{10000}',encoded=a.f.encode(value),from=Buffer.from;let buffers=0;
  try{
    Buffer.from=function(...args:Parameters<typeof Buffer.from>){buffers++;return Reflect.apply(from,Buffer,args);} as typeof Buffer.from;
    const first=p0Usage(a.request);
    for(let i=0;i<2;i++){a.f.charge(1,encoded.bytes);const hash=createHash('sha256');a.f.hashEncoding(hash,encoded);assert.equal(hash.digest('hex'),digestJson(value));}
    assert.equal(buffers,1);assert.equal(p0Usage(a.request).bytes-first.bytes,2*encoded.bytes+2*value.length+encoded.bytes-2);
    a.f.encodedText(encoded);a.f.charge(1,encoded.bytes);const hash=createHash('sha256');a.f.hashEncoding(hash,encoded);
    assert.equal(hash.digest('hex'),digestJson(value));assert.equal(buffers,2);
  }finally{Buffer.from=from;endP0FArtifactPass(a.f);}
});

function smallManifests(schema:unknown={text:'é\n\ud800',constructor:'own',toString:7}) {
  const hash='a'.repeat(64);
  return {formatVersion:1,kind:'database-manifests',dialect:'sqlite',schema,schemaManifestDigest:hash,
    tables:[{name:'t',columns:{column:'x'},count:'0',digest:hash}],controlRows:{storage_maintenance:[],storage_source_clients:[]},
    fullDataManifestDigest:hash,frozenBusinessManifestDigest:hash,capturedControlManifestDigest:hash};
}

test('F manifests: real strict parsing precedes exact immutable reuse and every normalization or ownership mismatch falls back',()=>{
  for(const schema of [{text:'é\n\ud800',constructor:'own',toString:7},JSON.parse('{"__proto__":{"nested":"x"}}'),JSON.parse('{"a":[{"__proto__":"x"}]}')]){
    const a=owned(),b=owned(),input=smallManifests(schema),native=parseManifests(input);
    try{
      a.f.freeze(input);a.f.encode(input);const frame=p0FCodecSyntaxFrame(a.f,input);
      const parsed=withP0FNativeConsumer(frame,()=>parseManifests(input));assert.deepEqual(parsed,native);
      if(Object.hasOwn(schema,'text'))assert.equal(parsed,input);else assert.notEqual(parsed,input);
      assert.notEqual(withP0FNativeConsumer(a.frame,()=>parseManifests(input)),input);
      assert.notEqual(withP0FNativeConsumer(b.frame,()=>parseManifests(input)),input);
      assert.notEqual(parseManifests(input),input);
      const invalid={...smallManifests(),formatVersion:2};a.f.freeze(invalid);a.f.encode(invalid);
      assert.throws(()=>withP0FNativeConsumer(p0FCodecSyntaxFrame(a.f,invalid),()=>parseManifests(invalid)));
      endP0FArtifactPass(a.f);assert.throws(()=>withP0FNativeConsumer(frame,()=>parseManifests(input)));
    }finally{endP0FArtifactPass(a.f);endP0FArtifactPass(b.f);}
  }
});

test('F schema configuration: complete dynamic factories reserve twelve units and zero or one-short cannot return a schema',()=>{
  for(const left of [0,11,12]){
    const a=owned();let completed=false;
    try{
      chargeP0(a.request,{tuples:250_000-p0Usage(a.request).tuples-left});
      const result=withP0Guard(a.request,()=>{const schema=controlProofSchemaFor(a.frame);completed=true;return schema;});
      if(left<12){assert(!result.ok);assert.equal(result.error.code,'resource_limit');assert.equal(completed,false);}
      else{assert(result.ok);assert.equal(completed,true);assert.equal(p0Usage(a.request).tuples,250_000);}
      const after=p0Usage(a.request);assert(controlProofSchemaFor());assert.deepEqual(p0Usage(a.request),after);
    }finally{endP0FArtifactPass(a.f);}
  }
});

test('F readonly native row equality: both inputs prepay actual own-key lists and descriptor bounds before native allocation',()=>{
  const legal=Object.fromEntries(sourceClientColumns.map(column=>[column.name,column.postgres==='25'?'text':column.name==='protocol_version'?'1':'0']));
  for(const row of [legal,{...legal,...Object.fromEntries(Array.from({length:17},(_,i)=>[`extra${i}`,'x']))}]){
    const keys=Object.keys(row).length,cost=2*(4+keys+(keys===16?16:0));
    for(const left of [0,cost-1,cost]){
      const a=owned(),ownKeys=Reflect.ownKeys,descriptor=Object.getOwnPropertyDescriptor;let lists=0,descriptors=0;
      try{
        chargeP0(a.request,{tuples:250_000-p0Usage(a.request).tuples-left});
        Reflect.ownKeys=function(target:object){if(target===row)lists++;return ownKeys(target);};
        Object.getOwnPropertyDescriptor=function(target:object,key:PropertyKey){if(target===row)descriptors++;return descriptor(target,key);};
        const result=withP0Guard(a.request,()=>withP0FNativeConsumer(a.frame,()=>{
          reserveP0FNativeClientEquality(row,row);return sameSourceClientRow(row,row);
        }));
        if(left<cost){assert(!result.ok);assert.equal(result.error.code,'resource_limit');assert.equal(lists,0);assert.equal(descriptors,0);}
        else{assert(result.ok);assert.equal(result.value,keys===16);assert.equal(lists,keys===16?2:1);assert.equal(descriptors,keys===16?32:0);assert.equal(p0Usage(a.request).tuples,250_000);}
      }finally{Reflect.ownKeys=ownKeys;Object.getOwnPropertyDescriptor=descriptor;endP0FArtifactPass(a.f);}
    }
  }
});
