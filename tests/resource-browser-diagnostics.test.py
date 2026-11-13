"""Observer-only controls; these do not launch or stand in for real Chromium."""
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1] / 'scripts/resource_browser_diagnostics.py'
spec = importlib.util.spec_from_file_location('resource_browser_diagnostics', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Session:
    def __init__(self):
        self.listeners = {}
        self.calls = []
    def on(self, name, callback): self.listeners[name] = callback
    def send(self, name, params=None):
        self.calls.append((name, params))
        if name == 'Browser.getWindowBounds': return {'bounds': {'windowState': 'minimized', 'width': 800, 'height': 600}}
        if name == 'Target.getTargetInfo': return {'targetInfo': {'targetId': 'real-session-target'}}
        return {}
    def detach(self): pass


class ObserverControls(unittest.TestCase):
    def test_owned_request_ids_and_out_of_order_extra_info(self):
        with tempfile.TemporaryDirectory() as folder:
            diag = module.BrowserDiagnostics(Path(folder)); session = Session()
            diag.attach_session(session, 1440, ['http://127.0.0.1:1234'])
            session.listeners['Network.requestWillBeSentExtraInfo']({'requestId': 'same', 'headers': {'Authorization': 'never-log', 'If-None-Match': 'etag'}, 'connectTiming': {'requestTime': 1}})
            session.listeners['Network.requestWillBeSent']({'requestId': 'same', 'timestamp': 1, 'wallTime': 2, 'request': {'url': 'http://127.0.0.1:1234/api/a', 'method': 'PATCH', 'postData': 'owned-body'}})
            session.listeners['Network.requestWillBeSent']({'requestId': 'outside', 'request': {'url': 'https://example.invalid/private', 'method': 'GET'}})
            session.listeners['Network.loadingFailed']({'requestId': 'same', 'timestamp': 3, 'canceled': True, 'errorText': 'net::ERR_ABORTED'})
            diag.close_session(session)
            receipt = diag.finish()
            raw = (Path(folder) / 'browser-observer.jsonl').read_text()
            rows = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual(sum(row['kind'] == 'Network.requestWillBeSent' for row in rows), 1)
            self.assertTrue(any(row['kind'] == 'Network.requestWillBeSentExtraInfo' and row['requestId'] == 'same' for row in rows))
            self.assertNotIn('never-log', raw); self.assertNotIn('owned-body', raw); self.assertNotIn('example.invalid', raw)
            self.assertFalse(any('setCache' in name or 'Fetch.' in name for name, _ in session.calls))
            self.assertEqual(receipt['observer']['dropped'], 0)
            self.assertEqual(receipt['netlog']['status'], 'NOT_OBSERVED')

    def test_caps_and_real_sink_failure_cannot_change_control_exception(self):
        with tempfile.TemporaryDirectory() as folder:
            diag = module.BrowserDiagnostics(Path(folder), max_events=3, max_bytes=1024)
            for i in range(10): diag.event('bounded', {'index': i})
            receipt = diag.finish()
            self.assertEqual(receipt['observer']['status'], 'INCOMPLETE')
            self.assertEqual(receipt['observer']['events'], 3)
            self.assertLessEqual((Path(folder) / 'browser-observer.jsonl').stat().st_size, 1024)
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'browser-observer.jsonl').mkdir()
            diag = module.BrowserDiagnostics(Path(folder)); original = RuntimeError('original-CDP-error')
            class Broken:
                def send(self, *args): raise original
            with self.assertRaises(RuntimeError) as caught:
                diag.control(Broken(), 'Browser.setWindowBounds', {'windowId': 9}, 1440)
            self.assertIs(caught.exception, original)
            self.assertEqual(diag.finish()['observer']['status'], 'INCOMPLETE')

    def test_preexisting_netlog_is_neither_replaced_nor_counted_as_this_capture(self):
        with tempfile.TemporaryDirectory() as folder:
            old = Path(folder) / 'chromium-netlog.json'
            content = '{"constants":{},"events":[{"type":"old-run"}]}'
            old.write_text(content)
            diag = module.BrowserDiagnostics(Path(folder))
            self.assertEqual(diag.launch_args(), [])
            diag.checkpoint_netlog()
            result = diag.finish()
            self.assertEqual(result['netlog']['status'], 'NOT_OBSERVED')
            self.assertEqual(result['observer']['status'], 'INCOMPLETE')
            self.assertEqual(old.read_text(), content)

    def test_failed_native_and_active_netlog_checkpoint_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            diag = module.BrowserDiagnostics(Path(folder)); session = Session()
            class Page:
                def evaluate(self, *args): return {'visibility': 'visible', 'focus': False, 'events': [{'state': 'visible', 'trusted': True}], 'dropped': 0}
            diag.native_snapshot(session, Page(), 9, 1440, 'hidden-wait-failed')
            progress = Path(folder) / 'chromium-netlog.json.inprogress'; progress.mkdir()
            (progress / 'event_file_0.json').write_text('{"type":1,"source":{"id":8},"phase":1},\n')
            diag.checkpoint_netlog()
            receipt = diag.finish()
            rows = [json.loads(line) for line in (Path(folder) / 'browser-observer.jsonl').read_text().splitlines()]
            native = next(row for row in rows if row['kind'] == 'native.snapshot')
            self.assertEqual(native['stage'], 'hidden-wait-failed')
            self.assertEqual(native['bounds']['bounds']['windowState'], 'minimized')
            self.assertEqual(native['page']['visibility'], 'visible')
            self.assertTrue(native['page']['events'][0]['trusted'])
            self.assertEqual(len(receipt['netlog']['checkpointFiles']), 1)
            self.assertEqual(receipt['netlog']['status'], 'PARTIAL')


if __name__ == '__main__': unittest.main()
