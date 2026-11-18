import assert from 'node:assert/strict';
import test from 'node:test';
import { planLinuxPartitions } from './linux-test-partitions.mjs';

const names = Array.from({ length: 64 }, (_, i) => `tests/file-${String(i).padStart(2, '0')}.test.ts`);

test('all discovered files, including nested and unmeasured additions, run exactly once', () => {
  const entries = [...names, 'tests/nested/new file.test.ts'];
  const plan = planLinuxPartitions(entries, { [names[0]]: 500_000, 'tests/deleted.test.ts': 900_000 });
  const selected = plan.flatMap(shard => shard.entries);
  assert.deepEqual(selected.toSorted(), entries.toSorted());
  assert.equal(new Set(selected).size, entries.length);
  assert.equal(plan.length, 16);
  assert.ok(plan.every(shard => shard.entries.length > 0));
});

test('the two measured slow files cannot exhaust one shard together', () => {
  // These actual failing-shard costs are scheduling inputs, never pass evidence.
  const weights = { [names[0]]: 564_083, [names[16]]: 542_703 };
  const plan = planLinuxPartitions(names, weights);
  const first = plan.findIndex(shard => shard.entries.includes(names[0]));
  const second = plan.findIndex(shard => shard.entries.includes(names[16]));
  assert.notEqual(first, second);
  assert.ok(Math.max(...plan.map(shard => shard.estimatedMs)) < 600_000);
});

test('discovery order and weight insertion order cannot change the assignment', () => {
  const weights = { [names[5]]: 100_000, [names[21]]: 100_000, [names[9]]: 12_000 };
  const a = planLinuxPartitions(names, weights);
  const b = planLinuxPartitions(names.toReversed(), Object.fromEntries(Object.entries(weights).reverse()));
  assert.deepEqual(a, b);
  assert.deepEqual(planLinuxPartitions(names, {}), planLinuxPartitions(names, {}));
});

test('bad or duplicate discovery and invalid scheduling costs fail closed', () => {
  for (const entries of [[], [names[0], names[0]], ['../outside.test.ts'], ['tests/../outside.test.ts'], ['tests/a.ts'], Array.from({ length: 1025 }, (_, i) => `tests/${i}.test.ts`)]) {
    assert.throws(() => planLinuxPartitions(entries, {}));
  }
  for (const cost of [0, -1, NaN, Infinity, '100', 1.5]) {
    assert.throws(() => planLinuxPartitions(names, { [names[0]]: cost }));
  }
});
