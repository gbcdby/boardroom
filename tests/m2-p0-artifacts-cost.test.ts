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
