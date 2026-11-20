import assert from 'node:assert/strict';
import test from 'node:test';
import { createM2DurableRequest } from '../src/server/identity/internal/m2-p0-request.ts';
import { withP0Guard } from '../src/server/identity/internal/m2-p0-budget.ts';
import { M2Graph } from '../src/server/identity/internal/m2-durable-graph.ts';
import { m2OriginFixture } from './helpers/m2-origin-fixture.ts';

test('M2 graph verifies complete nonempty P1 column, table and history digests from selected bytes', async () => {
  const fixture = await m2OriginFixture();
  const admitted = createM2DurableRequest(fixture.durableWire);
  assert(admitted.ok, JSON.stringify(admitted));
  const result = withP0Guard(admitted.value, () => {
    const graph = new M2Graph(admitted.value);
    const proof = graph.payload(fixture.refs.proof!, 'm2-post-a-proof');
    const exact = graph.evidence(proof.exactAllowedDeltaCheck, 'm2-exact-delta-check');
    const history = graph.history(exact.after);
    return { tables: history.observation.tables.length, digest: history.completeHistoryDigest };
  });
  assert(result.ok, JSON.stringify(result));
  assert.equal(result.value.tables, 72);
  assert.equal(result.value.digest, fixture.preBSelection.completeHistoryDigest);
});
