// Scheduling estimates only. The original suite, time limits and failure gates
// decide success; a weight can neither select nor exclude a test file.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';

export const LINUX_PARTITIONS = 16;
export const TEST_GLOB = 'tests/**/*.test.ts';
const DEFAULT_MS = 1000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Node interprets every positional CLI argument as a glob, even when it was
// already discovered as a filename. Preserve the original full-glob runner for
// every shard if any filename needs literal semantics that argv cannot promise.
export const selectionMode = entries => entries.some(path => /[\\*?\[\]{}()!+@]/.test(path))
  ? 'native-glob' : 'cost-balanced';

export function partitionIndex(partition) {
  assert.equal(typeof partition, 'string', 'unknown fixed partition');
  assert.match(partition, /^(?:[1-9]|1[0-6])\/16$/, 'unknown fixed partition');
  return Number(partition.split('/')[0]) - 1;
}

export function planLinuxPartitions(entries, weights) {
  assert.ok(Array.isArray(entries) && entries.length > 0 && entries.length <= 1024,
    'test discovery must be nonempty and bounded');
  assert.equal(new Set(entries).size, entries.length, 'duplicate test entry');
  for (const path of entries) {
    assert.ok(typeof path === 'string' && path.startsWith('tests/') && path.endsWith('.test.ts') &&
      !path.includes('\0') && !path.split('/').some(part => part === '..' || part === '.' || part === ''),
    'test entry must stay in the original tests glob');
  }
  assert.ok(weights && typeof weights === 'object' && !Array.isArray(weights), 'invalid weights');
  for (const cost of Object.values(weights)) {
    assert.ok(Number.isSafeInteger(cost) && cost > 0 && cost <= 3_600_000, 'invalid scheduling cost');
  }
  const cost = path => Object.hasOwn(weights, path) ? weights[path] : DEFAULT_MS;
  const native = selectionMode(entries) === 'native-glob';
  const ordered = native ? entries.toSorted()
    : entries.toSorted((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: LINUX_PARTITIONS }, (_, index) => ({
    partition: `${index + 1}/${LINUX_PARTITIONS}`, entries: [], estimatedMs: 0,
  }));
  for (const [index, path] of ordered.entries()) {
    let target = native ? shards[index % LINUX_PARTITIONS] : shards[0];
    if (!native) for (const shard of shards) if (shard.estimatedMs < target.estimatedMs) target = shard;
    target.entries.push(path);
    target.estimatedMs += cost(path);
  }
  for (const shard of shards) shard.entries.sort();
  assert.deepEqual(shards.flatMap(shard => shard.entries).sort(), entries.toSorted(),
    'every discovered file must be assigned exactly once');
  return shards;
}

export function linuxTestSelection(partition) {
  const index = partition === '1/1' ? null : partitionIndex(partition);
  const entries = globSync(TEST_GLOB).sort();
  const rawWeights = readFileSync(new URL('./linux-test-weights.json', import.meta.url));
  const weights = JSON.parse(rawWeights);
  assert.equal(weights.schema, 'boardroom-linux-test-estimates/v1');
  const plan = planLinuxPartitions(entries, weights.durationMs);
  return { entries, entriesSha256: digest(entries), selectionMode: selectionMode(entries),
    selectedEntries: index === null ? entries : plan[index].entries,
    estimatedMs: index === null ? plan.reduce((total, shard) => total + shard.estimatedMs, 0) : plan[index].estimatedMs,
    weightsSha256: createHash('sha256').update(rawWeights).digest('hex'),
    estimatesSource: weights.source, planSha256: digest(plan), plan,
  };
}
