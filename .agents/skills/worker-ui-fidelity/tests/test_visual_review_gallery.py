"""Exercise the gallery CLI with real images and independent expected pixels."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image

SKILL = Path(__file__).resolve().parents[1]
SCRIPT = SKILL/'scripts/visual_review_gallery.py'
SCRATCH = Path(tempfile.gettempdir())


class GalleryTests(unittest.TestCase):
    def test_utf8_artifacts_and_json_stdout_do_not_depend_on_locale(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as raw:
            root = Path(raw)
            image = root/'capture.png'
            Image.new('RGB', (32, 16), 'white').save(image)
            asset = {'path': 'capture.png', 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()}
            document = {'required_regions': ['标题'],
                        'captures': [{'id': '默认帧', 'version': 'snapshot:locale-test',
                                      'device': 'browser', 'font_scale': 1,
                                      **{kind: asset for kind in ('reference', 'actual', 'side_by_side', 'overlay')}}],
                        'regions': [{'capture': '默认帧', 'name': '标题', 'status': 'pending'}]}
            manifest = root/'review.json'
            cases = (('utf8-input', False, '0', None),
                     ('utf8-output', True, '0', None),
                     ('展示结果', True, '1', 'ascii'))
            for directory, escaped, utf8_mode, stream_encoding in cases:
                with self.subTest(directory=directory):
                    manifest.write_text(json.dumps(document, ensure_ascii=escaped), encoding='utf-8')
                    original = manifest.read_bytes()
                    output = root/directory
                    env = dict(os.environ, PYTHONUTF8=utf8_mode, PYTHONCOERCECLOCALE='0',
                               LC_ALL='C', PYTHONDONTWRITEBYTECODE='1')
                    env.pop('PYTHONIOENCODING', None)
                    if stream_encoding:
                        env['PYTHONIOENCODING'] = stream_encoding
                    result = subprocess.run([
                        sys.executable, '-B', str(SCRIPT), str(manifest), '--expect-version',
                        'snapshot:locale-test', '--output', str(output)], env=env, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
                    cli = json.loads(result.stdout)
                    self.assertEqual(cli['output'], str(output))
                    self.assertEqual(cli['visual_result'], 'pending')
                    report_text = (output/'gallery.json').read_text(encoding='utf-8')
                    self.assertIn('默认帧', report_text)
                    report = json.loads(report_text)
                    self.assertEqual(report['items'][0]['id'], '默认帧')
                    self.assertIsNone(report['coverage'])
                    self.assertIn('默认帧', (output/'index.html').read_text(encoding='utf-8'))
                    self.assertEqual(manifest.read_bytes(), original)

    def test_legacy_gallery_needs_no_invented_plan_or_git_history(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as raw:
            root = Path(raw)
            env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(root.parent))
            Image.new('RGB', (32, 16), 'white').save(root/'capture.png')
            asset = {'path': 'capture.png',
                     'sha256': hashlib.sha256((root/'capture.png').read_bytes()).hexdigest()}
            manifest = root/'legacy.json'
            manifest.write_text(json.dumps({
                'required_regions': ['header'],
                'captures': [{'id': 'default', 'version': 'snapshot:ui-smoke-1',
                              'device': 'browser 800x600', 'font_scale': 1,
                              **{kind: asset for kind in ('reference', 'actual', 'side_by_side', 'overlay')}}],
                'regions': [{'capture': 'default', 'name': 'header', 'status': 'pending'}]}))
            output = root/'gallery'
            args = [sys.executable, str(SCRIPT), str(manifest), '--expect-version',
                    'snapshot:ui-smoke-1', '--output', str(output)]
            result = subprocess.run(args, cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((output/'gallery.json').read_text())
            self.assertEqual(report['visual_result'], 'pending')
            self.assertIsNone(report['coverage'])
            self.assertIsNone(report['plan_sha256'])
            self.assertEqual(report['validation_scope'], 'declared_regions')
            self.assertTrue(report['presentation_only'])
            self.assertTrue((output/'capture-001.png').is_file())
            # Supplying half a frozen-plan contract must not silently use legacy mode.
            args[args.index(str(output))] = str(root/'bad-gallery')
            result = subprocess.run(args + ['--expect-plan-sha', '0'*64],
                                    cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertFalse((root/'bad-gallery').exists())

    def test_pairs_in_non_git_workspace_preserve_sources_aspect_and_history(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as raw:
            root = Path(raw)
            env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(root.parent))
            Image.new('RGB', (128, 256), 'red').save(root/'prototype.png')
            Image.new('RGB', (256, 128), 'blue').save(root/'runtime.png')
            def asset(name):
                return {'path':name, 'sha256':hashlib.sha256((root/name).read_bytes()).hexdigest()}
            ref, actual = asset('prototype.png'), asset('runtime.png')
            plan = {'schema_version':1, 'basis':'User-approved test contract',
                    'captures':[{'id':'normal','device':'test','font_scale':1,'reference':ref}],
                    'elements':[{'id':'button','attributes':['shape'],'not_applicable':{
                        k:'Outside this shape-only change' for k in
                        ('layout','background','color','border','typography','icon','artwork')}}],
                    'checks':[{'id':'shape','element':'button','attribute':'shape','target':'reference silhouette',
                               'basis':'prototype.png','captures':['normal']}],
                    'details':[{'id':'edge','capture':'normal','reference_crop':[0,0,16,16],
                                'actual_crop':[0,0,16,16],'note':'Top-left edge, source pixel coordinates'}]}
            bundle = {'required_regions':['button'],
                      'captures':[{'id':'normal','device':'test','font_scale':1,'version':'a'*40,
                                   'reference':ref,'actual':actual,'side_by_side':actual,'overlay':actual}],
                      'regions':[{'capture':'normal','name':'button','status':'pending'}],
                      'checks':[{'capture':'normal','check_id':'shape','status':'pending'}]}
            manifest, contract = root/'bundle.json', root/'plan.json'
            manifest.write_text(json.dumps(bundle));contract.write_text(json.dumps(plan))
            output = root/'gallery'
            args = [sys.executable,str(SCRIPT),str(manifest),'--plan',str(contract),
                    '--expect-plan-sha',hashlib.sha256(contract.read_bytes()).hexdigest(),
                    '--expect-version','a'*40,'--output',str(output),'--panel-width','128']
            result = subprocess.run(args,cwd=root,env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            with Image.open(output/'capture-001.png') as pair:
                self.assertEqual(pair.getpixel((64,100)),(255,0,0))
                self.assertEqual(pair.getpixel((204,90)),(0,0,255))
                # The short runtime image is letterboxed, never stretched to the reference height.
                self.assertEqual(pair.getpixel((204,200)),(255,255,255))
            self.assertTrue((output/'detail-001.png').is_file())
            self.assertTrue((output/'index.html').is_file())
            report=json.loads((output/'gallery.json').read_text())
            self.assertEqual(report['visual_result'],'pending')
            self.assertTrue(report['presentation_only'])
            self.assertEqual(report['items'][0]['reference']['sha256'],ref['sha256'])
            self.assertEqual(report['items'][0]['reference']['path'],str(root/'prototype.png'))
            self.assertEqual(report['items'][0]['actual']['path'],str(root/'runtime.png'))
            before=(output/'capture-001.png').read_bytes()
            self.assertNotEqual(subprocess.run(args,cwd=root,env=env,capture_output=True).returncode,0)
            self.assertEqual((output/'capture-001.png').read_bytes(),before)
            self.assertEqual(asset('prototype.png'),ref)
            self.assertEqual(asset('runtime.png'),actual)
            # A changed source must be refused, not silently redrawn as valid evidence.
            Image.new('RGB',(256,128),'green').save(root/'runtime.png')
            args[args.index(str(output))]=str(root/'stale-gallery')
            self.assertNotEqual(subprocess.run(args,cwd=root,env=env,capture_output=True).returncode,0)
            self.assertFalse((root/'stale-gallery').exists())


if __name__ == '__main__':
    unittest.main()
