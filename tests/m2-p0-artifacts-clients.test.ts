import test from 'node:test';
import assert from 'node:assert/strict';
import {createP0Request,chargeP0,p0Usage} from '../src/server/identity/internal/m2-p0.ts';
import {checkP0Artifacts} from '../src/server/identity/internal/m2-p0-artifacts.ts';
import {getP0OriginalClientClassifications} from '../src/server/identity/internal/m2-p0-artifacts-clients.ts';
import {canonicalJson} from '../src/server/storage/maintenance/canonical.ts';
import {p0ArtifactFixture} from './helpers/m2-p0-f-fixture.ts';
import {controlVector,currentClient,historicalClient} from './fixtures/maintenance-control-candidate.ts';
import type {SourceClientRawRow} from '../src/server/storage/maintenance/types.ts';

function admitted(input:ReturnType<typeof p0ArtifactFixture>){const result=createP0Request(JSON.stringify(input));assert(result.ok);return result.value;}
function checked(input:ReturnType<typeof p0ArtifactFixture>){const request=admitted(input),result=checkP0Artifacts(request,request.original);assert(result.ok,JSON.stringify(result));return request;}
function oldController(f:ReturnType<typeof controlVector>,change?:(profile:any)=>void){
  const old=historicalClient(f,'old-controller'),profile={formatVersion:1,kind:'maintenance-controller-registration',source:f.source,sourceIdentityDigest:f.source.identityDigest,
    creation:{migrationId:'older',plan:{ref:`plans/${'9'.repeat(64)}.json`,sha256:'9'.repeat(64),bytes:'13'},fenceEpoch:'1',ownerGeneration:'5',
      previousAnchor:{ref:`journals/older/1-${'8'.repeat(64)}.json`,sha256:'8'.repeat(64),bytes:'13'},targetSequence:'2'},
    sessionBinding:'per-source-lock-native-inventory-v1',drainReceipt:null};
  change?.(profile);
  const row:SourceClientRawRow={...old.row,entrypoint:f.text('maintenance-controller'),build_id:f.text('boardroom-maintenance-control-v1'),
    host_identity_json:f.text(canonicalJson(old.fact.host)),process_identity_json:f.text(canonicalJson(old.fact.process)),db_sessions_json:f.text(canonicalJson(profile)),
    registered_epoch:['integer','1'],observed_epoch:['integer','1'],ended_at:['null']};
  const fact={kind:'maintenance-controller',subject:row.client_id,rowDigest:f.rowDigest(row),host:old.fact.host,process:old.fact.process,processCheck:old.fact.processCheck,
    classification:'exited-actor',registration:'R0-historical'};
  return {row,fact};
}

test('F original cut data: v3 exact facts retain current/historical and controller classifications',()=>{
  for(const [client,expected] of [[historicalClient,'historical-client'],[(f:ReturnType<typeof controlVector>)=>currentClient(f,true),'current-client'],[oldController,'exited-actor']] as const){
    const input=p0ArtifactFixture({client}),request=admitted(input);assert.equal(getP0OriginalClientClassifications(request).ok,false);
    const original=checkP0Artifacts(request,request.original);assert(original.ok,JSON.stringify(original));
    const result=getP0OriginalClientClassifications(request);assert(result.ok,JSON.stringify(result));assert.equal(result.value.basis,'capture-facts-v3');assert.equal(result.value.clients[0]!.classification,expected);
    const receipt=input.artifacts.find(a=>a.kind==='receipt')!,body=JSON.parse(Buffer.from(receipt.bytesHex,'hex').toString('utf8'));
    assert.deepEqual(result.value.captureJournal,body.capture.journal);assert.deepEqual(result.value.source,body.capture.source);
    assert(Object.isFrozen(result.value)&&Object.isFrozen(result.value.clients)&&Object.isFrozen(result.value.clients[0]));
  }
});
test('F original cut data: v2 ordinary rule and historical controller profile remain distinct from native exit facts',()=>{
  for(const [client,expected] of [[historicalClient,'historical-client'],[(f:ReturnType<typeof controlVector>)=>currentClient(f,true),'current-client'],[oldController,'historical-profile'],
    [(f:ReturnType<typeof controlVector>)=>oldController(f,p=>{p.source={...p.source,identityDigest:'0'.repeat(64)};}),'unresolved-controller']] as const){
    const request=checked(p0ArtifactFixture({journalVersion:2,client})),result=getP0OriginalClientClassifications(request);
    assert(result.ok,JSON.stringify(result));assert.equal(result.value.basis,'legacy-v2-data');assert.equal(result.value.clients.length,1);assert.equal(result.value.clients[0]!.classification,expected);
  }
});
test('F original cut data: failed v3 proof cannot downgrade to the legacy profile path',()=>{
  const request=admitted(p0ArtifactFixture({client:f=>{const c=oldController(f);c.fact.classification='active-actor';return c;}}));
  assert.equal(checkP0Artifacts(request,request.original).ok,false);assert.equal(getP0OriginalClientClassifications(request).ok,false);
});
test('F original cut data: unknown decoder failures stay zero-reflection and resource exhaustion is not a profile status',t=>{
  const request=checked(p0ArtifactFixture({journalVersion:2,client:oldController}));let traps=0;
  const unknown=new Proxy({}, {get(){traps++;throw null;},getPrototypeOf(){traps++;throw null;},ownKeys(){traps++;throw null;}});
  const original=TextDecoder.prototype.decode;t.mock.method(TextDecoder.prototype,'decode',()=>{throw unknown;});
  const failed=getP0OriginalClientClassifications(request);assert(!failed.ok);assert.equal(failed.error.code,'invalid_value');assert.equal(traps,0);
  t.mock.method(TextDecoder.prototype,'decode',original);
  const recovered=getP0OriginalClientClassifications(request);assert(recovered.ok);assert.equal(recovered.value.clients[0]!.classification,'historical-profile');
  chargeP0(request,{nodes:250_000-p0Usage(request).nodes});const exhausted=getP0OriginalClientClassifications(request);assert(!exhausted.ok);assert.equal(exhausted.error.code,'resource_limit');
  assert.equal(canonicalJson({a:1}),'{"a":1}');
});
