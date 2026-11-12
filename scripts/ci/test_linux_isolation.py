"""Launcher contracts using owned local fixtures; account/UID changes are hosted-only."""
import ast
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
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
            self.assertEqual(sentinel.read_text(), 'unchanged')


if __name__ == '__main__':
    unittest.main()
