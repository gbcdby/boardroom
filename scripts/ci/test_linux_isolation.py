"""Launcher contracts using owned local fixtures; account/UID changes are hosted-only."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('linux_isolation', Path(__file__).with_name('linux_isolation.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


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
        self.assertEqual(ci.command_for('full-suite'), 'npm test')
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


if __name__ == '__main__':
    unittest.main()
