#!/usr/bin/env python3
"""Fetch a hash-pinned official TLC jar without changing system installations."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def fetch(lock_path: Path, destination: Path) -> dict:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if not isinstance(lock, dict) or type(lock.get("schema_version")) is not int or lock["schema_version"] != 1:
        raise ValueError("Unsupported toolchain schema_version")
    expected = lock.get("sha256", "")
    if not isinstance(expected, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected):
        raise ValueError("toolchain.sha256 must be a 64-character digest")
    expected = expected.lower()
    url = lock.get("url", "")
    parsed = urllib.parse.urlparse(url)
    if (parsed.scheme != "https" or parsed.netloc != "github.com"
            or not parsed.path.startswith("/tlaplus/tlaplus/releases/download/")
            or not parsed.path.endswith("/tla2tools.jar") or parsed.query or parsed.fragment):
        raise ValueError("Use an exact official HTTPS tlaplus/tlaplus release asset URL")
    if destination.is_symlink():
        raise ValueError("Refusing a symlink destination")
    destination = destination.absolute()
    ready = {"status": "READY", "path": str(destination), "version": lock.get("version"),
             "sha256": expected, "source": url}
    if destination.exists():
        if not destination.is_file() or digest(destination) != expected:
            raise ValueError("Destination exists with different content; choose a new path")
        if not zipfile.is_zipfile(destination):
            raise ValueError("Existing file is not a jar/ZIP")
        return {**ready, "downloaded": False}
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".tlc-download-", suffix=".part",
                                         dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            started = time.monotonic()
            count = 0
            request = urllib.request.Request(url, headers={"User-Agent": "tla-verify-design/1"})
            with urllib.request.urlopen(request, timeout=30) as response:
                while True:
                    block = response.read(256 * 1024)
                    if not block:
                        break
                    count += len(block)
                    if count > 64 * 1024 * 1024 or time.monotonic() - started > 120:
                        raise ValueError("Download exceeded the 64 MiB / 120 second budget")
                    output.write(block)
        if digest(temporary) != expected:
            raise ValueError("SHA-256 mismatch; the downloaded file will not be installed")
        if not zipfile.is_zipfile(temporary):
            raise ValueError("Downloaded file is not a jar/ZIP")
        # Exclusive creation prevents overwriting a file created during the download.
        created = False
        try:
            with destination.open("xb") as output, temporary.open("rb") as source:
                created = True
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    output.write(block)
        except BaseException:
            if created:
                destination.unlink(missing_ok=True)
            raise
        return {**ready, "downloaded": True}
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, required=True, help="Destination jar file; never overwritten")
    parser.add_argument("--toolchain", type=Path,
                        default=Path(__file__).resolve().parent.parent / "assets" / "toolchain.json")
    args = parser.parse_args()
    try:
        result = fetch(args.toolchain.resolve(), args.dest)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(json.dumps({"status": "TOOL_ERROR", "reason": str(exc)}, ensure_ascii=False))
        return 2
    except KeyboardInterrupt:
        print(json.dumps({"status": "INCONCLUSIVE", "reason": "Download interrupted"}))
        return 3
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
