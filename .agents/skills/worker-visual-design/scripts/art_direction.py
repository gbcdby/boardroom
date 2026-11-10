#!/usr/bin/env python3
"""Manage project-local art-direction references without inventing visual reviews.

Python 3.10+; Pillow is optional and only reads image metadata/validity.
All writes stay below the selected project's docs directory. Source images
are copied byte-for-byte; ingest never changes style guides or review claims.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
import unicodedata
from urllib.parse import unquote, urlsplit


SKILL_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DOCS = "docs/design-direction"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"}
ENTRY_FIELDS = {
    "id", "original_filename", "path", "sha256", "media_type", "width", "height",
    "category", "tags", "status", "review", "provenance", "added_in",
}


class DataError(Exception):
    """An actionable input, path, or data problem."""


def inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def checked_member(root: Path, value: str | Path) -> Path:
    """Resolve a managed relative path; reject traversal and symlinks."""
    raw = str(value)
    rel = Path(raw)
    if not raw or rel.is_absolute() or PureWindowsPath(raw).drive or ".." in rel.parts:
        raise DataError(f"Managed path must be relative and cannot contain '..': {raw}")
    if "\\" in raw:
        raise DataError(f"Use forward slashes in managed paths: {raw}")
    target = root / rel
    current = root
    for part in rel.parts:
        current = current / part
        if current.is_symlink():
            raise DataError(f"Managed paths cannot traverse symlinks: {raw}")
    if not inside(target.resolve(strict=False), root.resolve()):
        raise DataError(f"Managed path escapes its root: {raw}")
    return target


def roots(args: argparse.Namespace) -> tuple[Path, Path]:
    project = Path(args.project_root).expanduser()
    if not project.is_dir():
        raise DataError("--project-root must name an existing project directory")
    project = project.resolve()
    if inside(project, SKILL_ROOT):
        raise DataError("The skill package cannot be used as the project root")
    docs = checked_member(project, args.docs_dir)
    if docs == project:
        raise DataError("--docs-dir must be a nonempty subdirectory of the project")
    if docs.exists() and not docs.is_dir():
        raise DataError("The selected docs path exists but is not a directory")
    return project, docs


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise DataError(f"Cannot read JSON {path.name}: {exc}") from exc


def atomic_json(path: Path, data) -> None:
    """Replace a JSON file only after a complete UTF-8 write and fsync."""
    fd, temporary = tempfile.mkstemp(prefix=".art-direction-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_errors(data, docs: Path) -> list[str]:
    errors = []
    if not isinstance(data, dict):
        return ["manifest.json must be an object"]
    if data.get("schema_version") != 1:
        errors.append("manifest.schema_version must be 1")
    prefix, width, next_id = data.get("id_prefix"), data.get("id_width"), data.get("next_reference_number")
    if not isinstance(prefix, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", prefix):
        errors.append("manifest.id_prefix must be a short identifier beginning with a letter")
    if type(width) is not int or not 1 <= width <= 12:
        errors.append("manifest.id_width must be an integer between 1 and 12")
    if type(next_id) is not int or next_id < 1:
        errors.append("manifest.next_reference_number must be a positive integer")
    refs = data.get("references")
    if not isinstance(refs, list):
        return errors + ["manifest.references must be an array"]
    seen_ids, seen_numbers, seen_paths = set(), set(), set()
    largest = 0
    for index, item in enumerate(refs):
        label = f"references[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        missing = sorted(ENTRY_FIELDS - item.keys())
        if missing:
            errors.append(f"{label} is missing fields: {', '.join(missing)}")
        ref_id = item.get("id")
        label = ref_id if isinstance(ref_id, str) else label
        if not isinstance(ref_id, str):
            errors.append(f"{label}: id must be a string")
        else:
            if ref_id in seen_ids:
                errors.append(f"Duplicate reference id: {ref_id}")
            seen_ids.add(ref_id)
            match = re.fullmatch(re.escape(prefix) + r"([0-9]+)", ref_id) if isinstance(prefix, str) else None
            if not match or int(match.group(1)) < 1:
                errors.append(f"{label}: id must match the manifest prefix and a positive number")
            else:
                number = int(match.group(1))
                if number in seen_numbers:
                    errors.append(f"{label}: numeric ID duplicates another padded ID")
                seen_numbers.add(number)
                largest = max(largest, number)
        path = item.get("path")
        if not isinstance(path, str) or not path:
            errors.append(f"{label}: path must be a relative file path")
        else:
            try:
                target = checked_member(docs, path)
                normalized = str(target)
                if normalized in seen_paths:
                    errors.append(f"{label}: duplicate managed file path")
                seen_paths.add(normalized)
            except DataError as exc:
                errors.append(f"{label}: {exc}")
        digest = item.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
            errors.append(f"{label}: sha256 must contain 64 hexadecimal characters")
        for field in ("original_filename", "media_type", "category", "status", "added_in"):
            if not isinstance(item.get(field), str) or not item.get(field):
                errors.append(f"{label}: {field} must be a nonempty string")
        if not isinstance(item.get("tags"), list) or not all(isinstance(x, str) for x in item.get("tags", [])):
            errors.append(f"{label}: tags must be an array of strings")
        for field in ("width", "height"):
            value = item.get(field)
            if value is not None and (type(value) is not int or value < 1):
                errors.append(f"{label}: {field} must be a positive integer or null")
        if item.get("review") is not None and not isinstance(item.get("review"), dict):
            errors.append(f"{label}: review must be an object or null")
        if item.get("status") == "reviewed" and not isinstance(item.get("review"), dict):
            errors.append(f"{label}: reviewed status needs an explicit review record")
        if not isinstance(item.get("provenance"), dict):
            errors.append(f"{label}: provenance must be an object")
    if type(next_id) is int and next_id <= largest:
        errors.append("manifest.next_reference_number must be greater than every existing ID")
    return errors


def load_manifest(docs: Path):
    path = checked_member(docs, "references/manifest.json")
    if not path.is_file():
        raise DataError("Missing references/manifest.json; initialize the project first")
    data = read_json(path)
    errors = manifest_errors(data, docs)
    if errors:
        raise DataError("Invalid reference manifest: " + "; ".join(errors))
    return path, data


def init_project(args: argparse.Namespace) -> tuple[dict, int]:
    project, docs = roots(args)
    template = SKILL_ROOT / "assets/project-template"
    if not template.is_dir():
        raise DataError("Missing bundled assets/project-template directory")
    docs.mkdir(parents=True, exist_ok=True)
    created, preserved = [], []
    for source in sorted(template.rglob("*")):
        if source.is_symlink():
            raise DataError("Project templates must not contain symlinks")
        if not source.is_file():
            continue
        rel = source.relative_to(template).as_posix()
        target = checked_member(docs, rel)
        if target.exists():
            if not target.is_file():
                raise DataError(f"A template file conflicts with an existing directory: {rel}")
            preserved.append(rel)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as reader, target.open("xb") as writer:
            shutil.copyfileobj(reader, writer)
        created.append(rel)
    for relative in ("references/inbox", "references/images", "references/boards"):
        checked_member(docs, relative).mkdir(parents=True, exist_ok=True)
    if "project.json" in created:
        metadata_path = checked_member(docs, "project.json")
        metadata = read_json(metadata_path)
        if isinstance(metadata, dict):
            if metadata.get("project_id") == "":
                metadata["project_id"] = safe_filename(project.name)
            if metadata.get("display_name") == "":
                metadata["display_name"] = project.name
            atomic_json(metadata_path, metadata)
    return {
        "operation": "init", "status": "ok", "project_root": str(project),
        "docs_root": str(docs), "created": created, "preserved": preserved,
        "visual_review": "not_performed",
    }, 0


def safe_filename(name: str) -> str:
    normalized = unicodedata.normalize("NFKC", name)
    safe = re.sub(r"[^\w.-]+", "_", normalized, flags=re.UNICODE).strip("._")
    suffix = Path(safe).suffix
    stem = safe[:-len(suffix)] if suffix else safe
    stem = stem.encode("utf-8")[:140].decode("utf-8", "ignore").strip("._") or "image"
    return stem + suffix[:16]


def image_metadata(path: Path) -> dict:
    """Read metadata, never convert or re-save the source image."""
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    try:
        from PIL import Image
    except ImportError:
        return {"media_type": media_type, "width": None, "height": None,
                "metadata_status": "pillow_unavailable"}
    try:
        with Image.open(path) as image:
            width, height = image.size
            frames = getattr(image, "n_frames", 1)
            media_type = Image.MIME.get(image.format, media_type)
            image.verify()
        result = {"media_type": media_type, "width": width, "height": height}
        if frames > 1:
            result["frame_count"] = frames
        return result
    except Exception as exc:
        raise DataError(f"Cannot read image {path.name}: {exc}") from exc


def collect_inputs(inputs: list[Path]) -> tuple[list[Path], list[dict], list[str]]:
    files, errors, ignored, seen = [], [], [], set()
    for source in inputs:
        source = source.expanduser()
        if source.is_symlink():
            errors.append({"source": str(source), "error": "Symbolic-link inputs are not imported"})
            continue
        if not source.exists():
            errors.append({"source": str(source), "error": "Input does not exist"})
            continue
        if source.is_file():
            candidates = [source]
        elif source.is_dir():
            candidates = []
            def walk_error(exc):
                errors.append({"source": str(getattr(exc, "filename", source)), "error": str(exc)})
            for base, directories, names in os.walk(source, followlinks=False, onerror=walk_error):
                symlinks = [d for d in directories if (Path(base) / d).is_symlink()]
                for name in symlinks:
                    errors.append({"source": str(Path(base) / name), "error": "Symbolic-link directory was not followed"})
                directories[:] = sorted(d for d in directories if d not in symlinks and not d.startswith("."))
                candidates.extend(Path(base) / name for name in sorted(names) if not name.startswith("."))
        else:
            errors.append({"source": str(source), "error": "Input is not a regular file or directory"})
            continue
        for path in sorted(candidates):
            if path.is_symlink():
                errors.append({"source": str(path), "error": "Symbolic-link input was not imported"})
                continue
            if path.suffix.lower() not in IMAGE_SUFFIXES:
                ignored.append(str(path))
                if source.is_file():
                    errors.append({"source": str(path), "error": "Unsupported image extension"})
                continue
            absolute = path.resolve()
            if absolute not in seen:
                seen.add(absolute)
                files.append(absolute)
    return files, errors, ignored


def copy_new_image(source: Path, target: Path, expected_sha: str) -> None:
    """Publish one complete copy without overwriting a preexisting file."""
    if target.exists():
        raise DataError(f"Managed destination already exists: {target.name}")
    fd, temporary = tempfile.mkstemp(prefix=".incoming-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as writer, source.open("rb") as reader:
            shutil.copyfileobj(reader, writer)
            writer.flush()
            os.fsync(writer.fileno())
        if sha256(Path(temporary)) != expected_sha:
            raise DataError("Source changed during copying; no reference was registered")
        # Hard-link publication is exclusive, unlike replace(), which could overwrite.
        os.link(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def ingest(args: argparse.Namespace) -> tuple[dict, int]:
    project, docs = roots(args)
    if not docs.is_dir():
        raise DataError("Project docs are missing; run init first")
    manifest_path, data = load_manifest(docs)
    image_dir = checked_member(docs, "references/images")
    image_dir.mkdir(parents=True, exist_ok=True)
    inputs = [Path(value) for group in (args.input or []) for value in group]
    if not inputs:
        inputs = [checked_member(docs, "references/inbox")]
    sources, errors, ignored = collect_inputs(inputs)
    by_hash = {}
    for item in data["references"]:
        by_hash.setdefault(item["sha256"].lower(), item)
    imported, duplicates, created_paths, warnings = [], [], [], []
    batch = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for source in sources:
        try:
            digest = sha256(source)
            if digest in by_hash:
                old = by_hash[digest]
                target = checked_member(docs, old["path"])
                if not target.is_file() or sha256(target) != digest:
                    raise DataError(f"Existing reference {old['id']} is missing or changed; run check and repair it first")
                duplicates.append({"source_filename": source.name, "existing_id": old["id"]})
                continue
            metadata = image_metadata(source)
            number = data["next_reference_number"]
            ref_id = data["id_prefix"] + str(number).zfill(data["id_width"])
            relative = "references/images/" + ref_id + "__" + safe_filename(source.name)
            target = checked_member(docs, relative)
            copy_new_image(source, target, digest)
            created_paths.append(target)
            entry = {
                "id": ref_id, "original_filename": source.name, "path": relative,
                "sha256": digest, "media_type": metadata["media_type"],
                "width": metadata["width"], "height": metadata["height"],
                "category": "uncategorized", "tags": [], "status": "pending", "review": None,
                "provenance": {"source_filename": source.name}, "added_in": batch,
            }
            if "frame_count" in metadata:
                entry["frame_count"] = metadata["frame_count"]
                warnings.append({"id": ref_id, "message": "Multi-frame image requires explicit frame coverage during visual review"})
            if "metadata_status" in metadata:
                entry["metadata_status"] = metadata["metadata_status"]
                warnings.append({"id": ref_id, "message": "Pillow unavailable: dimensions and image decode were not verified"})
            data["references"].append(entry)
            data["next_reference_number"] = number + 1
            by_hash[digest] = entry
            imported.append({"id": ref_id, "path": relative, "source_filename": source.name, "status": "pending"})
        except (OSError, DataError) as exc:
            errors.append({"source": str(source), "error": str(exc)})
    if imported:
        try:
            atomic_json(manifest_path, data)
        except Exception:
            for path in created_paths:
                path.unlink(missing_ok=True)
            raise
    pending = [item["id"] for item in data["references"] if item["status"] == "pending"]
    return {
        "operation": "ingest", "status": "partial" if errors and imported else ("error" if errors else "ok"),
        "project_root": str(project), "docs_root": str(docs), "imported": imported,
        "duplicates": duplicates, "errors": errors, "ignored_non_images": ignored,
        "warnings": warnings, "pending_ids": pending, "reference_count": len(data["references"]),
        "visual_review": "not_performed", "guidelines_modified": False,
    }, 1 if errors else 0


def markdown_links(text: str) -> list[str]:
    # Exclude fenced code and inline code: examples are not live project links.
    kept, fence = [], None
    for line in text.splitlines():
        marker = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence is None:
            kept.append(line)
    clean = re.sub(r"(`+).*?\1", "", "\n".join(kept))
    links = []
    for match in re.finditer(r"!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))", clean):
        links.append(match.group(1) or match.group(2))
    for match in re.finditer(r"^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))", clean, flags=re.MULTILINE):
        links.append(match.group(1) or match.group(2))
    return links


def check(args: argparse.Namespace) -> tuple[dict, int]:
    project, docs = roots(args)
    if not docs.is_dir():
        raise DataError("Project docs are missing; run init first")
    errors, warnings, status_counts = [], [], {}
    data = None
    try:
        _, data = load_manifest(docs)
    except DataError as exc:
        errors.append(str(exc))
    if data is not None:
        content_ids = {}
        for entry in data["references"]:
            state = entry["status"]
            status_counts[state] = status_counts.get(state, 0) + 1
            path = checked_member(docs, entry["path"])
            if not path.is_file():
                errors.append(f"{entry['id']}: missing image {entry['path']}")
            else:
                try:
                    if sha256(path).lower() != entry["sha256"].lower():
                        errors.append(f"{entry['id']}: image bytes do not match the recorded sha256")
                except OSError as exc:
                    errors.append(f"{entry['id']}: cannot read image: {exc}")
            content_ids.setdefault(entry["sha256"].lower(), []).append(entry["id"])
        for ids in content_ids.values():
            if len(ids) > 1:
                warnings.append("Existing identical image bytes retain separate historical IDs: " + ", ".join(ids))
    json_files, markdown_files, links_checked = 0, 0, 0
    for path in sorted(docs.rglob("*")):
        if path.is_symlink():
            errors.append("Symlinks are not portable managed project data: " + path.relative_to(docs).as_posix())
            continue
        if not path.is_file():
            continue
        relative = path.relative_to(docs).as_posix()
        if path.suffix.lower() == ".json":
            json_files += 1
            try:
                value = read_json(path)
                if relative == "project.json" and (not isinstance(value, dict) or value.get("schema_version") != 1):
                    errors.append("project.json must be an object with schema_version 1")
            except DataError as exc:
                errors.append(f"{relative}: {exc}")
        if path.suffix.lower() != ".md":
            continue
        markdown_files += 1
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append(f"{relative}: cannot read Markdown: {exc}")
            continue
        for raw in markdown_links(text):
            parsed = urlsplit(raw)
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            links_checked += 1
            value = unquote(parsed.path)
            if Path(value).is_absolute() or PureWindowsPath(value).drive or "\\" in value:
                errors.append(f"{relative}: nonportable absolute link {raw}")
                continue
            target = (path.parent / value).resolve(strict=False)
            if not inside(target, project):
                errors.append(f"{relative}: link leaves the project: {raw}")
            elif not target.exists():
                errors.append(f"{relative}: missing link target: {raw}")
    if not (docs / "project.json").is_file():
        errors.append("Missing project.json")
    return {
        "operation": "check", "status": "ok" if not errors else "error",
        "project_root": str(project), "docs_root": str(docs),
        "reference_count": len(data["references"]) if data is not None else None,
        "status_counts": status_counts, "pending_count": status_counts.get("pending", 0),
        "reviewed_count": status_counts.get("reviewed", 0),
        "json_files_checked": json_files, "markdown_files_checked": markdown_files,
        "relative_links_checked": links_checked, "errors": errors, "warnings": warnings,
        "visual_review": "not_performed",
    }, 0 if not errors else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="operation", required=True)
    for name, help_text in (
        ("init", "Create project-local docs from templates without overwriting existing files"),
        ("ingest", "Copy new image bytes, deduplicate, and register pending references"),
        ("check", "Check data integrity and relative links, not visual/style quality"),
    ):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--project-root", required=True, help="Existing project directory; never inferred from the skill package")
        command.add_argument("--docs-dir", default=DEFAULT_DOCS, help="Relative docs directory inside the project (default: %(default)s)")
        if name == "ingest":
            command.add_argument("--input", action="append", nargs="+", metavar="PATH", help="Read-only source files/directories; repeatable; default references/inbox")
    args = parser.parse_args()
    try:
        result, code = {"init": init_project, "ingest": ingest, "check": check}[args.operation](args)
    except (DataError, OSError) as exc:
        result, code = {"operation": args.operation, "status": "error", "error": str(exc), "visual_review": "not_performed"}, 1
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
