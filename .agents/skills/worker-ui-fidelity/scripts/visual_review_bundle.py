#!/usr/bin/env python3
"""Validate visual review handoff files/version/region coverage, never aesthetics."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

from PIL import Image

VISUAL_ATTRIBUTES = {'layout', 'background', 'color', 'border', 'shape', 'typography', 'icon', 'artwork'}
MEDIA_KINDS = {'reference', 'actual', 'side_by_side', 'overlay'}


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def unique_records(records, label):
    if not isinstance(records, list) or not records:
        raise ValueError(f'{label}: expected a nonempty list')
    result = {}
    for row in records:
        if not isinstance(row, dict) or not nonempty(row.get('id')) or row['id'] in result:
            raise ValueError(f'{label}: missing/duplicate ID')
        result[row['id']] = row
    return result


def load_plan(path, expected_sha):
    data = path.read_bytes()
    if not re.fullmatch(r'[0-9a-f]{64}', expected_sha or '') or hashlib.sha256(data).hexdigest() != expected_sha:
        raise ValueError('plan hash differs; use the frozen pre-review plan SHA256')
    return json.loads(data)


def check_plan(document, plan):
    """Check independently declared applicability and element/attribute/state coverage."""
    if not isinstance(plan, dict) or plan.get('schema_version') != 1 or not nonempty(plan.get('basis')):
        raise ValueError('plan requires schema_version=1 and a confirmation/contract basis')
    planned = unique_records(plan.get('captures'), 'planned captures')
    actual = unique_records(document.get('captures'), 'captures')
    if set(planned) != set(actual):
        raise ValueError(f'capture coverage differs: missing={sorted(set(planned)-set(actual))}, extra={sorted(set(actual)-set(planned))}')
    for identity, capture in planned.items():
        current = actual[identity]
        for key in ('device', 'font_scale'):
            if capture.get(key) != current.get(key):
                raise ValueError(f'{identity}: planned {key} differs')
        reference = capture.get('reference', {})
        if (not isinstance(reference, dict)
                or not re.fullmatch(r'[0-9a-f]{64}', str(reference.get('sha256', '')))
                or reference['sha256'] != current['reference']['sha256']):
            raise ValueError(f'{identity}: adopted reference differs from plan')
        # State/theme are task-specific, but cannot disappear when declared in the plan.
        for key in ('state', 'theme', 'language', 'lifecycle'):
            if key in capture and capture[key] != current.get(key):
                raise ValueError(f'{identity}: planned {key} differs')
    elements = unique_records(plan.get('elements'), 'elements')
    applicable = set()
    for identity, element in elements.items():
        attrs, skipped = element.get('attributes'), element.get('not_applicable', {})
        if (not isinstance(attrs, list) or not all(nonempty(a) for a in attrs)
                or len(set(attrs)) != len(attrs) or not isinstance(skipped, dict)
                or any(not nonempty(reason) for reason in skipped.values()) or set(attrs) & set(skipped)):
            raise ValueError(f'{identity}: invalid attribute applicability/reasons')
        missing = VISUAL_ATTRIBUTES - set(attrs) - set(skipped)
        if missing:
            raise ValueError(f'{identity}: unassessed attributes {sorted(missing)}')
        applicable.update((identity, attribute) for attribute in attrs)
    checks = unique_records(plan.get('checks'), 'planned checks')
    expected, covered = set(), set()
    for identity, item in checks.items():
        pair = (item.get('element'), item.get('attribute'))
        captures = item.get('captures')
        if (pair not in applicable or not nonempty(item.get('target')) or not nonempty(item.get('basis'))
                or not isinstance(captures, list) or not captures
                or not all(nonempty(c) for c in captures) or len(set(captures)) != len(captures)
                or not set(captures) <= set(planned)):
            raise ValueError(f'{identity}: invalid element/attribute/target/basis/capture scope')
        covered.add(pair)
        expected.update((capture, identity) for capture in captures)
    if applicable - covered:
        raise ValueError(f'applicable attributes without checks: {sorted(applicable-covered)}')
    unchecked_captures = set(planned) - {capture for capture, _ in expected}
    if unchecked_captures:
        raise ValueError(f'planned captures without attribute checks: {sorted(unchecked_captures)}')
    rows = document.get('checks', [])
    if not isinstance(rows, list):
        raise ValueError('checks must be a list')
    observed = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('invalid check result')
        key = (row.get('capture'), row.get('check_id'))
        if key not in expected or key in observed:
            raise ValueError(f'unplanned/duplicate check result: {key}')
        observed.add(key)
        status = row.get('status')
        if status not in ('pass', 'fail', 'pending', 'exception'):
            raise ValueError(f'{key}: invalid check status')
        if status != 'pending':
            media = row.get('reviewed_media', [])
            if (not nonempty(row.get('observation')) or not isinstance(media, list)
                    or not all(nonempty(k) for k in media) or not set(media) <= MEDIA_KINDS
                    or not {'reference', 'actual', 'side_by_side'} <= set(media)):
                raise ValueError(f'{key}: observation and reviewed source/current/comparison media required')
        if status == 'exception' and not nonempty(row.get('acceptance_source')):
            raise ValueError(f'{key}: exception requires explicit acceptance source')
    if expected - observed:
        raise ValueError(f'missing planned checks: {sorted(expected-observed)}')
    return {'expected': len(expected), 'recorded': len(observed),
            'by_status': {status: sum(row['status'] == status for row in rows)
                          for status in ('pass', 'fail', 'pending', 'exception')}}


def check_binding(document, expected, repo):
    binding = document.get('source_binding')
    if binding is None:
        return
    if (not isinstance(binding, dict) or not re.fullmatch(r'[0-9a-f]{40}', expected)
            or binding.get('commit') != expected
            or not isinstance(binding.get('files'), list) or not binding['files']):
        raise ValueError('source binding requires the final commit and captured source hashes')
    files = binding['files']
    if any(not isinstance(f, dict) or not nonempty(f.get('path'))
           or not re.fullmatch(r'[0-9a-f]{64}', str(f.get('sha256', ''))) for f in files):
        raise ValueError('source binding requires file paths and SHA256 values')
    if len({f['path'] for f in files}) != len(files):
        raise ValueError('duplicate source binding paths')
    for source in files:
        path = PurePosixPath(source['path'])
        if path.is_absolute() or '..' in path.parts or any(p.startswith('.env') for p in path.parts):
            raise ValueError('source binding requires safe repository-relative paths')
        result = subprocess.run(['git', 'show', f'{expected}:{path}'], cwd=repo,
                                capture_output=True, timeout=15)
        if result.returncode or hashlib.sha256(result.stdout).hexdigest() != source['sha256']:
            raise ValueError(f'{path}: captured source differs from final commit')
    for capture in document['captures']:
        if capture.get('source_files') != files:
            raise ValueError(f'{capture["id"]}: captured sources do not match final binding')


def check(document, expected, root, repo=None, plan=None):
    if not isinstance(document, dict) or not nonempty(expected):
        raise ValueError('manifest must be an object and expected version must be nonempty')
    required = document.get('required_regions', [])
    captures = document.get('captures', [])
    regions = document.get('regions', [])
    if (not isinstance(required, list) or not required or not all(nonempty(r) for r in required)
            or len(set(required)) != len(required)):
        raise ValueError('declare unique nonempty required regions')
    ids = set(unique_records(captures, 'captures'))
    if not isinstance(regions, list) or any(not isinstance(r, dict) for r in regions):
        raise ValueError('regions must be a list of review records')
    check_binding(document, expected, repo or Path.cwd())
    media = []
    for capture in captures:
        identity = capture['id']
        if capture.get('version') != expected:
            raise ValueError(f'{identity}: stale capture version')
        scale = capture.get('font_scale')
        if not nonempty(capture.get('device')) or type(scale) not in (int, float) or not 0 < scale < float('inf'):
            raise ValueError(f'{identity}: device and positive finite font_scale required')
        for kind in ('reference','actual','side_by_side','overlay'):
            asset=capture[kind];path=Path(asset['path'])
            if not path.is_absolute():path=root/path
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest()!=asset['sha256']:raise ValueError(f'{identity}/{kind}: file hash differs')
            try:
                with Image.open(io.BytesIO(data)) as image:
                    image.load()
            except (OSError, ValueError) as error:
                raise ValueError(f'{identity}/{kind}: invalid image: {error}') from error
            media.append(dict(capture=identity,kind=kind,path=str(path.resolve())))
        if 'capture_record' in capture:
            asset=capture['capture_record'];path=Path(asset['path'])
            if not path.is_absolute():path=root/path
            if hashlib.sha256(path.read_bytes()).hexdigest()!=asset['sha256']:
                raise ValueError(f'{identity}: capture record hash differs')
            record=json.loads(path.read_text(encoding='utf-8'))
            if (not isinstance(record, dict) or record.get('status')!='captured' or not record.get('source_files')
                    or record.get('source_files')!=capture.get('source_files')
                    or record.get('actual',{}).get('sha256')!=capture['actual']['sha256']):
                raise ValueError(f'{identity}: capture record does not describe this evidence')
            if not re.fullmatch(r'[0-9a-f]{40}', str(record.get('head', ''))) or not isinstance(record.get('dirty_sources'), bool):
                raise ValueError(f'{identity}: capture provenance missing')
            if document.get('source_binding') is None and (record['head']!=expected or record['dirty_sources']):
                raise ValueError(f'{identity}: dirty/cross-version capture requires source_binding')
    for identity in ids:
        rows=[r for r in regions if r.get('capture')==identity]
        if len(rows)!=len(required) or {r['name'] for r in rows}!=set(required):raise ValueError(f'{identity}: missing/duplicate required regions')
    if any(r.get('capture') not in ids for r in regions):raise ValueError('region refers to unknown capture')
    for row in regions:
        if row.get('status') not in ('pass','fail','pending','exception'):raise ValueError('invalid region status')
        if row['status']!='pending' and not nonempty(row.get('observation')):raise ValueError('review conclusion requires an observation')
        if row['status']=='exception' and not nonempty(row.get('acceptance_source')):raise ValueError('exception requires explicit acceptance source')
    coverage = check_plan(document, plan) if plan is not None else None
    states={r['status'] for r in regions}
    if coverage is not None:
        states.update(r['status'] for r in document['checks'])
    outcome=('fail' if 'fail' in states else 'pending' if 'pending' in states else 'partial' if 'exception' in states else 'reviewer_reported_pass')
    return dict(evidence_valid=True,version=expected,visual_result=outcome,coverage=coverage,
                validation_scope='planned_attributes' if plan is not None else 'declared_regions',
                judgment_origin='reviewer_declared',
                note='File integrity, readable images and declared coverage only; not visual acceptance or proof of runtime provenance.',
                media=media,regions=regions)


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('manifest',type=Path);p.add_argument('--expect-version',required=True)
    p.add_argument('--repo', type=Path, default=Path.cwd(), help='Git checkout for optional final-commit source binding')
    p.add_argument('--plan', type=Path, help='Independent pre-review acceptance plan')
    p.add_argument('--expect-plan-sha', help='Frozen SHA256 of the independent plan')
    p.add_argument('--finalize', action='store_true', help='Require a plan and no failed/pending checks; exit 2 when incomplete')
    args=p.parse_args(argv)
    try:
        if bool(args.plan) != bool(args.expect_plan_sha) or (args.finalize and not args.plan):
            raise ValueError('--plan and --expect-plan-sha are required together; finalize requires both')
        plan = load_plan(args.plan, args.expect_plan_sha) if args.plan else None
        report = check(json.loads(args.manifest.read_text(encoding='utf-8')), args.expect_version,
                       args.manifest.resolve().parent, args.repo, plan)
        if plan is not None:
            report['plan_sha256'] = args.expect_plan_sha
        report['acceptance_complete'] = plan is not None and report['visual_result'] in ('reviewer_reported_pass', 'partial')
        print(json.dumps(report,ensure_ascii=True,indent=2))
        return 2 if args.finalize and not report['acceptance_complete'] else 0
    except (ValueError,KeyError,TypeError,OSError,subprocess.TimeoutExpired) as error:
        print(f'visual review bundle: {error}',file=sys.stderr);return 1

if __name__=='__main__':sys.exit(main())
