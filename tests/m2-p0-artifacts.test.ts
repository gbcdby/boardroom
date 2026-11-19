import test from "node:test";
import assert from "node:assert/strict";
import { createP0Request } from "../src/server/identity/internal/m2-p0.ts";
import { checkP0Artifacts } from "../src/server/identity/internal/m2-p0-artifacts.ts";
import { p0Fixture } from "./helpers/m2-p0-a-fixture.ts";
import type { P0Request, P0View } from "../src/server/identity/internal/m2-p0.ts";
const admitted = (value = p0Fixture()) => { const r=createP0Request(JSON.stringify(value)); assert(r.ok); return r.value; };

test("F ART01: empty selections cannot satisfy the actual inline catalog root", () => {
  const request=admitted(), result=checkP0Artifacts(request,request.original);
  assert.equal(result.ok,false); if(!result.ok) assert.equal(result.error.code,"artifact_missing");
});
test("F ART01: hostile request/view identities are rejected with zero reflection", () => {
  const request=admitted(); let traps=0;
  const hostile=new Proxy({}, {get(){traps++;throw null;},getPrototypeOf(){traps++;throw null;},ownKeys(){traps++;throw null;}});
  assert.equal(checkP0Artifacts(hostile as P0Request,hostile as P0View).ok,false);
  assert.equal(checkP0Artifacts(request,hostile as P0View).ok,false);
  assert.equal(checkP0Artifacts(request,{phase:'retained-graph',rows:()=>[],rowCount:0} as unknown as P0View).ok,false);
  assert.equal(traps,0);
});
test("F ART01: unregistered selected kind cannot become an opaque unused leaf", () => {
  const input=p0Fixture(); input.artifacts.push({kind:'caller-kind',artifact:{ref:'caller',sha256:'a'.repeat(64),bytes:'0'},bytesHex:''});
  const request=admitted(input), result=checkP0Artifacts(request,request.original);
  assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'artifact_kind_unsupported');
});

import {p0ArtifactFixture} from './helpers/m2-p0-f-fixture.ts';
import {p0Usage,retainP0Rows} from '../src/server/identity/internal/m2-p0.ts';
import {P0_TABLE_NAMES} from '../src/server/identity/internal/m2-p0-types.ts';
import {canonicalJson} from '../src/server/storage/maintenance/canonical.ts';
import {fState} from '../src/server/identity/internal/m2-p0-artifacts-common.ts';
import {pgTimestampValue} from '../src/server/identity/internal/m2-p0-artifacts-md.ts';
const full=(input=p0ArtifactFixture())=>{const r=createP0Request(JSON.stringify(input));assert(r.ok,JSON.stringify(r));return r.value;};
test('F ART01: complete 61-table graph reaches all 74 selections in both authenticated passes',()=>{
  const r=full(),first=checkP0Artifacts(r,r.original);assert(first.ok,JSON.stringify(first));assert.equal(first.value.artifacts,74);assert.equal(first.value.evidence,2);
  const before=p0Usage(r),retained=retainP0Rows(r,P0_TABLE_NAMES.flatMap(t=>r.original.rows(t))),second=checkP0Artifacts(r,retained);
  assert(second.ok,JSON.stringify(second));assert.equal(second.value.originalHistoryDigest,first.value.originalHistoryDigest);assert(p0Usage(r).bytes>before.bytes);
});
test('F ART01: warmed immutable data cannot bypass the shared node budget or per-pass reference checks',t=>{
  const request=full(),f=fState(request);let selections=0;const original=f.select;
  t.mock.method(f,'select',function(this:typeof f,...args:Parameters<typeof original>){selections++;return original.apply(this,args);});
  assert(checkP0Artifacts(request,request.original).ok);const firstSelections=selections;
  const retained=retainP0Rows(request,P0_TABLE_NAMES.flatMap(name=>request.original.rows(name)));
  assert(checkP0Artifacts(request,retained).ok);assert.equal(selections,firstSelections*2);
  chargeP0(request,{nodes:250_000-p0Usage(request).nodes});const result=checkP0Artifacts(request,retained);
  assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'resource_limit');
});
for(const [label,kind,change] of [
  ['wrong column metadata','pc-column-contract',(v:any)=>{v.columns[0].nullable=!v.columns[0].nullable;}],
  ['wrong plan context','m2-physical-source',(v:any)=>{v.payload.controlRoot.inode='19';}],
  ['omitted bundle role','restore-bundle',(v:any)=>{v.entries.shift();}],
  ['extra published member','publication',(v:any)=>{v.observedOperations.push(v.observedOperations[0]);}],
  ['cross receipt verification','verification',(v:any)=>{v.bundle=v.publication;}],
  ['wrong receipt control digest','receipt',(v:any)=>{v.capturedControlManifestDigest='f'.repeat(64);}],
] as const)test(`F ART01: ${label} rejects with valid surrounding bytes`,()=>{
  const r=full(p0ArtifactFixture({change:(k,v)=>{if(k===kind)change(v);}}));assert.equal(checkP0Artifacts(r,r.original).ok,false);
});
test('F ART01: changed original G is not excused by a self-consistent old receipt',()=>{
  const input=p0ArtifactFixture(),table=input.graph.observation.tables.find(t=>t.name==='schema_migrations')!;
  table.rows[0]!.cells[3]=['text',Buffer.from('different exact applied_at').toString('hex')];const r=full(input);assert.equal(checkP0Artifacts(r,r.original).ok,false);
});
test('F ART01: selection omission and mismatched binary bytes are rejected',()=>{
  for(const mode of ['missing','bytes','kind'] as const){const input=p0ArtifactFixture(),index=input.artifacts.findIndex(a=>a.kind==='database-snapshot');
    if(mode==='missing')input.artifacts.splice(index,1);else if(mode==='kind')input.artifacts[index]!.kind='source-file-payload';else{const a=input.artifacts[index]!;a.bytesHex='00'+a.bytesHex.slice(2);}
    const r=full(input);assert.equal(checkP0Artifacts(r,r.original).ok,false);
  }
});
test('F ART01: duplicate evidence IDs are ambiguous even with different internal digests',()=>{
  const input=p0ArtifactFixture();input.evidence.push({...input.evidence[0]!,evidence:{...input.evidence[0]!.evidence,digest:'f'.repeat(64)}});
  const r=full(input),result=checkP0Artifacts(r,r.original);assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'artifact_semantic_mismatch');
});
test('F ART01: unused selected byte-valid artifact does not pass the closure ledger',()=>{
  const input=p0ArtifactFixture(),bytes=Buffer.from('{"unused":true}'),hash=(awaitlessHash(bytes));
  input.artifacts.push({kind:'pc-typed-row',artifact:{ref:`m2/sha256/${hash}/pc-typed-row.json`,sha256:hash,bytes:String(bytes.length)},bytesHex:bytes.toString('hex')});
  const r=full(input);assert.equal(checkP0Artifacts(r,r.original).ok,false);
});
import {createHash} from 'node:crypto';
const awaitlessHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
test('F S4 canonical: exact original UTF16 ordering, finite floats and escaped strings',()=>{
  const r=admitted(),f=fState(r);for(const v of [{ '\u{10000}':1.25,'\ue000':'x',c:'\ud800',a:['\n','\t',false,null]},[1e-7,-2.5e-8,9007199254740991]])assert.equal(f.canonical(v),canonicalJson(v));
});
test('F S4 shared encoding: byte counts, streaming digest and equality match the actual old canonical consumer',()=>{
  const f=fState(admitted()),values:unknown[]=[null,false,3,1.25,1e-7,'', '\0\n"\\\u{10000}\ud800é',
    {z:['é','\u{10000}',null],a:{'\ue000':-2.5e-8,'\u{10000}':'\udfff'}},[['same'],['same']]];
  for(const value of values){f.freeze(value);const exact=canonicalJson(value),encoding=f.encode(value);
    assert.equal(encoding.bytes,Buffer.byteLength(exact));assert.equal(f.encodedText(encoding),exact);
    assert.equal(f.digest(value),createHash('sha256').update(exact).digest('hex'));
    const clone:unknown=JSON.parse(exact);f.freeze(clone);assert.equal(f.equal(value,clone),true);
    assert.equal(f.copyEncoding(value,clone),true);assert.equal(f.equal(value,clone),true);
  }
  for(const a of values)for(const b of values)assert.equal(f.equal(a,b),canonicalJson(a)===canonicalJson(b));
  assert.equal(f.equal({a:1,b:['x']},{b:['x'],a:1}),true);
  const mutable={a:'before'};const before=f.digest(mutable);mutable.a='after';assert.notEqual(f.digest(mutable),before);
  assert.equal(f.equal({a:'1'},{a:1}),false);assert.equal(f.equal({a:null},{a:false}),false);
});
test('F MD02: exact microseconds, BC, infinity and range checks use integer arithmetic',()=>{
  const r=admitted(),f=fState(r);for(const [u,text] of [[0n,'2000-01-01 00:00:00+00'],[1n,'2000-01-01 00:00:00.000001+00'],[-1n,'1999-12-31 23:59:59.999999+00'],[Buffer.from('ff1fc63d1bb12000','hex').readBigInt64BE(),'0001-01-01 00:00:00+00 BC'],[9223372036854775807n,'infinity'],[-9223372036854775808n,'-infinity']] as const)assert.equal(pgTimestampValue(f,u),text);
  assert.throws(()=>pgTimestampValue(f,9223371331200000000n));
});

import {checkPgColumnMetadata} from '../src/server/identity/internal/m2-p0-artifacts-md.ts';
import {chargeP0} from '../src/server/identity/internal/m2-p0.ts';
test('F PG metadata: owner type/name mapping retains collation namespace in the same G descriptor',()=>{
  const f=fState(admitted());const pc={name:'name',declaredType:'text',nullable:false,defaultExpression:null,identity:null,generated:null,collation:'default'};
  const actual={table_name:'agents',name:'name',position:'1',type_oid:'25',type_modifier:-1,type:'text',not_null:true,default_expression:null,identity:'',generated:'',collation:'default',collation_schema:'pg_catalog'};
  checkPgColumnMetadata(f,actual,{...actual},pc,'agents',1,'25');
  assert.throws(()=>checkPgColumnMetadata(f,actual,actual,{...pc,collation:'pg_catalog.default'},'agents',1,'25'));
  assert.throws(()=>checkPgColumnMetadata(f,{...actual,collation_schema:'other'},actual,pc,'agents',1,'25'));
  assert.throws(()=>checkPgColumnMetadata(f,{...actual,collation_schema:undefined},{...actual,collation_schema:undefined},pc,'agents',1,'25'));
});
test('F ART01: canonical bytes reject BOM and rounded unsafe numeric lexemes before legacy decoding',()=>{
  for(const mode of ['bom','rounded'] as const){const r=full(p0ArtifactFixture({bytes:(kind,bytes)=>kind!=='verification'?bytes:mode==='bom'?Buffer.concat([Buffer.from([239,187,191]),bytes]):Buffer.from(bytes.toString().replace('1.25','9007199254740990.5'))}));assert.equal(checkP0Artifacts(r,r.original).ok,false);}
});
test('F ART01: nested artifact depth and absent byte budget fail before expensive consumers',t=>{
  const r=full(p0ArtifactFixture({change:(kind,v)=>{if(kind==='verification'){let value:unknown=null;for(let n=0;n<65;n++)value=[value];v.verificationTargetIdentity=value;}}}));
  const result=checkP0Artifacts(r,r.original);assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'resource_limit');
  const request=full();chargeP0(request,{bytes:67_108_864-p0Usage(request).bytes-32});let decoded=0;
  t.mock.method(TextDecoder.prototype,'decode',()=>{decoded++;throw new Error('must not decode');});
  assert.equal(checkP0Artifacts(request,request.original).ok,false);assert.equal(decoded,0);
});
test('F ART01: an unknown error from the real decoder path keeps fixed null metadata and no traps',t=>{
  const r=full();let traps=0;const hostile=new Proxy({}, {get(){traps++;throw null;},ownKeys(){traps++;throw null;},getPrototypeOf(){traps++;throw null;}});
  t.mock.method(TextDecoder.prototype,'decode',()=>{throw hostile;});const result=checkP0Artifacts(r,r.original);assert.equal(result.ok,false);
  if(!result.ok){assert.equal(result.error.code,'invalid_value');assert.equal(result.error.rule,null);assert.equal(result.error.location,null);}assert.equal(traps,0);
});

import {checkP0Keys,withP0Guard} from '../src/server/identity/internal/m2-p0.ts';
import {parseJournal} from '../src/server/storage/maintenance/parse.ts';
import {beginP0FArtifactPass,endP0FArtifactPass,p0FJournalSyntaxFrame,type P0FArtifactSyntaxFrame} from '../src/server/identity/internal/m2-p0-artifacts-frame.ts';

test('F ART01: real inner JSON and row decoders preserve unknown failures in original and retained passes',()=>{
  const input=p0ArtifactFixture({sourceClient:true}),wire=JSON.stringify(input),nativeParse=JSON.parse,nativeDecode=TextDecoder.prototype.decode;
  const capture=input.artifacts.filter(a=>a.kind==='journal').map(a=>nativeParse(Buffer.from(a.bytesHex,'hex').toString('utf8'))).find(r=>r.event==='capture');
  const row=capture.sourceClients.rows[0],hostBytes=Buffer.from(row.host_identity_json[1],'hex');
  const targets=[capture.controlProof.maintenanceInvariant.controlRootJson,capture.controlProof.maintenanceInvariant.mutexIdentityJson,
    ...['host_identity_json','process_identity_json','db_sessions_json'].map(key=>Buffer.from(row[key][1],'hex').toString('utf8'))];
  const request=()=>{const made=createP0Request(wire);assert(made.ok);assert(checkP0Keys(made.value,made.value.original).ok);return made.value;};
  const view=(r:P0Request,retained:boolean)=>{if(!retained)return r.original;assert(checkP0Artifacts(r,r.original).ok);
    const kept=retainP0Rows(r,P0_TABLE_NAMES.flatMap(t=>r.original.rows(t)));assert(checkP0Keys(r,kept).ok);return kept;};
  for(const retained of [false,true])for(const target of targets){
    const baseline=request(),baselineView=view(baseline,retained);let total=0;
    JSON.parse=function(text:string,reviver?:Parameters<typeof JSON.parse>[1]){if(text===target)total++;return nativeParse(text,reviver);};
    try{assert(checkP0Artifacts(baseline,baselineView).ok);}finally{JSON.parse=nativeParse;}
    assert(total>=2,'Both syntax preflight and the real old consumer must execute');
    for(const injectAt of new Set([2,total])){
      const r=request(),v=view(r,retained);let calls=0,injected=0,traps=0;
      const poison=new Proxy({}, {get(){traps++;throw 0;},has(){traps++;throw 0;},ownKeys(){traps++;throw 0;},getPrototypeOf(){traps++;throw 0;}});
      JSON.parse=function(text:string,reviver?:Parameters<typeof JSON.parse>[1]){if(text===target&&++calls===injectAt){injected++;throw poison;}return nativeParse(text,reviver);};
      let result;try{result=checkP0Artifacts(r,v);}finally{JSON.parse=nativeParse;}
      assert(!result.ok);assert.equal(result.error.code,'invalid_value');assert.equal(result.error.rule,null);assert.equal(result.error.location,null);
      assert.equal(injected,1);assert.equal(traps,0);
    }
  }
  for(const retained of [false,true]){
    const r=request(),v=view(r,retained);let calls=0,injected=0,traps=0;
    const poison=new Proxy({}, {get(){traps++;throw 0;},getPrototypeOf(){traps++;throw 0;},ownKeys(){traps++;throw 0;}});
    TextDecoder.prototype.decode=function(input?:Parameters<typeof nativeDecode>[0],options?:Parameters<typeof nativeDecode>[1]){
      if(input instanceof Uint8Array&&hostBytes.equals(input)&&++calls===2){injected++;throw poison;}
      return nativeDecode.call(this,input,options);
    };
    let result;try{result=checkP0Artifacts(r,v);}finally{TextDecoder.prototype.decode=nativeDecode;}
    assert(!result.ok);assert.equal(result.error.code,'invalid_value');assert.equal(result.error.rule,null);assert.equal(result.error.location,null);
    assert.equal(injected,1);assert.equal(traps,0);
  }
});

test('F ART01: private syntax identities reject copied, foreign and expired scopes before reflecting unknown values',()=>{
  const r=full(),f=fState(r);beginP0FArtifactPass(f,r.original);
  const selected=r.input.artifacts.find(a=>a.kind==='journal')!;
  const value=f.json(f.select(selected.artifact,'journal')) as object,frame=p0FJournalSyntaxFrame(f,value);
  assert.deepEqual(parseJournal(value,frame),parseJournal(value));
  const copied=withP0Guard(r,()=>parseJournal({...value},frame));assert(!copied.ok);assert.equal(copied.error.rule,null);
  endP0FArtifactPass(f);
  const stale=withP0Guard(r,()=>parseJournal(value,frame));assert(!stale.ok);assert.equal(stale.error.rule,null);
  let traps=0;const poison=new Proxy({}, {get(){traps++;throw 0;},getPrototypeOf(){traps++;throw 0;},ownKeys(){traps++;throw 0;}});
  const unknown=withP0Guard(r,()=>parseJournal(poison,poison as P0FArtifactSyntaxFrame));assert(!unknown.ok);assert.equal(unknown.error.rule,null);
  assert.throws(()=>beginP0FArtifactPass(poison as typeof f,r.original));assert.equal(traps,0);
  const other=full(),of=fState(other);beginP0FArtifactPass(of,other.original);
  const foreign=withP0Guard(other,()=>parseJournal(value,frame));assert(!foreign.ok);assert.equal(foreign.error.rule,null);endP0FArtifactPass(of);
});
