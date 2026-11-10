#!/usr/bin/env python3
"""Build labeled reference-left/runtime-right viewing pairs from verified evidence.

Presentation only: independent aspect-preserving fit, no visual acceptance score.
"""
import argparse
import hashlib
import html
import io
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps
from visual_review_bundle import check, load_plan, nonempty


def image_asset(asset, root):
    path = Path(asset['path'])
    if not path.is_absolute():
        path = root/path
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != asset['sha256']:
        raise ValueError(f'{path}: image changed after evidence validation')
    with Image.open(io.BytesIO(data)) as source:
        rgba = ImageOps.exif_transpose(source).convert('RGBA')
    return Image.alpha_composite(Image.new('RGBA', rgba.size, 'white'), rgba).convert('RGB')


def crop(image, box):
    if (not isinstance(box, list) or len(box) != 4
            or any(type(n) is not int for n in box)):
        raise ValueError('detail crop requires integer x,y,width,height')
    x, y, width, height = box
    if min(x, y) < 0 or min(width, height) <= 0 or x+width > image.width or y+height > image.height:
        raise ValueError('detail crop outside source image')
    return image.crop((x, y, x+width, y+height))


def label_font():
    for path in ('/System/Library/Fonts/PingFang.ttc',
                 '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        if Path(path).is_file():
            return ImageFont.truetype(path, 16)
    return ImageFont.load_default()


def pair_image(reference, actual, width):
    # Two independently fitted panels preserve the original aspect ratios.
    # This must never feed pixel-diff/overlay tools as an aligned comparison.
    fitted = []
    for image in (reference, actual):
        factor = min(1, width/image.width, 1600/image.height)
        fitted.append(image.resize((max(1, round(image.width*factor)),
                                   max(1, round(image.height*factor))), Image.Resampling.LANCZOS))
    canvas = Image.new('RGB', (width*2+12, max(i.height for i in fitted)+104), 'white')
    draw = ImageDraw.Draw(canvas)
    font = label_font()
    placements = []
    for index, (label, original, image) in enumerate(zip(
            ('Reference', 'Implementation'), (reference, actual), fitted)):
        origin = index*(width+12)
        draw.text((origin+8, 8), label, fill='#26303b', font=font)
        draw.text((origin+8, 32), f'{original.width} x {original.height}px', fill='#596371', font=font)
        x, y = origin+(width-image.width)//2, 64
        canvas.paste(image, (x, y))
        placements.append([x, y, image.width, image.height])
    draw.line((width+6, 0, width+6, canvas.height), fill='#d0d5dc')
    # Short panels use compact labels; full explanation is in gallery.json/index.html.
    draw.text((8, canvas.height-28), 'Preview only', fill='#596371', font=font)
    return canvas, placements


def build(args):
    if not 128 <= args.panel_width <= 1600:
        raise ValueError('panel width must be 128..1600')
    if bool(args.plan) != bool(args.expect_plan_sha):
        raise ValueError('--plan and --expect-plan-sha are required together')
    output = args.output.resolve()
    if output.exists():
        raise ValueError('output already exists; use a new round directory')
    manifest_root = args.manifest.resolve().parent
    document = json.loads(args.manifest.read_text(encoding='utf-8'))
    plan = load_plan(args.plan, args.expect_plan_sha) if args.plan else None
    review = check(document, args.expect_version, manifest_root, args.repo, plan)
    captures = {c['id']: c for c in document['captures']}
    details = (plan or {}).get('details', [])
    if not isinstance(details, list) or len(captures)+len(details) > 64:
        raise ValueError('gallery requires a detail list and at most 64 full/detail pairs')
    jobs = [(f'capture-{index:03d}.png', capture['id'], capture, None)
            for index, capture in enumerate(document['captures'], 1)]
    detail_ids = set()
    for index, detail in enumerate(details, 1):
        if (not isinstance(detail, dict) or not nonempty(detail.get('id'))
                or detail['id'] in detail_ids or detail.get('capture') not in captures
                or not nonempty(detail.get('note'))):
            raise ValueError('detail requires unique ID, planned capture and coordinate-mapping note')
        detail_ids.add(detail['id'])
        jobs.append((f'detail-{index:03d}.png', detail['id'], captures[detail['capture']], detail))
    rendered, items = [], []
    # Preflight every source and crop before creating output files.
    for filename, identity, capture, detail in jobs:
        reference = image_asset(capture['reference'], manifest_root)
        actual = image_asset(capture['actual'], manifest_root)
        if detail is not None:
            reference = crop(reference, detail.get('reference_crop'))
            actual = crop(actual, detail.get('actual_crop'))
        image, placements = pair_image(reference, actual, args.panel_width)
        rendered.append((filename, image))
        sources = {}
        for kind in ('reference', 'actual'):
            asset = capture[kind]
            path = Path(asset['path'])
            sources[kind] = dict(asset, path=str((manifest_root/path).resolve()),
                                 declared_path=asset['path'])
        items.append({'id':identity, 'capture':capture['id'], 'file':filename,
                      **sources,
                      'detail':detail, 'placements_xywh':placements})
    output.mkdir(parents=True, exist_ok=False)
    for filename, image in rendered:
        image.save(output/filename)
    thumbs = [ImageOps.contain(image, (720, 1200), Image.Resampling.LANCZOS) for _, image in rendered]
    sheet = Image.new('RGB', (max(i.width for i in thumbs), sum(i.height+32 for i in thumbs)), 'white')
    draw = ImageDraw.Draw(sheet)
    top = 0
    for item, thumb in zip(items, thumbs):
        draw.text((8, top+6), item['id'], fill='#26303b', font=label_font())
        sheet.paste(thumb, (0, top+32))
        top += thumb.height+32
    sheet.save(output/'contact-sheet.png')
    report = {'presentation_only':True, 'visual_result':review['visual_result'],
              'version':args.expect_version, 'plan_sha256':args.expect_plan_sha,
              'validation_scope':review['validation_scope'], 'judgment_origin':review['judgment_origin'],
              'layout':'reference left; runtime right; independent aspect-preserving fit; white letterbox',
              'alpha_background':'#ffffff', 'items':items, 'coverage':review['coverage']}
    (output/'gallery.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    figures = '\n'.join(f'<figure><figcaption>{html.escape(item["id"])}</figcaption>'
                        f'<a href="{item["file"]}"><img src="{item["file"]}" alt="Reference left, implementation right"></a></figure>'
                        for item in items)
    (output/'index.html').write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Visual review</title>'
        '<style>body{max-width:1200px;margin:24px auto;font:16px system-ui;background:#eee}'
        'figure{margin:24px 0}img{display:block;max-width:100%;height:auto}figcaption{padding:8px}</style>'
        '<h1>Reference / Implementation</h1><p>Reference left, runtime right. '
        'Independently fitted previews; white letterboxing preserves aspect ratios. '
        'These previews do not prove pixel alignment or visual acceptance.</p>'
        f'<p>Review status: {html.escape(review["visual_result"])}</p>{figures}</html>', encoding='utf-8')
    return {'output':str(output), 'contact_sheet':str(output/'contact-sheet.png'),
            'pairs':len(items), 'visual_result':review['visual_result']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--plan', type=Path, help='Optional frozen coverage plan')
    parser.add_argument('--expect-plan-sha', help='Required when --plan is supplied')
    parser.add_argument('--expect-version', required=True)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--panel-width', type=int, default=540)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(build(args), ensure_ascii=True))
        return 0
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(f'visual review gallery: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
