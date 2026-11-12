#!/usr/bin/env python3
"""Run the two Linux inventory test entries as an owned, short-lived CI UID.

The runner creates exact-source/dependency archives. Root only creates and
removes the marked account/directories and supervises a capability-free child.
No PID/mount namespace, /proc filter, host policy change, or package install.
"""
import argparse
import ctypes
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

ENTRIES = ('sqlite', 'full-suite')
CAP_FIELDS = ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')
PG_URL = 'postgres://boardroom:boardroom-ci-only@127.0.0.1:5432/boardroom_ci'
SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
STAGE_PARENT = Path('/tmp')
MAX_ARCHIVE = 2 * 1024 * 1024 * 1024
WORKSPACE = Path('work/workspace')  # Existing plan fixtures create siblings of cwd.
PROTECTED = ('package.json', 'package-lock.json', 'src/server/storage/maintenance/sqlite.ts',
             'tests/maintenance-sqlite.test.ts', 'tests/fixtures/maintenance-linux-inventory-diagnostic.ts',
             'scripts/ci/linux_isolation.py')


class IsolationError(RuntimeError):
    pass


def command_for(entry):
    if entry == 'sqlite':
        return ("mkdir -p .agent-output/maintenance-native-diagnostics\n"
                "timeout --signal=TERM --kill-after=10s 30s node --test --test-reporter=tap "
                "--test-name-pattern='unknown source file users' tests/maintenance-sqlite.test.ts "
                "2>&1 | tee .agent-output/maintenance-native-diagnostics/sqlite-source-users.tap")
    if entry == 'full-suite':
        return 'npm test'
    raise IsolationError('Unknown fixed CI entry')


def child_environment(request, stage):
    env = {'PATH': request['node_dir'] + ':/usr/lib/postgresql/16/bin:' + SYSTEM_PATH,
           'HOME': str(stage / 'home'), 'TMPDIR': str(stage / 'tmp'),
           'npm_config_cache': str(stage / 'npm-cache'), 'LANG': 'C.UTF-8',
           'CI': 'true', 'GITHUB_ACTIONS': 'true', 'GITHUB_JOB': 'database-tests',
           'GITHUB_SHA': request['head'], 'GITHUB_RUN_ID': request['run_id'],
           'GITHUB_RUN_ATTEMPT': request['attempt'], 'GITHUB_WORKSPACE': str(stage / WORKSPACE)}
    if request['entry'] == 'full-suite':
        if request.get('pg_url') != PG_URL:
            raise IsolationError('Full suite requires the original temporary CI PostgreSQL URL')
        env['AGENT_STUDIO_PG_TEST_URL'] = PG_URL
    elif request.get('pg_url') is not None:
        raise IsolationError('SQLite diagnostic must not acquire a PostgreSQL environment')
    return env


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def write_json(path, value, owner=None):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + secrets.token_hex(6))
    with temporary.open('x', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    if owner is not None:
        os.chown(temporary, *owner)
    os.replace(temporary, path)


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024 * 1024:
            raise IsolationError('Invalid owned JSON record')
        with os.fdopen(fd, 'r', closefd=False) as stream:
            return json.load(stream)
    finally:
        os.close(fd)


def real_directory(path):
    if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_dir():
        raise IsolationError(f'Expected a real absolute directory: {path}')
    return path


def stage_directory(run_id, attempt, entry):
    # RUNNER_TEMP may have runner-private ancestors. Never chmod those ancestors.
    return STAGE_PARENT / stage_name(run_id, attempt, entry)


def validate_stage_parent():
    parent = real_directory(STAGE_PARENT)
    info = parent.stat()
    if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o1777 or \
       any(not (item.stat().st_mode & stat.S_IXOTH) for item in parent.parents) or \
       os.statvfs(parent).f_flag & (os.ST_NOEXEC | os.ST_RDONLY):
        raise IsolationError('Owned stage requires existing root-owned searchable sticky executable /tmp')


def bootstrap_targets(request, stage):
    environment = child_environment(request, stage)
    targets = {'launcher': (stage / 'launcher.py', os.R_OK),
               'context': (stage / 'child.json', os.R_OK),
               'workspace': (stage / WORKSPACE, os.R_OK | os.W_OK | os.X_OK),
               'dependencies': (stage / WORKSPACE / 'node_modules', os.R_OK | os.X_OK),
               'node': (Path(request['node']), os.R_OK | os.X_OK),
               'python': (Path('/usr/bin/python3'), os.R_OK | os.X_OK)}
    for name in ('home', 'tmp', 'npm-cache'):
        targets[name] = (stage / name, os.R_OK | os.W_OK | os.X_OK)
    for name in ('bash', 'mkdir', 'timeout', 'tee'):
        program = shutil.which(name, path=environment['PATH'])
        targets[name] = (Path(program) if program else None, os.R_OK | os.X_OK)
    if request['entry'] == 'full-suite':
        targets['npm'] = (Path(request['node_dir']) / 'npm', os.R_OK | os.X_OK)
        for name in ('pg_dump', 'pg_restore', 'psql'):
            targets[name] = (Path('/usr/lib/postgresql/16/bin') / name, os.R_OK | os.X_OK)
    return targets


def path_diagnostics(targets):
    # Observations only: root's access result is never a child authorization proof.
    result = {'observer_uid': os.geteuid(), 'observer_gid': os.getegid(), 'paths': {}}
    for label, (path, required) in targets.items():
        item = {'path': str(path) if path else None, 'required_access': required, 'available': False, 'components': []}
        result['paths'][label] = item
        if path is None:
            item['error'] = 'executable_not_found'
            continue
        item['available'] = os.access(path, required)
        components = [*reversed(path.parents), path]
        try:
            resolved = path.resolve(strict=True)
            item['resolved'] = str(resolved)
            components += [*reversed(resolved.parents), resolved]
        except (OSError, RuntimeError) as error:
            item['resolve_error'] = type(error).__name__
            item['resolve_errno'] = getattr(error, 'errno', None)
        for component in dict.fromkeys(components):
            row = {'path': str(component)}
            try:
                info = component.lstat()
                row.update(uid=info.st_uid, gid=info.st_gid, mode=oct(stat.S_IMODE(info.st_mode)),
                           device=info.st_dev, inode=info.st_ino, symlink=stat.S_ISLNK(info.st_mode))
                row['mount_flags'] = os.statvfs(component).f_flag
            except OSError as error:
                row['errno'] = error.errno
            try:
                acl = os.getxattr(component, 'system.posix_acl_access', follow_symlinks=False)
                row.update(acl_bytes=len(acl), acl_hex=acl[:4096].hex(), acl_truncated=len(acl) > 4096)
            except OSError as error:
                row['acl_errno'] = error.errno
            item['components'].append(row)
    return result


def verify_child_bootstrap(request, stage):
    # Called only after the actual nonroot identity/caps/groups/NNP checks.
    report = path_diagnostics(bootstrap_targets(request, stage))
    report.update(candidate=request['head'], tree=request['tree'], entry=request['entry'], probes=[])
    errors = ['inaccessible:' + label for label, item in report['paths'].items() if not item['available']]
    environment = child_environment(request, stage)
    node = Path(request['node'])
    if not errors:
        selected = shutil.which('node', path=environment['PATH'])
        if not selected or Path(selected).resolve() != node or digest(node) != request['node_sha256']:
            errors.append('prepared_node_identity_changed')
    if not errors:
        # Exercise loaders and npm's env-node shebang under the real child identity.
        native = "const D=require('better-sqlite3');const db=new D(':memory:');db.close();console.log('native dependency loaded')"
        probes = [('node-version', [str(node), '--version']), ('native-dependency', [str(node), '-e', native])]
        if request['entry'] == 'full-suite':
            probes += [(name, [report['paths'][name]['path'], '--version']) for name in ('npm', 'pg_dump', 'pg_restore', 'psql')]
        for label, argv in probes:
            item = {'label': label, 'argv': argv}
            try:
                completed = subprocess.run(argv, cwd=stage / WORKSPACE, env=environment, stdin=subprocess.DEVNULL,
                                           text=True, capture_output=True, timeout=5)
                item.update(exit_code=completed.returncode, stdout=completed.stdout[-2048:], stderr=completed.stderr[-2048:])
                if completed.returncode:
                    errors.append('probe_failed:' + label)
            except (OSError, subprocess.TimeoutExpired) as error:
                item.update(error=type(error).__name__, errno=getattr(error, 'errno', None))
                errors.append('probe_failed:' + label)
            report['probes'].append(item)
    report.update(status='BLOCKED' if errors else 'PASS', errors=errors)
    return report


def output_directory(base, relative=Path('.')):
    """Check existing components before creating a child; never follow an output symlink."""
    real_directory(base)
    current = base
    for part in relative.parts:
        if part in ('.', '..') or Path(part).is_absolute():
            raise IsolationError('Invalid relative output directory')
        current = current / part
        if current.exists() or current.is_symlink():
            real_directory(current)
        else:
            current.mkdir(mode=0o700)
    return current


def tool(argv, cwd=None, timeout=30):
    result = subprocess.run(argv, cwd=cwd, env={'PATH': SYSTEM_PATH, 'LC_ALL': 'C'},
                            text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise IsolationError(f'{Path(argv[0]).name} exit {result.returncode}: {result.stderr[-2048:]}')
    return result.stdout.strip()


def identity_record():
    fields = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    return {'pid': os.getpid(), 'uid': list(map(int, fields['Uid'].split())),
            'gid': list(map(int, fields['Gid'].split())), 'groups': list(map(int, fields['Groups'].split())),
            'capabilities': {key: fields[key].strip() for key in CAP_FIELDS},
            'no_new_privs': int(fields['NoNewPrivs']), 'pid_namespace': os.readlink('/proc/self/ns/pid')}


def assert_identity(actual, uid, gid, namespace):
    if uid <= 0 or gid <= 0 or actual['uid'] != [uid] * 4 or actual['gid'] != [gid] * 4 or \
       actual['groups'] != [] or actual['no_new_privs'] != 1 or actual['pid_namespace'] != namespace or \
       any(int(actual['capabilities'][key], 16) != 0 for key in CAP_FIELDS):
        raise IsolationError('Actual child identity/capabilities/groups/NNP/PID namespace do not match')


def run_command(argv, cwd, env, timeout=900, grace=5):
    """Keep the actual exit status; only signal/reap the child group we created."""
    started, received = time.monotonic(), []
    old_handlers = {}
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        old_handlers[sig] = signal.signal(sig, lambda number, frame: received.append(number))
    proc, timed_out = None, False
    try:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, start_new_session=True)
        while proc.poll() is None:
            timed_out = time.monotonic() - started >= timeout
            if received or timed_out:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=grace)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                break
            time.sleep(0.05)
        proc.wait(timeout=max(1, grace))
        return {'pid': proc.pid, 'returncode': proc.returncode, 'timed_out': timed_out,
                'signal': received[0] if received else None, 'reaped': True,
                'elapsed_seconds': time.monotonic() - started}
    finally:
        if proc is not None and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)


def result_code(command_exit, errors):
    if command_exit is None:
        return 1
    code = 128 - command_exit if command_exit < 0 else command_exit
    return code if code else int(bool(errors))


def safe_extract(archive, destination):
    if archive.stat().st_size > MAX_ARCHIVE:
        raise IsolationError('CI archive exceeds the 2 GiB transport bound')
    try:
        with tarfile.open(archive, 'r') as tar:
            members = tar.getmembers()
            if len(members) > 200000 or sum(member.size for member in members) > MAX_ARCHIVE:
                raise IsolationError('CI archive exceeds the finite extraction bound')
            for member in members:
                path = Path(member.name)
                if path.is_absolute() or '..' in path.parts or '.git' in path.parts or \
                   not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                    raise IsolationError('Unsafe CI archive member')
                tarfile.data_filter(member, str(destination))
            tar.extractall(destination, members=members, filter='data')
    except (tarfile.TarError, ValueError) as error:
        raise IsolationError(f'Unsafe or incomplete CI archive: {error}') from error


def verify_source_archive(archive, source):
    """Prove the credential-free export contains every tracked blob of this HEAD."""
    entries = tool(['git', 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'], source).split('\0')
    expected = {}
    for entry in filter(None, entries):
        metadata, name = entry.split('\t', 1)
        mode, kind, blob = metadata.split()
        if kind != 'blob':
            raise IsolationError('A gitlink needs an explicit source snapshot contract')
        expected[name] = (mode, blob)
    observed = {}
    with tarfile.open(archive, 'r') as tar:
        for member in tar:
            if member.isdir():
                continue
            if member.issym():
                data, mode = member.linkname.encode(), '120000'
            elif member.isfile():
                data = tar.extractfile(member).read()
                mode = '100755' if member.mode & 0o111 else '100644'
            else:
                raise IsolationError('Unexpected exact-source archive member')
            blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            observed[member.name] = (mode, blob)
    if observed != expected:
        raise IsolationError('Source archive differs from the complete tracked HEAD tree')
    return {'tracked_blobs': len(expected), 'all_blob_ids_and_modes_match': True}


def archive_artifacts(workspace, archive, uid):
    output, count, total = workspace / '.agent-output', 0, 0
    with tarfile.open(archive, 'w', dereference=False) as tar:
        if not output.exists() and not output.is_symlink():
            return {'files': 0, 'bytes': 0}
        real_directory(output)
        for directory, dirs, files in os.walk(output, followlinks=False):
            for name in sorted(dirs + files):
                path = Path(directory) / name
                info = path.lstat()
                if info.st_uid != uid or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or \
                   (stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
                    raise IsolationError('Artifact links, special files, or foreign ownership are retained, not followed')
                if stat.S_ISDIR(info.st_mode):
                    continue
                count, total = count + 1, total + info.st_size
                if count > 100000 or total > MAX_ARCHIVE:
                    raise IsolationError('Artifact collection exceeded its finite bound')
                tar.add(path, arcname=str(path.relative_to(output)), recursive=False)
    return {'files': count, 'bytes': total}


def merge_artifacts(archive, source, history):
    """Nonroot import; retain old differing bytes and the original relative paths."""
    history.mkdir(parents=True, exist_ok=True, mode=0o700)
    output = source / '.agent-output'
    output.mkdir(exist_ok=True, mode=0o700)
    real_directory(output)
    with tempfile.TemporaryDirectory(prefix='collect-', dir=history.parent) as temporary:
        extracted = Path(temporary)
        safe_extract(archive, extracted)
        for path in sorted(extracted.rglob('*')):
            if path.is_dir() and not path.is_symlink():
                continue
            if not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1:
                raise IsolationError('Collected artifact is not an independent regular file')
            relative = path.relative_to(extracted)
            destination = output / relative
            output_directory(output, relative.parent)
            if destination.exists() or destination.is_symlink():
                old = destination.lstat()
                if not stat.S_ISREG(old.st_mode) or old.st_nlink != 1:
                    raise IsolationError('Existing artifact target is not a regular owned file')
                if digest(destination) == digest(path):
                    continue
                prior = history / relative
                output_directory(history, relative.parent)
                if prior.exists():
                    if digest(prior) != digest(destination):
                        prior = prior.with_name(prior.name + '.' + digest(destination)[:12])
                shutil.copyfile(destination, prior, follow_symlinks=False)
            temporary_file = destination.with_name(destination.name + '.' + secrets.token_hex(6))
            shutil.copyfile(path, temporary_file, follow_symlinks=False)
            os.chmod(temporary_file, 0o600)
            os.replace(temporary_file, destination)


def process_rows(uid):
    rows = []
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            fields = dict(line.split(':', 1) for line in (path / 'status').read_text().splitlines() if ':' in line)
            if uid not in list(map(int, fields['Uid'].split())):
                continue
            tail = (path / 'stat').read_text().rsplit(') ', 1)[1].split()
            rows.append({'pid': int(path.name), 'start_ticks': tail[19], 'state': fields['State'].strip()})
        except (FileNotFoundError, ProcessLookupError):
            pass
    return rows


def stop_owned_processes(uid):
    """UID is newly allocated and account identity was checked by the caller."""
    initial = process_rows(uid)
    for sig, seconds in ((signal.SIGTERM, 3), (signal.SIGKILL, 3)):
        for row in process_rows(uid):
            try:
                fd = os.pidfd_open(row['pid'])
                try:
                    current = next((r for r in process_rows(uid) if r['pid'] == row['pid']), None)
                    if current and current['start_ticks'] == row['start_ticks']:
                        signal.pidfd_send_signal(fd, sig)
                finally:
                    os.close(fd)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                while os.waitpid(-1, os.WNOHANG)[0]:
                    pass
            except ChildProcessError:
                pass
            if not process_rows(uid):
                return initial
            time.sleep(0.05)
    raise IsolationError('Owned UID still has processes; preserve account and workspace')


def account_record(name):
    try:
        return pwd.getpwnam(name)
    except KeyError:
        return None


def group_record(name):
    try:
        return grp.getgrnam(name)
    except KeyError:
        return None


def verify_marker(stage, request, state):
    real_directory(stage)
    info = stage.stat()
    if [info.st_dev, info.st_ino] != request['directory_identity'] or state['token'] != request['token'] or \
       state['stage'] != str(stage) or state['name'] != request['name']:
        raise IsolationError('CI marker or directory identity changed; preserve unknown resources')


def cleanup_owned(stage, request, state):
    verify_marker(stage, request, state)
    if state.get('cleanup_complete'):
        return state['cleanup']
    result = {'remaining_processes': [], 'removed_paths': [], 'account_removed': False, 'group_removed': False}
    account, group = account_record(state['name']), group_record(state['name'])
    if account:
        if account.pw_uid != state.get('uid') or account.pw_gid != state.get('gid') or \
           account.pw_dir != str(stage / 'home') or account.pw_gecos != 'boardroom-ci-' + request['token']:
            raise IsolationError('New account ownership no longer matches this job')
        result['terminated_processes'] = stop_owned_processes(account.pw_uid)
    elif state.get('uid') and process_rows(state['uid']):
        raise IsolationError('Account missing but UID has processes; preserve unknown ownership')
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        mountpoint = line.split()[4]
        if mountpoint == str(stage) or mountpoint.startswith(str(stage) + '/'):
            raise IsolationError('Unexpected mount under owned CI directory; do not recursively delete')
    for name, expected in state.get('owned_directories', {}).items():
        path = stage / name
        if not path.exists() and not path.is_symlink():
            continue
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or [info.st_dev, info.st_ino] != expected:
            raise IsolationError('Owned resource identity changed; preserve it')
        if not shutil.rmtree.avoids_symlink_attacks:
            raise IsolationError('Platform lacks safe fd-relative directory cleanup')
        shutil.rmtree(path)
        result['removed_paths'].append(name)
    if account:
        tool(['/usr/sbin/userdel', state['name']])  # Never -r/-f; only the verified new account.
    result['account_removed'] = account_record(state['name']) is None
    group = group_record(state['name'])  # userdel may already remove its now-empty private group.
    if group:
        if group.gr_gid != state.get('gid') or group.gr_mem:
            raise IsolationError('New group ownership changed')
        tool(['/usr/sbin/groupdel', state['name']])
    result['group_removed'] = group_record(state['name']) is None
    if not result['account_removed'] or not result['group_removed']:
        raise IsolationError('Owned account/group removal did not complete')
    state.update(cleanup_complete=True, cleanup=result)
    write_json(stage / 'state.json', state)
    return result


def child(stage):
    context = read_json(stage / 'child.json')
    request, uid, gid = context['request'], context['uid'], context['gid']
    actual = identity_record()
    assert_identity(actual, uid, gid, request['pid_namespace'])
    if os.stat('/proc/' + str(context['supervisor_pid'])).st_uid != 0:
        raise IsolationError('Root supervisor must remain visible in the same complete /proc')
    workspace = real_directory(stage / WORKSPACE)
    for name in ('work', str(WORKSPACE), 'home', 'tmp', 'npm-cache'):
        info = (stage / name).stat()
        if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (uid, gid, 0o700):
            raise IsolationError('Private work/home/temp/cache ownership is incorrect')
    os.umask(0o077)
    actual.update(candidate=request['head'], tree=request['tree'], entry=request['entry'],
                  cwd=str(workspace), complete_proc=True, supervisor_visible=True,
                  node=request['node'], node_sha256=request['node_sha256'],
                  kernel=os.uname().release, architecture=os.uname().machine)
    write_json(workspace / '.agent-output/linux-ci-isolation' / request['entry'] / 'child-identity.json', actual)
    bootstrap = verify_child_bootstrap(request, stage)
    write_json(workspace / '.agent-output/linux-ci-isolation' / request['entry'] / 'bootstrap-access.json', bootstrap)
    if bootstrap['status'] != 'PASS':
        raise IsolationError('Nonroot bootstrap setup blocked: ' + ', '.join(bootstrap['errors']))
    os.chdir(workspace)
    os.execve('/bin/bash', ['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
                          command_for(request['entry'])], child_environment(request, stage))


def supervise(stage, cleanup_only=False):
    if os.getuid() != 0 or not sys.platform.startswith('linux'):
        raise IsolationError('Only the marked hosted supervisor may initialize/clean an account')
    request = read_json(stage / 'request.json')
    if request['runner_uid'] <= 0 or request['runner_gid'] <= 0 or request['entry'] not in ENTRIES or \
       not re.fullmatch(r'[0-9a-f]{32}', request['token']) or request['name'] != job_name(request['run_id'], request['attempt'], request['entry']):
        raise IsolationError('Invalid job-owned request')
    validate_stage_parent()
    if stage != stage_directory(request['run_id'], request['attempt'], request['entry']):
        raise IsolationError('Request is outside the exact job/entry directory')
    if int(os.environ.get('SUDO_UID', '-1')) != request['runner_uid'] or \
       int(os.environ.get('SUDO_GID', '-1')) != request['runner_gid']:
        raise IsolationError('Supervisor must originate from this request runner')
    state_path = stage / 'state.json'
    if state_path.exists():
        if state_path.stat().st_uid != 0:
            raise IsolationError('Root state is not root-owned')
        state = read_json(state_path)
    else:
        state = {'stage': str(stage), 'token': request['token'], 'name': request['name'],
                 'owned_directories': {}, 'cleanup_complete': False}
        verify_marker(stage, request, state)
        if stage.stat().st_uid != request['runner_uid']:
            raise IsolationError('Uninitialized directory is not owned by the runner')
        os.chown(stage, 0, 0)
        os.chmod(stage, 0o711)
        os.chown(stage / 'request.json', 0, 0)
        write_json(state_path, state)
    verify_marker(stage, request, state)
    report = {'entry': request['entry'], 'candidate': request['head'], 'tree': request['tree'],
              'command': command_for(request['entry']), 'command_exit': None, 'errors': [],
              'archives': request['archives'], 'protected_sha256': request['protected_sha256'],
              'source_snapshot': request.get('source_snapshot'),
              'cleanup_only': cleanup_only, 'setup_complete': False, 'product_entry_status': 'NOT_RUN'}
    if (stage / 'result.json').exists():
        report = read_json(stage / 'result.json')
    try:
        if not cleanup_only:
            if set(request['archives']) != {'source.tar', 'dependencies.tar'} or \
               set(request['protected_sha256']) != set(PROTECTED):
                raise IsolationError('Only the exact source/dependency archives and candidate fingerprints are allowed')
            if 'uid' in state or account_record(state['name']) or group_record(state['name']):
                raise IsolationError('Entry resources already exist; do not rerun a product command')
            if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
                raise IsolationError('Cannot reap this supervisor\'s orphaned descendants')
            for _ in range(64):
                uid = 40000 + secrets.randbelow(20000)
                try:
                    pwd.getpwuid(uid)
                    continue
                except KeyError:
                    pass
                try:
                    grp.getgrgid(uid)
                    continue
                except KeyError:
                    pass
                if not process_rows(uid):
                    break
            else:
                raise IsolationError('No unused bounded CI UID/GID candidate')
            state.update(uid=uid, gid=uid)
            write_json(state_path, state)
            tool(['/usr/sbin/groupadd', '--gid', str(uid), state['name']])
            # Shadow skips mail creation for --system. CREATE_MAIL_SPOOL is not
            # a login.defs -K key; the explicit, newly allocated UID stays nonroot.
            tool(['/usr/sbin/useradd', '--system', '--uid', str(uid), '--gid', str(uid), '--no-user-group',
                  '--no-create-home', '--no-log-init',
                  '--home-dir', str(stage / 'home'), '--shell', '/usr/sbin/nologin',
                  '--comment', 'boardroom-ci-' + request['token'], state['name']])
            for name in ('work', 'home', 'tmp', 'npm-cache'):
                path = stage / name
                path.mkdir(mode=0o700)
                info = path.stat()
                state['owned_directories'][name] = [info.st_dev, info.st_ino]
                write_json(state_path, state)
            workspace = stage / WORKSPACE
            workspace.mkdir(mode=0o700)
            for name, expected in request['archives'].items():
                archive = stage / name
                if digest(archive) != expected:
                    raise IsolationError('Source/dependency transport hash changed')
                safe_extract(archive, workspace)
            for directory, dirs, files in os.walk(workspace, followlinks=False):
                for name in dirs + files:
                    os.chown(Path(directory) / name, uid, uid, follow_symlinks=False)
            for name in state['owned_directories']:
                os.chown(stage / name, uid, uid)
                os.chmod(stage / name, 0o700)
            os.chown(workspace, uid, uid)
            os.chmod(workspace, 0o700)
            # Private dependency bytes are copies, never links into writable shared node_modules.
            for name, expected in request['protected_sha256'].items():
                if digest(workspace / name) != expected:
                    raise IsolationError('Exact candidate source fingerprint mismatch')
            shutil.copyfile(__file__, stage / 'launcher.py')
            os.chmod(stage / 'launcher.py', 0o444)
            write_json(stage / 'child.json', {'request': request, 'uid': uid, 'gid': uid,
                                            'supervisor_pid': os.getpid()})
            os.chmod(stage / 'child.json', 0o444)
            report['identity'] = {'uid': uid, 'gid': uid, 'name': state['name'], 'private_mode': '0700'}
            report['bootstrap_paths_root_observation'] = path_diagnostics(bootstrap_targets(request, stage))
            report['transport_paths_root_observation'] = path_diagnostics({
                'runner_temp_unused_by_child': (Path(request['runner_temp']), os.X_OK),
                'source_unused_by_child': (Path(request['source']), os.X_OK)})
            argv = ['/usr/bin/setpriv', '--reuid=' + str(uid), '--regid=' + str(uid), '--clear-groups',
                    '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all', '--no-new-privs',
                    '/usr/bin/python3', '-I', str(stage / 'launcher.py'), '--child', str(stage)]
            report['execution'] = run_command(argv, stage, {'PATH': SYSTEM_PATH})
            execution = report['execution']
            report['command_exit'] = 124 if execution['timed_out'] else execution['returncode']
            if execution['signal'] and report['command_exit'] == 0:
                report['command_exit'] = 128 + execution['signal']
            access_receipt = workspace / '.agent-output/linux-ci-isolation' / request['entry'] / 'bootstrap-access.json'
            if access_receipt.exists() and access_receipt.stat().st_uid == uid:
                bootstrap = read_json(access_receipt)
                report['setup_complete'] = bootstrap.get('status') == 'PASS' and bootstrap.get('observer_uid') == uid and \
                    bootstrap.get('candidate') == request['head'] and bootstrap.get('tree') == request['tree']
                report['product_entry_status'] = 'exec_attempted' if report['setup_complete'] else 'NOT_RUN'
    except Exception as error:
        report['errors'].append(str(error))
    finally:
        # Root stops only the verified new UID, then reads independent regular artifacts.
        try:
            account = account_record(state['name'])
            if account and account.pw_uid == state.get('uid') and account.pw_gecos == 'boardroom-ci-' + request['token']:
                lingering = stop_owned_processes(account.pw_uid)
                if lingering:
                    report['terminated_after_command'] = lingering
                    report['errors'].append('Command left owned processes; terminated before collecting artifacts')
        except Exception as error:
            report['errors'].append('process cleanup: ' + str(error))
        try:
            if (stage / WORKSPACE).exists() and 'uid' in state:
                if process_rows(state['uid']):
                    raise IsolationError('Do not collect mutable artifacts while owned processes remain')
                report['artifacts'] = archive_artifacts(stage / WORKSPACE, stage / 'artifacts.tar', state['uid'])
        except Exception as error:
            report['errors'].append('artifact collection: ' + str(error))
        finally:
            if (stage / 'artifacts.tar').exists():
                os.chown(stage / 'artifacts.tar', request['runner_uid'], request['runner_gid'])
                os.chmod(stage / 'artifacts.tar', 0o600)
        try:
            report['cleanup'] = cleanup_owned(stage, request, state)
        except Exception as error:
            report['errors'].append('resource cleanup: ' + str(error))
        report['cleanup_complete'] = state.get('cleanup_complete', False)
        report['exit_code'] = result_code(report['command_exit'], report['errors'])
        write_json(stage / 'result.json', report, (request['runner_uid'], request['runner_gid']))
        if report['cleanup_complete']:
            os.chown(stage, request['runner_uid'], request['runner_gid'])
            os.chmod(stage, 0o700)
    return report['exit_code']


def stage_name(run_id, attempt, entry):
    return f'boardroom-linux-{run_id}-{attempt}-{entry}'


def job_name(run_id, attempt, entry):
    return 'brci' + hashlib.sha256(f'{run_id}/{attempt}/database-tests/{entry}'.encode()).hexdigest()[:16]


def hosted_context():
    if not sys.platform.startswith('linux') or os.getuid() == 0 or os.environ.get('GITHUB_ACTIONS') != 'true' or \
       os.environ.get('GITHUB_JOB') != 'database-tests':
        raise IsolationError('This launcher requires the nonroot Linux GitHub Actions database-tests job')
    run_id, attempt = os.environ.get('GITHUB_RUN_ID', ''), os.environ.get('GITHUB_RUN_ATTEMPT', '')
    if not re.fullmatch(r'[1-9][0-9]{0,19}', run_id) or not re.fullmatch(r'[1-9][0-9]{0,9}', attempt):
        raise IsolationError('Missing exact hosted run identity')
    source = real_directory(Path(os.environ['GITHUB_WORKSPACE']))
    temporary = real_directory(Path(os.environ['RUNNER_TEMP']))
    return source, temporary, run_id, attempt


def import_result(stage, source, entry):
    output = source / '.agent-output/linux-ci-isolation' / entry
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    report = read_json(stage / 'result.json')
    if (stage / 'artifacts.tar').exists():
        merge_artifacts(stage / 'artifacts.tar', source, output / 'prior-artifacts')
    write_json(output / 'lifecycle.json', report)
    if report['cleanup_complete']:
        if stage.stat().st_uid != os.getuid():
            raise IsolationError('Cleaned transport was not returned to its runner')
        shutil.rmtree(stage)
    return report['exit_code']


def frontend(entry):
    source, temporary, run_id, attempt = hosted_context()
    validate_stage_parent()
    if entry == 'cleanup':
        errors = []
        for name in ENTRIES:
            stage = stage_directory(run_id, attempt, name)
            try:
                if stage.exists():
                    subprocess.run(['sudo', '-n', '--', '/usr/bin/python3', '-I', str(Path(__file__).resolve()),
                                    '--cleanup-root', str(stage)], check=False, timeout=45)
                    code = import_result(stage, source, name)
                    if code:
                        errors.append({'entry': name, 'exit_code': code})
                if account_record(job_name(run_id, attempt, name)) or group_record(job_name(run_id, attempt, name)) or stage.exists():
                    errors.append({'entry': name, 'reason': 'Resources retained or account exists without a usable marker'})
            except Exception as error:
                errors.append({'entry': name, 'reason': str(error)})
        write_json(source / '.agent-output/linux-ci-isolation/final-cleanup.json',
                   {'run_id': run_id, 'attempt': attempt, 'checked_entries': list(ENTRIES),
                    'errors': errors, 'status': 'FAIL' if errors else 'PASS'})
        return int(bool(errors))
    command_for(entry)
    if shutil.which('sudo') is None:
        raise IsolationError('Hosted account initialization requires existing passwordless sudo')
    head = tool(['git', 'rev-parse', 'HEAD'], source)
    tree = tool(['git', 'rev-parse', 'HEAD^{tree}'], source)
    if head != os.environ.get('GITHUB_SHA') or not re.fullmatch(r'[0-9a-f]{40}', head) or \
       tool(['git', 'status', '--porcelain', '--untracked-files=no'], source):
        raise IsolationError('Source must be the clean exact GITHUB_SHA candidate')
    node = Path(shutil.which('node') or '').resolve(strict=True)
    if not node.is_file() or node.stat().st_mode & (stat.S_ISUID | stat.S_ISGID):
        raise IsolationError('Node must be an ordinary prepared executable')
    stage = stage_directory(run_id, attempt, entry)
    stage.mkdir(mode=0o700)  # Exclusive: an unfinished entry is recovered, never replayed.
    info = stage.stat()
    request = {'entry': entry, 'head': head, 'tree': tree, 'run_id': run_id, 'attempt': attempt,
               'source': str(source), 'runner_temp': str(temporary), 'runner_uid': os.getuid(), 'runner_gid': os.getgid(),
               'directory_identity': [info.st_dev, info.st_ino], 'name': job_name(run_id, attempt, entry),
               'token': secrets.token_hex(16), 'pid_namespace': os.readlink('/proc/self/ns/pid'),
               'node': str(node), 'node_dir': str(node.parent), 'node_sha256': digest(node),
               'pg_url': os.environ.get('AGENT_STUDIO_PG_TEST_URL'), 'archives': {}, 'protected_sha256': {}}
    write_json(stage / 'request.json', request)
    child_environment(request, stage)  # Reject wrong PG scope before privileged initialization.
    try:
        tool(['git', 'archive', '--format=tar', '--output=' + str(stage / 'source.tar'), head], source)
        request['source_snapshot'] = verify_source_archive(stage / 'source.tar', source)
        if not (source / 'node_modules').is_dir() or (source / 'node_modules').is_symlink():
            raise IsolationError('Use this job\'s real npm ci dependency tree, not a shared symlink')
        extras = ['node_modules'] + [name for name in ('dist', 'build') if (source / name).is_dir()]
        tool(['tar', '-cf', str(stage / 'dependencies.tar'), '-C', str(source), *extras], timeout=90)
        request['archives'] = {name: digest(stage / name) for name in ('source.tar', 'dependencies.tar')}
        request['protected_sha256'] = {name: digest(source / name) for name in PROTECTED}
        write_json(stage / 'request.json', request)
        completed = run_command(['sudo', '-n', '--', '/usr/bin/python3', '-I', str(Path(__file__).resolve()),
                                 '--supervise', str(stage)], source, {'PATH': os.environ['PATH']}, timeout=900, grace=35)
        if not (stage / 'result.json').exists():
            raise IsolationError(f'No supervisor receipt; entry exit {completed["returncode"]}; preserve marker for always cleanup')
        write_json(source / '.agent-output/linux-ci-isolation' / entry / 'launcher-transport.json', completed)
        original_code = import_result(stage, source, entry)
        wrapper_code = 124 if completed['timed_out'] else result_code(completed['returncode'], [])
        if completed['signal'] and wrapper_code == 0:
            wrapper_code = 128 + completed['signal']
        return original_code or wrapper_code
    except Exception as error:
        write_json(source / '.agent-output/linux-ci-isolation' / entry / 'launcher-error.json',
                   {'entry': entry, 'candidate': head, 'tree': tree, 'error': str(error),
                    'preserved_stage': str(stage), 'product_rerun': False})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('entry', nargs='?', choices=(*ENTRIES, 'cleanup'))
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--supervise', type=Path)
    modes.add_argument('--cleanup-root', type=Path)
    modes.add_argument('--child', type=Path)
    args = parser.parse_args()
    try:
        if args.child:
            child(args.child)
        if args.supervise or args.cleanup_root:
            return supervise(args.supervise or args.cleanup_root, cleanup_only=bool(args.cleanup_root))
        if args.entry:
            return frontend(args.entry)
        parser.error('A fixed entry is required')
    except Exception as error:
        print('Linux CI isolation: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
