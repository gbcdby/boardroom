#!/usr/bin/env python3
"""Bind the product browser to this CI consumer and its verified producer artifact.

Creation verifies the dependency archive once. Loading rechecks the small on-disk
metadata and current CI identity; close helpers validate the resulting explicit
binding without hashing the archive or consulting a qualification run.
"""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
MAX_JSON_BYTES = 32768
MAX_METADATA_BYTES = 8192
MAX_LOCK_BYTES = 8 * 1024 * 1024
MAX_ID = 9007199254740991
ARTIFACT_NAMES = frozenset(("environment.json", "producer.json", "node_modules.tar.gz"))
WS_FILES = frozenset(("package.json", "index.js", "lib/websocket.js", "lib/receiver.js"))
ENVIRONMENT_KEYS = frozenset(("candidate", "node", "abi", "platform", "arch", "libc", "lockSha256"))
PRODUCER_KEYS = frozenset(("schema", "runId", "attempt", "candidate", "tree"))


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _keys(value, expected, label):
    _require(type(value) is dict and set(value) == set(expected), f"{label}: unexpected or missing fields")


def _hash(value, length, label):
    _require(type(value) is str and re.fullmatch(rf"[0-9a-f]{{{length}}}", value) is not None,
             f"{label}: invalid digest")


def _id(value, label):
    _require(type(value) is int and 0 < value <= MAX_ID, f"{label}: expected positive safe integer")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, f"JSON: duplicate field {key}")
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError(f"JSON: invalid constant {value}")


def _read_bytes(path, maximum):
    with Path(path).open("rb") as stream:
        data = stream.read(maximum + 1)
    _require(len(data) <= maximum, f"{Path(path).name}: exceeds size limit")
    return data


def _decode_json(data, label):
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object,
                          parse_constant=_reject_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError(f"{label}: invalid JSON") from error


def _read_json(path, maximum=MAX_JSON_BYTES):
    data = _read_bytes(path, maximum)
    return data, _decode_json(data, Path(path).name)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _git_identity(root):
    result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD", "HEAD^{tree}"],
                            capture_output=True, text=True, check=True, timeout=5)
    values = result.stdout.splitlines()
    _require(len(values) == 2, "source: invalid git identity")
    _hash(values[0], 40, "source.commit")
    _hash(values[1], 40, "source.tree")
    return {"commit": values[0], "tree": values[1]}


def _lock_sha(root):
    raw, lock = _read_json(Path(root) / "package-lock.json", MAX_LOCK_BYTES)
    _require(type(lock) is dict and type(lock.get("packages")) is dict, "lock: missing packages")
    package = lock["packages"].get("node_modules/ws")
    _require(type(package) is dict and package.get("version") == "8.22.0", "lock: expected ws 8.22.0")
    return _sha(raw)


def load_profile(root=ROOT):
    """Read the repository's fixed expectations, never the installed ws hashes."""
    _, profile = _read_json(Path(root) / "scripts/resource_browser_profile.json")
    _keys(profile, ("schema", "purpose", "qualification", "browser", "closeTransport"), "profile")
    _require(type(profile["schema"]) is int and profile["schema"] == 1 and
             profile["purpose"] == "RESOURCE_NATIVE_BROWSER_PROFILE", "profile: unsupported schema/purpose")
    _require(type(profile["browser"]) is dict and type(profile["qualification"]) is dict,
             "profile: missing browser/qualification")
    transport = profile["closeTransport"]
    _keys(transport, ("schema", "package", "version", "root", "entry", "sha256"), "profile.closeTransport")
    _require(type(transport["schema"]) is int and transport["schema"] == 1 and
             transport["package"] == "ws" and transport["version"] == "8.22.0" and
             transport["root"] == "node_modules/ws" and transport["entry"] == "index.js",
             "profile: unexpected close transport")
    _keys(transport["sha256"], WS_FILES, "profile.closeTransport.sha256")
    for name, value in transport["sha256"].items():
        _hash(value, 64, f"profile.ws.{name}")
    return profile


def _environment(value):
    _keys(value, ENVIRONMENT_KEYS, "environment")
    _hash(value["candidate"], 40, "environment.candidate")
    _hash(value["lockSha256"], 64, "environment.lockSha256")
    _require(type(value["node"]) is str and re.fullmatch(r"v24\.\d{1,4}\.\d{1,4}", value["node"]) is not None,
             "environment: expected Node 24 runtime")
    _require(type(value["abi"]) is str and re.fullmatch(r"[1-9][0-9]{0,5}", value["abi"]) is not None,
             "environment: invalid Node ABI")
    _require(value["platform"] == "linux" and value["arch"] == "x64", "environment: expected Linux x64")
    _require(type(value["libc"]) is str and re.fullmatch(r"[0-9]{1,4}(?:\.[0-9]{1,4}){1,2}", value["libc"]) is not None,
             "environment: invalid glibc version")


def _producer(value):
    _keys(value, PRODUCER_KEYS, "producer")
    _require(type(value["schema"]) is int and value["schema"] == 1, "producer: unsupported schema")
    _id(value["runId"], "producer.runId")
    _id(value["attempt"], "producer.attempt")
    _hash(value["candidate"], 40, "producer.candidate")
    _hash(value["tree"], 40, "producer.tree")


def validate_binding(binding, root=ROOT):
    """Validate explicit identity/expectations; do not reread the dependency tar."""
    _keys(binding, ("schema", "purpose", "source", "consumer", "dependencies", "closeTransport"), "binding")
    try:
        encoded = json.dumps(binding, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as error:
        raise ValueError("binding: invalid JSON value") from error
    _require(len(encoded) <= MAX_JSON_BYTES, "binding: exceeds size limit")
    _require(type(binding["schema"]) is int and binding["schema"] == 1 and
             binding["purpose"] == "RESOURCE_BROWSER_PRODUCT", "binding: unsupported schema/purpose")
    source, consumer, deps = binding["source"], binding["consumer"], binding["dependencies"]
    _keys(source, ("commit", "tree"), "source")
    _hash(source["commit"], 40, "source.commit")
    _hash(source["tree"], 40, "source.tree")
    _require(source == _git_identity(root), "binding: source differs from current HEAD/tree")
    _keys(consumer, ("runId", "attempt"), "consumer")
    _id(consumer["runId"], "consumer.runId")
    _id(consumer["attempt"], "consumer.attempt")
    _keys(deps, ("artifactId", "producer", "producerSha256", "environment", "environmentSha256", "tarSha256"),
          "dependencies")
    _id(deps["artifactId"], "dependencies.artifactId")
    for name in ("producerSha256", "environmentSha256", "tarSha256"):
        _hash(deps[name], 64, f"dependencies.{name}")
    producer, environment = deps["producer"], deps["environment"]
    _producer(producer)
    _environment(environment)
    _require(producer["runId"] == consumer["runId"] and producer["attempt"] <= consumer["attempt"],
             "binding: producer run/attempt differs from this consumer")
    _require(producer["candidate"] == source["commit"] and producer["tree"] == source["tree"] and
             environment["candidate"] == source["commit"], "binding: producer source mismatch")
    _require(environment["lockSha256"] == _lock_sha(root), "binding: lock differs from current source")
    expected = copy.deepcopy(load_profile(root)["closeTransport"])
    expected["producer"] = {"artifactId": deps["artifactId"], "tarSha256": deps["tarSha256"],
                            "environmentSha256": deps["environmentSha256"],
                            "lockSha256": environment["lockSha256"]}
    transport = binding["closeTransport"]
    _keys(transport, expected, "closeTransport")
    _require(type(transport["schema"]) is int, "closeTransport: invalid schema type")
    _keys(transport["sha256"], WS_FILES, "closeTransport.sha256")
    for name, digest in transport["sha256"].items():
        _hash(digest, 64, f"closeTransport.sha256.{name}")
    _keys(transport["producer"], expected["producer"], "closeTransport.producer")
    _id(transport["producer"]["artifactId"], "closeTransport.producer.artifactId")
    for name in ("tarSha256", "environmentSha256", "lockSha256"):
        _hash(transport["producer"][name], 64, f"closeTransport.producer.{name}")
    _require(transport == expected, "binding: close transport differs from fixed profile/producer")
    return copy.deepcopy(binding)


def _runtime():
    script = ("console.log(JSON.stringify({node:process.version,abi:process.versions.modules,"
              "platform:process.platform,arch:process.arch,"
              "libc:process.report.getReport().header.glibcVersionRuntime}))")
    result = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True,
                            check=True, timeout=5)
    _require(len(result.stdout) <= MAX_METADATA_BYTES, "runtime: exceeds size limit")
    value = _decode_json(result.stdout, "runtime")
    _keys(value, ("node", "abi", "platform", "arch", "libc"), "runtime")
    return value


def _artifact_dir(root):
    return Path(root).resolve() / ".agent-output/browser-dependencies"


def create_runtime_binding(artifact_dir, artifact_id, run_id, consumer_attempt, root=ROOT):
    """Verify this producer's three files once after the CI artifact download."""
    _id(artifact_id, "artifactId")
    _id(run_id, "runId")
    _id(consumer_attempt, "consumerAttempt")
    artifact_dir = Path(artifact_dir).resolve()
    _require(artifact_dir == _artifact_dir(root), "artifact directory: expected this checkout's browser-dependencies")
    sums = _read_bytes(artifact_dir / "SHA256SUMS", MAX_METADATA_BYTES).decode("ascii")
    expected = {}
    for line in sums.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (environment\.json|producer\.json|node_modules\.tar\.gz)", line)
        _require(match is not None, "SHA256SUMS: unexpected entry")
        digest, name = match.groups()
        _require(name not in expected, "SHA256SUMS: duplicate entry")
        expected[name] = digest
    _require(set(expected) == ARTIFACT_NAMES, "SHA256SUMS: missing file")
    env_raw, environment = _read_json(artifact_dir / "environment.json", MAX_METADATA_BYTES)
    producer_raw, producer = _read_json(artifact_dir / "producer.json", MAX_METADATA_BYTES)
    actual = {"environment.json": _sha(env_raw), "producer.json": _sha(producer_raw),
              "node_modules.tar.gz": _file_sha(artifact_dir / "node_modules.tar.gz")}
    _require(actual == expected, "artifact: SHA256SUMS mismatch")
    source = _git_identity(root)
    current_environment = {"candidate": source["commit"], **_runtime(), "lockSha256": _lock_sha(root)}
    _require(environment == current_environment, "artifact: producer environment differs from this source/runtime/lock")
    close_transport = copy.deepcopy(load_profile(root)["closeTransport"])
    close_transport["producer"] = {"artifactId": artifact_id, "tarSha256": actual["node_modules.tar.gz"],
                                   "environmentSha256": actual["environment.json"],
                                   "lockSha256": environment["lockSha256"]}
    return validate_binding({
        "schema": 1, "purpose": "RESOURCE_BROWSER_PRODUCT", "source": source,
        "consumer": {"runId": run_id, "attempt": consumer_attempt},
        "dependencies": {"artifactId": artifact_id, "producer": producer,
                         "producerSha256": actual["producer.json"], "environment": environment,
                         "environmentSha256": actual["environment.json"], "tarSha256": actual["node_modules.tar.gz"]},
        "closeTransport": close_transport,
    }, root=root)


def _env_id(name):
    value = os.environ.get(name)
    _require(type(value) is str and re.fullmatch(r"[1-9][0-9]{0,15}", value) is not None,
             f"{name}: required positive integer")
    result = int(value)
    _id(result, name)
    return result


def _ci_context(root):
    identity = _git_identity(root)
    _require(os.environ.get("GITHUB_SHA") == identity["commit"], "GITHUB_SHA: must equal current HEAD")
    return {"source": identity, "runId": _env_id("GITHUB_RUN_ID"),
            "attempt": _env_id("GITHUB_RUN_ATTEMPT"), "artifactId": _env_id("RESOURCE_BROWSER_ARTIFACT_ID")}


def load_runtime_binding(path, root=ROOT):
    """Require the same CI consumer and retained small producer metadata."""
    _, value = _read_json(path)
    binding = validate_binding(value, root=root)
    context = _ci_context(root)
    _require(binding["source"] == context["source"] and
             binding["consumer"] == {"runId": context["runId"], "attempt": context["attempt"]} and
             binding["dependencies"]["artifactId"] == context["artifactId"],
             "binding: differs from current CI consumer/artifact")
    deps = binding["dependencies"]
    for name, field in (("environment.json", "environment"), ("producer.json", "producer")):
        raw, observed = _read_json(_artifact_dir(root) / name, MAX_METADATA_BYTES)
        _require(_sha(raw) == deps[field + "Sha256"] and observed == deps[field],
                 f"binding: retained {name} differs from producer proof")
    return binding


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        context = _ci_context(ROOT)
        binding = create_runtime_binding(args.artifact_dir, context["artifactId"], context["runId"],
                                         context["attempt"], root=ROOT)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(binding, indent=2) + "\n")
        print(json.dumps({"status": "BOUND", "source": binding["source"], "consumer": binding["consumer"],
                          "artifactId": context["artifactId"],
                          "producerAttempt": binding["dependencies"]["producer"]["attempt"]}))
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"resource browser binding failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
