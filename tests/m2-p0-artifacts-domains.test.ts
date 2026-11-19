import assert from 'node:assert/strict';
import test from 'node:test';
import { createP0Request, withP0Guard } from '../src/server/identity/internal/m2-p0.ts';
import { fState } from '../src/server/identity/internal/m2-p0-artifacts-common.ts';
import { beginP0FArtifactPass, endP0FArtifactPass } from '../src/server/identity/internal/m2-p0-artifacts-frame.ts';
import { physicalP0 } from '../src/server/identity/internal/m2-p0-artifacts-columns.ts';
import { compareP0Manifests } from '../src/server/identity/internal/m2-p0-artifacts-md.ts';
import { canonicalJson, digestJson, sha256 } from '../src/server/storage/maintenance/canonical.ts';
import { buildDatabaseManifests } from '../src/server/storage/maintenance/manifests.ts';
import type { Json } from '../src/server/storage/maintenance/types.ts';
import { p0Fixture } from './helpers/m2-p0-a-fixture.ts';
import { controlVector } from './fixtures/maintenance-control-candidate.ts';

const U64 = '18446744073709551615', U64_OVER = '18446744073709551616';
const U32 = '4294967295', U32_OVER = '4294967296';
function physicalComponent(request: ReturnType<typeof physicalRequest>) {
  const f = fState(request); beginP0FArtifactPass(f, request.original);
  try { return withP0Guard(request, () => physicalP0(f)); } finally { endP0FArtifactPass(f); }
}
type Backend = 'sqlite' | 'postgres';

/** An admitted, actual two-artifact physical/plan component. This is not a
 * complete ART01 graph or native qualification. The complete frozen graphs
 * are replayed separately by the repair evidence. No request/FState is forged. */
function physicalRequest(backend: Backend, identityPatch: Record<string, string> = {}, rootPatch: Record<string, string> = {}) {
  const seed = p0Fixture(backend), original = controlVector({backend});
  const sourceIdentity = {
    ...(original.sourceIdentity as Record<string, Json>),
    ...(backend === 'sqlite' ? {sourcePath: '/a12/source-alias.sqlite', sqlitePath: '/a12/source.sqlite'} : {}),
    ...identityPatch,
  };
  const source = {...original.source, identityDigest: digestJson(sourceIdentity)};
  const root = {...original.root, ...rootPatch};
  const plan = {...original.plan, source, sourceIdentity,
    controlRoot: {path: root.path, existingAncestor: {path: root.path, device: root.device, inode: root.inode}, absentSegments: []}};
  const pack = (kind: 'plan' | 'm2-physical-source', value: unknown) => {
    const bytes = Buffer.from(canonicalJson(value)), digest = sha256(bytes);
    return {kind, artifact: {ref: kind === 'plan' ? `plans/${digest}.json` : `m2/sha256/${digest}/${kind}.json`, sha256: digest, bytes: String(bytes.length)}, bytesHex: bytes.toString('hex')};
  };
  const selectedPlan = pack('plan', plan);
  const payload = {contract: 'm2-physical-source-observation/r1', source, sourceIdentity,
    observedAt: '2026-11-19T00:00:00.000Z', controlRoot: root, sourcePlan: selectedPlan.artifact};
  const selectedPhysical = pack('m2-physical-source', {formatVersion: 1, kind: 'm2-physical-source', payload});
  const physicalSourceRef = {artifactId: 'physical-component', digest: digestJson(payload)};
  const input = {...seed, graph: {...seed.graph, observation: {...seed.graph.observation, source, physicalSourceRef}},
    artifacts: [selectedPlan, selectedPhysical], evidence: [{kind: 'm2-physical-source', artifact: selectedPhysical.artifact, evidence: physicalSourceRef}]};
  const result = createP0Request(JSON.stringify(input));
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

const rangeCases = [
  {name: 'SQLite device', backend: 'sqlite', owner: 'source', field: 'device', valid: ['0', U64], invalid: [U64_OVER]},
  {name: 'SQLite inode', backend: 'sqlite', owner: 'source', field: 'inode', valid: ['1', U64], invalid: ['0', U64_OVER]},
  {name: 'PG systemIdentifier', backend: 'postgres', owner: 'source', field: 'systemIdentifier', valid: ['1', U64], invalid: ['0', U64_OVER]},
  {name: 'PG databaseOid', backend: 'postgres', owner: 'source', field: 'databaseOid', valid: ['1', U32], invalid: ['0', U32_OVER, U64]},
  {name: 'PG schemaOid', backend: 'postgres', owner: 'source', field: 'schemaOid', valid: ['1', U32], invalid: ['0', U32_OVER, U64]},
  ...(['sqlite', 'postgres'] as const).flatMap(backend => [
    {name: `${backend} controlRoot device`, backend, owner: 'root', field: 'device', valid: ['0', U64], invalid: [U64_OVER]},
    {name: `${backend} controlRoot inode`, backend, owner: 'root', field: 'inode', valid: ['1', U64], invalid: ['0', U64_OVER]},
  ]),
] as const;

for (const c of rangeCases) test(`F R06: exact ${c.name} domain preserves endpoints and rejects overflow`, () => {
  for (const [valid, values] of [[true, c.valid], [false, c.invalid]] as const) for (const value of values) {
    const patch = {[c.field]: value};
    const request = physicalRequest(c.backend as Backend, c.owner === 'source' ? patch : {}, c.owner === 'root' ? patch : {});
    // Repeated evaluation is real; cached parsed values cannot cache validity.
    for (let pass = 0; pass < 2; pass++) {
      const result = physicalComponent(request);
      assert.equal(result.ok, valid, `${c.name}=${value}, pass=${pass}: ${JSON.stringify(result)}`);
      if (result.ok) {
        const identity = result.value.plan.sourceIdentity as Record<string, Json>;
        assert.equal(c.owner === 'source' ? identity[c.field] : result.value.root[c.field as 'device' | 'inode'], value);
      } else {
        assert.equal(result.error.code, 'artifact_semantic_mismatch');
        assert.equal(result.error.rule, 'PC1B-ART01');
      }
    }
  }
});

test('F R06: canonical spelling and 20-character limit remain before integer conversion', () => {
  for (const value of ['', '00', '01', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '1'.repeat(21)]) {
    const request = physicalRequest('postgres', {systemIdentifier: value});
    const result = physicalComponent(request);
    assert.equal(result.ok, false, value);
    if (!result.ok) assert.equal(result.error.code, 'artifact_semantic_mismatch', value);
  }
});

test('F R06: source locator and physical SQLite path retain their distinct original values', () => {
  const request = physicalRequest('sqlite', {device: U64, inode: U64});
  const result = physicalComponent(request);
  assert(result.ok, JSON.stringify(result));
  const identity = result.value.plan.sourceIdentity as Record<string, Json>;
  assert.equal(identity.sourcePath, '/a12/source-alias.sqlite');
  assert.equal(identity.sqlitePath, '/a12/source.sqlite');
});

test('F MD02: existing PG owner shape and asserted profile strings cannot prove original output conditions', () => {
  const schemas: Json[] = [
    {profile: 'boardroom-pg16-closed-schema-v1', serverMajor: 16,
      environment: {database: [{encoding: 'UTF8'}], settings: [], extensions: []}},
    {profile: 'boardroom-pg16-closed-schema-v1', serverMajor: 16,
      environment: {database: [{encoding: 'UTF8'}], settings: [{scope: 'database-role', role: 'ALL', settings: ['TimeZone=Europe/Paris', 'DateStyle=SQL, DMY']}], extensions: []}},
    {profile: 'boardroom-pg16-closed-schema-v1', serverMajor: 16, typeProfile: [],
      environment: {database: [{encoding: 'UTF8'}], settings: [], extensions: []}},
    {profile: 'boardroom-pg16-closed-schema-v1', serverMajor: 16,
      environment: {database: [{encoding: 'UTF8'}], settings: [{scope: 'database-role', role: 'ALL', settings: ['TimeZone=UTC', 'DateStyle=ISO, YMD']}], extensions: []},
      // Not a new wire format: unowned extra declarations must not enable PG.
      session: {TimeZone: 'UTC', DateStyle: 'ISO, YMD'}, pg_time_t_bits: 64, builtinSendOutVerified: true},
  ];
  for (const schema of schemas) {
    const made = createP0Request(JSON.stringify(p0Fixture('postgres'))); assert(made.ok);
    const md = buildDatabaseManifests('postgres', schema, [], {storage_maintenance: [], storage_source_clients: []});
    const result = withP0Guard(made.value, () => compareP0Manifests(fState(made.value), md, []));
    assert.equal(result.ok, false);
    if (!result.ok) {assert.equal(result.error.code, 'semantic_unsupported'); assert.equal(result.error.rule, 'PC1B-ART01');}
  }
});
