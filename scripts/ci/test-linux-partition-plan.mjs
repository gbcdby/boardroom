import assert from 'node:assert/strict';
import test from 'node:test';
import { linuxTestSelection, planLinuxPartitions } from './linux-test-partitions.mjs';

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

// Weights are a content-addressed sample: a tree hash has no meaningful partial
// distance, so the only safe threshold is zero drift from the validated candidate.
// run/attempt/url/candidate/tree are only the current-candidate anchor for this
// assertion; per-file durations come from multiple CI runs' execution reporter.
// Rebaseline all together when the test set changes.
const MEASURED_CANDIDATE = '10bca94fc25f7a7bff0b2b91ccae47acacc286b7';
const MEASURED_TREE = '85440a2d1631168a83378c55895733b73db8b856';
const FULL_SUITE_SECONDS = 1200; // linux_isolation.py; never widened by this guard.
const HEADROOM = 1.5;
const SPLIT_FILES = [
  'tests/00-maintenance-capture.test.ts',
  'tests/memory-replay-zcapture-postgres-basics.test.ts',
  'tests/memory-replay-zcapture-postgres-drift.test.ts',
  'tests/memory-replay-zcapture-postgres-failures.test.ts',
  'tests/zz-maintenance-service-postgres-cli.test.ts',
];

test('real plan stays inside the full-suite budget and weights match the current candidate', () => {
  const selection = linuxTestSelection('1/16');
  assert.equal(selection.estimatesSource.candidate, MEASURED_CANDIDATE, 'weights must be rebaselined on the current candidate');
  assert.equal(selection.estimatesSource.tree, MEASURED_TREE, 'weights tree drift invalidates current-candidate reconciliation');
  const selected = selection.plan.flatMap(shard => shard.entries);
  assert.deepEqual(selected.toSorted(), selection.entries.toSorted());
  assert.equal(new Set(selected).size, selection.entries.length);
  // 1200 / 1.5 = 800s (not 700s); 700s is reserved for the split files below.
  const budgetMs = FULL_SUITE_SECONDS / HEADROOM * 1000;
  assert.ok(Math.max(...selection.plan.map(shard => shard.estimatedMs)) <= budgetMs,
    `max shard estimate exceeds ${budgetMs / 1000}s budget`);
  for (const path of SPLIT_FILES) {
    const shard = selection.plan.find(entry => entry.entries.includes(path));
    assert.ok(shard, `${path} missing from real plan`);
    assert.ok(shard.estimatedMs < 700_000, `${path} shard exceeds 700s budget`);
  }
});
