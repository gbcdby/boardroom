import assert from 'node:assert/strict';
import test from 'node:test';
import { m2ClientFactsFixture } from './helpers/m2-client-facts-fixture.ts';
import { digestJson } from '../src/server/storage/maintenance/canonical.ts';

test('CF17 replays a nonempty P0/P1 roster and one actual value-level owner registration', async () => {
  const fixture = await m2ClientFactsFixture();
  const result = fixture.run();
  assert(result.ok, JSON.stringify(result));
  assert.equal(result.value.actorClientId, '新-owner');
  assert.equal(result.value.after.count, '3');
  assert.equal(result.value.registrations.size, 2);
  assert.deepEqual(result.value.after.rows, fixture.expectedAfter.rows);
});

test('CF17 preserves a previously verified P1 birth pair and immutable registration JSON',async t=>{
  await t.test('prior P1 registration remains valid while a new owner registers',async()=>{
    const fixture=await m2ClientFactsFixture({priorP1Birth:true}),result=fixture.run();
    assert(result.ok,JSON.stringify(result));
    const existing=result.value.registrations.get(Buffer.from('origin-coordinator').toString('hex'))!;
    assert.equal(existing.birthFormat?.protocolVersion,2);
    assert.equal(existing.birthFormat?.writerFormatDigest,fixture.parameters.currentFormat.writerFormatDigest);
    assert.equal(result.value.registrations.size,2);
  });
  const changes:Record<string,(value:any)=>void>={
    birthProtocol:value=>{value.writerFormat.protocolVersion=1;},
    birthDigest:value=>{value.writerFormat.writerFormatDigest='0'.repeat(64);},
    birthCreation:value=>{value.creation.ownerGeneration='999';},
    birthExtraField:value=>{value.rebound=true;},
  };
  for(const [name,change] of Object.entries(changes))await t.test(name,async()=>{
    const fixture=await m2ClientFactsFixture({priorP1Birth:true,mutate(label,value){
      if(label==='clientPriorP1Registration')change(value);
    }});
    const result=fixture.run();assert.equal(result.ok,false);
    if(!result.ok)assert.notEqual(result.error.code,'resource_limit');
  });
});

test('CF17 owner acquisition cannot increment G through an existing active actor observation',async()=>{
  const fixture=await m2ClientFactsFixture({existingActorObservation:true});
  const result=fixture.run();
  assert.equal(result.ok,false);
  if(!result.ok)assert.notEqual(result.error.code,'resource_limit');
});

test('CF01/02 preserves UTF-16 bytes and PG binary frames in its distinct original hash domain', async t => {
  const fixture=await m2ClientFactsFixture();
  for(const encoding of [{backend:'sqlite',name:'UTF-16le'},{backend:'sqlite',name:'UTF-16be'},{backend:'postgres',name:'UTF8'}] as const)
    await t.test(encoding.backend+':'+encoding.name,()=>{
      const result=fixture.frames(encoding);assert(result.ok,JSON.stringify(result));
      assert.equal(result.value.decoded[0]!.decoded.client_id,'historical-旧');
      assert.equal(result.value.decoded[1]!.protocol,2);
      assert(result.value.rows.every(row=>encoding.backend==='postgres'?row.rowid===null:row.rowid!==null));
      const table=fixture.parameters.before,source={...fixture.parameters.source,kind:encoding.backend};
      const expected=digestJson(['profile-source-clients-live-rows/r2',source,encoding,table.columnContract,
        table.columnContractValueDigest,String(result.value.rows.length),result.value.rows.map(row=>[row.rowid,row.cells])]);
      assert.equal(result.value.rowsDigest,expected);
      if(encoding.backend==='postgres'){
        assert(result.value.rows[0]!.cells.some(cell=>cell[0]==='pg-binary'));
        const projected=result.value.rows.map(row=>[row.rowid,row.cells.map(cell=>cell[0]==='pg-binary'&&cell[1]==='25'?['text',cell[2]]:cell)]);
        assert.notEqual(result.value.rowsDigest,digestJson(['profile-source-clients-live-rows/r2',source,encoding,
          table.columnContract,table.columnContractValueDigest,String(result.value.rows.length),projected]));
      }
    });
});

test('CF01 refuses wrong OID, signed rowid overflow, duplicate rowid and unsupported text decoding', async t=>{
  const fixture=await m2ClientFactsFixture();
  await t.test('OID',()=>assert.equal(fixture.frames({backend:'postgres',name:'UTF8'},table=>{
    table.rows[0]!.cells[4]=['pg-binary','20','0000000000000001'];
  }).ok,false));
  await t.test('PG rowid',()=>assert.equal(fixture.frames({backend:'postgres',name:'UTF8'},table=>{table.rows[0]!.rowid='1';}).ok,false));
  await t.test('overflow',()=>assert.equal(fixture.frames({backend:'sqlite',name:'UTF-16le'},table=>{table.rows[0]!.rowid='9223372036854775808';}).ok,false));
  await t.test('duplicate rowid',()=>assert.equal(fixture.frames({backend:'sqlite',name:'UTF-16be'},table=>{table.rows[0]!.rowid=table.rows[1]!.rowid;}).ok,false));
  await t.test('invalid UTF16',()=>assert.equal(fixture.frames({backend:'sqlite',name:'UTF-16le'},table=>{table.rows[0]!.cells[0]=['text','00d8'];}).ok,false));
  await t.test('unsupported PG encoding',()=>{
    const result=fixture.frames({backend:'postgres',name:'LATIN1'});assert.equal(result.ok,false);
    if(!result.ok)assert.equal(result.error.code,'semantic_unsupported');
  });
});

test('every one of a new owner\'s 17 cells is constrained independently',async t=>{
  for(let i=0;i<17;i++)await t.test(String(i),async()=>{
    const fixture=await m2ClientFactsFixture({mutate(label,value){
      if(label!=='clientDelta')return;
      const cell=value.changes[1].after.cells[i];
      value.changes[1].after.cells[i]=cell[0]==='integer'?['integer','999']:cell[0]==='null'?['text','78']:['text',Buffer.from('changed').toString('hex')];
    }});
    const result=fixture.run();assert.equal(result.ok,false);if(!result.ok)assert.notEqual(result.error.code,'resource_limit');
  });
});

test('CF03/05 refuses independent facts, identity, time, session and transition substitutions',async t=>{
  const changes:Record<string,(value:any)=>void>={
    beforeDigest:value=>{value.observation.beforeRowsDigest='0'.repeat(64);},
    afterDigest:value=>{value.afterRowsDigest='0'.repeat(64);},
    subject:value=>{value.observation.clients[0].subject=['text','78'];},
    actor:value=>{value.observation.actor.actorId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';},
    matchedProcess:value=>{value.observation.actor.processCheck.startTicksAfter='902';},
    exactISO:value=>{value.observation.observedAt='2026-11-19T00:01:00Z';},
    runtimeOmission:value=>{value.observation.runtime.runners=[];},
    ownerOmission:value=>{value.observation.runtime.owners=[];},
    sessionSource:value=>{value.observation.sessions.sourceFiles[0].inode='999';},
    sessionResourceKey:value=>{value.observation.sessions.ownedResources=[{key:'map:2:1:0:r--p',device:'1',inode:'2'}];},
    generation:value=>{value.context.toGeneration+=1;},
    epoch:value=>{value.context.epochAfter+=1;},
    receiptGeneration:value=>{value.context.receiptGeneration+=1;},
    swappedBeforeAfter:value=>{[value.before,value.after]=[value.after,value.before];},
    writerFormat:value=>{value.context.currentFormat.writerFormatDigest='0'.repeat(64);},
  };
  for(const [name,change] of Object.entries(changes))await t.test(name,async()=>{
    const fixture=await m2ClientFactsFixture({mutate(label,value){if(label==='clientFacts')change(value);}});
    const result=fixture.run();assert.equal(result.ok,false);if(!result.ok)assert.notEqual(result.error.code,'resource_limit');
  });
});

test('CF05 rejects no-op observations, deleting the old roster, actor reuse and two registrations',async t=>{
  await t.test('noop',async()=>{
    const f=await m2ClientFactsFixture({mutate(label,value){if(label==='clientDelta')value.changes[0].after=structuredClone(value.changes[0].before);}});
    assert.equal(f.run().ok,false);
  });
  await t.test('missing retained row',async()=>{
    const f=await m2ClientFactsFixture({mutate(label,value){if(label==='clientDelta')value.changes.shift();}});
    assert.equal(f.run().ok,false);
  });
  await t.test('previous actor',async()=>{
    const f=await m2ClientFactsFixture();const registration=f.parameters.knownRegistrations.values().next().value!;
    f.parameters.knownRegistrations.set('removed-registration',{...registration,actorId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'});
    assert.equal(f.run().ok,false);
  });
  await t.test('second registration',async()=>{
    const f=await m2ClientFactsFixture({mutate(label,value){if(label==='clientDelta')value.changes.push(structuredClone(value.changes[1]));}});
    assert.equal(f.run().ok,false);
  });
});

test('CF keeps the enclosing request budget when new or old refinements execute',async()=>{
  const fixture=await m2ClientFactsFixture();
  for(const dimension of ['work','bytes'] as const){const result=fixture.run(dimension);assert.equal(result.ok,false);
    if(!result.ok)assert.equal(result.error.code,'resource_limit');}
});

test('CF17 rejects a self-consistent after digest when a retained cell is changed', async () => {
  const fixture = await m2ClientFactsFixture({ mutate(label, value) {
    if (label === 'clientDelta') value.changes[0].after.cells[8] = ['integer', '99'];
  } });
  assert.equal(fixture.run().ok, false);
});

test('CF17 rejects stale runtime facts even when client hashes are exact', async () => {
  const fixture = await m2ClientFactsFixture({ mutate(label, value) {
    if (label === 'clientFacts') value.observation.runtime.runners[0].generation += 1;
  } });
  assert.equal(fixture.run().ok, false);
});

test('CF17 rejects rowid replacement, wrong original row digest and stale predecessor independently', async t => {
  for (const [name, mutate] of [
    ['rowid', (label: string, value: any) => { if (label === 'clientDelta') value.changes[0].after.rowid = '991'; }],
    ['row digest', (label: string, value: any) => { if (label === 'clientFacts') value.observation.clients[0].rowDigest = '0'.repeat(64); }],
    ['predecessor', (label: string, value: any) => { if (label === 'clientFacts') value.context.targetSequence += 1; }],
  ] as const) await t.test(name, async () => {
    const fixture = await m2ClientFactsFixture({ mutate });
    assert.equal(fixture.run().ok, false);
  });
});
