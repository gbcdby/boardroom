// The wrapper never narrows tests by names or outcomes. Node receives the exact
// nonempty shard selected from the original complete discovery set.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { linuxTestSelection, partitionIndex } from './linux-test-partitions.mjs';

assert.equal(process.argv.length, 3, 'one fixed partition is required');
const partition = process.argv[2];
partitionIndex(partition);
assert.equal(process.env.BOARDROOM_CI_TEST_PARTITION, partition, 'partition context mismatch');
const expected = linuxTestSelection(partition);
assert.ok(expected.selectedEntries.length > 0, 'empty partition must not run the default suite');
const recorded = JSON.parse(readFileSync('.agent-output/linux-ci-isolation/full-suite/test-scheduler.json', 'utf8'));
assert.equal(recorded.schema, 'boardroom-linux-test-discovery/v2');
assert.equal(recorded.candidate, process.env.GITHUB_SHA);
assert.equal(recorded.partition, partition);
assert.equal(recorded.configuredConcurrency, 1);
for (const key of ['entries', 'entriesSha256', 'selectedEntries', 'weightsSha256', 'planSha256', 'plan']) {
  assert.deepEqual(recorded[key], expected[key], `discovery changed before execution: ${key}`);
}
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...expected.selectedEntries], {
  stdio: 'inherit', env: process.env,
});
if (result.error) throw result.error;
// A killed runner must never become success through a null status.
process.exit(result.status ?? 1);
