#!/usr/bin/env python3
"""有限验证 macOS 原生分片的发现、失败传播与嵌套 runner 边界。"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class MacosPartitionContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        code = "import fs from 'node:fs';import YAML from 'yaml';console.log(JSON.stringify(YAML.parse(fs.readFileSync('.github/workflows/database-ci.yml','utf8'))))"
        cls.workflow = json.loads(subprocess.check_output(
            ['node', '--input-type=module', '-e', code], cwd=ROOT, text=True))
        cls.scripts = json.loads((ROOT / 'package.json').read_text())['scripts']
        cls.job = cls.workflow['jobs']['macos-partitions']
        cls.full = next(step for step in cls.job['steps'] if 'matrix.script' in step.get('run', ''))

    def test_fixed_jobs_keep_native_gates_default_concurrency_and_observation(self):
        self.assertEqual(self.job['runs-on'], 'macos-26')
        self.assertEqual(self.job['timeout-minutes'], 15)
        self.assertEqual(self.job['strategy'], {'fail-fast': False, 'matrix': {'include': [
            {'partition': f'{index}/8', 'script': f'test:ci:macos:{index}of8'}
            for index in range(1, 9)
        ]}})
        for index in range(1, 9):
            self.assertEqual(self.scripts[f'test:ci:macos:{index}of8'],
                             f'node --test --test-shard={index}/8 "tests/**/*.test.ts"')
        self.assertEqual(self.scripts['test'], 'node --test "tests/**/*.test.ts"')
        self.assertEqual(self.full['shell'], 'bash')
        self.assertEqual(self.full['env']['BOARDROOM_CI_TEST_PARTITION'], '${{ matrix.partition }}')
        self.assertEqual(self.full['run'], 'npm run ${{ matrix.script }} 2>&1 | tee .agent-output/macos-tests/full-suite.log')
        options = self.full['env']['NODE_OPTIONS']
        self.assertNotIn('--test-shard', options)
        self.assertNotIn('--test-concurrency', options)
        self.assertIn('--test-reporter=spec', options)
        self.assertIn('--test-reporter=${{ github.workspace }}/scripts/ci/test-execution-reporter.mjs', options)
        self.assertIn('--import=${{ github.workspace }}/scripts/ci/test-process-observer.mjs', options)
        self.assertNotIn('AGENT_STUDIO_PG_TEST_URL', self.job.get('env', {}))
        self.assertNotIn('AGENT_STUDIO_PG_TEST_URL', self.full['env'])
        runs = [step.get('run', '') for step in self.job['steps']]
        self.assertIn('node scripts/build-maintenance-platform.mjs --required', runs)
        self.assertIn('node --test --test-reporter=tap --test-timeout=60000 --test-concurrency=1 tests/maintenance-darwin.acceptance.ts 2>&1 | tee .agent-output/macos-tests/maintenance-native.log', runs)
        self.assertIn('node --test --test-reporter=tap --test-timeout=60000 --test-concurrency=1 tests/db-host-migration.test.ts tests/native-management-admission.test.ts tests/storage-source-client.test.ts tests/maintenance-platform.test.ts tests/maintenance-sqlite.test.ts tests/maintenance-objects.test.ts tests/maintenance-plan.test.ts 2>&1 | tee .agent-output/macos-tests/maintenance-regression.log', runs)
        environment = next(step for step in self.job['steps'] if 'environment.json' in step.get('run', ''))
        self.assertEqual(environment['env']['BOARDROOM_CI_TEST_PARTITION'], '${{ matrix.partition }}')
        self.assertIn('commit: process.env.GITHUB_SHA, partition: process.env.BOARDROOM_CI_TEST_PARTITION', environment['run'])
        artifact = next(step for step in self.job['steps'] if step.get('uses', '').startswith('actions/upload-artifact@'))
        self.assertEqual(artifact['if'], 'always()')
        self.assertEqual(artifact['with']['name'], 'macos-tests-${{ strategy.job-index }}-${{ github.run_attempt }}')
        self.assertEqual(artifact['with']['path'], '.agent-output/macos-tests/')

    def test_original_check_name_requires_every_partition_success(self):
        aggregate = self.workflow['jobs']['macos-tests']
        self.assertEqual(aggregate['name'], 'Node 24 · macOS arm64 / SQLite')
        self.assertEqual(aggregate['needs'], 'macos-partitions')
        self.assertIn('always()', aggregate['if'])
        self.assertIn('inputs.full_matrix', aggregate['if'])
        self.assertIn("contains(github.event.pull_request.labels.*.name, 'ci-full')", aggregate['if'])
        gate, = aggregate['steps']
        self.assertEqual(gate['env']['PARTITIONS_RESULT'], '${{ needs.macos-partitions.result }}')
        for result in ('success', 'failure', 'cancelled', 'skipped', '', 'unknown'):
            with self.subTest(result=result):
                actual = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', gate['run']],
                                        env=dict(os.environ, PARTITIONS_RESULT=result), timeout=5)
                self.assertEqual(actual.returncode == 0, result == 'success')

    def test_actual_eight_partitions_cover_once_keep_failure_and_do_not_shard_nested_runner(self):
        names = [f'tests/file-{index:02d}.test.ts' for index in range(16)] + ['tests/nested/a.test.ts', 'tests/nested/b.test.ts']
        selected, receipts = [], []
        with tempfile.TemporaryDirectory(prefix='boardroom-macos-partitions-') as directory:
            for row in self.job['strategy']['matrix']['include']:
                root = Path(directory) / row['partition'].replace('/', '-')
                (root / 'scripts/ci').mkdir(parents=True)
                (root / 'nested').mkdir()
                for name in ('test-process-observer.mjs', 'test-execution-reporter.mjs'):
                    shutil.copyfile(ROOT / 'scripts/ci' / name, root / 'scripts/ci' / name)
                for name in ('a', 'b'):
                    (root / 'nested' / f'{name}.test.mjs').write_text(
                        "import test from 'node:test';import {appendFileSync} from 'node:fs';"
                        f"test('{name}',()=>appendFileSync(process.env.BOARDROOM_NESTED_PROBE,'{name}\\n'));\n")
                for index, name in enumerate(names):
                    file = root / name
                    file.parent.mkdir(parents=True, exist_ok=True)
                    nested = ("assert.doesNotMatch(process.env.NODE_OPTIONS,/--test-(shard|concurrency)/);"
                              "const env={...process.env};delete env.NODE_TEST_CONTEXT;"
                              "execFileSync(process.execPath,['--test','nested/a.test.mjs','nested/b.test.mjs'],{env,stdio:'pipe'});") if index == 0 else ''
                    file.write_text("import test from 'node:test';import assert from 'node:assert/strict';"
                                    "import {appendFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';"
                                    f"test({json.dumps(name)},()=>{{appendFileSync(process.env.BOARDROOM_MACOS_PROBE,JSON.stringify({{entry:{json.dumps(name)},partition:process.env.BOARDROOM_CI_TEST_PARTITION}})+{json.dumps(chr(10))});"
                                    + nested + ("assert.fail('deliberate macOS partition failure');" if index == 1 else '') + "});\n")
                env = dict(os.environ, BOARDROOM_CI_TEST_PARTITION=row['partition'],
                           BOARDROOM_MACOS_PROBE=str(root / 'seen.txt'),
                           BOARDROOM_NESTED_PROBE=str(root / 'nested.txt'),
                           NODE_OPTIONS=self.full['env']['NODE_OPTIONS'].replace('${{ github.workspace }}', str(root)))
                env.pop('NODE_TEST_CONTEXT', None)
                command = self.scripts[row['script']]
                actual = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', command],
                                        cwd=root, env=env, text=True, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, timeout=30)
                observed = [json.loads(line) for line in (root / 'seen.txt').read_text().splitlines()]
                self.assertEqual({entry['partition'] for entry in observed}, {row['partition']})
                entries = [entry['entry'] for entry in observed]
                self.assertEqual(len(entries), len(set(entries)))
                partition_index = int(row['partition'].split('/')[0]) - 1
                self.assertEqual(set(entries), set(names[partition_index::8]))
                selected.append(set(entries))
                if row['partition'] == '1/8':
                    self.assertEqual(actual.returncode, 0, actual.stdout)
                    self.assertEqual(sorted((root / 'nested.txt').read_text().splitlines()), ['a', 'b'])
                elif row['partition'] == '2/8':
                    self.assertNotEqual(actual.returncode, 0)
                    self.assertIn('deliberate macOS partition failure', actual.stdout)
                    self.assertIn(names[1], entries)
                else:
                    self.assertEqual(actual.returncode, 0, actual.stdout)
                receipts.append({'partition': row['partition'], 'script': row['script'],
                                 'command': command, 'exit': actual.returncode, 'entries': sorted(entries)})
        for index, entries in enumerate(selected):
            for other in selected[index + 1:]:
                self.assertFalse(entries & other)
        self.assertEqual(set().union(*selected), set(names))
        self.assertEqual(sum(map(len, selected)), len(names))
        print(json.dumps({'proof': 'actual-eight-partitions-and-nested-runner', 'receipts': receipts}))


if __name__ == '__main__':
    unittest.main()
