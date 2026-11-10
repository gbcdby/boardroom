"""Evidence contract, not an automated aesthetic score."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image
SKILL=Path(__file__).resolve().parents[1]
SCRIPT=SKILL/'scripts/visual_review_bundle.py'
SCRATCH = Path(tempfile.gettempdir())

def planned_fixture(root):
    image=root/'capture.png';Image.new('RGB', (16, 16), 'white').save(image)
    asset={'path':str(image),'sha256':hashlib.sha256(image.read_bytes()).hexdigest()}
    capture={'id':'normal','version':'a'*40,'device':'test','font_scale':1,
             **{k:asset for k in ('reference','actual','side_by_side','overlay')}}
    document={'required_regions':['button'],'captures':[capture],
              'regions':[{'capture':'normal','name':'button','status':'pass','observation':'visible'}],
              'checks':[{'capture':'normal','check_id':'button-shape','status':'pass','observation':'round ends match','reviewed_media':['reference','actual','side_by_side']}]}
    plan={'schema_version':1,'basis':'User-approved button reference',
          'captures':[{'id':'normal','device':'test','font_scale':1,'reference':asset}],
          'elements':[{'id':'button','attributes':['shape','border'],
              'not_applicable':{k:'Outside this border/shape change' for k in
                  ('layout','background','color','typography','icon','artwork')}}],
          'checks':[{'id':'button-shape','element':'button','attribute':'shape','target':'capsule',
                     'basis':'approved.png','captures':['normal']},
                    {'id':'button-border','element':'button','attribute':'border','target':'1pt teal',
                     'basis':'button contract','captures':['normal']}]}
    manifest=root/'bundle.json';manifest.write_text(json.dumps(document))
    plan_path=root/'plan.json';plan_path.write_text(json.dumps(plan))
    return capture, document, plan, manifest, plan_path


class BundleTests(unittest.TestCase):
    def test_utf8_manifest_capture_record_and_json_stdout_under_ascii_locale(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as raw:
            root = Path(raw)
            image = root/'capture.png'
            Image.new('RGB', (16, 16), 'white').save(image)
            asset = {'path': 'capture.png', 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()}
            source = root/'screen.py'
            source.write_text('# capture fixture\n', encoding='utf-8')
            sources = [{'path': 'screen.py', 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}]
            record = {'status': 'captured', 'head': 'a'*40, 'dirty_sources': False,
                      'source_files': sources, 'actual': asset, 'note': '中文捕获记录'}
            capture = {'id': 'default', 'version': 'a'*40, 'device': 'browser', 'font_scale': 1,
                       'source_files': sources,
                       **{kind: asset for kind in ('reference', 'actual', 'side_by_side', 'overlay')}}
            document = {'required_regions': ['标题'], 'captures': [capture],
                        'regions': [{'capture': 'default', 'name': '标题', 'status': 'pass',
                                     'observation': '中文标题已按本轮原图核对'}]}
            manifest, capture_record = root/'review.json', root/'capture.json'
            # Isolate manifest input, nested record input, and JSON stdout encoding.
            for case, escape_manifest, escape_record in (
                    ('manifest', False, True), ('capture_record', True, False),
                    ('stdout', True, True)):
                with self.subTest(case=case):
                    capture_record.write_text(json.dumps(record, ensure_ascii=escape_record), encoding='utf-8')
                    capture['capture_record'] = {
                        'path': 'capture.json', 'sha256': hashlib.sha256(capture_record.read_bytes()).hexdigest()}
                    manifest.write_text(json.dumps(document, ensure_ascii=escape_manifest), encoding='utf-8')
                    originals = manifest.read_bytes(), capture_record.read_bytes()
                    results = []
                    for utf8_mode in ('1', '0'):
                        env = dict(os.environ, PYTHONUTF8=utf8_mode, PYTHONCOERCECLOCALE='0',
                                   LC_ALL='C', PYTHONDONTWRITEBYTECODE='1')
                        env.pop('PYTHONIOENCODING', None)
                        result = subprocess.run([
                            sys.executable, '-B', str(SCRIPT), str(manifest),
                            '--expect-version', 'a'*40], env=env, capture_output=True)
                        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
                        report = json.loads(result.stdout)
                        self.assertEqual(report['regions'], document['regions'])
                        self.assertEqual(report['visual_result'], 'reviewer_reported_pass')
                        self.assertFalse(report['acceptance_complete'])
                        results.append(report)
                    self.assertEqual(results[0], results[1])
                    self.assertEqual((manifest.read_bytes(), capture_record.read_bytes()), originals)

    def test_legacy_records_reject_empty_identity_and_invalid_font_scale(self):
        cases = ('version', 'capture_id', 'device', 'region_name',
                 'bool_scale', 'nan_scale', 'infinite_scale', 'numeric_observation')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as raw:
            for case in cases:
                with self.subTest(case=case):
                    capture, document, _, manifest, _ = planned_fixture(Path(raw))
                    expected = 'a'*40
                    if case == 'version':
                        expected = capture['version'] = ' '
                    elif case == 'capture_id':
                        capture['id'] = document['regions'][0]['capture'] = ''
                    elif case == 'device':
                        capture['device'] = ' '
                    elif case == 'region_name':
                        document['required_regions'] = ['']
                        document['regions'][0]['name'] = ''
                    elif case == 'numeric_observation':
                        document['regions'][0]['observation'] = 17
                    else:
                        capture['font_scale'] = {
                            'bool_scale': True, 'nan_scale': float('nan'),
                            'infinite_scale': float('inf')}[case]
                    manifest.write_text(json.dumps(document))
                    result = subprocess.run([
                        sys.executable, str(SCRIPT), str(manifest),
                        '--expect-version', expected], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                    self.assertNotIn('Traceback', result.stderr)

    def test_finalize_rejects_blank_region_exception_acceptance_source(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as raw:
            _, document, _, manifest, plan_path = planned_fixture(Path(raw))
            document['checks'].append({
                'capture': 'normal', 'check_id': 'button-border', 'status': 'pass',
                'observation': 'Outline inspected at display size',
                'reviewed_media': ['reference', 'actual', 'side_by_side']})
            document['regions'][0].update(status='exception', acceptance_source='   ')
            manifest.write_text(json.dumps(document))
            result = subprocess.run([
                sys.executable, str(SCRIPT), str(manifest), '--expect-version', 'a'*40,
                '--plan', str(plan_path), '--expect-plan-sha',
                hashlib.sha256(plan_path.read_bytes()).hexdigest(), '--finalize'],
                capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn('acceptance source', result.stderr)

    def test_finalize_rejects_unreadable_media_even_with_matching_hash(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as raw:
            root = Path(raw)
            capture, document, plan, manifest, plan_path = planned_fixture(root)
            document['checks'].append({
                'capture': 'normal', 'check_id': 'button-border', 'status': 'pass',
                'observation': 'Outline inspected at display size',
                'reviewed_media': ['reference', 'actual', 'side_by_side']})
            invalid = root/'unreadable.png'
            invalid.write_bytes(b'This is text, not a runtime screenshot.')
            capture['actual'] = {'path': str(invalid),
                                'sha256': hashlib.sha256(invalid.read_bytes()).hexdigest()}
            manifest.write_text(json.dumps(document))
            result = subprocess.run([
                sys.executable, str(SCRIPT), str(manifest), '--expect-version', 'a'*40,
                '--plan', str(plan_path), '--expect-plan-sha',
                hashlib.sha256(plan_path.read_bytes()).hexdigest(), '--finalize'],
                capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn('image', result.stderr.lower())
            self.assertNotIn('Traceback', result.stderr)

    def test_independent_plan_catches_attribute_omitted_from_region_pass(self):
        scratch=SCRATCH;scratch.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as raw:
            capture,document,plan,manifest,plan_path=planned_fixture(Path(raw))
            def call():
                manifest.write_text(json.dumps(document))
                return subprocess.run([sys.executable,str(SCRIPT),str(manifest),'--expect-version','a'*40,
                    '--plan',str(plan_path),'--expect-plan-sha',hashlib.sha256(plan_path.read_bytes()).hexdigest()],
                    capture_output=True,text=True)
            result=call()
            self.assertNotEqual(result.returncode,0)
            self.assertIn('button-border',result.stderr)
            document['checks'].append({'capture':'normal','check_id':'button-border','status':'pending'})
            result=call();self.assertEqual(result.returncode,0,result.stderr)
            report=json.loads(result.stdout)
            self.assertEqual(report['visual_result'],'pending')
            self.assertEqual(report['coverage']['expected'],2)
            # A declared large-font capture cannot borrow the normal capture's checks.
            extra=dict(capture,id='large')
            document['captures'].append(extra)
            document['regions'].append({'capture':'large','name':'button','status':'pass','observation':'visible'})
            plan['captures'].append(dict(plan['captures'][0],id='large'))
            plan_path.write_text(json.dumps(plan))
            result=call();self.assertNotEqual(result.returncode,0)
            self.assertIn('large',result.stderr)

    def test_finalize_requires_complete_planned_review_and_frozen_plan(self):
        scratch=SCRATCH;scratch.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as raw:
            capture,document,plan,manifest,plan_path=planned_fixture(Path(raw))
            document['checks'].append({'capture':'normal','check_id':'button-border','status':'pending'})
            args=[sys.executable,str(SCRIPT),str(manifest),'--expect-version','a'*40,
                  '--plan',str(plan_path),'--expect-plan-sha',hashlib.sha256(plan_path.read_bytes()).hexdigest()]
            def call(finalize=True):
                manifest.write_text(json.dumps(document))
                return subprocess.run(args+(['--finalize'] if finalize else []),capture_output=True,text=True)
            r=call();self.assertEqual(r.returncode,2,r.stderr)
            self.assertFalse(json.loads(r.stdout)['acceptance_complete'])
            row=document['checks'][1]
            row.update(status='pass',observation='Actual outline inspected at display size',
                       reviewed_media=['reference','actual','side_by_side'])
            r=call();self.assertEqual(r.returncode,0,r.stderr)
            self.assertTrue(json.loads(r.stdout)['acceptance_complete'])
            row['status']='fail';self.assertEqual(call().returncode,2)
            row['status']='exception';self.assertNotEqual(call().returncode,0)
            row['acceptance_source']='User accepted native edge rendering in current task'
            r=call();self.assertEqual(r.returncode,0,r.stderr)
            self.assertEqual(json.loads(r.stdout)['visual_result'],'partial')
            row['reviewed_media']=[];self.assertNotEqual(call().returncode,0)
            row['reviewed_media']=['reference','actual','side_by_side']
            document['checks'].append(dict(row));self.assertNotEqual(call().returncode,0)
            document['checks'].pop()
            document['captures'][0]['font_scale']=1.3;self.assertNotEqual(call().returncode,0)
            document['captures'][0]['font_scale']=1
            plan_path.write_text(plan_path.read_text()+'\n')
            self.assertNotEqual(call().returncode,0)

    def test_final_commit_binding_rejects_changed_source_and_capture_record(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location('bundle',SCRIPT)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        scratch=SCRATCH;scratch.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as raw:
            root=Path(raw)
            subprocess.run(['git','init','-q',str(root)],check=True)
            source=root/'screen.tsx';source.write_text('source at capture')
            subprocess.run(['git','-C',str(root),'add','.'],check=True)
            subprocess.run(['git','-C',str(root),'-c','user.name=test','-c','user.email=test@example.com','commit','-qm','source'],check=True)
            commit=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
            files=[{'path':'screen.tsx','sha256':hashlib.sha256(source.read_bytes()).hexdigest()}]
            image=root/'raw.png';Image.new('RGB', (16, 16), 'white').save(image)
            asset={'path':'raw.png','sha256':hashlib.sha256(image.read_bytes()).hexdigest()}
            record=root/'capture.json'
            record_data={'status':'captured','head':commit,'dirty_sources':False,'source_files':files,'actual':asset}
            record.write_text(json.dumps(record_data))
            capture={'id':'one','version':commit,'device':'test','font_scale':1,'source_files':files,
                     **{k:asset for k in ('reference','actual','side_by_side','overlay')},
                     'capture_record':{'path':'capture.json','sha256':hashlib.sha256(record.read_bytes()).hexdigest()}}
            d={'source_binding':{'commit':commit,'files':files},'required_regions':['title'],'captures':[capture],
               'regions':[{'capture':'one','name':'title','status':'pending'}]}
            self.assertTrue(module.check(d,commit,root,root)['evidence_valid'])
            binding=d.pop('source_binding')
            self.assertTrue(module.check(d,commit,root,root)['evidence_valid'])
            for change in ({'head':'0'*40},{'dirty_sources':True},{'source_files':[]}):
                with self.subTest(change=change):
                    record.write_text(json.dumps({**record_data,**change}))
                    capture['capture_record']['sha256']=hashlib.sha256(record.read_bytes()).hexdigest()
                    with self.assertRaises(ValueError): module.check(d,commit,root,root)
            # Dirty捕获可以通过最终提交的相同源码证明关联，保留原捕获head。
            d['source_binding']=binding
            record.write_text(json.dumps({**record_data,'head':'0'*40,'dirty_sources':True}))
            capture['capture_record']['sha256']=hashlib.sha256(record.read_bytes()).hexdigest()
            self.assertTrue(module.check(d,commit,root,root)['evidence_valid'])
            files[0]['sha256']='0'*64
            with self.assertRaises(ValueError): module.check(d,commit,root,root)
            files[0]['sha256']=hashlib.sha256(source.read_bytes()).hexdigest()
            record.write_text('{}')
            with self.assertRaises(ValueError): module.check(d,commit,root,root)

    def test_cli_rejects_missing_stale_or_uncovered_evidence(self):
        scratch=SCRATCH;scratch.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as raw:
            root=Path(raw);image=root/'capture.png';Image.new('RGB', (16, 16), 'white').save(image)
            asset={'path':str(image),'sha256':hashlib.sha256(image.read_bytes()).hexdigest()}
            capture={'id':'small-default','version':'a'*40,'device':'375x667','font_scale':1,
                     'reference':asset,'actual':asset,'side_by_side':asset,'overlay':asset}
            d={'required_regions':['title','entry labels'],'captures':[capture],
               'regions':[{'capture':'small-default','name':name,'status':'pending','observation':''} for name in ['title','entry labels']]}
            manifest=root/'bundle.json'
            def call():
                manifest.write_text(json.dumps(d))
                return subprocess.run([sys.executable,str(SCRIPT),str(manifest),'--expect-version','a'*40],capture_output=True,text=True)
            r=call();self.assertEqual(r.returncode,0,r.stderr)
            report=json.loads(r.stdout)
            self.assertEqual(report['visual_result'],'pending')
            self.assertIsNone(report['coverage'])
            self.assertFalse(report['acceptance_complete'])
            self.assertEqual(report['validation_scope'],'declared_regions')
            finalize=subprocess.run([sys.executable,str(SCRIPT),str(manifest),'--expect-version','a'*40,'--finalize'],capture_output=True,text=True)
            self.assertEqual(finalize.returncode,1)
            self.assertIn('finalize requires',finalize.stderr)
            d['regions'][0].update(status='pass',observation='Actual brush shapes inspected')
            d['regions'][1].update(status='pass',observation='Side spacing inspected')
            self.assertEqual(json.loads(call().stdout)['visual_result'],'reviewer_reported_pass')
            d['captures'][0]['version']='b'*40;self.assertNotEqual(call().returncode,0)
            d['captures'][0]['version']='a'*40;d['regions'].pop();self.assertNotEqual(call().returncode,0)
            d['regions'].append({'capture':'small-default','name':'entry labels','status':'pass','observation':'checked'})
            image.unlink();self.assertNotEqual(call().returncode,0)

if __name__=='__main__':unittest.main()
