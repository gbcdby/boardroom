#!/usr/bin/env python3
"""Local identity/metadata controls; synthetic CI IDs, no browser or hosted run."""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SUBJECT = ROOT / "scripts/resource_browser_binding.py"
PROFILE = ROOT / "scripts/resource_browser_profile.json"
CI_KEYS = ("GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "RESOURCE_BROWSER_ARTIFACT_ID")


def subject():
    if not SUBJECT.is_file():
        raise AssertionError("required product runtime binding entrypoint is absent")
    spec = importlib.util.spec_from_file_location("resource_browser_binding", SUBJECT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Fixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="boardroom-binding-control-")
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        shutil.copyfile(PROFILE, self.root / "scripts/resource_browser_profile.json")
        shutil.copyfile(SUBJECT, self.root / "scripts/resource_browser_binding.py")
        (self.root / ".gitignore").write_text(".agent-output/\n__pycache__/\n")
        (self.root / "package-lock.json").write_text(json.dumps({
            "lockfileVersion": 3,
            "packages": {"node_modules/ws": {"version": "8.22.0"}},
        }))
        self.git("init", "--quiet")
        self.git("add", ".")
        self.git("-c", "user.name=Binding Control", "-c", "user.email=binding-control@example.invalid",
                 "commit", "--quiet", "-m", "synthetic binding fixture")
        self.commit, self.tree = self.git("rev-parse", "HEAD", "HEAD^{tree}").splitlines()
        self.artifact = self.root / ".agent-output/browser-dependencies"
        self.artifact.mkdir(parents=True)
        runtime = json.loads(subprocess.check_output([
            "node", "--input-type=module", "-e",
            "console.log(JSON.stringify({node:process.version,abi:process.versions.modules,"
            "platform:process.platform,arch:process.arch,"
            "libc:process.report.getReport().header.glibcVersionRuntime}))",
        ], text=True, timeout=5))
        self.environment = {"candidate": self.commit, **runtime,
                            "lockSha256": sha(self.root / "package-lock.json")}
        self.producer = {"schema": 1, "runId": 700001, "attempt": 1,
                         "candidate": self.commit, "tree": self.tree}
        self.env = {"GITHUB_SHA": self.commit, "GITHUB_RUN_ID": "700001",
                    "GITHUB_RUN_ATTEMPT": "2", "RESOURCE_BROWSER_ARTIFACT_ID": "800001"}
        # Only hash/identity behavior is exercised; this is not a dependency archive.
        (self.artifact / "node_modules.tar.gz").write_bytes(b"synthetic dependency bytes\x00")
        self.write_metadata()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args],
                                       text=True, stderr=subprocess.PIPE, timeout=5).strip()

    def write_metadata(self):
        for name, value in (("environment.json", self.environment), ("producer.json", self.producer)):
            (self.artifact / name).write_text(json.dumps(value, indent=2))
        self.write_sums()

    def write_sums(self):
        names = ("node_modules.tar.gz", "environment.json", "producer.json")
        (self.artifact / "SHA256SUMS").write_text("".join(
            f"{sha(self.artifact / name)}  {name}\n" for name in names))

    def create(self, module):
        return module.create_runtime_binding(self.artifact, 800001, 700001, 2, root=self.root)

    def save(self, binding):
        path = self.root / ".agent-output/resource-binding.json"
        path.write_text(json.dumps(binding))
        return path

    def close(self):
        self.temp.cleanup()


class BindingTests(unittest.TestCase):
    def test_00_required_entrypoint(self):
        module = subject()
        for name in ("load_profile", "validate_binding", "load_runtime_binding", "create_runtime_binding"):
            self.assertTrue(callable(getattr(module, name, None)), name)

    def fixture(self):
        fixture = Fixture()
        self.addCleanup(fixture.close)
        return fixture

    def test_valid_current_source_and_reused_successful_producer(self):
        module = subject()
        fixture = self.fixture()
        binding = fixture.create(module)
        self.assertEqual(binding["consumer"]["attempt"], 2)
        self.assertEqual(binding["dependencies"]["producer"]["attempt"], 1)
        with patch.dict(os.environ, fixture.env):
            loaded = module.load_runtime_binding(fixture.save(binding), root=fixture.root)
        self.assertEqual(loaded, binding)
        validated = module.validate_binding(binding, root=fixture.root)
        validated["dependencies"]["producer"]["attempt"] = 2
        self.assertEqual(binding["dependencies"]["producer"]["attempt"], 1)
        # Validation/loading reuses the create-time tar proof, not a second archive read.
        (fixture.artifact / "node_modules.tar.gz").unlink()
        with patch.dict(os.environ, fixture.env):
            self.assertEqual(module.load_runtime_binding(fixture.save(binding), root=fixture.root), binding)

    def test_shape_source_run_attempt_lock_and_ws_mismatches_rejected(self):
        module = subject()
        fixture = self.fixture()
        original = fixture.create(module)
        changes = {
            "source": lambda b: b["source"].update(commit="a" * 40),
            "tree": lambda b: b["source"].update(tree="b" * 40),
            "producer_run": lambda b: b["dependencies"]["producer"].update(runId=700002),
            "producer_attempt": lambda b: b["dependencies"]["producer"].update(attempt=3),
            "boolean_id": lambda b: b["dependencies"].update(artifactId=True),
            "string_id": lambda b: b["consumer"].update(runId="700001"),
            "lock": lambda b: b["dependencies"]["environment"].update(lockSha256="0" * 64),
            "ws_hash": lambda b: b["closeTransport"]["sha256"].update({"index.js": "0" * 64}),
            "ws_extra_hash": lambda b: b["closeTransport"]["sha256"].update({"extra.js": "0" * 64}),
            "ws_boolean_schema": lambda b: b["closeTransport"].update(schema=True),
            "close_producer": lambda b: b["closeTransport"]["producer"].update(artifactId=800002),
            "unknown_field": lambda b: b.update(unexpected=True),
            "missing_field": lambda b: b["dependencies"].pop("producerSha256"),
        }
        for label, mutate in changes.items():
            with self.subTest(label=label):
                value = copy.deepcopy(original)
                mutate(value)
                with self.assertRaises(ValueError):
                    module.validate_binding(value, root=fixture.root)

    def test_create_verifies_each_artifact_digest_and_exact_sums(self):
        module = subject()
        fixture = self.fixture()
        for name in ("environment.json", "producer.json", "node_modules.tar.gz"):
            with self.subTest(file=name):
                path = fixture.artifact / name
                original = path.read_bytes()
                path.write_bytes(original + b" ")
                with self.assertRaises(ValueError):
                    fixture.create(module)
                path.write_bytes(original)
        sums = fixture.artifact / "SHA256SUMS"
        original = sums.read_text()
        for malformed in (original.splitlines()[0] + "\n", original + original.splitlines()[0] + "\n",
                          original + "0" * 64 + "  ../extra\n"):
            with self.subTest(sums=malformed):
                sums.write_text(malformed)
                with self.assertRaises(ValueError):
                    fixture.create(module)
        sums.write_text(original)

    def test_create_rejects_rehashed_wrong_source_runtime_and_producer(self):
        module = subject()
        fixture = self.fixture()
        environment = copy.deepcopy(fixture.environment)
        producer = copy.deepcopy(fixture.producer)
        mutations = (
            lambda: fixture.environment.update(candidate="a" * 40),
            lambda: fixture.environment.update(node="v24.0.0"),
            lambda: fixture.environment.update(abi="1"),
            lambda: fixture.producer.update(runId=700002),
            lambda: fixture.producer.update(attempt=3),
            lambda: fixture.producer.update(tree="a" * 40),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                fixture.environment = copy.deepcopy(environment)
                fixture.producer = copy.deepcopy(producer)
                mutate()
                fixture.write_metadata()
                with self.assertRaises(ValueError):
                    fixture.create(module)

    def test_load_requires_this_consumer_and_small_metadata_proof(self):
        module = subject()
        fixture = self.fixture()
        binding = fixture.create(module)
        path = fixture.save(binding)
        for key in CI_KEYS:
            with self.subTest(missing=key), patch.dict(os.environ, fixture.env):
                os.environ.pop(key)
                with self.assertRaises(ValueError):
                    module.load_runtime_binding(path, root=fixture.root)
        for key, value in (("GITHUB_SHA", "a" * 40), ("GITHUB_RUN_ID", "700002"),
                           ("GITHUB_RUN_ATTEMPT", "3"), ("RESOURCE_BROWSER_ARTIFACT_ID", "800002")):
            with self.subTest(wrong=key), patch.dict(os.environ, {**fixture.env, key: value}):
                with self.assertRaises(ValueError):
                    module.load_runtime_binding(path, root=fixture.root)
        for name in ("environment.json", "producer.json"):
            original = (fixture.artifact / name).read_bytes()
            (fixture.artifact / name).write_bytes(original + b"\n")
            with self.subTest(changed=name), patch.dict(os.environ, fixture.env):
                with self.assertRaises(ValueError):
                    module.load_runtime_binding(path, root=fixture.root)
            (fixture.artifact / name).write_bytes(original)

    def test_bounded_json_and_duplicate_fields_rejected(self):
        module = subject()
        fixture = self.fixture()
        path = fixture.root / ".agent-output/malformed.json"
        for content in ('{"schema":1,"schema":1}', '{"schema":NaN}', "[" + " " * 65536 + "]"):
            with self.subTest(prefix=content[:30]), patch.dict(os.environ, fixture.env):
                path.write_text(content)
                with self.assertRaises(ValueError):
                    module.load_runtime_binding(path, root=fixture.root)

    def test_cli_current_ci_context_and_missing_id(self):
        module = subject()
        fixture = self.fixture()
        target = fixture.root / ".agent-output/cli-binding.json"
        command = [sys.executable, str(fixture.root / "scripts/resource_browser_binding.py"),
                   "--artifact-dir", str(fixture.artifact), "--output", str(target)]
        result = subprocess.run(command, env={**os.environ, **fixture.env}, capture_output=True,
                                text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        with patch.dict(os.environ, fixture.env):
            loaded = module.load_runtime_binding(target, root=fixture.root)
        self.assertEqual(loaded["dependencies"]["artifactId"], 800001)
        env = {**os.environ, **fixture.env}
        env.pop("RESOURCE_BROWSER_ARTIFACT_ID")
        failed = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("RESOURCE_BROWSER_ARTIFACT_ID", failed.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
