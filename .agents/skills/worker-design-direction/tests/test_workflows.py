"""Local regression tests for source management, case coverage and color checks.

No visual aesthetic, UX success, or platform conformance is asserted here.
"""
from __future__ import annotations
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/art_direction.py'
COLOR = ROOT / 'scripts/color_check.py'
SPEC = importlib.util.spec_from_file_location('color_check', COLOR)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

class ColorCheckerTests(unittest.TestCase):
    def test_json_preserves_chinese_pair_names_under_ascii_locale(self):
        with tempfile.TemporaryDirectory() as tmp:
            palette = Path(tmp)/'palette.json'
            palette.write_text(json.dumps({'readability_pairs': [{
                'name': '正文文字', 'foreground': '#000000',
                'background': '#FFFFFF', 'kind': 'text'}]}, ensure_ascii=False), encoding='utf-8')
            env = dict(os.environ, PYTHONUTF8='0', PYTHONCOERCECLOCALE='0',
                       LC_ALL='C', PYTHONDONTWRITEBYTECODE='1')
            env.pop('PYTHONIOENCODING', None)
            result = subprocess.run([sys.executable, '-B', str(COLOR), 'check',
                                     '--palette', str(palette), '--json'], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
            data = json.loads(result.stdout)
            self.assertEqual(data['results'][0]['name'], '正文文字')
            self.assertEqual(data['results'][0]['ratio'], 21)
            self.assertEqual(data['passed'], 1)

    def test_white_on_black(self): self.assertAlmostEqual(mod.contrast('#000000','#FFFFFF'), 21, places=4)
    def test_same_color(self): self.assertAlmostEqual(mod.contrast('#445566','#445566'), 1.0)
    def test_invalid_hex(self):
        with self.assertRaises(mod.PaletteError): mod.contrast('red','#ffffff')
    def test_failure_not_silently_rounded(self):
        result=mod.validate_pair({'name':'low contrast','foreground':'#BBBBBB','background':'#FFFFFF','kind':'text'},1)
        self.assertFalse(result['passes_declared_threshold'])
    def test_palette_schema_rejects_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'empty.json';p.write_text('{"readability_pairs": []}')
            with self.assertRaises(mod.PaletteError): mod.check_palette(p)

class CaseLibraryTests(unittest.TestCase):
    def test_twenty_distinct_cases_and_provenance(self):
        data=json.loads((ROOT/'references/game-case-index.json').read_text())
        cases=data['cases']
        self.assertEqual(len(cases),20)
        self.assertEqual([x['id'] for x in cases],[f'GAME{i:02d}' for i in range(1,21)])
        self.assertEqual(sum(x['reviewed_visual_count'] for x in cases),46)
        for x in cases:
            self.assertTrue(x['sources'],x['id'])
            self.assertTrue(all(y['url'].startswith('https://') for y in x['sources']),x['id'])
            self.assertTrue(x['limits'],x['id'])
    def test_twelve_patterns(self):
        text=(ROOT/'references/game-ui-ux-patterns.md').read_text()
        ids=re.findall(r'^### (GP\d\d)',text,re.M)
        self.assertEqual(ids,[f'GP{i:02d}' for i in range(1,13)])
    def test_skill_markdown_links(self):
        from urllib.parse import urlsplit,unquote
        rg=re.compile(r'\]\(([^\s\)]+)\)')
        for md in ROOT.rglob('*.md'):
            for raw in rg.findall(md.read_text(encoding='utf-8')):
                parsed=urlsplit(raw)
                if parsed.scheme or parsed.netloc or not parsed.path: continue
                target=(md.parent/unquote(parsed.path)).resolve()
                self.assertTrue(target.is_file(),f'{md}: missing {raw}')

class ProjectCliTests(unittest.TestCase):
    def test_json_preserves_chinese_error_labels_under_ascii_locale(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)/'demo'
            docs = project/'docs/design-direction'
            (docs/'references').mkdir(parents=True)
            (docs/'project.json').write_text('{"schema_version": 1}', encoding='utf-8')
            manifest = {'schema_version': 1, 'id_prefix': 'R', 'id_width': 2,
                        'next_reference_number': 2, 'references': [{'id': '中文参考'}]}
            (docs/'references/manifest.json').write_text(
                json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
            env = dict(os.environ, PYTHONUTF8='0', PYTHONCOERCECLOCALE='0',
                       LC_ALL='C', PYTHONDONTWRITEBYTECODE='1')
            env.pop('PYTHONIOENCODING', None)
            result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'check',
                                     '--project-root', str(project)], env=env, capture_output=True)
            # The invalid reference still reports its input error, as parseable JSON.
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, b'')
            data = json.loads(result.stdout)
            self.assertEqual(data['status'], 'error')
            self.assertTrue(any('中文参考' in error for error in data['errors']))
            self.assertEqual(data['visual_review'], 'not_performed')

    def call(self,project:Path,command:str,*extra:str):
        p=subprocess.run([sys.executable,str(SCRIPT),command,'--project-root',str(project),*extra],capture_output=True,text=True)
        try: data=json.loads(p.stdout)
        except json.JSONDecodeError: raise AssertionError(p.stdout+' '+p.stderr)
        return p.returncode,data
    def test_init_check_ingest_dedup_and_hash_tamper(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'demo';root.mkdir()
            code,result=self.call(root,'init');self.assertEqual(code,0,result)
            code,result=self.call(root,'init');self.assertEqual(code,0,result)
            code,result=self.call(root,'check');self.assertEqual(code,0,result)
            # A minimal known valid PNG; bytes must be copied exactly.
            from PIL import Image
            src=Path(tmp)/'source.png';Image.new('RGB',(2,2),'red').save(src)
            code,result=self.call(root,'ingest','--input',str(src));self.assertEqual(code,0,result)
            self.assertEqual(len(result['imported']),1)
            code,result=self.call(root,'ingest','--input',str(src));self.assertEqual(code,0,result)
            self.assertEqual(len(result['imported']),0)
            self.assertTrue(result['duplicates'])
            code,result=self.call(root,'check');self.assertEqual(code,0,result)
            manifest=json.loads((root/'docs/design-direction/references/manifest.json').read_text())
            f=root/'docs/design-direction'/manifest['references'][0]['path']
            f.write_bytes(b'changed')
            code,result=self.call(root,'check');self.assertNotEqual(code,0)
            self.assertTrue(any('sha256' in x for x in result['errors']))
    def test_default_init_preserves_existing_design_knowledge(self):
        with tempfile.TemporaryDirectory() as tmp:
            project=Path(tmp)/'demo';project.mkdir()
            docs=project/'docs/design-direction';docs.mkdir(parents=True)
            saved={'README.md':'Existing unified design index\n','context.md':'Project knowledge\n','preferences.md':'Confirmed user choices\n','decisions.md':'Design evidence\n'}
            for name,text in saved.items(): (docs/name).write_text(text)
            code,result=self.call(project,'init');self.assertEqual(code,0,result)
            self.assertFalse((project/'docs/art-direction').exists())
            self.assertTrue((docs/'references/manifest.json').is_file())
            for name,text in saved.items(): self.assertEqual((docs/name).read_text(),text)
            code,result=self.call(project,'check');self.assertEqual(code,0,result)

    def test_explicit_docs_directory_remains_supported(self):
        with tempfile.TemporaryDirectory() as tmp:
            project=Path(tmp)/'demo';project.mkdir()
            custom='docs/custom-design'
            code,result=self.call(project,'init','--docs-dir',custom);self.assertEqual(code,0,result)
            self.assertTrue((project/custom/'references/manifest.json').is_file())
            self.assertFalse((project/'docs/design-direction').exists())
            code,result=self.call(project,'check','--docs-dir',custom);self.assertEqual(code,0,result)

    def test_reject_manifest_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            project=Path(tmp)/'demo';project.mkdir()
            self.assertEqual(self.call(project,'init')[0],0)
            f=project/'docs/design-direction/references/manifest.json'
            d=json.loads(f.read_text())
            d['references']=[{'id':'R01','path':'../escape.png', 'sha256':'0'*64,'original_filename':'a.png','media_type':'image/png','width':2,'height':2,'category':'test','tags':[],'status':'pending','review':None,'provenance':{},'added_in':'test'}]
            d['next_reference_number']=2
            f.write_text(json.dumps(d))
            code,result=self.call(project,'check');self.assertNotEqual(code,0)
            self.assertIn('cannot contain',json.dumps(result,ensure_ascii=False))

if __name__=='__main__': unittest.main()
