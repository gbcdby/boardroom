#!/usr/bin/env python3
"""One owned Darwin/PG16.15 PUB-R05 attempt. No shared service or global install."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

VERSION = "16.15"
SOURCE = "https://ftp.postgresql.org/pub/source/v16.15/postgresql-16.15.tar.bz2"
PROGRAMS = ("postgres", "initdb", "pg_ctl", "pg_isready", "pg_dump", "pg_restore", "psql")
TEST = "tests/maintenance-postgres-public-darwin.acceptance.ts"
DIRECTORY_TESTS = (
    "tests/maintenance-postgres-public-directory.test.ts",
    "tests/maintenance-postgres-public-directory.acceptance.ts",
)
DIRECTORY_HEADERS = "native/node-api/v24.22.1"
DIRECTORY_SOURCES = (
    "native/README.md", "native/postgres-public-directory.c", "scripts/build-maintenance-platform.mjs",
    "src/server/storage/maintenance/postgres-public-directory.ts",
    "src/server/storage/maintenance/postgres-public-restore.ts", *DIRECTORY_TESTS,
    "tests/fixtures/postgres-public-directory-controls.ts",
    *(f"{DIRECTORY_HEADERS}/{name}" for name in ("node_api.h", "node_api_types.h", "js_native_api.h",
        "js_native_api_types.h", "LICENSE", "SOURCES.json")),
)
REQUIRED_SOURCES = (
    TEST, *DIRECTORY_TESTS, "tests/fixtures/postgres-public-directory-controls.ts",
    "scripts/ci/run_public_darwin_fd.py", "scripts/build-maintenance-platform.mjs",
    ".github/workflows/public-darwin-fd-acceptance.yml", "package.json", "package-lock.json",
    "src/server/storage/maintenance/postgres.ts", "src/server/storage/maintenance/postgres-public-restore.ts",
    "src/server/storage/maintenance/postgres-public-directory.ts", "native/postgres-public-directory.c", "native/README.md",
    *(f"{DIRECTORY_HEADERS}/{name}" for name in ("node_api.h", "node_api_types.h", "js_native_api.h",
        "js_native_api_types.h", "LICENSE", "SOURCES.json")),
)
ACTIVITY_SECONDS = 600
CLEANUP_SECONDS = 40


def sha(path):
    value = hashlib.sha256()
    with pathlib.Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def source_inventory(repo, tree):
    """Bind the runtime/build/test closure and bundled headers to this exact Git tree."""
    inventory = {}
    for entry in tree.split("\0"):
        if not entry:
            continue
        metadata, relative = entry.split("\t", 1)
        mode, kind, blob = metadata.split(" ")
        if relative not in REQUIRED_SOURCES and not relative.startswith(("src/server/", "native/", "tests/fixtures/")):
            continue
        path = repo / relative
        if kind != "blob" or mode not in ("100644", "100755") or path.resolve() != path or not stat.S_ISREG(path.lstat().st_mode):
            raise RuntimeError(f"qualification source must be a tracked regular file: {relative}")
        contents = path.read_bytes()
        actual_blob = hashlib.sha1(f"blob {len(contents)}\0".encode() + contents).hexdigest()
        if actual_blob != blob:
            raise RuntimeError(f"qualification source differs from candidate tree: {relative}")
        inventory[relative] = {"git_blob": blob, "git_mode": mode, "bytes": len(contents),
                               "sha256": hashlib.sha256(contents).hexdigest()}
    missing = sorted(set(REQUIRED_SOURCES) - inventory.keys())
    if missing:
        raise RuntimeError(f"qualification source inventory is incomplete: {missing}")
    return dict(sorted(inventory.items()))


def bridge_binary_identity(path):
    info = path.lstat()
    if (path.resolve() != path or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o700):
        raise RuntimeError("production directory bridge binary identity/mode is unavailable")
    return {"path": str(path), "device": str(info.st_dev), "inode": str(info.st_ino), "uid": info.st_uid,
            "mode": oct(stat.S_IMODE(info.st_mode)), "nlink": info.st_nlink, "bytes": info.st_size, "sha256": sha(path)}


def header_source_receipt(repo, inventory):
    receipt = json.loads((repo / DIRECTORY_HEADERS / "SOURCES.json").read_text())
    expected = {"node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h", "LICENSE"}
    files = receipt.get("files", [])
    if (receipt.get("upstreamVersion") != "v24.22.1" or receipt.get("napiVersion") != 8
            or receipt.get("origin") != "https://github.com/nodejs/node" or len(files) != len(expected)
            or {item.get("name") for item in files} != expected):
        raise RuntimeError("bundled Node-API header provenance is incomplete")
    for item in files:
        actual = inventory[f"{DIRECTORY_HEADERS}/{item['name']}"]
        if item.get("sha256") != actual["sha256"] or item.get("bytes") != actual["bytes"]:
            raise RuntimeError("bundled Node-API header/license bytes differ from official-source receipt")
    return receipt


def directory_control_gate(receipts, inventory, runtime, binary, uid, exit_code, tap):
    """Require each fixed production control and each independent cleanup receipt."""
    issues = []
    observed_failure = False
    observed_blocked = False
    summary = {}
    expected_runtime = {"platform": "darwin", "arch": "arm64", "node": runtime["node"],
                        "uid": uid, "napi": runtime["napi"]}
    expected_sources = {path: inventory[path]["sha256"] for path in DIRECTORY_SOURCES}
    for suite, ids in (("core", [f"DIRFD-{i:02}" for i in range(1, 11)]), ("socket", ["DIRFD-11"])):
        receipt = receipts.get(suite)
        if not isinstance(receipt, dict):
            issues.append(f"{suite}: missing receipt object")
            continue
        status = receipt.get("status")
        observed_failure |= status == "FAIL"
        observed_blocked |= status == "BLOCKED"
        controls = receipt.get("controls")
        valid_controls = isinstance(controls, list) and all(isinstance(control, dict) for control in controls)
        actual_ids = [control.get("id") for control in controls] if valid_controls else []
        if len(actual_ids) != len(ids) or set(filter(lambda value: isinstance(value, str), actual_ids)) != set(ids):
            issues.append(f"{suite}: missing, extra or repeated control ID")
        if valid_controls:
            observed_failure |= any(control.get("status") == "FAIL" for control in controls)
            observed_blocked |= any(control.get("status") == "BLOCKED" for control in controls)
        if not valid_controls or any(control.get("status") != "PASS" for control in controls):
            issues.append(f"{suite}: every required control must independently PASS")
        if receipt.get("suite") != suite or status != "PASS":
            issues.append(f"{suite}: receipt suite/status did not PASS")
        if receipt.get("runtime") != expected_runtime:
            issues.append(f"{suite}: actual Darwin/runtime/UID/NAPI binding mismatch")
        if receipt.get("headers") != {"upstreamVersion": "v24.22.1", "napiVersion": 8}:
            issues.append(f"{suite}: header source/API binding mismatch")
        loaded = receipt.get("binary")
        required_binary = {"path": binary["path"], "sha256": binary["sha256"], "mode": 0o700,
                           "uid": uid, "nlink": 1, "device": binary["device"], "inode": binary["inode"],
                           "productionDarwinArtifact": True}
        if (not isinstance(loaded, dict) or any(loaded.get(key) != value for key, value in required_binary.items())
                or loaded.get("productionDarwinArtifact") is not True or type(loaded.get("nlink")) is not int):
            issues.append(f"{suite}: actual loaded production binary binding mismatch")
        if receipt.get("sourceSha256") != expected_sources:
            issues.append(f"{suite}: complete fixed production source binding mismatch")
        if receipt.get("nativeAttempted") is not True:
            issues.append(f"{suite}: real production native execution was not reached")
        if receipt.get("remainingOwnedDescriptors") != [] or receipt.get("ownedFixtureRemoved") is not True:
            issues.append(f"{suite}: owned descriptor/fixture cleanup not proven")
        if suite == "socket" and (receipt.get("fixtureCreated") is not True or receipt.get("fixtureStatus") != "CREATED"):
            issues.append("socket: actual Unix socket fixture was not created")
        summary[suite] = {"receipt_status": status, "controls": controls, "nativeAttempted": receipt.get("nativeAttempted"),
                          "ownedFixtureRemoved": receipt.get("ownedFixtureRemoved")}
    tap_summary = dict(re.findall(r"^# (tests|pass|fail|cancelled|skipped) (\d+)$", tap, re.M))
    if exit_code != 0 or tap_summary != {"tests": "13", "pass": "13", "fail": "0", "cancelled": "0", "skipped": "0"}:
        issues.append("core/socket Node process and all 13 parent/control TAP results must pass without skips")
    status = "PASS" if not issues else "FAIL" if observed_failure else "BLOCKED" if observed_blocked else "INCONCLUSIVE"
    return {"status": status, "issues": issues, "suites": summary, "exit_code": exit_code, "tap_summary": tap_summary}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-commit", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.expected_commit):
        parser.error("expected commit must be the exact 40-character GitHub run SHA")
    repo = pathlib.Path(__file__).resolve().parents[2]
    output = repo / ".agent-output/darwin-public-fd-r05"
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    evidence = output / "cases"
    evidence.mkdir(mode=0o700)
    directory_evidence = output / "public-directory"
    directory_evidence.mkdir(mode=0o700)
    started = time.monotonic()
    deadline = started + ACTIVITY_SECONDS
    proof = {"work_id": "BR-COLLAB-S4-T2/PUB-R05-Darwin", "started_at": utc(),
             "expected_commit": args.expected_commit, "maximum_attempts": 1,
             "activity_budget_seconds": ACTIVITY_SECONDS, "cleanup_budget_seconds": CLEANUP_SECONDS,
             "product_status": "NOT_RUN", "public_case_status": "NOT_RUN", "outcome": "BLOCKED", "commands": [],
             "platform": platform.system(), "architecture": platform.machine(), "kernel": platform.release(),
             "image_os": os.environ.get("ImageOS", "unknown"), "image_version": os.environ.get("ImageVersion", "unknown"),
             "production_modified": False, "shared_service_modified": False, "global_tools_modified": False}
    environment = {k: v for k, v in os.environ.items() if not k.startswith("PG") and k != "NODE_OPTIONS"}
    owned = None
    identity = None
    marker = uuid.uuid4().hex
    postmaster = None
    current = None
    server_log = None
    accepted = False
    cleanup_ok = True
    cancelled = False

    def save():
        (output / "execution.json").write_text(json.dumps(proof, indent=2) + "\n")

    def group_alive(process):
        if process is None:
            return False
        try:
            os.killpg(process.pid, 0)
            return True
        except ProcessLookupError:
            return False

    def stopped(process, seconds=8):
        if process is None:
            return
        # Each launched command owns its process group. No PID discovered by name is signalled.
        # The leader may already have exited while a wrapper/native child is still alive.
        for signum, budget in [(signal.SIGTERM, seconds), (signal.SIGKILL, 3)]:
            if not group_alive(process):
                process.poll()
                return
            try:
                os.killpg(process.pid, signum)
            except ProcessLookupError:
                pass
            until = time.monotonic() + budget
            while time.monotonic() < until:
                process.poll()
                if not group_alive(process):
                    return
                time.sleep(0.05)
        raise RuntimeError("owned process group did not exit within cleanup budget")

    def interrupt(signum, _frame):
        nonlocal cancelled
        cancelled = True
        raise InterruptedError(f"runner received signal {signum}")

    def budget_expired(_signum, _frame):
        raise TimeoutError("active wall-clock budget expired")

    def call(name, argv, seconds, cwd=None, env=None, allow_failure=False):
        nonlocal current
        remaining = min(seconds, deadline - time.monotonic())
        if remaining <= 0:
            raise TimeoutError("activity budget exhausted")
        log = output / f"{len(proof['commands']):02d}-{name}.log"
        entry = {"name": name, "argv": [str(a) for a in argv], "started_at": utc(),
                 "budget_seconds": remaining, "log": log.name}
        proof["commands"].append(entry)
        before = time.monotonic()
        try:
            with log.open("wb") as sink:
                current = subprocess.Popen([str(a) for a in argv], cwd=cwd or repo, env=env or environment,
                                           stdin=subprocess.DEVNULL, stdout=sink, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                try:
                    code = current.wait(timeout=remaining)
                except BaseException:
                    stopped(current)
                    raise
            entry["exit_code"] = code
            entry["process_group_clear"] = not group_alive(current)
            if not entry["process_group_clear"]:
                stopped(current, 1)
                raise RuntimeError("command leader exited with surviving owned children")
            if log.stat().st_size > 16 * 1024 * 1024:
                raise RuntimeError("command evidence exceeded 16 MiB")
            text = log.read_text(errors="replace")
            if code != 0 and not allow_failure:
                raise RuntimeError(f"{name} exited {code}; see bounded raw log")
            if time.monotonic() >= deadline:
                raise TimeoutError("activity deadline expired after command/evidence write")
            return code, text
        finally:
            if current is not None:
                entry["actual_exit_code"] = current.poll()
            entry["elapsed_seconds"] = time.monotonic() - before
            if current is not None and current.poll() is not None and not group_alive(current):
                current = None
            save()

    def versions(binary, label):
        observed = {}
        for program in PROGRAMS:
            path = binary / program
            if not path.is_file() or not os.access(path, os.X_OK):
                return None
            code, text = call(f"{label}-{program}-version", [path, "--version"], 3, allow_failure=True)
            observed[program] = text.strip()
            if code or not re.fullmatch(rf"{program} \(PostgreSQL\) {re.escape(VERSION)}", text.strip()):
                return None
        return observed

    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, interrupt)
    signal.signal(signal.SIGALRM, budget_expired)
    signal.setitimer(signal.ITIMER_REAL, ACTIVITY_SECONDS)
    try:
        if platform.system() != "Darwin" or platform.machine() != "arm64" or os.getuid() == 0:
            raise RuntimeError("actual unprivileged Darwin arm64 is required; no platform override")
        _, head = call("git-head", ["git", "rev-parse", "HEAD"], 3)
        _, tree = call("git-tree", ["git", "rev-parse", "HEAD^{tree}"], 3)
        _, status = call("git-status", ["git", "status", "--porcelain=v1"], 3)
        if head.strip() != args.expected_commit or status.strip():
            raise RuntimeError("run candidate changed or is dirty")
        proof.update(candidate=head.strip(), tree=tree.strip(), node=call("node-version", ["node", "--version"], 3)[1].strip())
        _, runtime_text = call("node-runtime", ["node", "-e",
            "process.stdout.write(JSON.stringify({node:process.version,napi:process.versions.napi,modules:process.versions.modules,platform:process.platform,arch:process.arch}))"], 3)
        runtime = json.loads(runtime_text)
        if runtime.get("platform") != "darwin" or runtime.get("arch") != "arm64" or int(runtime.get("napi", "0")) < 8:
            raise RuntimeError("actual Node runtime cannot load the fixed Node-API 8 bridge")
        proof["node_runtime"] = runtime
        call("macos-version", ["sw_vers"], 3)
        call("compiler-version", ["xcrun", "clang", "--version"], 3)
        call("build-compiler-version", ["/usr/bin/cc", "--version"], 3)
        proof["darwin_sdk"] = {"version": call("sdk-version", ["xcrun", "--show-sdk-version"], 3)[1].strip(),
                               "path": call("sdk-path", ["xcrun", "--show-sdk-path"], 3)[1].strip()}
        _, tree_files = call("source-tree-inventory", ["git", "ls-tree", "-rz", "--full-tree", "HEAD"], 3)
        inventory = source_inventory(repo, tree_files)
        (output / "source-inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
        proof["source_sha256"] = {p: record["sha256"] for p, record in inventory.items()}
        proof["directory_headers"] = {"source_version": "v24.22.1", "compiled_node_api_version": 8,
            "actual_runtime_version": runtime["node"], "actual_runtime_napi": runtime["napi"],
            "same_version_headers_claimed": False,
            "source_receipt": header_source_receipt(repo, inventory)}
        # The fixed production build includes host identity, SQLite and the public-directory bridge.
        call("maintenance-native-build", ["node", "scripts/build-maintenance-platform.mjs", "--required"], 30)
        bridge_path = repo / "build/maintenance-platform/postgres-public-directory-arm64.node"
        proof["directory_bridge_binary"] = bridge_binary_identity(bridge_path)
        bridge_copy = output / bridge_path.name
        shutil.copyfile(bridge_path, bridge_copy)
        os.chmod(bridge_copy, 0o600)
        if sha(bridge_copy) != proof["directory_bridge_binary"]["sha256"]:
            raise RuntimeError("saved bridge binary differs from production build")
        owned = pathlib.Path(tempfile.mkdtemp(prefix="boardroom-r05-")).resolve()
        os.chmod(owned, 0o700)
        identity = (owned.stat().st_dev, owned.stat().st_ino)
        (owned / "owner.json").write_text(json.dumps({"token": marker, "uid": os.getuid(), "candidate": head.strip()}))
        proof["owned_root"] = {"path": str(owned), "device": str(identity[0]), "inode": str(identity[1]), "uid": os.getuid()}
        runtime_tmp = owned / "fixtures"
        runtime_tmp.mkdir(mode=0o700)
        environment["TMPDIR"] = str(runtime_tmp)
        environment["BOARDROOM_PUBLIC_DIRECTORY_EVIDENCE"] = str(directory_evidence)
        proof["product_status"] = "RUNNING"
        proof["directory_controls"] = {"status": "RUNNING", "receipts": str(directory_evidence.relative_to(output))}
        code, tap = call("production-directory-controls", ["node", "--test", "--test-reporter=tap",
            "--test-timeout=30000", "--test-concurrency=1", *DIRECTORY_TESTS], 45, allow_failure=True)
        receipts = {}
        receipt_errors = []
        for suite in ("core", "socket"):
            path = directory_evidence / f"public-directory-{suite}.json"
            try:
                info = path.lstat()
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 1024 * 1024):
                    raise RuntimeError("receipt file identity/size is invalid")
                receipts[suite] = json.loads(path.read_text())
            except (OSError, ValueError, RuntimeError) as error:
                receipt_errors.append(f"{suite}: {type(error).__name__}: {str(error)[:256]}")
        gate = directory_control_gate(receipts, inventory, runtime, proof["directory_bridge_binary"], os.getuid(), code, tap)
        gate["issues"].extend(receipt_errors)
        if bridge_binary_identity(bridge_path) != proof["directory_bridge_binary"]:
            gate["issues"].append("production bridge binary changed during core/socket controls")
        if source_inventory(repo, tree_files) != inventory:
            gate["issues"].append("qualification source inventory changed during core/socket controls")
        if gate["issues"] and gate["status"] == "PASS":
            gate["status"] = "INCONCLUSIVE"
        proof["directory_controls"] = gate
        if gate["status"] != "PASS":
            proof["product_status"] = "NOT_RUN" if gate["status"] == "BLOCKED" else gate["status"]
            raise RuntimeError("production directory core/socket qualification did not pass; see independent receipts")
        proof["product_status"] = "NOT_RUN"
        binary = None
        candidates = [pathlib.Path("/opt/homebrew/opt/postgresql@16/bin")]
        installed = shutil.which("postgres")
        if installed:
            candidates.append(pathlib.Path(installed).resolve().parent)
        for choice in dict.fromkeys(candidates):
            actual = versions(choice, "existing")
            if actual:
                binary = choice.resolve()
                proof["tools"] = {"origin": "preexisting-readonly", "bin": str(binary), "versions": actual}
                break
        if binary is None:
            archive = owned / "postgresql-16.15.tar.bz2"
            checksum = output / "postgresql-16.15.tar.bz2.sha256"
            common = ["curl", "--fail", "--location", "--silent", "--show-error", "--proto", "=https",
                      "--connect-timeout", "10", "--max-time", "30", "--retry", "0"]
            call("official-checksum", [*common, "--max-filesize", "512", SOURCE + ".sha256", "--output", checksum], 32)
            value = checksum.read_text().strip()
            match = re.fullmatch(r"([a-f0-9]{64})\s+\*?postgresql-16\.15\.tar\.bz2", value)
            if not match:
                raise RuntimeError("official checksum has unexpected format")
            call("official-source", [*common, "--max-filesize", str(32 * 1024 * 1024), SOURCE, "--output", archive], 32)
            actual_sha = sha(archive)
            if actual_sha != match[1]:
                raise RuntimeError("official source checksum mismatch")
            proof["official_source"] = {"url": SOURCE, "checksum_url": SOURCE + ".sha256", "sha256": actual_sha,
                                        "bytes": archive.stat().st_size, "signature_verified": False}
            with tarfile.open(archive, "r:bz2") as bundle:
                members = bundle.getmembers()
                if len(members) > 30000 or sum(m.size for m in members) > 400 * 1024 * 1024:
                    raise RuntimeError("official source archive exceeds fixture bound")
                for member in members:
                    parts = pathlib.PurePosixPath(member.name).parts
                    if not parts or parts[0] != "postgresql-16.15" or ".." in parts or not (member.isdir() or member.isfile()):
                        raise RuntimeError("unsafe source archive member")
                bundle.extractall(owned, filter="data")
            source = owned / "postgresql-16.15"
            prefix = owned / "pg16.15"
            call("configure", [source / "configure", f"--prefix={prefix}", "--without-readline", "--without-icu"], 60, cwd=source)
            call("make", ["make", "-j3"], 300, cwd=source)
            call("install-private", ["make", "install"], 45, cwd=source)
            binary = (prefix / "bin").resolve()
            actual = versions(binary, "built")
            if not actual:
                raise RuntimeError("built tools do not match exact 16.15 profile")
            proof["tools"] = {"origin": "official-source-private-build", "bin": str(binary), "versions": actual}
        proof["tool_binary_sha256"] = {name: sha(binary / name) for name in PROGRAMS}
        environment["PATH"] = str(binary) + os.pathsep + environment.get("PATH", "")
        user = "br_pub_r05_" + uuid.uuid4().hex[:12]
        data = owned / "data"
        call("initdb-owned", [binary / "initdb", "-D", data, "-U", user, "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-instructions"], 20)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        if port == 5432:
            raise RuntimeError("default shared service port is forbidden")
        server_log = (output / "owned-postgres.log").open("wb")
        postmaster = subprocess.Popen([str(binary / "postgres"), "-D", str(data), "-h", "127.0.0.1", "-p", str(port),
            "-c", "unix_socket_directories=", "-c", "fsync=on", "-c", "max_connections=20", "-c", "shared_buffers=16MB",
            "-c", "log_statement=none", "-c", "log_min_messages=warning"], env=environment,
            stdin=subprocess.DEVNULL, stdout=server_log, stderr=subprocess.STDOUT, start_new_session=True)
        proof["owned_postmaster"] = {"pid": postmaster.pid, "port": port, "data": str(data), "listen": "127.0.0.1", "unix_socket": "disabled"}
        environment.update(PGHOST="127.0.0.1", PGPORT=str(port), PGUSER=user, PGDATABASE="postgres", PGCONNECT_TIMEOUT="2")
        ready_until = min(deadline, time.monotonic() + 15)
        while time.monotonic() < ready_until:
            if postmaster.poll() is not None:
                raise RuntimeError("owned postmaster exited before ready")
            code, _ = call("owned-ready", [binary / "pg_isready", "--quiet", "--timeout=1"], 2, allow_failure=True)
            if code == 0:
                break
            time.sleep(0.1)
        else:
            raise TimeoutError("owned server readiness deadline")
        _, facts = call("owned-server-identity", [binary / "psql", "--no-psqlrc", "--no-password", "-Atc",
            "SELECT current_setting('data_directory')||'|'||current_setting('port')||'|'||current_setting('server_version_num')||'|'||(pg_control_system()).system_identifier::text"], 5)
        actual_data, actual_port, version, system_id = facts.strip().split("|")
        pid_lines = (data / "postmaster.pid").read_text().splitlines()
        if pathlib.Path(actual_data).resolve() != data.resolve() or actual_port != str(port) or version != "160015" or int(pid_lines[0]) != postmaster.pid:
            raise RuntimeError("owned server identity does not match this process/cluster")
        proof["owned_postmaster"].update(system_identifier=system_id, identity_verified=True)
        environment.update(AGENT_STUDIO_PG_TEST_URL=f"postgres://{user}@127.0.0.1:{port}/postgres",
            BOARDROOM_PUB_R05_PG_BIN=str(binary), BOARDROOM_PUB_R05_EVIDENCE=str(evidence), BOARDROOM_PUB_R05_OWNED_DATA=str(data))
        proof["product_status"] = "RUNNING"
        proof["public_case_status"] = "RUNNING"
        code, tap = call("darwin-native-acceptance", ["node", "--test", "--test-reporter=tap", "--test-timeout=120000",
            "--test-concurrency=1", TEST], 130, env=environment, allow_failure=True)
        if code != 0:
            proof["product_status"] = "FAIL"
            proof["public_case_status"] = "FAIL"
        result = json.loads((evidence / "acceptance.json").read_text()) if (evidence / "acceptance.json").exists() else None
        accepted = (code == 0 and result is not None and result.get("actualDarwinExecution") is True
                    and len(result.get("cases", [])) == 5 and all(c.get("status") == c.get("cleanup") == "PASS" for c in result["cases"]))
        proof["product_status"] = "PASS" if accepted else "FAIL"
        proof["tap_summary"] = dict(re.findall(r"^# (tests|pass|fail|cancelled|skipped) (\d+)$", tap, re.M))
        if proof["tap_summary"].get("skipped") != "0":
            accepted = False
            proof["product_status"] = "FAIL"
        proof["public_case_status"] = proof["product_status"]
        proof["directory_bridge_binary_after"] = bridge_binary_identity(bridge_path)
        if proof["directory_bridge_binary_after"] != proof["directory_bridge_binary"]:
            raise RuntimeError("production directory bridge changed during qualification")
        if source_inventory(repo, tree_files) != inventory:
            raise RuntimeError("qualification source inventory changed during execution")
        _, after = call("git-status-after", ["git", "status", "--porcelain=v1"], 3)
        if after.strip():
            raise RuntimeError("candidate changed during acceptance")
        proof["outcome"] = proof["product_status"]
    except BaseException as error:
        proof["error"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        if proof["product_status"] == "RUNNING":
            proof["product_status"] = "INCONCLUSIVE"
        if proof["public_case_status"] == "RUNNING":
            proof["public_case_status"] = "INCONCLUSIVE"
        proof["outcome"] = "FAIL" if proof["product_status"] == "FAIL" else "INCONCLUSIVE" if proof["product_status"] != "NOT_RUN" else "BLOCKED"
        accepted = False
    finally:
        # Cleanup has its own bounded window; a second signal cannot interrupt ownership checks midway.
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, signal.SIG_IGN)
        signal.setitimer(signal.ITIMER_REAL, CLEANUP_SECONDS)
        cleanup_started = time.monotonic()
        try:
            stopped(current, 3)
            if postmaster is not None and postmaster.poll() is None:
                postmaster.send_signal(signal.SIGINT)  # fast stop of exactly this owned child
                try:
                    postmaster.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    cleanup_ok = False
                    stopped(postmaster, 3)
            if postmaster is not None:
                proof["postmaster_exit"] = postmaster.poll()
                cleanup_ok = cleanup_ok and postmaster.poll() == 0
                if group_alive(postmaster):
                    cleanup_ok = False
                    stopped(postmaster, 3)
                proof["postmaster_group_clear"] = not group_alive(postmaster)
            if server_log:
                server_log.close()
            if owned is not None:
                info = owned.lstat()
                saved = json.loads((owned / "owner.json").read_text())
                if not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != identity or info.st_uid != os.getuid() or saved["token"] != marker:
                    raise RuntimeError("owned root identity changed; refusing recursive removal")
                proof["pid_file_absent_before_remove"] = not (owned / "data/postmaster.pid").exists()
                if postmaster is not None and (owned / "data/postmaster.pid").exists():
                    cleanup_ok = False
                shutil.rmtree(owned)
                proof["owned_root_removed"] = not owned.exists()
        except BaseException as error:
            cleanup_ok = False
            proof["cleanup_error"] = {"type": type(error).__name__, "message": str(error)[:1000]}
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        elapsed = time.monotonic() - cleanup_started
        cleanup_ok = cleanup_ok and elapsed <= CLEANUP_SECONDS
        proof.update(cleanup="PASS" if cleanup_ok else "FAIL", cleanup_elapsed_seconds=elapsed,
                     cancelled=cancelled, finished_at=utc(), total_seconds=time.monotonic() - started)
        if not cleanup_ok:
            proof["outcome"] = "FAIL" if proof["product_status"] == "FAIL" else "INCONCLUSIVE"
        save()
        records = [{"path": str(p.relative_to(output)), "bytes": p.stat().st_size, "sha256": sha(p)}
                   for p in sorted(output.rglob("*")) if p.is_file() and p.name != "sha256.json"]
        (output / "sha256.json").write_text(json.dumps({"files": records}, indent=2) + "\n")
    print(json.dumps({"outcome": proof["outcome"], "product_status": proof["product_status"], "cleanup": proof["cleanup"]}))
    return 0 if accepted and cleanup_ok else 1


if __name__ == "__main__":
    sys.exit(main())
