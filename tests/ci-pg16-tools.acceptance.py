"""Linux-only command-boundary regression; run: python3 tests/ci-pg16-tools.acceptance.py.

Uses real APT/dpkg and a temporary local file repository. The tiny .deb contents
are fixtures, not PostgreSQL, so this does not replace the real restart CI gate.
Only these locally generated test inputs are trusted; repository signature
verification is not covered. Production keeps APT's normal authentication.
No system package state, sources, services or keyrings are changed.
"""

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from email.utils import formatdate


SCRIPT = Path(os.environ.get("BOARDROOM_PG_TOOLS_SCRIPT", Path(__file__).resolve().parents[1] / "scripts/prepare-ci-pg16-tools.sh"))
VERIFY_SCRIPT = Path(__file__).resolve().parents[1] / "scripts/verify-ci-pg16-client.sh"
INSTALLED = "16.16-1.pgdg24.04+1"
AVAILABLE = "16.15-0ubuntu0.24.04.1"
NEWER_AVAILABLE = "16.16-0ubuntu0.24.04.1"
PACKAGES = ("postgresql-16", "postgresql-client-16")


class AptFixture:
    def __init__(self, packages, *, bad_arch=False, bad_major=False, binary_versions=None):
        self.temp = tempfile.TemporaryDirectory(prefix="br-pg16-apt-")
        self.root = Path(self.temp.name)
        self.arch = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
        for directory in ("repo/pool", "lists/partial", "cache/archives/partial", "run", "downloads", "log"):
            (self.root / directory).mkdir(parents=True, mode=0o700)
        self.env = {**os.environ, "PATH": "/usr/bin:/bin", "LC_ALL": "C"}
        records = []
        for package, version in packages:
            build = self.root / f"build-{package}-{version}"
            (build / "DEBIAN").mkdir(parents=True)
            metadata = f"Package: {package}\nVersion: {version}\nArchitecture: {'arm64' if bad_arch and self.arch != 'arm64' else 'amd64' if bad_arch else self.arch}\nMaintainer: CI fixture <fixture@example.invalid>\nDescription: Regression fixture, not PostgreSQL\n"
            (build / "DEBIAN/control").write_text(metadata)
            postinst = build / "DEBIAN/postinst"
            postinst.write_text(f"#!/bin/sh\ntouch '{self.root / 'postinst-ran'}'\n")
            postinst.chmod(0o755)
            binary = build / "usr/lib/postgresql/16/bin"
            binary.mkdir(parents=True)
            names = ("postgres", "initdb", "pg_ctl") if package == "postgresql-16" else ("pg_dump", "pg_restore", "psql")
            for name in names:
                tool = binary / name
                binary_version = (binary_versions or {}).get(name, "17.0" if bad_major else version.split("-")[0])
                tool.write_text(f"#!/bin/sh\nprintf '%s\\n' '{name} (PostgreSQL) {binary_version}'\n")
                tool.chmod(0o755)
            if package == "postgresql-16":
                (build / "usr/share/postgresql/16").mkdir(parents=True)
                (build / "usr/share/postgresql/16/postgres.bki").write_text("fixture\n")
                (build / "usr/lib/postgresql/16/lib").mkdir()
            archive = self.root / "repo/pool" / f"{package}_{version}_{self.arch}.deb"
            self.run("dpkg-deb", "--build", "--root-owner-group", str(build), str(archive))
            contents = archive.read_bytes()
            # A malformed package may disagree with its index; extraction
            # must still check the package's own architecture.
            index_metadata = metadata.replace("Architecture: arm64", f"Architecture: {self.arch}").replace("Architecture: amd64", f"Architecture: {self.arch}")
            records.append(index_metadata + f"Filename: pool/{archive.name}\nSize: {len(contents)}\nSHA256: {hashlib.sha256(contents).hexdigest()}\n")
        index = "\n".join(records).encode()
        (self.root / "repo/Packages").write_bytes(index)
        release = f"Date: {formatdate(usegmt=True)}\nArchitectures: {self.arch}\nSHA256:\n {hashlib.sha256(index).hexdigest()} {len(index)} Packages\n"
        (self.root / "repo/Release").write_text(release)
        (self.root / "sources.list").write_text(f"deb [trusted=yes] file:{self.root / 'repo'} ./\n")
        self.status = "\n".join(f"Package: {package}\nStatus: install ok installed\nArchitecture: {self.arch}\nVersion: {INSTALLED}\nDescription: installed-only runner fixture\n" for package in PACKAGES)
        (self.root / "status").write_text(self.status)
        (self.root / "apt.conf").write_text(f'''Dir::Etc::main "-";
Dir::Etc::parts "-";
Dir::Etc::sourcelist "{self.root}/sources.list";
Dir::Etc::sourceparts "-";
Dir::Etc::preferences "-";
Dir::Etc::preferencesparts "-";
Dir::Etc::trusted "-";
Dir::Etc::trustedparts "-";
Dir::State "{self.root}";
Dir::State::status "{self.root}/status";
Dir::State::lists "{self.root}/lists";
Dir::Cache "{self.root}/cache";
Dir::Log "{self.root}/log";
APT::Architecture "{self.arch}";
APT::Architectures {{ "{self.arch}"; }};
Acquire::Languages "none";
''')
        self.env.update(APT_CONFIG=str(self.root / "apt.conf"), RUNNER_TEMP=str(self.root / "run"), GITHUB_OUTPUT=str(self.root / "output"), GITHUB_PATH=str(self.root / "path"))
        self.run("apt-get", "update")

    def run(self, *args, check=True, text=True, cwd=None):
        result = subprocess.run(args, env=self.env, cwd=cwd or self.root, capture_output=True, text=text, timeout=30)
        if check and result.returncode:
            raise AssertionError(f"{args!r}: exit {result.returncode}\n{result.stdout}\n{result.stderr}")
        return result

    def prepare(self):
        return self.run("bash", "-euo", "pipefail", str(SCRIPT), check=False)

    def client_handoff(self):
        output = dict(line.split("=", 1) for line in (self.root / "output").read_text().splitlines())
        self.env.update(BOARDROOM_CI_PG16_VERSION=output["version"],
                        BOARDROOM_CI_PG16_CLIENT_ARCHIVE=output["client_archive"],
                        BOARDROOM_CI_PG16_CLIENT_BYTES=output["client_bytes"],
                        BOARDROOM_CI_PG16_CLIENT_SHA256=output["client_sha256"],
                        BOARDROOM_CI_PG16_CLIENT_PACKAGE=output["client_package"],
                        BOARDROOM_CI_PG16_ARCHITECTURE=output["architecture"])
        return Path(output["client_archive"])

    def verify_client(self):
        return self.run("bash", "-euo", "pipefail", str(VERIFY_SCRIPT), check=False)

    def assert_unchanged(self, case):
        case.assertEqual((self.root / "status").read_text(), self.status)
        case.assertFalse((self.root / "postinst-ran").exists())

    def close(self):
        self.temp.cleanup()


class PostgreSQLToolsAcceptance(unittest.TestCase):
    def fixture(self, packages, **kwargs):
        fixture = AptFixture(packages, **kwargs)
        self.addCleanup(fixture.close)
        self.addCleanup(fixture.assert_unchanged, self)
        return fixture

    def assert_failed_without_tools(self, fixture, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        for name in ("output", "path"):
            self.assertFalse((fixture.root / name).exists() and (fixture.root / name).read_text().strip(), "failed preparation must not publish tools")

    def test_installed_newer_without_source_uses_downloadable_pair(self):
        fixture = self.fixture([(package, version) for package in PACKAGES for version in ("16.2-1ubuntu4", AVAILABLE)])
        policy = fixture.run("apt-cache", "policy", f"postgresql-16:{fixture.arch}").stdout
        self.assertIn(f"Candidate: {INSTALLED}", policy)
        original = fixture.run("apt-get", "download", "postgresql-16", cwd=fixture.root / "downloads", check=False)
        self.assertEqual(original.returncode, 100, original.stdout + original.stderr)
        self.assertIn("Can't find a source to download", original.stderr)
        result = fixture.prepare()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        output = dict(line.split("=", 1) for line in (fixture.root / "output").read_text().splitlines())
        self.assertEqual(output["version"], AVAILABLE)
        binary = Path(output["bin"])
        self.assertTrue(binary.resolve().is_relative_to(fixture.root / "run"))
        self.assertEqual((fixture.root / "path").read_text().strip(), str(binary))
        for name in ("postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore", "psql"):
            self.assertIn("(PostgreSQL) 16.15", fixture.run(str(binary / name), "--version").stdout)
        downloaded = list((fixture.root / "run").rglob("*.deb"))
        self.assertEqual(len(downloaded), 2)
        self.assertEqual({fixture.run("dpkg-deb", "--field", str(archive), "Version").stdout.strip() for archive in downloaded}, {AVAILABLE})
        # Exercise real APT selection without changing package state or running
        # maintainer scripts. CI installs this exact validated client version.
        downgrade = fixture.run("apt-get", "--simulate", "install", "--yes", "--no-install-recommends", "--no-remove", "--allow-downgrades", f"postgresql-client-16:{fixture.arch}={output['version']}")
        self.assertIn("will be DOWNGRADED", downgrade.stdout)
        self.assertIn(f"Inst postgresql-client-16 [{INSTALLED}] ({AVAILABLE}", downgrade.stdout)
        self.assertNotIn("Inst postgresql-16 ", downgrade.stdout)

    def test_newer_downloadable_minor_does_not_replace_supported_profile(self):
        fixture = self.fixture([(package, version) for package in PACKAGES for version in (AVAILABLE, NEWER_AVAILABLE)])
        result = fixture.prepare()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        output = dict(line.split("=", 1) for line in (fixture.root / "output").read_text().splitlines())
        self.assertEqual(output["version"], AVAILABLE)
        self.assertEqual({fixture.run("dpkg-deb", "--field", str(archive), "Version").stdout.strip() for archive in (fixture.root / "run").rglob("*.deb")}, {AVAILABLE})

    def test_verified_client_remains_installable_without_repository_archive(self):
        fixture = self.fixture([(package, AVAILABLE) for package in PACKAGES])
        prepared = fixture.prepare()
        self.assertEqual(prepared.returncode, 0, prepared.stdout + prepared.stderr)
        archive = fixture.client_handoff()
        self.assertEqual(fixture.env["BOARDROOM_CI_PG16_CLIENT_BYTES"], str(archive.stat().st_size))
        self.assertEqual(fixture.env["BOARDROOM_CI_PG16_CLIENT_SHA256"], hashlib.sha256(archive.read_bytes()).hexdigest())
        next((fixture.root / "repo/pool").glob("postgresql-client-16_*.deb")).unlink()
        verification = fixture.verify_client()
        self.assertEqual(verification.returncode, 0, verification.stderr)
        self.assertEqual(verification.stdout.strip(), str(archive.resolve()))
        # Unlike simulation, download-only actually tries to acquire missing
        # archives, but never changes package state or executes maintainer scripts.
        fetched = fixture.run("apt-get", "--download-only", "install", "--yes", "--no-install-recommends",
                              "--no-remove", "--allow-downgrades", str(archive))
        self.assertIn("0 B", fetched.stdout)
        simulated = fixture.run("apt-get", "--simulate", "install", "--yes", "--no-install-recommends",
                                "--no-remove", "--allow-downgrades", str(archive))
        self.assertIn(f"Inst postgresql-client-16 [{INSTALLED}] ({AVAILABLE}", simulated.stdout)
        self.assertNotIn("Inst postgresql-16 ", simulated.stdout)

    def test_client_handoff_rejects_wrong_expected_fields(self):
        fixture = self.fixture([(package, AVAILABLE) for package in PACKAGES])
        self.assertEqual(fixture.prepare().returncode, 0)
        fixture.client_handoff()
        for key, value in {"BOARDROOM_CI_PG16_VERSION": NEWER_AVAILABLE,
                           "BOARDROOM_CI_PG16_CLIENT_PACKAGE": "postgresql-16",
                           "BOARDROOM_CI_PG16_ARCHITECTURE": "arm64" if fixture.arch != "arm64" else "amd64",
                           "BOARDROOM_CI_PG16_CLIENT_BYTES": "1",
                           "BOARDROOM_CI_PG16_CLIENT_SHA256": "0" * 64}.items():
            with self.subTest(field=key):
                original = fixture.env[key]
                fixture.env[key] = value
                rejected = fixture.verify_client()
                fixture.env[key] = original
                self.assertNotEqual(rejected.returncode, 0, rejected.stdout + rejected.stderr)
                self.assertEqual(rejected.stdout, "")

    def test_client_handoff_rejects_changed_bytes_and_unsafe_paths(self):
        fixture = self.fixture([(package, AVAILABLE) for package in PACKAGES])
        self.assertEqual(fixture.prepare().returncode, 0)
        archive = fixture.client_handoff()
        original = archive.read_bytes()
        outside = fixture.root / archive.name
        outside.write_bytes(original)
        symlink = archive.with_name("symlink.deb")
        symlink.symlink_to(archive)
        alias_directory = fixture.root / "run/boardroom-pg16-restart-debs.alias"
        alias_directory.symlink_to(archive.parent, target_is_directory=True)
        for candidate in (archive.relative_to(fixture.root), outside, symlink, alias_directory / archive.name, archive.parent):
            with self.subTest(path=str(candidate)):
                fixture.env["BOARDROOM_CI_PG16_CLIENT_ARCHIVE"] = str(candidate)
                self.assertNotEqual(fixture.verify_client().returncode, 0)
        fixture.env["BOARDROOM_CI_PG16_CLIENT_ARCHIVE"] = str(archive)
        for changed in (original + b"x", bytes([original[0] ^ 1]) + original[1:]):
            archive.write_bytes(changed)
            rejected = fixture.verify_client()
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

    def test_client_handoff_rechecks_archive_metadata_after_digest(self):
        for kind in ("package", "version", "architecture"):
            with self.subTest(kind=kind):
                fixture = self.fixture([(package, AVAILABLE) for package in PACKAGES])
                self.assertEqual(fixture.prepare().returncode, 0)
                archive = fixture.client_handoff()
                version = "16.2-1ubuntu4" if kind == "version" else AVAILABLE
                alternative = self.fixture([(package, version) for package in PACKAGES], bad_arch=kind == "architecture")
                package = "postgresql-16" if kind == "package" else "postgresql-client-16"
                shutil.copyfile(next((alternative.root / "repo/pool").glob(f"{package}_*.deb")), archive)
                fixture.env["BOARDROOM_CI_PG16_CLIENT_BYTES"] = str(archive.stat().st_size)
                fixture.env["BOARDROOM_CI_PG16_CLIENT_SHA256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
                rejected = fixture.verify_client()
                self.assertNotEqual(rejected.returncode, 0, rejected.stdout + rejected.stderr)
                self.assertEqual(rejected.stdout, "")

    def test_only_newer_minor_fails_without_using_installed_tools(self):
        fixture = self.fixture([(package, NEWER_AVAILABLE) for package in PACKAGES])
        self.assert_failed_without_tools(fixture, fixture.prepare())

    def test_no_repository_version_fails_without_using_installed_tools(self):
        fixture = self.fixture([])
        self.assert_failed_without_tools(fixture, fixture.prepare())

    def test_disjoint_server_and_client_versions_fail(self):
        fixture = self.fixture([("postgresql-16", AVAILABLE), ("postgresql-client-16", "16.2-1ubuntu4")])
        self.assert_failed_without_tools(fixture, fixture.prepare())

    def test_missing_archive_fails_without_falling_back(self):
        fixture = self.fixture([(package, version) for package in PACKAGES for version in ("16.2-1ubuntu4", AVAILABLE)])
        next((fixture.root / "repo/pool").glob(f"postgresql-16_{AVAILABLE}_*.deb")).unlink()
        result = fixture.prepare()
        self.assertEqual(result.returncode, 100, result.stdout + result.stderr)
        self.assert_failed_without_tools(fixture, result)

    def test_wrong_package_architecture_fails(self):
        fixture = self.fixture([(package, AVAILABLE) for package in PACKAGES], bad_arch=True)
        self.assert_failed_without_tools(fixture, fixture.prepare())

    def test_wrong_binary_major_fails(self):
        fixture = self.fixture([(package, AVAILABLE) for package in PACKAGES], bad_major=True)
        self.assert_failed_without_tools(fixture, fixture.prepare())

    def test_wrong_binary_minor_fails(self):
        fixture = self.fixture([(package, AVAILABLE) for package in PACKAGES], binary_versions={"pg_restore": "16.16"})
        self.assert_failed_without_tools(fixture, fixture.prepare())

    def test_psql_is_checked_before_publishing_paths(self):
        fixture = self.fixture([(package, AVAILABLE) for package in PACKAGES], binary_versions={"psql": "16.16"})
        self.assert_failed_without_tools(fixture, fixture.prepare())

    def test_binary_minor_prefix_is_not_the_supported_minor(self):
        fixture = self.fixture([(package, AVAILABLE) for package in PACKAGES], binary_versions={"pg_dump": "16.150"})
        self.assert_failed_without_tools(fixture, fixture.prepare())


if __name__ == "__main__":
    unittest.main(verbosity=2)
