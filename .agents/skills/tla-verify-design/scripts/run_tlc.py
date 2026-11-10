#!/usr/bin/env python3
"""Run a deliberately limited, reproducible TLC model check (Python 3.10+).

This is an evidence collector, not a sandbox or a proof of implementation.
Only the documented manifest/config subset is accepted; unsupported syntax
fails closed. No shell command, arbitrary JVM option, or extra TLC argument is
accepted from the manifest. See references/execution.md for the contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

STATUSES = {
    "PASS_WITHIN_SCOPE": 0,
    "COUNTEREXAMPLE": 2,
    "INCONCLUSIVE": 3,
    "TOOL_ERROR": 4,
}
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
HEADERS = {
    "SPECIFICATION", "INIT", "NEXT", "CONSTANT", "CONSTANTS",
    "INVARIANT", "INVARIANTS", "PROPERTY", "PROPERTIES", "CHECK_DEADLOCK",
    "CONSTRAINT", "CONSTRAINTS", "ACTION_CONSTRAINT", "ACTION_CONSTRAINTS",
    "SYMMETRY", "VIEW", "ALIAS", "POSTCONDITION",
}
SUPPORTED_HEADERS = {
    "SPECIFICATION", "INIT", "NEXT", "CONSTANT", "CONSTANTS",
    "INVARIANT", "INVARIANTS", "PROPERTY", "PROPERTIES", "CHECK_DEADLOCK",
}
# Known stateful, randomized, or external-I/O helpers are outside this runner's
# supported pure-model subset. This lexical guard is deliberately conservative;
# it is not a semantic verifier and does not replace source review.
UNSUPPORTED_IDENTIFIERS = {
    "TLCSet", "TLCGet", "JavaTime", "RandomElement", "Randomization", "Any",
    "IOUtils", "Json", "CSV", "PickSuccessor",
}
STRIPPED_ENV = (
    "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH",
    "TLA_LIBRARY", "TLA-Library",
)
MESSAGE = re.compile(
    r"@!@!@STARTMSG (\d+):(\d+) @!@!@\r?\n(.*?)"
    r"@!@!@ENDMSG \1 @!@!@", re.DOTALL
)
COUNTEREXAMPLE_CODES = {2107, 2108, 2110, 2112, 2114, 2116, 2132}
RESOURCE_CODES = {1001, 1002, 1003, 1005}


class RunnerError(Exception):
    """Invalid inputs or unsupported runner configuration."""


class RunInterrupted(Exception):
    """Signal requested termination."""


class EvidenceArgumentParser(argparse.ArgumentParser):
    """Keep invalid command lines distinct from model counterexamples."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(json.dumps({"status": "TOOL_ERROR", "reason": message, "result": None}, ensure_ascii=False))
        raise SystemExit(STATUSES["TOOL_ERROR"])


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest_file(path: Path) -> str:
    with path.open("rb") as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def require_dict(value: object, label: str) -> dict:
    if not isinstance(value, dict):
        raise RunnerError(f"{label} must be an object")
    return value


def positive_number(value: object, label: str, integer: bool = False) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RunnerError(f"{label} must be a positive {'integer' if integer else 'number'}")
    if not math.isfinite(value) or value <= 0 or (integer and not isinstance(value, int)):
        raise RunnerError(f"{label} must be a finite positive {'integer' if integer else 'number'}")
    return value


def names(value: object, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(x, str) or not IDENTIFIER.fullmatch(x) for x in value):
        raise RunnerError(f"{label} must be a list of simple TLA+ operator identifiers")
    if len(value) != len(set(value)):
        raise RunnerError(f"{label} contains duplicates")
    return value


def relative_file(root: Path, value: object, suffix: str, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise RunnerError(f"{label} must be a relative file path")
    raw = Path(value)
    if raw.is_absolute() or ".." in raw.parts:
        raise RunnerError(f"{label} must stay within model.root")
    path = root / raw
    if path.suffix != suffix or not path.is_file():
        raise RunnerError(f"{label} must name an existing {suffix} file")
    return path


def lex(text: str) -> list[tuple[str, str]]:
    """Tokenize the supported cfg subset, honoring strings/nested comments.

    No TLA+ expression is evaluated or claimed to be parsed here. Unknown
    config syntax is left to TLC after the explicit subset checks.
    """
    tokens: list[tuple[str, str]] = []
    i = 0
    while i < len(text):
        char = text[i]
        if char.isspace():
            i += 1
        elif text.startswith("\\*", i):
            end = text.find("\n", i)
            i = len(text) if end < 0 else end + 1
        elif text.startswith("(*", i):
            i += 2
            depth = 1
            while i < len(text) and depth:
                if text.startswith("(*", i):
                    depth += 1
                    i += 2
                elif text.startswith("*)", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                raise RunnerError("Unterminated block comment")
        elif char == '"':
            begin = i
            i += 1
            while i < len(text):
                if text[i] == "\\":
                    i += 2
                elif text[i] == '"':
                    i += 1
                    tokens.append(("string", text[begin:i]))
                    break
                else:
                    i += 1
            else:
                raise RunnerError("Unterminated string")
        elif char.isascii() and (char.isalpha() or char == "_"):
            begin = i
            i += 1
            while i < len(text) and text[i].isascii() and (text[i].isalnum() or text[i] == "_"):
                i += 1
            tokens.append(("identifier", text[begin:i]))
        elif text.startswith("<-", i):
            tokens.append(("symbol", "<-"))
            i += 2
        else:
            tokens.append(("symbol", char))
            i += 1
    return tokens


def inspect_config(text: str, profile: dict) -> dict:
    tokens = lex(text)
    sections: list[tuple[str, list[tuple[str, str]]]] = []
    for kind, value in tokens:
        if kind == "identifier" and value in HEADERS:
            if value not in SUPPORTED_HEADERS:
                raise RunnerError(f"Unsupported config directive {value}; use a separately reviewed workflow")
            sections.append((value, []))
        elif not sections:
            raise RunnerError("Configuration must begin with a supported directive")
        else:
            sections[-1][1].append((kind, value))
    if not sections:
        raise RunnerError("Configuration is empty")
    collected: dict[str, list[str]] = {"invariants": [], "properties": []}
    behavior: dict[str, str] = {}
    deadlock = True  # TLC's documented default.
    seen_deadlock = False
    for key, values in sections:
        if key in {"CONSTANT", "CONSTANTS"}:
            if not values or any(value == "<-" for _, value in values):
                raise RunnerError("Use literal CONSTANT(S) assignments; definition overrides are unsupported")
            continue
        if key in {"INVARIANT", "INVARIANTS", "PROPERTY", "PROPERTIES"}:
            if not values or any(kind != "identifier" or not IDENTIFIER.fullmatch(value) for kind, value in values):
                raise RunnerError(f"{key} accepts only whitespace-separated simple operator names")
            target = "invariants" if key.startswith("INVARIANT") else "properties"
            collected[target].extend(value for _, value in values)
        elif key == "CHECK_DEADLOCK":
            if seen_deadlock or values not in [[("identifier", "TRUE")], [("identifier", "FALSE")]]:
                raise RunnerError("CHECK_DEADLOCK must occur at most once with TRUE or FALSE")
            seen_deadlock = True
            deadlock = values[0][1] == "TRUE"
        else:
            if key in behavior or len(values) != 1 or values[0][0] != "identifier":
                raise RunnerError(f"{key} must occur once with a simple operator name")
            behavior[key] = values[0][1]
    if set(behavior) not in [{"SPECIFICATION"}, {"INIT", "NEXT"}]:
        raise RunnerError("Use either SPECIFICATION or INIT plus NEXT, exclusively")
    for field in ("invariants", "properties"):
        actual = collected[field]
        expected = names(profile.get("expected_" + field), "expected_" + field)
        if len(actual) != len(set(actual)) or set(actual) != set(expected):
            raise RunnerError(f"Configured {field} must exactly match expected_{field}; expected={expected}, configured={actual}")
    if not collected["invariants"] and not collected["properties"]:
        raise RunnerError("At least one explicit invariant or temporal property is required")
    if type(profile.get("checks_deadlock")) is not bool or deadlock != profile["checks_deadlock"]:
        raise RunnerError("checks_deadlock must be explicit and agree with CHECK_DEADLOCK (default TRUE)")
    if not deadlock and not isinstance(profile.get("deadlock_reason"), str):
        raise RunnerError("Disabling deadlock checking requires a nonempty deadlock_reason")
    if not deadlock and not profile["deadlock_reason"].strip():
        raise RunnerError("Disabling deadlock checking requires a nonempty deadlock_reason")
    return {
        "expected_invariants": profile["expected_invariants"],
        "expected_properties": profile["expected_properties"],
        "configured_invariants": collected["invariants"],
        "configured_properties": collected["properties"],
        "checks_deadlock": deadlock,
        "deadlock_reason": profile.get("deadlock_reason"),
        "behavior": behavior,
    }


def snapshot_model(root: Path, target: Path) -> list[dict]:
    """Snapshot local TLA+/cfg files; all other dependency forms are unsupported."""
    files: list[dict] = []
    module_names: set[str] = set()
    target.mkdir()
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise RunnerError(f"Symlinks are unsupported within model.root: {path.relative_to(root)}")
        if not path.is_file():
            continue
        if path.suffix.lower() in {".class", ".jar", ".java"}:
            raise RunnerError("Keep Java overrides/libraries outside model.root; this runner does not load them")
        if path.suffix not in {".tla", ".cfg"}:
            continue
        relative = path.relative_to(root)
        data = path.read_bytes()
        text = data.decode("utf-8-sig")
        if path.suffix == ".tla":
            if path.stem in module_names:
                raise RunnerError(f"Duplicate local module basename: {path.stem}")
            module_names.add(path.stem)
            identifiers = {value for kind, value in lex(text) if kind == "identifier"}
            unsupported = sorted(identifiers & UNSUPPORTED_IDENTIFIERS)
            if unsupported:
                raise RunnerError(f"Unsupported stateful/random/external helper(s) in {relative}: {', '.join(unsupported)}")
            if "@!@!@" in text:
                raise RunnerError(f"Reserved TLC message delimiter in model input: {relative}")
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        files.append({"path": relative.as_posix(), "sha256": digest_bytes(data), "bytes": len(data)})
    if not files:
        raise RunnerError("No model input files found")
    return files


def parse_messages(text: str) -> list[dict]:
    return [{"code": int(m[1]), "severity": int(m[2]), "text": m[3].strip()} for m in MESSAGE.finditer(text)]


def classify(messages: list[dict], exit_code: int | None, timed_out: bool = False,
             interrupted: bool = False, raw_text: str = "") -> tuple[str, str, dict]:
    codes = {message["code"] for message in messages}
    statistics = {"generated_states": None, "distinct_states": None, "remaining_states": None}
    for message in messages:
        if message["code"] == 2199:
            match = re.search(r"([\d,]+) states? generated, ([\d,]+) distinct states? found, ([\d,]+) states? left on queue", message["text"])
            if match:
                statistics = dict(zip(statistics, (int(v.replace(",", "")) for v in match.groups())))
    if timed_out or interrupted:
        return "INCONCLUSIVE", "TIMEOUT" if timed_out else "INTERRUPTED", statistics
    if codes & COUNTEREXAMPLE_CODES:
        return "COUNTEREXAMPLE", "PROPERTY_OR_DEADLOCK_VIOLATION", statistics
    if codes & RESOURCE_CODES or any(x in raw_text for x in ("OutOfMemoryError", "StackOverflowError")):
        return "INCONCLUSIVE", "RESOURCE_LIMIT", statistics
    if exit_code is not None and exit_code < 0:
        return "INCONCLUSIVE", "PROCESS_TERMINATED", statistics
    if 2118 in codes:
        return "TOOL_ERROR", "NO_INITIAL_STATES", statistics
    if any(m["severity"] in {1, 2} for m in messages):
        return "TOOL_ERROR", "TLC_REPORTED_ERROR", statistics
    if exit_code != 0:
        return "TOOL_ERROR", "NONZERO_EXIT", statistics
    if 2188 in codes or 2271 in codes:
        return "TOOL_ERROR", "UNEXPECTED_CHECKING_MODE", statistics
    if not {2187, 2193, 2186, 2199}.issubset(codes):
        return "INCONCLUSIVE", "MISSING_COMPLETION_EVIDENCE", statistics
    if not (statistics["distinct_states"] is not None and statistics["distinct_states"] > 0):
        return "TOOL_ERROR", "NO_REACHABLE_STATES", statistics
    if statistics["remaining_states"] != 0:
        return "INCONCLUSIVE", "UNEXPLORED_STATES_REMAIN", statistics
    return "PASS_WITHIN_SCOPE", "COMPLETE_MODEL_CHECK", statistics


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=3)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        if process.poll() is None:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
            process.wait(timeout=3)


def handle_signal(signum: int, frame: object) -> None:
    raise RunInterrupted(f"signal {signum}")


def execute(args: argparse.Namespace) -> tuple[dict, Path | None]:
    started = time.monotonic()
    result = {
        "schema_version": 1, "run_id": str(uuid.uuid4()),
        "status": "TOOL_ERROR", "reason": "PREFLIGHT_NOT_COMPLETE",
        "mode": "modelcheck", "profile": args.profile,
        "started_at": utc_now(), "finished_at": None, "duration_seconds": None,
        "completed": False, "implementation_status": "NOT_ASSESSED",
        "tool": {}, "inputs": {}, "checks": {}, "scope": {}, "assumptions": [],
        "command": [], "process": {"exit_code": None, "timed_out": False, "interrupted": False},
        "statistics": {}, "evidence": {}, "message_codes": [], "error_codes": [], "warning_codes": [],
    }
    output: Path | None = None
    try:
        requested = Path(args.out).expanduser().absolute()
        if requested.exists():
            raise RunnerError("Output directory already exists; choose a fresh run directory. Existing evidence was not modified.")
        requested.mkdir(parents=True, exist_ok=False)
        output = requested.resolve()
        write_json(output / "result.json", result)
        manifest_path = Path(args.manifest).expanduser().resolve(strict=True)
        manifest_data = manifest_path.read_bytes()
        manifest = require_dict(json.loads(manifest_data.decode("utf-8-sig")), "manifest")
        if type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 1:
            raise RunnerError("Only manifest schema_version 1 is supported")
        model = require_dict(manifest.get("model"), "model")
        root_value = model.get("root")
        if not isinstance(root_value, str) or not root_value or Path(root_value).is_absolute():
            raise RunnerError("model.root must be a directory relative to the manifest")
        root = (manifest_path.parent / root_value).resolve(strict=True)
        if not root.is_dir():
            raise RunnerError("model.root must be a directory")
        if output == root or root in output.parents:
            raise RunnerError("Place --out outside model.root so snapshots cannot include themselves")
        profiles = require_dict(manifest.get("profiles"), "profiles")
        profile = require_dict(profiles.get(args.profile), "selected profile")
        allowed_profile = {
            "config", "timeout_seconds", "workers", "heap_mb", "expected_invariants",
            "expected_properties", "checks_deadlock", "deadlock_reason", "scope", "assumptions",
        }
        if set(profile) - allowed_profile:
            raise RunnerError("Unsupported profile field(s): " + ", ".join(sorted(set(profile) - allowed_profile)))
        timeout = positive_number(profile.get("timeout_seconds"), "timeout_seconds")
        workers = positive_number(profile.get("workers"), "workers", integer=True)
        heap = positive_number(profile.get("heap_mb"), "heap_mb", integer=True)
        result["scope"] = require_dict(profile.get("scope"), "scope")
        assumptions = profile.get("assumptions")
        if not isinstance(assumptions, list) or any(not isinstance(x, str) for x in assumptions):
            raise RunnerError("assumptions must be a list of strings (use [] explicitly if none)")
        result["assumptions"] = assumptions
        entry = relative_file(root, model.get("entry"), ".tla", "model.entry")
        config = relative_file(root, profile.get("config"), ".cfg", "profile.config")
        snapshot = output / "input"
        files = snapshot_model(root, snapshot)
        result["inputs"] = {
            "manifest_sha256": digest_bytes(manifest_data), "model_root": str(root),
            "snapshot_directory": str(snapshot), "files": files,
            "runner_sha256": digest_file(Path(__file__).resolve()),
        }
        (output / "manifest.json").write_bytes(manifest_data)
        config_snapshot = snapshot / config.relative_to(root)
        entry_snapshot = snapshot / entry.relative_to(root)
        result["checks"] = inspect_config(config_snapshot.read_text(encoding="utf-8-sig"), profile)
        pinned_tool = require_dict(manifest.get("tool"), "tool")
        expected_sha = pinned_tool.get("sha256")
        label = pinned_tool.get("version")
        if not isinstance(expected_sha, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha):
            raise RunnerError("tool.sha256 must pin the actual 64-character SHA256")
        if not isinstance(label, str) or not label.strip():
            raise RunnerError("tool.version must be an explicit descriptive version label")
        original_jar = Path(args.jar).expanduser()
        if not original_jar.is_absolute() or not original_jar.is_file():
            raise RunnerError("--jar must be an existing absolute file path")
        tool_dir = output / "tool"
        tool_dir.mkdir()
        jar = tool_dir / "tla2tools.jar"
        shutil.copyfile(original_jar, jar)
        actual_sha = digest_file(jar)
        if actual_sha.lower() != expected_sha.lower():
            raise RunnerError("Tool SHA256 mismatch; no model check was started")
        java = shutil.which(args.java)
        if not java:
            raise RunnerError("Java executable is unavailable")
        environment = os.environ.copy()
        stripped = [key for key in STRIPPED_ENV if key in environment]
        for key in STRIPPED_ENV:
            environment.pop(key, None)
        # Values of removed variables are never recorded.
        environment["LC_ALL"] = "C"
        environment["LANG"] = "C"
        version = subprocess.run([java, "-version"], shell=False, env=environment,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 timeout=min(float(timeout), 10.0), text=True, encoding="utf-8", errors="replace")
        if version.returncode != 0:
            raise RunnerError("Java version probe failed")
        result["tool"] = {
            "version_label": label, "sha256": actual_sha, "jar_snapshot": str(jar),
            "java_path": java, "java_version": version.stdout.strip(),
            "removed_environment_names": stripped,
        }
        # TLC 2.19 treats an empty statistics-id system property as an enabled
        # (empty) identifier. Use an isolated home with an empty opt-in file
        # instead; never read/change the user's TLC statistics preferences.
        runtime_home = output / "runtime-home"
        preferences = runtime_home / ".tlaplus"
        preferences.mkdir(parents=True)
        (preferences / "esc.txt").write_bytes(b"")
        runtime_tmp = output / "tmp"
        runtime_tmp.mkdir()
        libdirs = sorted({str((snapshot / row["path"]).parent) for row in files if row["path"].endswith(".tla")})
        command = [java, f"-Xmx{heap}m", "-XX:+UseParallelGC",
                   "-Duser.language=en", "-Duser.country=US",
                   "-Duser.home=" + str(runtime_home),
                   "-Djava.io.tmpdir=" + str(runtime_tmp),
                   "-DTLA-Library=" + os.pathsep.join(libdirs),
                   "-cp", str(jar), "tlc2.TLC", "-tool", "-modelcheck",
                   "-workers", str(workers), "-metadir", str(output / "states"),
                   "-config", str(config_snapshot), str(entry_snapshot)]
        log = output / "tlc.log"
        result["command"] = command
        result["evidence"] = {"log": str(log), "messages": str(output / "messages.json")}
        result["status"] = "INCONCLUSIVE"
        result["reason"] = "RUNNING_OR_TERMINATED_BEFORE_FINAL_REPORT"
        write_json(output / "result.json", result)
        process: subprocess.Popen | None = None
        previous = {}
        try:
            for sig in (signal.SIGINT, signal.SIGTERM):
                previous[sig] = signal.signal(sig, handle_signal)
            with log.open("wb") as stream:
                process = subprocess.Popen(command, cwd=entry_snapshot.parent, env=environment,
                                           stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                           shell=False, start_new_session=(os.name == "posix"))
                try:
                    process.wait(timeout=float(timeout))
                except subprocess.TimeoutExpired:
                    result["process"]["timed_out"] = True
                except (KeyboardInterrupt, RunInterrupted):
                    result["process"]["interrupted"] = True
                finally:
                    stop_process(process)
                    result["process"]["exit_code"] = process.returncode
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        raw = log.read_text(encoding="utf-8", errors="replace")
        messages = parse_messages(raw)
        write_json(output / "messages.json", messages)
        result["message_codes"] = sorted({m["code"] for m in messages})
        result["error_codes"] = sorted({m["code"] for m in messages if m["severity"] in {1, 2}})
        result["warning_codes"] = sorted({m["code"] for m in messages if m["severity"] == 3})
        result["tool"]["reported_version"] = next((m["text"] for m in messages if m["code"] == 2262), None)
        result["status"], result["reason"], result["statistics"] = classify(messages, **result["process"], raw_text=raw)
        result["completed"] = result["status"] == "PASS_WITHIN_SCOPE"
    except subprocess.TimeoutExpired:
        result.update(status="INCONCLUSIVE", reason="JAVA_PROBE_TIMEOUT")
        result["process"]["timed_out"] = True
    except (KeyboardInterrupt, RunInterrupted):
        result.update(status="INCONCLUSIVE", reason="INTERRUPTED")
        result["process"]["interrupted"] = True
    except (RunnerError, OSError, UnicodeError, ValueError, TypeError) as exc:
        result.update(status="TOOL_ERROR", reason=str(exc))
    finally:
        result["finished_at"] = utc_now()
        result["duration_seconds"] = round(time.monotonic() - started, 6)
        if output is not None:
            write_json(output / "result.json", result)
    return result, output


def main() -> int:
    parser = EvidenceArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--jar", required=True)
    parser.add_argument("--out", required=True, help="New directory outside model.root")
    parser.add_argument("--java", default="java", help="Java executable name or absolute path")
    args = parser.parse_args()
    result, output = execute(args)
    print(json.dumps({"status": result["status"], "reason": result["reason"],
                      "result": str(output / "result.json") if output else None}, ensure_ascii=False))
    return STATUSES[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
