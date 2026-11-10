#!/usr/bin/env python3
"""Export named, validated personal skills; --check verifies an existing export.

Requires Python 3 and PyYAML. This is a maintainer utility, not a skill installer.
Only user-entry SKILL frontmatter is adapted for Claude Code / Cursor.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath

import yaml


def digest(data):
    return hashlib.sha256(data).hexdigest()


def frontmatter(text):
    match = re.match(r'\A---\n(.*?)\n---(?:\n|\Z)', text, re.S)
    if not match:
        raise ValueError('Missing SKILL frontmatter')
    value = yaml.safe_load(match.group(1))
    if not isinstance(value, dict):
        raise ValueError('Invalid SKILL frontmatter')
    return value


def destination(root, name, relative):
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', name):
        raise ValueError('Invalid skill name')
    rel = PurePosixPath(relative)
    if rel.is_absolute() or not rel.parts or any(p in ('.', '..') for p in rel.parts):
        raise ValueError('Invalid resource path')
    path = root / '.agents/skills' / name / Path(*rel.parts)
    if any(p.is_symlink() for p in (path, *path.parents) if p != root and root in p.parents):
        raise ValueError('Refusing symlinked export destination')
    if any(p.exists() and not p.is_dir() for p in path.parents if root in p.parents):
        raise ValueError('Export destination ancestor is not a directory')
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--add', nargs='*', default=[])
    parser.add_argument('--version')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    root = args.repo.resolve()
    registry = root / '.agents/skills/work-suite.json'
    if any(p.is_symlink() for p in [root / '.agents', root / '.agents/skills', registry]):
        raise ValueError('Refusing symlinked registry')
    manifest = json.loads(registry.read_text())
    old = {s['name']: s for s in manifest['skills']}
    if len(old) != len(manifest['skills']):
        raise ValueError('Duplicate manifest skill names')
    names = list(old) + [n for n in args.add if n not in old]
    if len(names) != len(set(names)):
        raise ValueError('Duplicate skill names')
    sources = {}
    for entry in args.source_root.glob('*/SKILL.md'):
        name = frontmatter(entry.read_text()).get('name')
        if name in names:
            if name in sources:
                raise ValueError('Duplicate source: ' + name)
            sources[name] = entry.parent
    if set(names) != set(sources):
        raise ValueError('Missing sources: ' + repr(sorted(set(names) - set(sources))))

    planned = {}
    records = []
    for name in names:
        source = sources[name]
        config = yaml.safe_load((source / 'agents/openai.yaml').read_text())
        implicit = config.get('policy', {}).get('allow_implicit_invocation', True)
        if not isinstance(implicit, bool):
            raise ValueError('Non-boolean invocation policy: ' + name)
        files = []
        for entry in sorted(source.rglob('*')):
            if '__pycache__' in entry.parts or not entry.is_file():
                continue
            if entry.is_symlink():
                raise ValueError('Source resources must be ordinary files: ' + str(entry))
            rel = entry.relative_to(source).as_posix()
            data = original = entry.read_bytes()
            if rel == 'SKILL.md':
                text = data.decode('utf-8')
                meta = frontmatter(text)
                if 'disable-model-invocation' in meta:
                    raise ValueError('Canonical source already has host extension: ' + name)
                if not implicit:
                    header, body = text.split('\n---', 1)
                    data = (header + '\ndisable-model-invocation: true\n---' + body).encode('utf-8')
            target = destination(root, name, rel)
            planned[target] = data
            record = {'path': rel, 'sha256': digest(data)}
            if data != original:
                record.update(source_sha256=digest(original), transform='add-disable-model-invocation')
            files.append(record)
        records.append({'name': name, 'path': '.agents/skills/' + name,
                        'invocation': 'implicit-or-explicit' if implicit else 'explicit-user',
                        'files': files})

    manifest['skills'] = records
    if args.version:
        manifest['suite_version'] = args.version
    manifest['export_policy'] = {
        'canonical': 'Personal skill content; OpenAI invocation policy in agents/openai.yaml.',
        'user_entry_transform': 'Add disable-model-invocation: true only to explicit-user SKILL frontmatter; retain body bytes.',
        'verification': 'Static metadata and resource equality are not proof of host runtime enforcement.'
    }
    planned[registry] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    if any(s['path'] != '.agents/skills/' + name for name, s in old.items()):
        raise ValueError('Invalid manifest skill directory')
    tracked = {destination(root, name, f['path']) for name, s in old.items() for f in s['files']}
    stale = tracked - set(planned)
    collisions = [p for p in planned if p != registry and p.exists() and p not in tracked]
    if collisions:
        raise ValueError('Refusing to overwrite unregistered export files: ' + repr(collisions))
    extras = []
    for name in names:
        target = root / '.agents/skills' / name
        if target.exists():
            extras.extend(p for p in target.rglob('*') if p.is_file() and p not in planned and p not in stale)
    if extras:
        raise ValueError('Unregistered files would be left in export: ' + repr(extras))
    different = [str(p.relative_to(root)) for p, data in planned.items()
                 if not p.exists() or p.read_bytes() != data]
    if args.check:
        if different or any(p.exists() for p in stale):
            raise ValueError('Export differs: ' + repr(different + [str(p.relative_to(root)) for p in stale if p.exists()]))
    else:
        for p, data in planned.items():
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        for p in stale:
            p.unlink(missing_ok=True)
    print(json.dumps({'skills': len(records), 'resources': sum(len(s['files']) for s in records),
                      'user_entries': [s['name'] for s in records if s['invocation'] == 'explicit-user'],
                      'mode': 'verified' if args.check else 'exported'}))


if __name__ == '__main__':
    main()
