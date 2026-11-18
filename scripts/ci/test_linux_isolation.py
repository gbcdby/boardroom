"""Launcher contracts using owned local fixtures; account/UID changes are hosted-only."""
import ast
import copy
import ctypes
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('linux_isolation', Path(__file__).with_name('linux_isolation.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class WholeSuiteBudgetContracts(unittest.TestCase):
    def configured(self, owner, entry):
        # Read the real invocation without creating accounts or launching a suite.
        source = ast.parse(Path(ci.__file__).read_text())
        function = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == owner)
        calls = [node for node in ast.walk(function) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Name) and node.func.id == 'run_command']
        self.assertEqual(len(calls), 1)
        values = dict(zip(('timeout', 'grace'), ci.run_command.__defaults__))
        for item in calls[0].keywords:
            if item.arg in values:
                values[item.arg] = eval(compile(ast.Expression(item.value), '<fixed-budget>', 'eval'),
                                        vars(ci), {'entry': entry, 'request': {'entry': entry}})
        return values

    def virtual_command(self, duration, budget, exit_code=0):
        clock, signals = [0.0], []
        child = SimpleNamespace(pid=24680, returncode=None)

        def poll():
            if child.returncode is None and clock[0] >= duration:
                child.returncode = exit_code
            return child.returncode

        def wait(timeout):
            if poll() is None:
                raise subprocess.TimeoutExpired('virtual-child', timeout)
            return child.returncode

        def signal_group(pid, number):
            self.assertEqual(pid, child.pid)
            signals.append(number)
            child.returncode = -number

        child.poll, child.wait = poll, wait
        with mock.patch.object(ci.subprocess, 'Popen', return_value=child), \
             mock.patch.object(ci.time, 'monotonic', side_effect=lambda: clock[0]), \
             mock.patch.object(ci.time, 'sleep', side_effect=lambda _: clock.__setitem__(0, clock[0] + 1)), \
             mock.patch.object(ci.signal, 'signal'), mock.patch.object(ci.os, 'killpg', side_effect=signal_group):
            result = ci.run_command(['virtual-child'], Path('/virtual'), {}, **budget)
        return result, signals

    def test_progressing_full_suite_can_finish_beyond_the_old_900_seconds(self):
        result, signals = self.virtual_command(1000, self.configured('supervise', 'full-suite'))
        self.assertFalse(result['timed_out'])
        self.assertEqual(result['returncode'], 0)
        self.assertTrue(result['reaped'])
        self.assertEqual(signals, [])

    def test_outer_allows_inner_deadline_preparation_and_original_failure_receipt(self):
        inner = self.configured('supervise', 'full-suite')
        outer = self.configured('frontend', 'full-suite')
        # 30s preparation + the whole inner budget/grace + 45s owned receipt/cleanup.
        result, signals = self.virtual_command(30 + inner['timeout'] + inner['grace'] + 45, outer, 124)
        self.assertFalse(result['timed_out'])
        self.assertEqual(result['returncode'], 124)
        self.assertTrue(result['reaped'])
        self.assertEqual(signals, [])

    def test_full_suite_exhaustion_remains_bounded_and_reaped(self):
        budget = self.configured('supervise', 'full-suite')
        result, signals = self.virtual_command(budget['timeout'] + 100, budget)
        self.assertTrue(result['timed_out'])
        self.assertEqual(result['returncode'], -signal.SIGTERM)
        self.assertTrue(result['reaped'])
        self.assertEqual(signals, [signal.SIGTERM])

    def test_other_entry_and_existing_reap_graces_are_unchanged(self):
        self.assertEqual(self.configured('supervise', 'sqlite'), {'timeout': 900, 'grace': 5})
        self.assertEqual(self.configured('frontend', 'sqlite'), {'timeout': 900, 'grace': 35})
        self.assertEqual(self.configured('supervise', 'full-suite')['grace'], 5)
        self.assertEqual(self.configured('frontend', 'full-suite')['grace'], 35)
        self.assertIn('timeout --signal=TERM --kill-after=10s 30s node', ci.command_for('sqlite'))

    def test_workflow_leaves_time_for_transport_and_post_suite_steps(self):
        import re
        workflow = (Path(ci.__file__).resolve().parents[2] / '.github/workflows/database-ci.yml').read_text()
        linux = workflow.split('  database-partitions:\n', 1)[1].split('\n  database-tests:', 1)[0]
        job_minutes = int(re.search(r'^    timeout-minutes: (\d+)$', linux, re.M).group(1))
        suite_step = linux.split('      - name: 全量测试（启用 PostgreSQL 门控用例）\n', 1)[1].split('\n      - name:', 1)[0]
        match = re.search(r'^        timeout-minutes: (\d+)$', suite_step, re.M)
        self.assertIsNotNone(match, 'The full-suite step needs its own bounded transport envelope')
        step_seconds = int(match.group(1)) * 60
        outer = self.configured('frontend', 'full-suite')
        # The unchanged runner can wait after TERM, after KILL, then in finally.
        # Existing source/dependency archive bounds are 30s/90s outside supervise.
        self.assertGreater(step_seconds, 30 + 90 + outer['timeout'] + 2 * outer['grace'] + 5)
        self.assertGreaterEqual(job_minutes * 60 - step_seconds, 600)
        self.assertIn('timeout-minutes: 15', workflow.split('  database-partitions:', 1)[0])
        self.assertIn('timeout-minutes: 15', workflow.split('  managed-web-browser:', 1)[1])

    def test_workflow_covers_actual_double_wait_and_finally_reap_paths(self):
        import re
        workflow = (Path(ci.__file__).resolve().parents[2] / '.github/workflows/database-ci.yml').read_text()
        suite_step = workflow.split('      - name: 全量测试（启用 PostgreSQL 门控用例）\n', 1)[1].split('\n      - name:', 1)[0]
        step_seconds = int(re.search(r'^        timeout-minutes: (\d+)$', suite_step, re.M).group(1)) * 60
        budget = self.configured('frontend', 'full-suite')
        for finally_reap in (False, True):
            with self.subTest(finally_reap=finally_reap):
                clock, signals, waits = [0.0], [], []
                child = SimpleNamespace(pid=24680, returncode=None)
                child.poll = lambda: child.returncode

                def wait(timeout):
                    waits.append(timeout)
                    if len(waits) == 1 or (len(waits) == 2 and finally_reap):
                        clock[0] += timeout
                        raise subprocess.TimeoutExpired('virtual-child', timeout)
                    clock[0] += 5 if finally_reap else 30
                    child.returncode = -signal.SIGKILL
                    return child.returncode

                def signal_group(pid, number):
                    self.assertEqual(pid, child.pid)
                    signals.append(number)

                child.wait = wait
                with mock.patch.object(ci.subprocess, 'Popen', return_value=child), \
                     mock.patch.object(ci.time, 'monotonic', side_effect=lambda: clock[0]), \
                     mock.patch.object(ci.time, 'sleep', side_effect=lambda _: clock.__setitem__(0, clock[0] + 1)), \
                     mock.patch.object(ci.signal, 'signal'), mock.patch.object(ci.os, 'killpg', side_effect=signal_group):
                    if finally_reap:
                        with self.assertRaises(subprocess.TimeoutExpired):
                            ci.run_command(['virtual-child'], Path('/virtual'), {}, **budget)
                    else:
                        result = ci.run_command(['virtual-child'], Path('/virtual'), {}, **budget)
                        self.assertTrue(result['timed_out'])
                        self.assertTrue(result['reaped'])
                        self.assertEqual(result['returncode'], -signal.SIGKILL)
                self.assertEqual(waits, [35, 35, 5] if finally_reap else [35, 35])
                self.assertEqual(signals, [signal.SIGTERM, signal.SIGKILL, signal.SIGKILL]
                                 if finally_reap else [signal.SIGTERM, signal.SIGKILL])
                self.assertEqual(clock[0], budget['timeout'] + (75 if finally_reap else 65))
                self.assertEqual(child.returncode, -signal.SIGKILL)
                self.assertGreater(step_seconds, 30 + 90 + clock[0])


class WholeSuitePartitionContracts(unittest.TestCase):
    root = Path(ci.__file__).resolve().parents[2]
    support_files = ('test-execution-reporter.mjs', 'test-process-observer.mjs', 'test-discovery.mjs',
                     'linux-test-partitions.mjs', 'linux-test-weights.json', 'run-linux-partition.mjs')

    def workflow(self):
        # Read the actual workflow through the already locked Node YAML parser.
        code = "import fs from 'node:fs';import YAML from 'yaml';console.log(JSON.stringify(YAML.parse(fs.readFileSync('.github/workflows/database-ci.yml','utf8'))))"
        result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=self.root,
                                capture_output=True, text=True, timeout=10, check=True)
        return json.loads(result.stdout)

    def test_all_balanced_partitions_cover_the_original_glob_once_and_keep_failure(self):
        import shlex
        import shutil
        package = json.loads((self.root / 'package.json').read_text())
        scripts = package['scripts']
        self.assertEqual(scripts['test'], 'node --test "tests/**/*.test.ts"')
        self.assertEqual(scripts['test:ci:linux'], 'node --test --test-concurrency=4 "tests/**/*.test.ts"')
        with tempfile.TemporaryDirectory(prefix='boardroom-partition-proof-') as directory:
            names = [f'tests/file-{i:02d}.test.ts' for i in range(48)] + ['tests/nested/a.test.ts', 'tests/nested/b.test.ts']
            selected, codes, receipts = [], [], []
            for index in range(1, 17):
                # Actual CI has a fresh workspace per partition. Preserve that
                # boundary without enlarging the passive observer's local limits.
                stage = Path(directory) / str(index)
                root = stage / ci.WORKSPACE
                root.mkdir(parents=True)
                observer = root / 'scripts/ci'
                observer.mkdir(parents=True)
                for filename in self.support_files:
                    shutil.copyfile(self.root / 'scripts/ci' / filename, observer / filename)
                for i, name in enumerate(names):
                    file = root / name
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_text("import test from 'node:test';import assert from 'node:assert/strict';import {appendFileSync} from 'node:fs';\n"
                        "import {setTimeout as delay} from 'node:timers/promises';\n"
                        f"const file={json.dumps(name)};const record=event=>appendFileSync(process.env.BOARDROOM_PARTITION_INTERVALS,"
                        "JSON.stringify({event,file,pid:process.pid,ns:String(process.hrtime.bigint())})+'\\n');\n"
                        "record('file-start');process.once('exit',()=>record('process-exit'));\n"
                        f"test({json.dumps(name)},async()=>{{appendFileSync(process.env.BOARDROOM_PARTITION_PROBE_FILE,{json.dumps(name + chr(10))});"
                        "await delay(60);"
                        + ("assert.fail('deliberate partition failure');" if i == 43 else "assert.ok(true);") + "});\n")
                script = scripts[f'test:ci:linux:{index}of16']
                self.assertEqual(script, f'node scripts/ci/run-linux-partition.mjs {index}/16')
                log = root / f'partition-{index}.txt'
                intervals = root / f'partition-{index}-intervals.jsonl'
                request = LauncherContracts().request('full-suite') | {'partition': f'{index}/16'}
                observation_env = ci.child_environment(request, stage)
                env = dict(os.environ, BOARDROOM_PARTITION_PROBE_FILE=str(log),
                           BOARDROOM_PARTITION_INTERVALS=str(intervals),
                           BOARDROOM_CI_TEST_PARTITION=observation_env['BOARDROOM_CI_TEST_PARTITION'],
                           GITHUB_SHA=request['head'], NODE_OPTIONS=observation_env['NODE_OPTIONS'])
                discovery = subprocess.run(['node', str(observer / 'test-discovery.mjs')], cwd=root, env=env,
                                           capture_output=True, text=True, timeout=10)
                self.assertEqual(discovery.returncode, 0, discovery.stderr)
                self.assertEqual(json.loads(discovery.stdout)['discovered'], len(names))
                result = subprocess.run(shlex.split(script), cwd=root, env=env,
                                        capture_output=True, text=True, timeout=30)
                self.assertIn(result.returncode, (0, 1), result.stderr)
                entries = log.read_text().splitlines()
                self.assertGreaterEqual(len(entries), 3, f'partition {index} needs multiple real files to check serialization')
                self.assertEqual(len(entries), len(set(entries)))
                # Observe actual test-file process intervals, not only a CLI flag.
                # An exit hook is not a kernel reap receipt; that stronger claim is out of scope.
                active, ended, maximum = set(), set(), 0
                events = [json.loads(line) for line in intervals.read_text().splitlines()]
                self.assertEqual(len(events), 2 * len(entries))
                for event in events:
                    self.assertIn(event['file'], entries)
                    self.assertGreater(event['pid'], 0)
                    if event['event'] == 'file-start':
                        self.assertNotIn(event['file'], active | ended)
                        active.add(event['file']); maximum = max(maximum, len(active))
                        self.assertEqual(len(active), 1, f'overlapping actual files in partition {index}: {events}')
                    else:
                        self.assertEqual(event['event'], 'process-exit')
                        self.assertIn(event['file'], active)
                        active.remove(event['file']); ended.add(event['file'])
                self.assertEqual(maximum, 1); self.assertEqual(active, set()); self.assertEqual(ended, set(entries))
                if result.returncode:
                    self.assertIn('deliberate partition failure', result.stdout)
                    self.assertIn(names[43], entries)
                else:
                    self.assertNotIn(names[43], entries)
                selected.append(set(entries)); codes.append(result.returncode)
                evidence = root / '.agent-output/linux-ci-isolation/full-suite'
                discovery = json.loads((evidence / 'test-scheduler.json').read_text())
                self.assertEqual(discovery['candidate'], 'a' * 40)
                self.assertEqual(discovery['partition'], f'{index}/16')
                self.assertEqual(discovery['configuredConcurrency'], 1)
                self.assertEqual(discovery['result'], 'NOT_RUN')
                self.assertEqual(discovery['entries'], sorted(names))
                self.assertEqual(discovery['selectedEntries'], sorted(entries))
                self.assertEqual(sorted(entry for shard in discovery['plan'] for entry in shard['entries']), sorted(names))
                manifests = [json.loads(p.read_text()) for p in (evidence / 'test-entrypoints').glob('slot-*/entrypoints.json')]
                self.assertEqual(len(manifests), 1)
                self.assertEqual(manifests[0]['partition'], f'{index}/16')
                self.assertEqual(manifests[0]['source'], 'node:fs.globSync')
                self.assertEqual(set(manifests[0]['entries']), set(names))
                observations = []
                for path in (evidence / 'test-processes').glob('slot-*/process.jsonl'):
                    observations += [json.loads(line) for line in path.read_text().splitlines()]
                ready = [event for event in observations if event['event'] == 'observer-ready']
                self.assertEqual({event['entryFile'] for event in ready}, set(entries))
                self.assertEqual(len(ready), len(entries))
                process_exits = [event for event in observations if event['event'] == 'process-exit']
                self.assertEqual(len(process_exits), len(entries))
                self.assertEqual(any(event['code'] != 0 for event in process_exits), names[43] in entries)
                reporters = list((evidence / 'test-execution').glob('slot-*/runner-*.jsonl'))
                self.assertEqual(len(reporters), 1)
                reporter_events = [json.loads(line) for line in reporters[0].read_text().splitlines()]
                self.assertEqual(reporter_events[0]['event'], 'reporter-ready')
                self.assertEqual(reporter_events[-1]['event'], 'reporter-end')
                self.assertTrue(reporter_events[-1]['sourceEnded'])
                receipts.append({'partition': f'{index}/16', 'command': script, 'exit': result.returncode,
                                 'entries': entries, 'maxActive': maximum, 'intervals': events})
            self.assertEqual(sorted(codes), [0] * 15 + [1])
            self.assertEqual(set.union(*selected), set(names))
            for left in range(16):
                for right in range(left + 1, 16):
                    self.assertFalse(selected[left] & selected[right])
            print(json.dumps({'proof': 'actual-balanced-sixteen-partitions', 'files': len(names), 'receipts': receipts}))

    def test_fixed_partition_input_and_nested_node_scope(self):
        for index in range(1, 17):
            partition = f'{index}/16'
            self.assertIn(f'npm run test:ci:linux:{index}of16 ', ci.command_for('full-suite', partition))
            request = LauncherContracts().request('full-suite') | {'partition': partition}
            env = ci.child_environment(request, Path('/owned/stage'))
            self.assertEqual(env['BOARDROOM_CI_TEST_PARTITION'], partition)
            self.assertEqual(env['AGENT_STUDIO_PG_TEST_URL'], ci.PG_URL)
            self.assertNotIn('--test-shard', env['NODE_OPTIONS'])
            self.assertNotIn('--test-concurrency', env['NODE_OPTIONS'])
        for invalid in ('', '0/16', '17/16', '01/16', '10/8', '1/1', '1/4', '1/8', '1/16 --test-name-pattern=skip', 1, {}, []):
            with self.subTest(partition=invalid):
                with self.assertRaises(ci.IsolationError):
                    ci.command_for('full-suite', invalid)
                with self.assertRaises(ci.IsolationError):
                    ci.child_environment(LauncherContracts().request('full-suite') | {'partition': invalid}, Path('/owned/stage'))
        with self.assertRaises(ci.IsolationError):
            ci.command_for('sqlite', '1/16')

    def test_discovery_reports_original_default_and_every_serial_partition(self):
        with tempfile.TemporaryDirectory(prefix='boardroom-discovery-context-') as directory:
            invalid = ('1/4', '1/8', '0/16', '17/16', '01/16', '10/8')
            for partition in (None, *(f'{index}/16' for index in range(1, 17)), *invalid):
                with self.subTest(partition=partition):
                    root = Path(directory) / (partition.replace('/', '-') if partition else 'default')
                    (root / 'tests').mkdir(parents=True)
                    (root / 'tests' / 'only.test.ts').write_text('// Discovery only; never executed.\n')
                    env = dict(os.environ, GITHUB_SHA='a' * 40)
                    env.pop('BOARDROOM_CI_TEST_PARTITION', None)
                    if partition is not None:
                        env['BOARDROOM_CI_TEST_PARTITION'] = partition
                    result = subprocess.run(['node', str(self.root / 'scripts/ci/test-discovery.mjs')], cwd=root,
                                            env=env, capture_output=True, text=True, timeout=10)
                    output = root / '.agent-output/linux-ci-isolation/full-suite/test-scheduler.json'
                    if partition in invalid:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('unknown fixed partition', result.stderr)
                        self.assertFalse(output.exists())
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        value = json.loads(output.read_text())
                        self.assertEqual(value['partition'], partition or '1/1')
                        self.assertEqual(value['configuredConcurrency'], 1 if partition else 4)
                        self.assertEqual(value['entries'], ['tests/only.test.ts'])
                        self.assertEqual(value['candidate'], 'a' * 40)
                        self.assertEqual(value['result'], 'NOT_RUN')

    def test_nested_node_receives_observation_without_inheriting_parent_scheduling(self):
        import shlex
        import shutil
        scripts = json.loads((self.root / 'package.json').read_text())['scripts']
        with tempfile.TemporaryDirectory(prefix='boardroom-nested-partition-') as directory:
            stage = Path(directory); root = stage / ci.WORKSPACE
            observer = root / 'scripts/ci'; observer.mkdir(parents=True)
            for filename in self.support_files:
                shutil.copyfile(self.root / 'scripts/ci' / filename, observer / filename)
            (root / 'tests').mkdir(); (root / 'nested').mkdir()
            for name in ('a', 'b'):
                (root / 'nested' / f'{name}.test.mjs').write_text("import test from 'node:test';import {appendFileSync} from 'node:fs';"
                    f"test('{name}',()=>appendFileSync(process.env.BOARDROOM_NESTED_PROBE,{json.dumps(name + chr(10))}));")
            (root / 'tests' / 'parent.test.ts').write_text("import test from 'node:test';import assert from 'node:assert/strict';"
                "import {execFileSync} from 'node:child_process';"
                "test('actual nested runner',()=>{assert.doesNotMatch(process.env.NODE_OPTIONS,/--test-(shard|concurrency)/);"
                "const env={...process.env};delete env.NODE_TEST_CONTEXT;"
                "const output=execFileSync(process.execPath,['--test','nested/a.test.mjs','nested/b.test.mjs'],{env,encoding:'utf8'});"
                "assert.match(output,/# pass 2/);});")
            request = LauncherContracts().request('full-suite') | {'partition': '1/16'}
            env = dict(os.environ, **ci.child_environment(request, stage), BOARDROOM_NESTED_PROBE=str(root / 'nested.txt'))
            # Keep the actual local Node binary while exercising the original child context values.
            env['PATH'] = os.environ['PATH']
            subprocess.run(['node', str(observer / 'test-discovery.mjs')], cwd=root, env=env,
                           capture_output=True, text=True, timeout=10, check=True)
            result = subprocess.run(shlex.split(scripts['test:ci:linux:1of16']), cwd=root, env=env,
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(sorted((root / 'nested.txt').read_text().splitlines()), ['a', 'b'])

    def test_partition_runner_rejects_missing_changed_or_empty_selection_without_running_tests(self):
        import shutil
        with tempfile.TemporaryDirectory(prefix='boardroom-partition-rejection-') as directory:
            for scenario in ('missing', 'added-file', 'omitted-file', 'weights', 'candidate', 'partition', 'empty'):
                with self.subTest(scenario=scenario):
                    root = Path(directory) / scenario
                    support = root / 'scripts/ci'; support.mkdir(parents=True)
                    for filename in self.support_files:
                        shutil.copyfile(self.root / 'scripts/ci' / filename, support / filename)
                    (root / 'tests').mkdir()
                    marker = root / 'executed.txt'
                    fixture = "import {writeFileSync} from 'node:fs';writeFileSync('executed.txt','ran');"
                    (root / 'tests/one.test.ts').write_text(fixture)
                    partition = '2/16' if scenario == 'empty' else '1/16'
                    env = dict(os.environ, GITHUB_SHA='a' * 40, BOARDROOM_CI_TEST_PARTITION=partition)
                    if scenario != 'missing':
                        subprocess.run(['node', 'scripts/ci/test-discovery.mjs'], cwd=root, env=env,
                                       capture_output=True, text=True, timeout=10, check=True)
                    record = root / '.agent-output/linux-ci-isolation/full-suite/test-scheduler.json'
                    if scenario == 'added-file':
                        (root / 'tests/new.test.ts').write_text(fixture)
                    elif scenario in ('omitted-file', 'candidate'):
                        value = json.loads(record.read_text())
                        value['selectedEntries' if scenario == 'omitted-file' else 'candidate'] = [] if scenario == 'omitted-file' else 'b' * 40
                        record.write_text(json.dumps(value))
                    elif scenario == 'weights':
                        value = json.loads((support / 'linux-test-weights.json').read_text())
                        value['durationMs']['tests/one.test.ts'] = 2
                        (support / 'linux-test-weights.json').write_text(json.dumps(value))
                    elif scenario == 'partition':
                        env['BOARDROOM_CI_TEST_PARTITION'] = '2/16'
                    result = subprocess.run(['node', 'scripts/ci/run-linux-partition.mjs', partition], cwd=root, env=env,
                                            capture_output=True, text=True, timeout=10)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(marker.exists(), 'invalid selection must fail before Node runs tests')

    def test_hosted_frontend_accepts_only_the_actual_partition_job(self):
        workflow = self.workflow()
        executor = next(name for name, job in workflow['jobs'].items()
                        if any(step.get('run') == 'python3 scripts/ci/linux_isolation.py full-suite'
                               for step in job.get('steps', [])))
        with tempfile.TemporaryDirectory(prefix='boardroom-partition-context-') as directory:
            root = Path(directory).resolve()
            source, temporary = root / 'source', root / 'runner-temp'
            source.mkdir()
            temporary.mkdir()
            env = {'GITHUB_ACTIONS': 'true', 'GITHUB_JOB': executor,
                   'GITHUB_RUN_ID': '42', 'GITHUB_RUN_ATTEMPT': '3',
                   'GITHUB_WORKSPACE': str(source), 'RUNNER_TEMP': str(temporary)}
            # Only identity inputs are simulated. The real hosted_context and
            # path validation execute without accounts, sudo, or test children.
            with mock.patch.dict(ci.os.environ, env, clear=True), \
                 mock.patch.object(ci.sys, 'platform', 'linux'), \
                 mock.patch.object(ci.os, 'getuid', return_value=1001):
                self.assertEqual(ci.hosted_context(), (source, temporary, '42', '3'))
                for job in ('database-tests', 'managed-web-browser', '', 'database-partitions-other'):
                    with self.subTest(job=job), mock.patch.dict(ci.os.environ, {'GITHUB_JOB': job}):
                        with self.assertRaises(ci.IsolationError):
                            ci.hosted_context()
                with mock.patch.object(ci.os, 'getuid', return_value=0):
                    with self.assertRaises(ci.IsolationError):
                        ci.hosted_context()
                with mock.patch.dict(ci.os.environ, {'GITHUB_ACTIONS': 'false'}):
                    with self.assertRaises(ci.IsolationError):
                        ci.hosted_context()

    def test_workflow_requires_every_partition_and_keeps_all_later_gates(self):
        workflow = self.workflow()
        partitions = workflow['jobs']['database-partitions']
        aggregate = workflow['jobs']['database-tests']
        self.assertEqual(partitions['strategy'], {'fail-fast': False, 'matrix': {'partition': [f'{index}/16' for index in range(1, 17)]}})
        self.assertEqual(aggregate['name'], 'Node 24 · SQLite / PostgreSQL')
        self.assertEqual(aggregate['needs'], 'database-partitions')
        self.assertEqual(aggregate['if'], '${{ always() }}')
        gate = aggregate['steps'][0]
        self.assertEqual(gate['env']['PARTITIONS_RESULT'], '${{ needs.database-partitions.result }}')
        for state in ('success', 'failure', 'cancelled', 'skipped', ''):
            result = subprocess.run(['/bin/bash', '-e', '-c', gate['run']],
                                    env={'PARTITIONS_RESULT': state, 'PATH': '/usr/bin:/bin'}, timeout=5)
            self.assertEqual(result.returncode == 0, state == 'success')
        full = next(step for step in partitions['steps'] if step.get('run') == 'python3 scripts/ci/linux_isolation.py full-suite')
        self.assertEqual(full['env']['BOARDROOM_CI_TEST_PARTITION'], '${{ matrix.partition }}')
        self.assertEqual(full['env']['AGENT_STUDIO_PG_TEST_URL'], ci.PG_URL)
        runs = [step.get('run', '') for step in partitions['steps']]
        for command in ('npm run e2e', 'npm run e2e:tasks', 'npm run e2e:memory', 'node scripts/e2e-install.mjs'):
            self.assertEqual(runs.count(command), 2, command)
        self.assertTrue(any('tests/maintenance-postgres-restart.test.ts' in run for run in runs))
        self.assertIn('node --test --test-concurrency=1 tests/lifecycle-load.acceptance.ts', runs)
        self.assertEqual(next(step for step in partitions['steps'] if step.get('run') == 'python3 scripts/ci/linux_isolation.py cleanup')['if'], 'always()')
        for step in partitions['steps']:
            if step.get('uses', '').startswith('actions/upload-artifact@'):
                self.assertIn('${{ strategy.job-index }}', step['with']['name'])


class LauncherContracts(unittest.TestCase):
    def request(self, entry='sqlite'):
        return {'entry': entry, 'node_dir': '/opt/node/bin', 'head': 'a' * 40,
                'tree': 'b' * 40, 'run_id': '42', 'attempt': '3',
                'pg_url': ci.PG_URL if entry == 'full-suite' else None}

    def test_original_commands_and_explicit_pg_scope(self):
        self.assertEqual(ci.command_for('sqlite'),
            "mkdir -p .agent-output/maintenance-native-diagnostics\n"
            "timeout --signal=TERM --kill-after=10s 30s node --test --test-reporter=tap "
            "--test-name-pattern='unknown source file users' tests/maintenance-sqlite.test.ts "
            "2>&1 | tee .agent-output/maintenance-native-diagnostics/sqlite-source-users.tap")
        self.assertEqual(ci.command_for('full-suite'),
            "mkdir -p .agent-output/linux-ci-isolation/full-suite\n"
            "node scripts/ci/test-discovery.mjs\n"
            "npm run test:ci:linux 2>&1 | tee .agent-output/linux-ci-isolation/full-suite/full-suite.tap")
        package = json.loads((Path(ci.__file__).resolve().parents[2] / 'package.json').read_text())
        self.assertEqual(package['scripts']['test'], 'node --test "tests/**/*.test.ts"')
        self.assertEqual(package['scripts']['test:ci:linux'],
                         'node --test --test-concurrency=4 "tests/**/*.test.ts"')
        for entry in ('sqlite', 'full-suite'):
            env = ci.child_environment(self.request(entry), Path('/owned/stage'))
            self.assertEqual(env['GITHUB_WORKSPACE'], '/owned/stage/work/workspace')
            self.assertEqual(env['HOME'], '/owned/stage/home')
            self.assertEqual(env['TMPDIR'], '/owned/stage/tmp')
            self.assertEqual(env['npm_config_cache'], '/owned/stage/npm-cache')
            self.assertNotIn('GITHUB_TOKEN', env)
            self.assertNotIn('RUNNER_TRACKING_ID', env)
            self.assertNotIn('AGENT_STUDIO_PG_RESTART_BIN', env)
            self.assertEqual(env.get('AGENT_STUDIO_PG_TEST_URL'), ci.PG_URL if entry == 'full-suite' else None)
            # The scheduling flag belongs to the original CLI only, not every
            # ordinary Node child or nested test runner via inherited NODE_OPTIONS.
            if entry == 'full-suite':
                self.assertIn('--test-reporter=tap --test-reporter-destination=stdout', env['NODE_OPTIONS'])
                self.assertIn('--test-reporter=/owned/stage/work/workspace/scripts/ci/test-execution-reporter.mjs', env['NODE_OPTIONS'])
                self.assertIn('--import=/owned/stage/work/workspace/scripts/ci/test-process-observer.mjs', env['NODE_OPTIONS'])
                self.assertNotIn('--test-shard', env['NODE_OPTIONS'])
                self.assertNotIn('--test-concurrency', env['NODE_OPTIONS'])
            else:
                self.assertNotIn('NODE_OPTIONS', env)
            self.assertNotIn('BOARDROOM_CI_TEST_PARTITION', env)

    def test_identity_requires_actual_nonroot_caps_groups_and_namespace(self):
        value = {'uid': [42001] * 4, 'gid': [42001] * 4, 'groups': [], 'no_new_privs': 1,
                 'capabilities': {name: '0000000000000000' for name in ci.CAP_FIELDS},
                 'pid_namespace': 'pid:[123]', 'pid': 1234}
        ci.assert_identity(value, 42001, 42001, 'pid:[123]')
        for name, changed in [('uid', [0] * 4), ('gid', [42001, 0, 0, 0]),
                              ('groups', [42001]), ('no_new_privs', 0), ('pid_namespace', 'pid:[456]')]:
            bad = copy.deepcopy(value)
            bad[name] = changed
            with self.assertRaises(ci.IsolationError, msg=name):
                ci.assert_identity(bad, 42001, 42001, 'pid:[123]')
        bad = copy.deepcopy(value)
        bad['capabilities']['CapBnd'] = '0000000000000001'
        with self.assertRaises(ci.IsolationError):
            ci.assert_identity(bad, 42001, 42001, 'pid:[123]')

    def test_original_failure_survives_pipeline_and_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            result = ci.run_command(['/bin/bash', '-e', '-o', 'pipefail', '-c',
                                     "(printf 'failure evidence\\n'; exit 37) | tee output.log"],
                                    Path(temp), {'PATH': '/usr/bin:/bin'}, timeout=3)
            self.assertEqual(result['returncode'], 37)
            self.assertFalse(result['timed_out'])
            self.assertIn('failure evidence', (Path(temp) / 'output.log').read_text())
            self.assertEqual(ci.result_code(37, ['cleanup failure']), 37)
            self.assertEqual(ci.result_code(0, ['cleanup failure']), 1)
            self.assertEqual(ci.result_code(-signal.SIGTERM, []), 143)

    def test_owned_child_timeout_is_reaped(self):
        with tempfile.TemporaryDirectory() as temp:
            result = ci.run_command([sys.executable, '-c', 'import time; time.sleep(20)'],
                                    Path(temp), {'PATH': '/usr/bin:/bin'}, timeout=0.1, grace=0.2)
            self.assertTrue(result['timed_out'])
            self.assertTrue(result['reaped'])
            self.assertLess(result['elapsed_seconds'], 2)
            with self.assertRaises(ProcessLookupError):
                os.kill(result['pid'], 0)

    def test_cancellation_preserves_signal_and_reaps_own_child(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            script = '''
import importlib.util,json,pathlib,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('launcher',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
base=pathlib.Path(sys.argv[2])
code="import os,pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(20)"
result=module.run_command([sys.executable,'-c',code,str(base/'ready')],base,{'PATH':'/usr/bin:/bin'},timeout=10,grace=0.2)
(base/'result.json').write_text(json.dumps(result))
'''
            proc = subprocess.Popen([sys.executable, '-c', script,
                                     str(Path(__file__).with_name('linux_isolation.py').resolve()), temp],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child_fd = None
            try:
                deadline = time.monotonic() + 3
                while not (base / 'ready').exists() and proc.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue((base / 'ready').exists())
                child_pid = int((base / 'ready').read_text())
                child_fd = os.pidfd_open(child_pid)
                proc.send_signal(signal.SIGTERM)
                stdout, stderr = proc.communicate(timeout=3)
                self.assertEqual(proc.returncode, 0, stderr)
                result = json.loads((base / 'result.json').read_text())
                self.assertEqual(result['signal'], signal.SIGTERM)
                self.assertEqual(result['returncode'], -signal.SIGTERM)
                self.assertTrue(result['reaped'])
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                if child_fd is not None:
                    try:
                        signal.pidfd_send_signal(child_fd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    os.close(child_fd)
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=3)

    def test_artifacts_preserve_pg_and_prior_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace, source = base / 'private', base / 'source'
            path = Path('maintenance-native-diagnostics')
            (workspace / '.agent-output' / path).mkdir(parents=True)
            (source / '.agent-output' / path).mkdir(parents=True)
            (workspace / '.agent-output' / path / 'sqlite-source-users.tap').write_text('new failure\n')
            (source / '.agent-output' / path / 'postgres.tap').write_text('original PG\n')
            (source / '.agent-output' / path / 'sqlite-source-users.tap').write_text('old failure\n')
            archive, history = base / 'artifacts.tar', base / 'history'
            ci.archive_artifacts(workspace, archive, os.getuid())
            ci.merge_artifacts(archive, source, history)
            self.assertEqual((source / '.agent-output' / path / 'postgres.tap').read_text(), 'original PG\n')
            self.assertEqual((source / '.agent-output' / path / 'sqlite-source-users.tap').read_text(), 'new failure\n')
            self.assertEqual((history / path / 'sqlite-source-users.tap').read_text(), 'old failure\n')

    def test_artifact_links_and_traversal_are_not_followed(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            outside = base / 'outside'
            outside.write_text('unchanged')
            workspace = base / 'private'
            output = workspace / '.agent-output'
            output.mkdir(parents=True)
            (output / 'link').symlink_to(outside)
            with self.assertRaises(ci.IsolationError):
                ci.archive_artifacts(workspace, base / 'out.tar', os.getuid())
            archive = base / 'bad.tar'
            with tarfile.open(archive, 'w') as tar:
                member = tarfile.TarInfo('../outside')
                member.size = 3
                tar.addfile(member, io.BytesIO(b'bad'))
            destination = base / 'extract'
            destination.mkdir()
            with self.assertRaises(ci.IsolationError):
                ci.safe_extract(archive, destination)
            self.assertEqual(outside.read_text(), 'unchanged')

    def test_existing_artifact_directory_symlink_does_not_create_outside_children(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            outside = base / 'outside'
            outside.mkdir()
            output = base / 'source/.agent-output'
            output.mkdir(parents=True)
            (output / 'redirect').symlink_to(outside, target_is_directory=True)
            archive = base / 'artifacts.tar'
            with tarfile.open(archive, 'w') as tar:
                member = tarfile.TarInfo('redirect/new/file.txt')
                member.size = 3
                tar.addfile(member, io.BytesIO(b'bad'))
            with self.assertRaises(ci.IsolationError):
                ci.merge_artifacts(archive, base / 'source', base / 'history')
            self.assertEqual(list(outside.iterdir()), [])

    def test_local_entry_cannot_create_host_accounts(self):
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin')}
        run = subprocess.run([sys.executable, str(Path(__file__).with_name('linux_isolation.py')), 'sqlite'],
                             env=env, text=True, capture_output=True, timeout=3)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('GitHub Actions', run.stderr)

    def test_owned_stage_bootstrap_avoids_unsearchable_runner_ancestor(self):
        # Actual ordinary-UID permission failure/success; no account or privilege fixture.
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            private, shared = base / 'runner-private', base / 'shared'
            private.mkdir(mode=0o700); shared.mkdir(mode=0o700)
            old = private / ci.stage_name('43304799101', '1', 'sqlite')
            with mock.patch.object(ci, 'STAGE_PARENT', shared):
                new = ci.stage_directory('43304799101', '1', 'sqlite')
            payload = "import json,os,pathlib,sys; p=pathlib.Path(sys.argv[1]); json.loads((p/'child.json').read_text()); os.chdir(p/'work'); print('loaded context and cwd')"
            for stage in (old, new):
                stage.mkdir(mode=0o711); stage.chmod(0o711)
                (stage / 'work').mkdir(mode=0o700)
                (stage / 'launcher.py').write_text(payload); (stage / 'launcher.py').chmod(0o444)
                (stage / 'child.json').write_text('{}'); (stage / 'child.json').chmod(0o444)
            private.chmod(0o600)
            try:
                old_run = subprocess.run([sys.executable, '-I', str(old / 'launcher.py'), str(old)],
                                         cwd=base, text=True, capture_output=True, timeout=3)
                self.assertEqual(old_run.returncode, 2)
                self.assertIn('Permission denied', old_run.stderr)
                observed = ci.path_diagnostics({'launcher': (old / 'launcher.py', os.R_OK)})
                self.assertFalse(observed['paths']['launcher']['available'])
                self.assertTrue(any(row.get('errno') == 13 for row in observed['paths']['launcher']['components']))
                new_run = subprocess.run([sys.executable, '-I', str(new / 'launcher.py'), str(new)],
                                         cwd=base, text=True, capture_output=True, timeout=3)
                self.assertEqual(new_run.returncode, 0, new_run.stderr)
                self.assertIn('loaded context and cwd', new_run.stdout)
                self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600, 'No shared parent chmod to make access succeed')
            finally:
                private.chmod(0o700)

    def test_shared_stage_parent_contract_is_strict_and_readonly(self):
        # Raw metadata predicates only; this is not a real root-owned /tmp qualification.
        accepted = SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | 0o1777)
        for change, flags, rejected in [({}, 0, False), ({'st_uid': 1000}, 0, True),
                                        ({'st_gid': 1000}, 0, True),
                                        ({'st_mode': stat.S_IFDIR | 0o777}, 0, True),
                                        ({}, os.ST_NOEXEC, True), ({}, os.ST_RDONLY, True)]:
            info = SimpleNamespace(**(vars(accepted) | change))
            with mock.patch.object(ci, 'real_directory', return_value=Path('/tmp')), \
                 mock.patch.object(Path, 'stat', return_value=info), \
                 mock.patch.object(os, 'statvfs', return_value=SimpleNamespace(f_flag=flags)), \
                 mock.patch.object(os, 'chmod') as chmod, mock.patch.object(os, 'chown') as chown:
                if rejected:
                    with self.assertRaises(ci.IsolationError): ci.validate_stage_parent()
                else:
                    ci.validate_stage_parent()
                chmod.assert_not_called(); chown.assert_not_called()

    def test_child_bootstrap_records_all_missing_paths_without_launching_products(self):
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary).resolve()
            request = self.request()
            request.update(node=str(stage / 'missing-node'), node_sha256='0' * 64)
            with mock.patch.object(subprocess, 'run') as run:
                report = ci.verify_child_bootstrap(request, stage)
            run.assert_not_called()
            self.assertEqual(report['observer_uid'], os.geteuid())
            self.assertEqual(report['status'], 'BLOCKED')
            for name in ('launcher', 'context', 'workspace', 'dependencies', 'node', 'home', 'tmp', 'npm-cache'):
                self.assertIn('inaccessible:' + name, report['errors'])
            self.assertNotIn(ci.PG_URL, json.dumps(report))
            request = self.request('full-suite')
            request.update(node='/opt/node/bin/node', node_sha256='0' * 64)
            targets = ci.bootstrap_targets(request, stage)
            self.assertEqual(str(targets['npm'][0]), '/opt/node/bin/npm')
            for name in ('pg_dump', 'pg_restore', 'psql'):
                self.assertEqual(str(targets[name][0]), '/usr/lib/postgresql/16/bin/' + name)
            self.assertNotIn('AGENT_STUDIO_PG_RESTART_BIN', ci.child_environment(request, stage))

    def account_argv(self, program, stage, token, uid=42001, entry='sqlite'):
        # Evaluate only the actual argv expression; never execute account/setpriv commands.
        source = Path(__file__).with_name('linux_isolation.py').read_text()
        expressions = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.List)
                       and node.elts and isinstance(node.elts[0], ast.Constant) and node.elts[0].value == program]
        self.assertEqual(len(expressions), 1)
        values = {'uid': uid, 'stage': stage, 'request': {'token': token},
                  'state': {'name': ci.job_name('43291999828', '1', entry)}, 'str': str}
        return eval(compile(ast.Expression(expressions[0]), '<fixed argv fixture>', 'eval'),
                    {'__builtins__': {}}, values)

    def test_account_argv_uses_valid_passwd_fields_and_supported_privilege_options(self):
        # Shadow 4.13 useradd VALID rejects ':' and newline, independently of launcher spelling.
        token = '4b033c3841b2c655a49fd1133017d730'
        for entry in ci.ENTRIES:
            stage = Path('/home/runner/work/_temp') / ci.stage_name('43291999828', '1', entry)
            argv = self.account_argv('/usr/sbin/useradd', stage, token, entry=entry)
            field = lambda option: argv[argv.index(option) + 1]
            for option in ('--comment', '--home-dir', '--shell'):
                self.assertNotRegex(field(option), '[:\n\x00]', option)
            self.assertEqual(field('--comment').count(token), 1)
            self.assertTrue(field('--comment').endswith(token))
            self.assertEqual(field('--home-dir'), str(stage / 'home'))
            self.assertTrue(Path(field('--home-dir')).is_absolute())
            self.assertEqual(field('--shell'), '/usr/sbin/nologin')
            self.assertRegex(argv[-1], r'^[a-z_][a-z0-9_-]{0,31}$')
            self.assertEqual(field('--uid'), '42001')
            self.assertEqual(field('--gid'), field('--uid'))
            self.assertTrue({'--system', '--no-user-group', '--no-create-home', '--no-log-init'} <= set(argv))
            self.assertNotIn('-K', argv)
            self.assertNotIn('--badname', argv)
            self.assertEqual(self.account_argv('/usr/sbin/groupadd', stage, token, entry=entry),
                             ['/usr/sbin/groupadd', '--gid', field('--gid'), argv[-1]])
            privilege = self.account_argv('/usr/bin/setpriv', stage, token, entry=entry)
            self.assertEqual(privilege[1:8], ['--reuid=42001', '--regid=42001', '--clear-groups',
                                           '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all',
                                           '--no-new-privs'])
            self.assertEqual(privilege[8:], ['/usr/bin/python3', '-I', str(stage / 'launcher.py'), '--child', str(stage)])

    def test_account_cleanup_rejects_changed_nonce_uid_gid_home_or_marker(self):
        # NSS records are fixtures. Stop at the first process boundary; no accounts are created/deleted.
        class ProcessBoundaryReached(Exception):
            pass

        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary).resolve()
            sentinel = stage / 'preserve.txt'
            sentinel.write_text('unchanged')
            token = '4b033c3841b2c655a49fd1133017d730'
            name = ci.job_name('43291999828', '1', 'sqlite')
            info = stage.stat()
            request = {'token': token, 'name': name, 'directory_identity': [info.st_dev, info.st_ino]}
            state = {'token': token, 'name': name, 'stage': str(stage), 'uid': 42001, 'gid': 42001}
            argv = self.account_argv('/usr/sbin/useradd', stage, token)
            account = {'pw_uid': 42001, 'pw_gid': 42001, 'pw_dir': str(stage / 'home'),
                       'pw_gecos': argv[argv.index('--comment') + 1]}
            bad_accounts = [dict(account, **change) for change in [
                {'pw_uid': 42002}, {'pw_gid': 42002}, {'pw_dir': str(stage / 'another-home')},
                {'pw_gecos': account['pw_gecos'][:-1]},
                {'pw_gecos': account['pw_gecos'].replace(token, '0' + token[1:])},
            ]]
            for bad in bad_accounts:
                with self.subTest(changed=bad), mock.patch.object(ci, 'account_record', return_value=SimpleNamespace(**bad)), \
                     mock.patch.object(ci, 'group_record', return_value=None), \
                     mock.patch.object(ci, 'stop_owned_processes') as stop, mock.patch.object(ci, 'tool') as tool:
                    with self.assertRaisesRegex(ci.IsolationError, 'ownership'):
                        ci.cleanup_owned(stage, request, state)
                    stop.assert_not_called()
                    tool.assert_not_called()
            for change in ({'token': '0' + token[1:]}, {'stage': str(stage / 'other')}, {'name': name + 'x'}):
                with self.assertRaisesRegex(ci.IsolationError, 'marker'):
                    ci.verify_marker(stage, request, dict(state, **change))
            with self.assertRaisesRegex(ci.IsolationError, 'marker'):
                ci.verify_marker(stage, dict(request, directory_identity=[info.st_dev, info.st_ino + 1]), state)
            with mock.patch.object(ci, 'account_record', return_value=SimpleNamespace(**account)), \
                 mock.patch.object(ci, 'group_record', return_value=None), \
                 mock.patch.object(ci, 'stop_owned_processes', side_effect=ProcessBoundaryReached) as stop:
                with self.assertRaises(ProcessBoundaryReached):
                    ci.cleanup_owned(stage, request, state)
                stop.assert_called_once_with(42001)
            for incomplete in ({'remaining': [{'pid': 123}], 'errors': []},
                               {'remaining': [], 'errors': ['identity is unknown']}):
                with mock.patch.object(ci, 'account_record', return_value=SimpleNamespace(**account)), \
                     mock.patch.object(ci, 'group_record', return_value=None), \
                     mock.patch.object(ci, 'stop_owned_processes', return_value=incomplete), \
                     mock.patch.object(ci, 'tool') as tool:
                    with self.assertRaisesRegex(ci.IsolationError, 'cleanup is unproven'):
                        ci.cleanup_owned(stage, request, state)
                    tool.assert_not_called()
            self.assertEqual(sentinel.read_text(), 'unchanged')


class OwnedReapControls(unittest.TestCase):
    """Real child processes, with only inventory scoped to this test's children.

    Never invoke UID-wide termination for the shared local test user. The
    production /proc view is unchanged; pidfd/wait/signal calls remain native.
    """

    def setUp(self):
        self.children = {}
        self.evidence = {'inventory': 'test-owned exact PID scope; native process operations',
                         'uid': os.getuid(), 'supervisor_pid': os.getpid()}
        self.libc = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        self.assertEqual(self.libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.previous_subreaper = previous.value
        self.assertEqual(self.libc.prctl(36, 1, 0, 0, 0), 0)
        actual = ctypes.c_int()
        self.assertEqual(self.libc.prctl(37, ctypes.byref(actual), 0, 0, 0), 0)
        self.assertEqual(actual.value, 1)
        self.evidence['actual_subreaper'] = actual.value
        self.native_inventory = ci.process_rows
        self.inventory_patch = mock.patch.object(ci, 'process_rows', self.inventory)
        self.inventory_patch.start()

    def row(self, pid):
        base = Path('/proc') / str(pid)
        fields = dict(line.split(':', 1) for line in (base / 'status').read_text().splitlines() if ':' in line)
        tail = (base / 'stat').read_text().rsplit(') ', 1)[1].split()
        return {'pid': pid, 'start_ticks': tail[19], 'state': fields['State'].strip(),
                'stat_state': tail[0], 'ppid': int(tail[1]), 'uids': list(map(int, fields['Uid'].split()))}

    def inventory(self, uid):
        rows = []
        for pid in self.children:
            try:
                row = self.row(pid)
                if uid in row['uids']:
                    rows.append(row)
            except (FileNotFoundError, ProcessLookupError):
                pass
        return rows

    def remember(self, pid):
        self.children[pid] = os.pidfd_open(pid)
        return pid

    def poll_exit(self, pid):
        poller = select.poll()
        poller.register(self.children[pid], select.POLLIN)
        self.assertTrue(poller.poll(2000), 'owned child did not reach its intended exit')

    def orphan_zombie(self, status=23):
        pid_read, pid_write = os.pipe()
        release_read, release_write = os.pipe()
        parent = os.fork()
        if parent == 0:
            os.close(pid_read)
            os.close(release_write)
            child = os.fork()
            if child == 0:
                os.close(pid_write)
                os.read(release_read, 1)
                os._exit(status)
            os.write(pid_write, str(child).encode())
            os._exit(0)
        os.close(pid_write)
        os.close(release_read)
        try:
            self.assertTrue(select.select([pid_read], [], [], 2)[0])
            child = self.remember(int(os.read(pid_read, 32)))
            waited_parent = os.waitpid(parent, 0)
            self.assertEqual(waited_parent[1], 0)
            self.assertEqual(self.row(child)['ppid'], os.getpid())
            self.evidence['orphan_adoption'] = {'original_parent_pid': parent, 'parent_wait': list(waited_parent),
                                               'child_pid': child, 'adopted_ppid': self.row(child)['ppid']}
            os.write(release_write, b'exit')
            self.poll_exit(child)
            self.assertEqual(self.row(child)['stat_state'], 'Z')
            return child
        finally:
            os.close(pid_read)
            os.close(release_write)

    def live_child(self, ignore_term=False):
        ready_read, ready_write = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(ready_read)
            if ignore_term:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
            os.write(ready_write, b'ready')
            while True:
                signal.pause()
        self.remember(child)
        os.close(ready_write)
        try:
            self.assertTrue(select.select([ready_read], [], [], 2)[0])
            self.assertEqual(os.read(ready_read, 5), b'ready')
        finally:
            os.close(ready_read)
        return child

    @staticmethod
    def command_cleanup_exit(receipt):
        # Preserve the original caller's rule for the baseline RED comparison.
        if isinstance(receipt, list):
            return ci.result_code(0, ['owned leftovers'] if receipt else [])
        return ci.result_code(0, [] if receipt['reap_only'] else ['owned leftovers'])

    def test_orphan_already_zombie_is_actually_reaped_without_failure(self):
        child = self.orphan_zombie()
        before = self.row(child)
        receipt = ci.stop_owned_processes(os.getuid())
        self.evidence.update(initial=before, receipt=receipt)
        self.assertEqual(self.command_cleanup_exit(receipt), 0,
                         'already-terminated owned children must pass only after actual reap')
        self.assertEqual(receipt['initial'], [before])
        self.assertEqual(receipt['signals'], [])
        self.assertEqual(receipt['remaining'], [])
        self.assertEqual(receipt['errors'], [])
        self.assertEqual(len(receipt['reaped']), 1)
        reaped = receipt['reaped'][0]
        self.assertEqual(reaped['process'], before)
        self.assertEqual(reaped['peek'], reaped['consumed'])
        self.assertEqual(reaped['consumed'], {'si_pid': child, 'si_uid': os.getuid(),
                         'si_signo': signal.SIGCHLD, 'si_code': os.CLD_EXITED, 'si_status': 23})
        self.assertFalse(Path('/proc', str(child)).exists())

    def test_live_residual_remains_failure_after_real_term_and_reap(self):
        child = self.live_child()
        receipt = ci.stop_owned_processes(os.getuid())
        self.evidence['receipt'] = receipt
        self.assertEqual(self.command_cleanup_exit(receipt), 1)
        self.assertEqual(receipt['remaining'], [])
        self.assertEqual(receipt['errors'], [])
        self.assertTrue(receipt['signals'])
        self.assertEqual(receipt['reaped'][0]['consumed']['si_pid'], child)
        self.assertEqual(receipt['reaped'][0]['consumed']['si_code'], os.CLD_KILLED)
        self.assertEqual(receipt['reaped'][0]['consumed']['si_status'], signal.SIGTERM)

    def test_live_snapshot_followed_by_new_zombie_is_reaped_before_collection(self):
        ready_read, ready_write = os.pipe()
        exit_read, exit_write = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(ready_read)
            os.close(exit_write)
            def term(number, frame):
                os.write(ready_write, b't')
                os.read(exit_read, 1)
                os._exit(47)
            signal.signal(signal.SIGTERM, term)
            os.write(ready_write, b'r')
            while True:
                signal.pause()
        self.remember(child)
        os.close(ready_write)
        os.close(exit_read)
        native_signal, native_wait = signal.pidfd_send_signal, os.waitid
        sent, transitioned = False, False
        trace, waits = [], []

        def ready(expected):
            self.assertTrue(select.select([ready_read], [], [], 2)[0])
            self.assertEqual(os.read(ready_read, 1), expected)

        def actual():
            return [row for row in self.native_inventory(os.getuid()) if row['pid'] == child]

        def inventory(uid):
            nonlocal transitioned
            self.assertEqual(uid, os.getuid())
            if sent and not transitioned:
                ready(b't')
                snapshot = actual()
                self.assertEqual(len(snapshot), 1)
                self.assertFalse(ci.zombie(snapshot[0]))
                os.write(exit_write, b'x')
                self.poll_exit(child)
                after = actual()
                self.assertEqual(len(after), 1)
                self.assertTrue(ci.zombie(after[0]))
                transitioned = True
                trace.append({'returned_real_snapshot': snapshot, 'actual_after_release': after})
                return snapshot
            snapshot = actual()
            trace.append({'returned_real_snapshot': snapshot})
            return snapshot

        def send(*args):
            nonlocal sent
            result = native_signal(*args)
            sent = True
            return result

        def wait(*args):
            result = native_wait(*args)
            waits.append({'args': list(args), 'result': list(result) if result else None})
            return result

        try:
            ready(b'r')
            with mock.patch.object(ci, 'process_rows', side_effect=inventory), \
                 mock.patch.object(signal, 'pidfd_send_signal', side_effect=send), \
                 mock.patch.object(os, 'waitid', side_effect=wait):
                receipt = ci.stop_owned_processes(os.getuid())
            self.evidence.update(trace=trace, candidate_wait_calls=waits, receipt=receipt,
                                 inventory_before_harness_cleanup=actual(),
                                 artifact_collection_guard_would_reject=bool(actual()))
            self.assertTrue(transitioned)
            self.assertFalse(receipt['reap_only'])
            self.assertEqual(self.command_cleanup_exit(receipt), 1)
            self.assertEqual(receipt['remaining'], [])
            self.assertEqual(receipt['errors'], [])
            self.assertEqual(len(waits), 2)
            self.assertEqual(len(receipt['reaped']), 1)
            self.assertEqual(receipt['reaped'][0]['peek'], receipt['reaped'][0]['consumed'])
            self.assertEqual(receipt['reaped'][0]['consumed']['si_status'], 47)
            self.assertEqual(receipt['reaped'][0]['consumed']['si_code'], os.CLD_EXITED)
            self.assertEqual(receipt['signals'][0]['signal'], signal.SIGTERM)
            self.assertFalse(actual())
        finally:
            os.close(ready_read)
            os.close(exit_write)

    def test_ignore_term_residual_keeps_budget_and_failure_after_kill(self):
        child = self.live_child(ignore_term=True)
        started = time.monotonic()
        receipt = ci.stop_owned_processes(os.getuid())
        self.evidence.update(receipt=receipt, elapsed_seconds=time.monotonic() - started)
        self.assertEqual(self.command_cleanup_exit(receipt), 1)
        self.assertEqual(receipt['remaining'], [])
        self.assertEqual([item['signal'] for item in receipt['signals']], [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual(receipt['reaped'][0]['consumed']['si_pid'], child)
        self.assertEqual(receipt['reaped'][0]['consumed']['si_status'], signal.SIGKILL)
        self.assertGreaterEqual(self.evidence['elapsed_seconds'], 3)
        self.assertLess(self.evidence['elapsed_seconds'], 7)

    def test_changed_start_or_uid_does_not_wait_or_signal(self):
        child = self.live_child()
        actual = self.row(child)
        for uid, expected in [(os.getuid(), dict(actual, start_ticks=str(int(actual['start_ticks']) + 1))),
                              (os.getuid() + 1, actual)]:
            with self.subTest(expected_uid=uid), mock.patch.object(os, 'waitid', wraps=os.waitid) as wait, \
                 mock.patch.object(signal, 'pidfd_send_signal', wraps=signal.pidfd_send_signal) as send:
                with self.assertRaisesRegex(ci.IsolationError, 'identity'):
                    ci.reap_owned_process(uid, expected)
                wait.assert_not_called()
                send.assert_not_called()
        self.assertIsNone(os.waitid(os.P_PIDFD, self.children[child], os.WEXITED | os.WNOHANG | os.WNOWAIT))
        self.evidence.update(initial=actual, refused_start_and_uid=True, still_alive=True)

    def test_no_wait_result_cannot_certify_a_real_zombie(self):
        child = self.orphan_zombie()
        expected = self.row(child)
        with mock.patch.object(os, 'waitid', return_value=None) as wait:
            receipt = ci.stop_owned_processes(os.getuid())
            self.assertFalse(receipt['reap_only'])
            self.assertEqual(receipt['reaped'], [])
            self.assertEqual(receipt['remaining'], [expected])
            self.assertEqual(len(receipt['errors']), 1)
            self.assertEqual(wait.call_count, 1)
        self.assertEqual(self.row(child)['stat_state'], 'Z')
        self.evidence.update(initial=expected, injected_boundary='waitid returned None',
                             receipt=receipt, attempted_wait_count=1,
                             still_unreaped=True, not_hosted_account_evidence=True)

    def test_real_nonchild_zombie_is_not_certified_by_its_state(self):
        pid_read, pid_write = os.pipe()
        release_read, release_write = os.pipe()
        parent = os.fork()
        if parent == 0:
            os.close(pid_read)
            os.close(release_write)
            child = os.fork()
            if child == 0:
                os._exit(29)
            os.write(pid_write, str(child).encode())
            os.read(release_read, 1)
            waited = os.waitpid(child, 0)
            os.write(pid_write, ('\n' + str(waited[1])).encode())
            os._exit(0)
        self.remember(parent)
        os.close(pid_write)
        os.close(release_read)
        try:
            self.assertTrue(select.select([pid_read], [], [], 2)[0])
            child = self.remember(int(os.read(pid_read, 32)))
            self.poll_exit(child)
            expected = self.row(child)
            self.assertEqual(expected['ppid'], parent)
            self.assertEqual(expected['stat_state'], 'Z')
            with self.assertRaisesRegex(ci.IsolationError, 'no waitable status'):
                ci.reap_owned_process(os.getuid(), expected)
            self.assertEqual(self.row(child)['stat_state'], 'Z')
            os.write(release_write, b'reap')
            self.assertTrue(select.select([pid_read], [], [], 2)[0])
            actual_parent_wait_status = int(os.read(pid_read, 32))
            self.assertEqual(os.waitstatus_to_exitcode(actual_parent_wait_status), 29)
            self.poll_exit(parent)
            self.assertEqual(os.waitid(os.P_PIDFD, self.children[parent], os.WEXITED).si_status, 0)
            self.assertFalse(Path('/proc', str(child)).exists())
            self.evidence.update(initial=expected, native_nonchild_wait='ECHILD; rejected',
                                 actual_parent_wait_status=actual_parent_wait_status)
        finally:
            os.close(pid_read)
            os.close(release_write)

    def test_consumption_mismatch_never_becomes_a_reap_receipt(self):
        child = self.orphan_zombie()
        expected = self.row(child)
        native_wait = os.waitid
        calls = []
        def changed_return(*args):
            value = native_wait(*args)
            calls.append(value)
            if not (args[2] & os.WNOWAIT):
                return SimpleNamespace(si_pid=value.si_pid, si_uid=value.si_uid, si_signo=value.si_signo,
                                       si_code=value.si_code, si_status=value.si_status + 1)
            return value
        with mock.patch.object(os, 'waitid', side_effect=changed_return):
            with self.assertRaisesRegex(ci.IsolationError, 'wait'):
                ci.reap_owned_process(os.getuid(), expected)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.evidence.update(initial=expected, injected_boundary='consumption return status changed',
                             real_kernel_returns=[list(item) for item in calls], falsely_certified=False)

    def tearDown(self):
        cleanup = []
        try:
            for pid, fd in self.children.items():
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    result = os.waitid(os.P_PIDFD, fd, os.WEXITED)
                    cleanup.append({'pid': pid, 'wait': list(result) if result else None})
                except ChildProcessError:
                    cleanup.append({'pid': pid, 'already_reaped': True})
                finally:
                    os.close(fd)
                self.assertFalse(Path('/proc', str(pid)).exists(), 'test-owned child survived cleanup')
        finally:
            self.inventory_patch.stop()
            self.libc.prctl(36, self.previous_subreaper, 0, 0, 0)
            self.evidence['test_cleanup'] = cleanup
            evidence_root = os.environ.get('ISOLATION_REAP_EVIDENCE_DIR')
            if evidence_root:
                output = Path(evidence_root)
                output.mkdir(parents=True, exist_ok=True)
                (output / (self._testMethodName + '.json')).write_text(json.dumps(self.evidence, indent=2) + '\n')


if __name__ == '__main__':
    unittest.main()
