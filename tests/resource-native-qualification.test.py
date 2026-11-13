"""限定本次资格 harness；所有原生进程均由本测试 fork/exec，不启动 Chromium。"""
import importlib.util
import ast
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from resource_owned_chromium import OwnedChromium, native_arguments, compare_arguments, close_browser_endpoint
import resource_owned_chromium as ownership
import qualify_resource_native as qualification

REFERENCE = ["/owned/chrome", "--enable-automation", "--ozone-platform=x11",
             "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
             "--disable-renderer-backgrounding", "--user-data-dir=/old", "--remote-debugging-pipe",
             "--no-startup-window", "--flag-switches-begin", "--flag-switches-end"]


class QualificationControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="boardroom-native-control-")
        self.output = Path(self.temp.name)
        self.owners = []
        self.receipts = []
        self.evidence = {}

    def tearDown(self):
        for owner in self.owners:
            if not owner.closed:
                owner.close(None)
        for owner in self.owners:
            self.assertIsNotNone(owner.process.poll() if owner.process else 0)
            self.assertFalse(owner.members(), "本测试自有进程组仍有残留")
            self.assertFalse(Path(owner.profile).exists())
        directory = os.environ.get("RESOURCE_NATIVE_CONTROL_OUTPUT")
        if directory:
            destination = Path(directory); destination.mkdir(parents=True, exist_ok=True)
            (destination / (self._testMethodName + ".json")).write_text(
                json.dumps([o.receipt for o in self.owners], indent=2) + "\n")
            if self.evidence:
                (destination / (self._testMethodName + "-control.json")).write_text(json.dumps(self.evidence, indent=2) + "\n")
        self.temp.cleanup()

    def owner(self, code):
        owner = OwnedChromium(self.output / str(len(self.owners)))
        self.owners.append(owner)
        script = owner.output / "child.py"; script.write_text(code)
        owner.spawn([sys.executable, str(script)], dict(os.environ))
        return owner

    def wait_file(self, path, content=False):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            if path.exists():
                value = path.read_text()
                if value or not content:
                    return value
            time.sleep(0.01)
        self.fail("自有控制进程未就绪")


    def wire_peer(self, wire, *, termination="FIN", linger=0, upgrade_head=b"", wait_pong=False,
                  allow_disconnect=False):
        """专属真实 TCP peer；wire 是实际发送的 bytes，不假造客户端事件。"""
        config = {"wireHex": wire.hex(), "termination": termination, "linger": linger,
                  "upgradeHeadHex": upgrade_head.hex(), "waitPong": wait_pong,
                  "allowDisconnect": allow_disconnect}
        code = r'''import base64,errno,hashlib,json,os,socket,struct,time
from pathlib import Path
root=Path(__file__).parent
config=CONFIG_JSON
record={"pid":os.getpid(),"config":config,"events":[],"request":None}
def note(kind, **fields):
    record["events"].append({"kind":kind,"monotonicNs":time.monotonic_ns(),**fields})
    (root/"peer.json").write_text(json.dumps(record,indent=2)+"\n")
server=socket.socket();server.settimeout(5);server.bind(("127.0.0.1",0));server.listen(1)
(root/"ready").write_text("ws://127.0.0.1:"+str(server.getsockname()[1])+"/devtools/browser/p3-wire-control")
conn=None
try:
    conn,_=server.accept();conn.settimeout(5)
    header=b""
    while b"\r\n\r\n" not in header and len(header)<8192:
        part=conn.recv(1024);assert part;header+=part
    assert header.endswith(b"\r\n\r\n")
    key=next(line.split(b":",1)[1].strip() for line in header.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key:"))
    accept=base64.b64encode(hashlib.sha1(key+b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
    upgrade=b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+b"\r\n\r\n"
    initial=bytes.fromhex(config["upgradeHeadHex"])
    conn.sendall(upgrade+initial)
    note("upgrade-sent",headHex=initial.hex())
    def receive(n):
        data=b""
        while len(data)<n:
            part=conn.recv(n-len(data));assert part;data+=part
        return data
    def client_frame():
        head=receive(2);assert head[1]&0x80 and head[1]&127<126
        mask=receive(4);raw=receive(head[1]&127)
        return head[0],bytes(v^mask[i%4] for i,v in enumerate(raw))
    if not initial:
        opcode,body=client_frame();assert opcode==0x81
        request=json.loads(body);assert request=={"id":1,"method":"Browser.close"}
        record["request"]=request;note("request-received",opcode=opcode,payloadHex=body.hex())
        wire=bytes.fromhex(config["wireHex"])
        if wire: conn.sendall(wire)
        note("wire-sent",bytes=len(wire),sha256=hashlib.sha256(wire).hexdigest())
        if config["waitPong"]:
            opcode,payload=client_frame();assert opcode==0x8a and payload==b"r"
            note("pong-received",opcode=opcode,payloadHex=payload.hex())
    if config["termination"]=="RST":
        conn.setsockopt(socket.SOL_SOCKET,socket.SO_LINGER,struct.pack("ii",1,0))
        conn.close();conn=None
        note("rst-close-issued")
    else:
        try:
            conn.shutdown(socket.SHUT_WR)
            note("fin-issued")
        except OSError as error:
            if not config["allowDisconnect"] or error.errno not in (errno.EPIPE,errno.ECONNRESET,errno.ENOTCONN): raise
            note("shutdown-error",name=type(error).__name__,errno=error.errno,message=str(error))
        try:
            while True:
                part=conn.recv(4096)
                if not part:
                    note("client-eof");break
                note("client-tail",bytes=len(part),hex=part.hex())
        except ConnectionError as error:
            if not config["allowDisconnect"]: raise
            note("client-error",name=type(error).__name__,errno=error.errno,message=str(error))
        conn.close();conn=None
    server.close()
    note("connection-closed",linger=config["linger"])
    if config["linger"]: time.sleep(config["linger"])
    note("natural-exit")
finally:
    if conn is not None: conn.close()
    server.close()
'''.replace("CONFIG_JSON", repr(config))
        owner = self.owner(code)
        endpoint = self.wait_file(owner.output / "ready", content=True)
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        return owner, endpoint

    def run_wire_control(self, name, wire, **options):
        owner, endpoint = self.wire_peer(wire, **options)
        started = time.monotonic()
        receipt = owner.close(lambda: close_browser_endpoint(endpoint))
        peer = json.loads((owner.output / "peer.json").read_text())
        self.evidence.setdefault("kind", "real loopback peer and Node helper/owned child; no Chromium")
        self.evidence.setdefault("cases", []).append(
            {"name": name, "elapsedMs": round((time.monotonic()-started)*1000),
             "peer": peer, "receipt": receipt})
        return receipt, peer

    def assert_natural_wire_owner(self, receipt):
        self.assertEqual(receipt["signals"], [])
        self.assertFalse(receipt["forced"])
        self.assertEqual(receipt["exitCode"], 0)
        self.assertTrue(receipt["reaped"])
        self.assertEqual(receipt["remaining"], [])
        self.assertTrue(receipt["profileRemoved"])

    def test_actual_complete_ack_then_eof_and_owned_exit(self):
        body = b'{"id":1,"result":{}}'
        receipt, peer = self.run_wire_control("complete-ack-eof", b"\x81"+bytes([len(body)])+body)
        self.assertEqual(peer["request"], {"id": 1, "method": "Browser.close"})
        self.assertIn("fin-issued", [event["kind"] for event in peer["events"]])
        self.assertIn("client-eof", [event["kind"] for event in peer["events"]])
        self.assert_natural_wire_owner(receipt)
        self.assertEqual(receipt["status"], "PASS", receipt)
        self.assertTrue(receipt["apiClose"]["reply"])
        self.assertEqual(receipt["apiClose"]["wire"]["transportClass"], "EOF_AFTER_ACK")
        self.assertTrue(receipt["apiClose"]["wire"]["raw"]["endSeen"])
        self.assertFalse(receipt["apiClose"]["wire"]["raw"]["hadError"])
        # P3 F：成功原件删掉错误观察字段，不得把缺失当作“没有错误”。
        self.evidence["missingWireObservations"] = []
        for path in (("raw", "error"), ("wsError",), ("audit", "error")):
            incomplete = json.loads(receipt["apiClose"]["helperStdout"])
            target = incomplete["wire"]
            for key in path[:-1]:
                target = target[key]
            del target[path[-1]]
            parsed = ownership.parse_close_helper_receipt(json.dumps(incomplete), "", 0)
            self.evidence["missingWireObservations"].append({"removed": path, "result": parsed})
            self.assertEqual(parsed["status"], "FAIL", {"removed": path, "result": parsed})



    def assert_ack_wire_failure(self, receipt):
        self.assert_natural_wire_owner(receipt)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertEqual(receipt["apiClose"]["status"], "FAIL")
        self.assertTrue(receipt["apiClose"]["requestSent"] and receipt["apiClose"]["reply"])
        self.assertEqual(receipt["apiClose"]["response"], {"id": 1, "result": {}})
        self.assertEqual(receipt["apiClose"]["wire"]["transportClass"], "INVALID_OR_UNKNOWN")
        self.assertEqual(receipt["naturalExitObservation"]["limitSeconds"], 3)

    def test_actual_same_ack_then_illegal_opcode_remains_failure(self):
        body = b'{"id":1,"result":{}}'
        wire = b"\x81"+bytes([len(body)])+body+b"\x83\x00"
        receipt, peer = self.run_wire_control("same-ack-illegal-opcode", wire, allow_disconnect=True)
        self.assertEqual(peer["request"], {"id": 1, "method": "Browser.close"})
        self.assertIn("wire-sent", [event["kind"] for event in peer["events"]])
        self.assert_ack_wire_failure(receipt)
        self.assertTrue(receipt["apiClose"].get("transportError")
                        or receipt["apiClose"]["wire"]["audit"]["error"])

    def test_actual_truncated_wire_and_unfinished_fragment_fail(self):
        body = b'{"id":1,"result":{}}'
        ack = b"\x81"+bytes([len(body)])+body
        tails = {
            "half-basic-header": b"\x81",
            "half-length16": b"\x81\x7e\x01",
            "half-length64": b"\x81\x7f"+b"\x00"*7,
            "half-payload": b"\x81\x02{",
            "unfinished-fragment": b"\x01\x01{",
        }
        for name, tail in tails.items():
            with self.subTest(name=name):
                receipt, _ = self.run_wire_control(name, ack+tail, allow_disconnect=True)
                self.assert_ack_wire_failure(receipt)
                self.assertFalse(receipt["apiClose"]["wire"]["audit"]["complete"])

    def test_actual_wire_after_close_frame_is_not_ignored(self):
        body = b'{"id":1,"result":{}}'
        wire = b"\x81"+bytes([len(body)])+body+b"\x88\x02\x03\xe8\x81\x00"
        receipt, _ = self.run_wire_control("bytes-after-close", wire, allow_disconnect=True)
        self.assert_ack_wire_failure(receipt)
        self.assertTrue(receipt["apiClose"]["wire"]["audit"]["error"])

    def test_actual_socket_reset_after_ack_remains_failure(self):
        body = b'{"id":1,"result":{}}'
        # 收到自动 pong 才发 RST：真实协议屏障，不用 sleep 猜客户端是否已读 ACK。
        wire = b"\x81"+bytes([len(body)])+body+b"\x89\x01r"
        receipt, peer = self.run_wire_control("ack-pong-rst", wire, termination="RST", wait_pong=True)
        self.assert_ack_wire_failure(receipt)
        kinds = [event["kind"] for event in peer["events"]]
        self.assertLess(kinds.index("pong-received"), kinds.index("rst-close-issued"))
        raw = receipt["apiClose"]["wire"]["raw"]
        self.assertTrue(raw.get("error") or raw["hadError"], raw)

    def test_actual_missing_and_rejected_ack_cannot_pass(self):
        cases = {
            "missing-ack-eof": b"",
            "protocol-rejection": b'{"id":1,"error":{"code":-32000,"message":"denied"}}',
        }
        for name, body in cases.items():
            with self.subTest(name=name):
                wire = b"\x81"+bytes([len(body)])+body if body else b""
                receipt, _ = self.run_wire_control(name, wire, allow_disconnect=True)
                self.assert_natural_wire_owner(receipt)
                self.assertEqual(receipt["status"], "FAIL")
                self.assertTrue(receipt["apiClose"]["requestSent"])
                self.assertFalse(receipt["apiClose"]["reply"])
                self.assertEqual(receipt["apiClose"]["status"], "FAIL")
                self.assertEqual(receipt["naturalExitObservation"]["limitSeconds"], 3)

    def test_actual_complete_fragmented_ack_then_eof_passes(self):
        body = b'{"id":1,"result":{}}'
        wire = b"\x01\x0a"+body[:10]+b"\x80"+bytes([len(body)-10])+body[10:]
        receipt, _ = self.run_wire_control("complete-fragmented-ack", wire)
        self.assert_natural_wire_owner(receipt)
        self.assertEqual(receipt["status"], "PASS", receipt)
        self.assertEqual(receipt["apiClose"]["response"], {"id": 1, "result": {}})
        self.assertEqual(receipt["apiClose"]["wire"]["transportClass"], "EOF_AFTER_ACK")
        self.assertTrue(receipt["apiClose"]["wire"]["audit"]["complete"])
        self.assertFalse(receipt["apiClose"]["wire"]["audit"]["fragmentOpen"])

    def test_actual_valid_eof_does_not_release_live_owned_process(self):
        body = b'{"id":1,"result":{}}'
        receipt, peer = self.run_wire_control("valid-eof-live-owner",
                                             b"\x81"+bytes([len(body)])+body, linger=60)
        self.assertIn("connection-closed", [event["kind"] for event in peer["events"]])
        self.assertEqual(receipt["apiClose"]["status"], "PASS", receipt)
        self.assertEqual(receipt["apiClose"]["wire"]["transportClass"], "EOF_AFTER_ACK")
        self.assertEqual(receipt["status"], "FAIL")
        self.assertEqual(receipt["naturalExitObservation"]["limitSeconds"], 3)
        self.assertGreaterEqual(receipt["naturalExitObservation"]["elapsedMs"], 2900)
        self.assertTrue(receipt["forced"])
        self.assertIn(signal.SIGTERM, [event["signal"] for event in receipt["signals"]])
        self.assertTrue(receipt["reaped"])
        self.assertEqual(receipt["remaining"], [])
        self.assertTrue(receipt["profileRemoved"])

    def test_actual_nonempty_upgrade_head_fails_closed(self):
        receipt, peer = self.run_wire_control("early-upgrade-wire", b"",
                                             upgrade_head=b"\x89\x01r", allow_disconnect=True)
        self.assertEqual(peer["config"]["upgradeHeadHex"], "890172")
        self.assertEqual(receipt["status"], "FAIL")
        self.assertFalse(receipt["apiClose"]["requestSent"])
        self.assertFalse(receipt["apiClose"]["reply"])
        self.assertGreater(receipt["apiClose"]["wire"]["upgradeHeadBytes"], 0)
        self.assertEqual(receipt["apiClose"]["status"], "FAIL")
        self.assertTrue(receipt["reaped"])
        self.assertEqual(receipt["remaining"], [])
        self.assertTrue(receipt["profileRemoved"])

    def test_actual_wire_caps_cannot_pass(self):
        body = b'{"id":1,"result":{}}'
        ack = b"\x81"+bytes([len(body)])+body
        event = json.dumps({"method": "control", "params": {"padding": "x"*4000}},
                           separators=(",", ":")).encode()
        event_frame = b"\x81\x7e"+len(event).to_bytes(2, "big")+event
        cases = {"frame-cap": ack+b"\x8a\x00"*33, "byte-cap": ack+event_frame*17}
        for name, wire in cases.items():
            with self.subTest(name=name):
                receipt, peer = self.run_wire_control(name, wire, allow_disconnect=True)
                self.assertIn("wire-sent", [event["kind"] for event in peer["events"]])
                self.assert_ack_wire_failure(receipt)
                self.assertTrue(receipt["apiClose"]["wire"]["audit"]["error"])

    def test_frame_audit_known_bytes_across_chunk_boundaries(self):
        body = b'{"id":1,"result":{}}'
        ack = b"\x81"+bytes([len(body)])+body
        fragmented = b"\x01\x0a"+body[:10]+b"\x80"+bytes([len(body)-10])+body[10:]
        vectors = [
            {"name": "one-byte-chunks", "chunks": [ack[i:i+1].hex() for i in range(len(ack))],
             "complete": True},
            {"name": "fragmented-three-byte-chunks",
             "chunks": [fragmented[i:i+3].hex() for i in range(0, len(fragmented), 3)],
             "complete": True},
            {"name": "half-extended-length", "chunks": ["817e", "01"], "complete": False},
            {"name": "half-payload", "chunks": ["81", "02", "7b"], "complete": False},
            {"name": "missing-continuation", "chunks": ["0101", "7b"], "complete": False},
            {"name": "bytes-after-close", "chunks": ["880203", "e8", "8100"], "complete": False},
            {"name": "invalid-opcode", "chunks": ["83", "00"], "complete": False},
            {"name": "frame-cap", "chunks": ["8a00"]*33, "complete": False},
            {"name": "byte-cap", "chunks": [(b"\x81\x7e\x10\x00"+b"x"*4096).hex()]*17,
             "complete": False},
        ]
        program = ownership.FRAME_AUDIT_JS + r'''
const cases = JSON.parse((await import('node:fs')).readFileSync(0, 'utf8'));
const result = cases.map(item => {
  const audit = createFrameAudit();
  for (const chunk of item.chunks) audit.append(Buffer.from(chunk, 'hex'));
  return {name:item.name, audit:audit.snapshot()};
});
process.stdout.write(JSON.stringify(result)+'\n');
'''
        execution = subprocess.run(["node", "--input-type=module", "-e", program],
                                   input=json.dumps(vectors), capture_output=True, text=True, timeout=4)
        self.evidence = {"kind": "actual Node pure framing audit with known bytes; no network/Chromium",
                         "inputs": vectors, "exitCode": execution.returncode,
                         "stdout": execution.stdout, "stderr": execution.stderr}
        self.assertEqual(execution.returncode, 0, execution.stderr)
        results = json.loads(execution.stdout)
        self.assertEqual([item["name"] for item in results], [item["name"] for item in vectors])
        for vector, result in zip(vectors, results):
            with self.subTest(name=vector["name"]):
                self.assertIs(result["audit"]["complete"], vector["complete"], result)


    def nonzero_close_helper_owner(self, linger):
        # 真正 loopback WebSocket，先发匹配成功回复，再用非法 opcode 触发 Node
        # error/close；这是协议故障控制，不是 Chromium 或实际故障 socket 的归因。
        owner = self.owner(r'''import base64,hashlib,json,socket,time
from pathlib import Path
root=Path(__file__).parent
server=socket.socket();server.settimeout(5);server.bind(('127.0.0.1',0));server.listen(1)
(root/'ready').write_text('ws://127.0.0.1:'+str(server.getsockname()[1])+'/devtools/browser/close-receipt-control')
conn,_=server.accept();conn.settimeout(5)
header=b''
while b'\r\n\r\n' not in header and len(header)<8192: header+=conn.recv(1024)
key=next(line.split(b':',1)[1].strip() for line in header.split(b'\r\n') if line.lower().startswith(b'sec-websocket-key:'))
accept=base64.b64encode(hashlib.sha1(key+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
conn.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+b'\r\n\r\n')
def receive(n):
    data=b''
    while len(data)<n:
        chunk=conn.recv(n-len(data));assert chunk;data+=chunk
    return data
head=receive(2);assert head[0]==0x81 and head[1]&0x80 and head[1]&127<126
mask=receive(4);raw=receive(head[1]&127)
request=json.loads(bytes(v^mask[i%4] for i,v in enumerate(raw)))
assert request=={'id':1,'method':'Browser.close'}
(root/'request.json').write_text(json.dumps(request))
body=b'{"id":1,"result":{}}'
conn.sendall(b'\x81'+bytes([len(body)])+body)
conn.sendall(b'\x83\x00')
time.sleep(LINGER_SECONDS)
conn.close();server.close()
'''.replace('LINGER_SECONDS', repr(linger)))
        endpoint = self.wait_file(owner.output / "ready", content=True)
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        return owner, endpoint

    def test_nonzero_close_helper_preserves_ack_and_observes_natural_exit(self):
        owner, endpoint = self.nonzero_close_helper_owner(.35)
        started = time.monotonic()
        receipt = owner.close(lambda: close_browser_endpoint(endpoint))
        self.evidence = {"kind": "real Node helper/WebSocket fault and owned process; no Chromium",
                         "elapsedMs": round((time.monotonic()-started)*1000), "receipt": receipt}
        self.assertIn("apiClose", receipt)
        self.assertTrue(receipt["apiClose"]["requestSent"])
        self.assertTrue(receipt["apiClose"]["reply"])
        self.assertEqual(receipt["apiClose"]["helperExit"], 1)
        self.assertEqual(receipt["apiClose"]["response"], {"id": 1, "result": {}})
        self.assertIn("transportError", receipt["apiClose"])
        self.assertEqual(receipt["naturalExitObservation"]["limitSeconds"], 3)
        self.assertEqual(receipt["signals"], [])
        self.assertFalse(receipt["forced"])
        self.assertTrue(receipt["reaped"])
        self.assertEqual(receipt["exitCode"], 0)
        self.assertEqual(receipt["remaining"], [])
        self.assertEqual(receipt["status"], "FAIL")  # socket error 没有被自然退出洗成 PASS。

    def test_nonzero_close_helper_waits_then_forces_a_live_owned_process(self):
        owner, endpoint = self.nonzero_close_helper_owner(60)
        receipt = owner.close(lambda: close_browser_endpoint(endpoint))
        self.evidence = {"kind": "same real helper error; owned process intentionally stays alive", "receipt": receipt}
        self.assertIn("apiClose", receipt)
        self.assertTrue(receipt["apiClose"]["requestSent"] and receipt["apiClose"]["reply"])
        self.assertEqual(receipt["naturalExitObservation"]["limitSeconds"], 3)
        self.assertGreaterEqual(receipt["naturalExitObservation"]["elapsedMs"], 2900)
        self.assertTrue(receipt["forced"])
        self.assertIn(signal.SIGTERM, [entry["signal"] for entry in receipt["signals"]])
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(receipt["reaped"])
        self.assertEqual(receipt["remaining"], [])

    def test_invalid_or_rejected_close_receipts_cannot_acknowledge_success(self):
        valid = {"schema": 1, "helperPid": 123, "request": {"id": 1, "method": "Browser.close"},
                 "requestSent": True, "reply": True, "socketClosed": True,
                 "response": {"id": 1, "result": {}}, "events": []}
        cases = ["not-json", json.dumps({**valid, "requestSent": False}),
                 json.dumps({**valid, "response": {"id": 2, "result": {}}}),
                 json.dumps({**valid, "response": {"id": 1, "error": {"code": -32000, "message": "denied"}}}),
                 json.dumps({**valid, "reply": False, "error": "Browser.close deadline"})]
        results = []
        for value in cases:
            item = ownership.parse_close_helper_receipt(value, "", 0)
            self.assertEqual(item["status"], "FAIL")
            self.assertFalse(item["reply"])
            results.append(item)
        self.evidence = {"kind": "logical helper receipt negatives, no browser or process", "results": results}

    def test_reference_functional_flags_and_transport_are_bound(self):
        argv = native_arguments(REFERENCE, Path("/owned/profile"))
        self.assertEqual(argv[0], REFERENCE[0])
        self.assertIn("--disable-background-timer-throttling", argv)
        self.assertIn("--remote-debugging-port=0", argv)
        self.assertNotIn("--remote-debugging-pipe", argv)
        self.assertEqual(compare_arguments(REFERENCE, argv)["functionalDifference"], [])
        broken = [a for a in argv if a != "--disable-background-timer-throttling"]
        with self.assertRaisesRegex(AssertionError, "argv"):
            compare_arguments(REFERENCE, broken)
        with self.assertRaisesRegex(AssertionError, "argv"):
            compare_arguments(REFERENCE, argv + ["--headless=new"])

    def test_graceful_owned_process_and_child_are_reaped(self):
        owner = self.owner("""import os,time
from pathlib import Path
root=Path(__file__).parent
pid=os.fork()
if pid==0:
    while not (root/'finish').exists(): time.sleep(.01)
    os._exit(0)
(root/'ready').write_text(str(pid))
while not (root/'finish').exists(): time.sleep(.01)
os.waitpid(pid,0)
""")
        child = int(self.wait_file(owner.output / "ready", content=True))
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        self.assertIn(child, [i["pid"] for i in owner.members()])
        def close():
            (owner.output / "finish").touch()
            return {"requestSent": True, "reply": True, "source": "test-owned-file-control"}
        receipt = owner.close(close)
        self.assertEqual(receipt["status"], "PASS")
        self.assertEqual(receipt["exitCode"], 0)
        self.assertTrue(receipt["reaped"])
        self.assertEqual(receipt["signals"], [])
        self.assertEqual(receipt["remaining"], [])
        self.assertTrue(receipt["profileRemoved"])

    def test_api_failure_requires_term_and_never_becomes_pass(self):
        owner = self.owner("import time\nfrom pathlib import Path\nPath(__file__).with_name('ready').touch()\ntime.sleep(60)\n")
        self.wait_file(owner.output / "ready")
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        def failure():
            raise RuntimeError("original-api-failure")
        receipt = owner.close(failure)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertIn("original-api-failure", json.dumps(receipt))
        self.assertTrue(receipt["forced"])
        self.assertTrue(any(i["signal"] == signal.SIGTERM for i in receipt["signals"]))
        self.assertEqual(receipt["remaining"], [])

    def test_term_ignoring_owned_process_requires_kill_and_fails(self):
        owner = self.owner("import signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nPath(__file__).with_name('ready').touch()\ntime.sleep(60)\n")
        self.wait_file(owner.output / "ready")
        receipt = owner.close(None)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(any(i["signal"] == signal.SIGKILL for i in receipt["signals"]))
        self.assertEqual(receipt["exitCode"], -signal.SIGKILL)
        self.assertEqual(receipt["remaining"], [])

    def test_foreign_browser_pid_is_rejected_without_signalling_it(self):
        owner = self.owner("import time\nfrom pathlib import Path\nPath(__file__).with_name('ready').touch()\ntime.sleep(60)\n")
        self.wait_file(owner.output / "ready")
        with self.assertRaisesRegex(AssertionError, "PID"):
            owner.bind_browser([{"type": "browser", "id": os.getpid()}])
        self.assertEqual(owner.receipt["signals"], [])
        self.assertEqual(os.kill(os.getpid(), 0), None)
        receipt = owner.close(None)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertNotIn(os.getpid(), [i["pid"] for i in receipt["signals"]])

    def test_invalid_endpoint_fails_without_connecting_and_cleans(self):
        owner = self.owner("import time\nfrom pathlib import Path\nPath(__file__).with_name('ready').touch()\ntime.sleep(60)\n")
        self.wait_file(owner.output / "ready")
        endpoint = Path(owner.profile) / "DevToolsActivePort"
        endpoint.write_text("9222\n/devtools/page/not-a-browser")
        with self.assertRaisesRegex(AssertionError, "endpoint"):
            owner.endpoint()
        receipt = owner.close(None)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(receipt["profileRemoved"])

    def test_actual_cdp_close_frame_and_owned_endpoint_exit(self):
        owner = self.owner(r'''import base64,hashlib,json,socket
from pathlib import Path
root=Path(__file__).parent
server=socket.socket();server.settimeout(5);server.bind(('127.0.0.1',0));server.listen(1)
(root/'ready').write_text('ws://127.0.0.1:'+str(server.getsockname()[1])+'/devtools/browser/owned-control')
conn,_=server.accept();conn.settimeout(5)
header=b''
while b'\r\n\r\n' not in header and len(header)<8192: header+=conn.recv(1024)
key=next(line.split(b':',1)[1].strip() for line in header.split(b'\r\n') if line.lower().startswith(b'sec-websocket-key:'))
accept=base64.b64encode(hashlib.sha1(key+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
conn.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+b'\r\n\r\n')
def receive(n):
    data=b''
    while len(data)<n:
        more=conn.recv(n-len(data));assert more;data+=more
    return data
head=receive(2);assert head[0]==0x81 and head[1]&0x80 and head[1]&127<126
mask=receive(4);raw=receive(head[1]&127)
request=json.loads(bytes(v^mask[i%4] for i,v in enumerate(raw)))
assert request=={'id':1,'method':'Browser.close'}
(root/'request.json').write_text(json.dumps(request))
body=b'{"id":1,"result":{}}'
conn.sendall(b'\x81'+bytes([len(body)])+body+b'\x88\x02\x03\xe8')
conn.close();server.close()
''')
        endpoint = self.wait_file(owner.output / "ready", content=True)
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        receipt = owner.close(lambda: close_browser_endpoint(endpoint))
        self.assertEqual(receipt["status"], "PASS", receipt)
        self.assertEqual(json.loads((owner.output / "request.json").read_text()), {"id": 1, "method": "Browser.close"})
        self.assertTrue(receipt["apiClose"]["requestSent"])
        self.assertEqual(receipt["apiClose"]["helperExit"], 0)
        self.assertEqual(receipt["signals"], [])

    def test_actual_wrong_reply_id_cannot_be_hidden_by_normal_exit(self):
        # 与独立 reviewer 反例完全相同：只把原真实 WebSocket 正控回复 id1 改成 id2。
        tree = ast.parse(Path(__file__).read_text())
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)
                      and n.name == "test_actual_cdp_close_frame_and_owned_endpoint_exit")
        assignment = next(n for n in method.body if isinstance(n, ast.Assign)
                          and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute)
                          and n.value.func.attr == "owner")
        original = ast.literal_eval(assignment.value.args[0])
        old = 'body=b\'{"id":1,"result":{}}\''
        new = 'body=b\'{"id":2,"result":{}}\''
        self.assertEqual(original.count(old), 1)
        owner = self.owner(original.replace(old, new))
        endpoint = self.wait_file(owner.output / "ready", content=True)
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        receipt = owner.close(lambda: close_browser_endpoint(endpoint))
        received = json.loads((owner.output / "request.json").read_text())
        self.evidence = {"kind": "actual Node/WebSocket/owned process, wrong response id only; no Chromium",
                         "actualReceivedRequest": received, "serverResponse": {"id": 2, "result": {}}, "receipt": receipt}
        self.assertEqual(received, {"id": 1, "method": "Browser.close"})
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(receipt["apiClose"]["requestSent"])
        self.assertFalse(receipt["apiClose"]["reply"])
        self.assertEqual(receipt["apiClose"]["status"], "FAIL")
        self.assertEqual(receipt["apiClose"]["response"], {"id": 2, "result": {}})
        self.assertEqual(receipt["naturalExitObservation"]["limitSeconds"], 3)
        self.assertEqual(receipt["signals"], [])
        self.assertFalse(receipt["forced"])
        self.assertTrue(receipt["reaped"])
        self.assertEqual(receipt["exitCode"], 0)
        self.assertEqual(receipt["remaining"], [])

    def thread_leader_pending_owner(self):
        """真实多代 orphan；leader 已退出，worker 的 FIFO 屏障尚未释放。"""
        owner = OwnedChromium(self.output / str(len(self.owners)))
        self.owners.append(owner)
        source = owner.output / "thread-leader.c"
        executable = owner.output / "thread-leader"
        source.write_text(r'''
#define _GNU_SOURCE
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
static pthread_barrier_t started;
static void number_file(const char *name, long value) {
  FILE *stream = fopen(name, "w");
  if (!stream || fprintf(stream, "%ld\n", value) < 0 || fclose(stream)) _exit(91);
}
static void *worker(void *unused) {
  (void)unused;
  int fd = open("release.fifo", O_RDWR | O_CLOEXEC);
  if (fd < 0) _exit(92);
  number_file("worker-tid", syscall(SYS_gettid));
  pthread_barrier_wait(&started);
  char value;
  if (read(fd, &value, 1) != 1 || value != 'x') _exit(93);
  close(fd);
  number_file("worker-released", syscall(SYS_gettid));
  return NULL;
}
int main(int argc, char **argv) {
  if (argc != 2 || chdir(argv[1])) return 94;
  if (mkfifo("release.fifo", 0600) || mkfifo("finish.fifo", 0600)) return 95;
  pid_t middle = fork();
  if (middle < 0) return 96;
  if (middle == 0) {
    pid_t leaf = fork();
    if (leaf < 0) _exit(97);
    if (leaf != 0) { number_file("leaf-pid", leaf); _exit(0); }
    pthread_t thread;
    if (pthread_barrier_init(&started, NULL, 2) || pthread_create(&thread, NULL, worker, NULL)) _exit(98);
    pthread_barrier_wait(&started);
    pthread_exit(NULL); /* 真实 leader 退出，不改 /proc，不伪造 wait 返回。 */
  }
  int status;
  if (waitpid(middle, &status, 0) != middle || status != 0) return 99;
  number_file("middle-reaped", middle);
  int fd = open("finish.fifo", O_RDWR | O_CLOEXEC);
  if (fd < 0) return 100;
  number_file("ready", getpid());
  char value;
  if (read(fd, &value, 1) != 1 || value != 'x') return 101;
  close(fd);
  return 0;
}
''')
        command = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread",
                   str(source), "-o", str(executable)]
        compiled = subprocess.run(command, capture_output=True, text=True, timeout=15)
        self.evidence["compile"] = {"argv": command, "exit": compiled.returncode,
                                    "stdout": compiled.stdout, "stderr": compiled.stderr}
        self.assertEqual(compiled.returncode, 0, self.evidence["compile"])
        owner.spawn([str(executable), str(owner.output)], dict(os.environ))
        self.wait_file(owner.output / "ready", content=True)
        leaf = int(self.wait_file(owner.output / "leaf-pid", content=True))
        worker = int(self.wait_file(owner.output / "worker-tid", content=True))
        until = time.monotonic() + 3
        while True:
            actual = ownership.process_identity(leaf)
            if actual["state"] == "Z" and actual["ppid"] == os.getpid():
                break
            self.assertLess(time.monotonic(), until, actual)
            time.sleep(.005)
        tasks = {int(p.name): (p / "stat").read_text() for p in (Path("/proc") / str(leaf) / "task").iterdir()}
        self.assertIn(leaf, tasks)
        self.assertIn(worker, tasks)
        self.assertNotEqual(leaf, worker)
        self.evidence.update(kind="real orphan thread leader Z / WNOHANG pending; no Chromium",
                             kernel=os.uname().release, leafIdentity=actual, workerTid=worker,
                             taskStatAtReady=tasks, waitCalls=[], testOnlyCleanup={})
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        return owner, actual

    @staticmethod
    def release_fifo(path):
        fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            assert os.write(fd, b"x") == 1
        finally:
            os.close(fd)

    def finish_thread_control(self, owner, identity):
        """仅清理本测试固定的 leaf；不会更改被测 close 的原始 FAIL 收据。"""
        cleanup = self.evidence["testOnlyCleanup"]
        for name in ("finish.fifo", "release.fifo"):
            try:
                self.release_fifo(owner.output / name)
                cleanup.setdefault("released", []).append(name)
            except OSError as error:
                cleanup.setdefault("releaseErrors", []).append({"fifo": name, "errno": error.errno})
        if not owner.closed:
            owner.close(None)
        if owner.process.poll() is None:
            owner.process.wait(timeout=3)
        try:
            actual = ownership.process_identity(identity["pid"])
        except FileNotFoundError:
            cleanup["leafAlreadyAbsent"] = True
        else:
            self.assertEqual(ownership.identity_key(actual), ownership.identity_key(identity))
            fd = os.pidfd_open(identity["pid"])
            try:
                self.assertEqual(ownership.identity_key(ownership.process_identity(identity["pid"])),
                                 ownership.identity_key(identity))
                until = time.monotonic() + 3
                while True:
                    peek = os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    if peek is not None:
                        break
                    self.assertLess(time.monotonic(), until, "测试兜底未取得 leaf 真实终态")
                    time.sleep(.005)
                consumed = os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG)
                fields = ("si_pid", "si_uid", "si_signo", "si_code", "si_status")
                cleanup["peek"] = {field: getattr(peek, field) for field in fields}
                cleanup["consumed"] = {field: getattr(consumed, field) for field in fields}
                self.assertEqual(cleanup["peek"], cleanup["consumed"])
                self.assertEqual(peek.si_pid, identity["pid"])
                self.assertEqual(peek.si_uid, identity["uid"])
            finally:
                os.close(fd)
        cleanup["rootExit"] = owner.process.poll()
        cleanup["remaining"] = owner.members()
        self.assertEqual(cleanup["remaining"], [])
        if owner.profile.exists():
            info = owner.profile.stat()
            self.assertEqual((info.st_dev, info.st_ino, info.st_uid), owner.profile_identity)
            shutil.rmtree(owner.profile)
            cleanup["profileRemovedByTestFallback"] = True
        cleanup["profileExistsAfter"] = owner.profile.exists()

    def test_real_thread_leader_pending_then_terminal_is_reaped(self):
        owner, identity = self.thread_leader_pending_owner()
        real_waitid = os.waitid
        released = False

        def observe_wait(idtype, target, options):
            nonlocal released
            info = (Path("/proc/self/fdinfo") / str(target)).read_text() if idtype == os.P_PIDFD else ""
            actual_pid = next((int(line.split(":", 1)[1]) for line in info.splitlines()
                               if line.startswith("Pid:")), None)
            result = real_waitid(idtype, target, options)
            if actual_pid == identity["pid"]:
                raw = {field: getattr(result, field) for field in
                       ("si_pid", "si_uid", "si_signo", "si_code", "si_status")} if result is not None else None
                self.evidence["waitCalls"].append({"monotonicNs": time.monotonic_ns(),
                    "idtype": idtype, "pidfdTarget": actual_pid, "options": options, "raw": raw})
                if result is None and options & os.WNOWAIT and not released:
                    self.release_fifo(owner.output / "release.fifo")
                    released = True
                    self.evidence["releaseAfterRealNoneMonotonicNs"] = time.monotonic_ns()
            return result

        def close():
            self.release_fifo(owner.output / "finish.fifo")
            return {"requestSent": True, "source": "test-owned-fifo-control"}

        try:
            with patch.object(ownership.os, "waitid", side_effect=observe_wait):
                receipt = owner.close(close)
            self.evidence["receiptBeforeTestFallback"] = copy.deepcopy(receipt)
            calls = self.evidence["waitCalls"]
            self.assertTrue(released, calls)
            self.assertTrue(any(call["raw"] is None for call in calls), calls)
            self.assertEqual(receipt["status"], "PASS", receipt)
            self.assertEqual(receipt["naturalExitObservation"]["limitSeconds"], 3)
            self.assertLess(receipt["naturalExitObservation"]["elapsedMs"], 3000)
            self.assertEqual(receipt["signals"], [])
            self.assertFalse(receipt["forced"])
            self.assertEqual(receipt["exitCode"], 0)
            self.assertTrue(receipt["reaped"])
            self.assertEqual(receipt["remaining"], [])
            self.assertTrue(receipt["profileRemoved"])
            waits = [w for w in receipt["orphanWaits"] if w["consumed"]["si_pid"] == identity["pid"]]
            self.assertEqual(len(waits), 1)
            self.assertEqual(waits[0]["peek"], waits[0]["consumed"])
            self.assertEqual(waits[0]["consumed"]["si_code"], os.CLD_EXITED)
            self.assertEqual(waits[0]["consumed"]["si_status"], 0)
        finally:
            self.finish_thread_control(owner, identity)

    def test_real_pending_until_natural_deadline_remains_failure(self):
        owner, identity = self.thread_leader_pending_owner()
        real_waitid = os.waitid
        real_signal = owner._signal
        released = False

        def observe_wait(idtype, target, options):
            info = (Path("/proc/self/fdinfo") / str(target)).read_text() if idtype == os.P_PIDFD else ""
            actual_pid = next((int(line.split(":", 1)[1]) for line in info.splitlines()
                               if line.startswith("Pid:")), None)
            result = real_waitid(idtype, target, options)
            if actual_pid == identity["pid"]:
                raw = {field: getattr(result, field) for field in
                       ("si_pid", "si_uid", "si_signo", "si_code", "si_status")} if result is not None else None
                self.evidence["waitCalls"].append({"monotonicNs": time.monotonic_ns(),
                    "idtype": idtype, "pidfdTarget": actual_pid, "options": options, "raw": raw})
            return result

        def after_natural_deadline(number):
            nonlocal released
            if not released:
                # 在原自然窗口结束后才释放；不延长产品期限，不代替真实信号路径。
                self.evidence["observationAtFirstEscalation"] = copy.deepcopy(owner.receipt["naturalExitObservation"])
                self.release_fifo(owner.output / "release.fifo")
                released = True
                self.evidence["releaseAtEscalationMonotonicNs"] = time.monotonic_ns()
            return real_signal(number)

        def close():
            self.release_fifo(owner.output / "finish.fifo")
            return {"requestSent": True, "source": "test-owned-fifo-control"}

        try:
            with patch.object(ownership.os, "waitid", side_effect=observe_wait), \
                 patch.object(owner, "_signal", side_effect=after_natural_deadline):
                receipt = owner.close(close)
            self.evidence["receiptBeforeTestFallback"] = copy.deepcopy(receipt)
            self.assertTrue(released)
            before = self.evidence["observationAtFirstEscalation"]
            self.assertEqual(before["limitSeconds"], 3)
            self.assertGreaterEqual(before["elapsedMs"], 3000)
            self.assertLess(before["elapsedMs"], 4000)
            self.assertTrue(any(ownership.identity_key(item) == ownership.identity_key(identity)
                                for item in before["remaining"]))
            self.assertTrue(any(call["raw"] is None for call in self.evidence["waitCalls"]))
            self.assertEqual(receipt["status"], "FAIL")
            self.assertTrue(receipt["forced"])
            self.assertEqual(receipt["remaining"], [])
            waits = [w for w in receipt["orphanWaits"] if w["consumed"]["si_pid"] == identity["pid"]]
            self.assertEqual(len(waits), 1)
            self.assertEqual(waits[0]["peek"], waits[0]["consumed"])
        finally:
            self.finish_thread_control(owner, identity)

    def test_pin_wrong_start_or_uid_does_not_wait_or_signal_owned_target(self):
        owner = self.owner("import time\nfrom pathlib import Path\nroot=Path(__file__).parent\n(root/'ready').touch()\nwhile not (root/'finish').exists(): time.sleep(.01)\n")
        self.wait_file(owner.output / "ready")
        identity = ownership.process_identity(owner.process.pid)
        self.evidence = {"kind": "explicit wrong identity arguments; real pidfd and /proc identity",
                         "target": identity, "rejections": []}
        for field in ("start", "uid"):
            wrong = dict(identity)
            wrong[field] += 1
            with self.assertRaises(AssertionError) as caught:
                owner._pin(wrong)
            self.evidence["rejections"].append({"argument": wrong, "error": str(caught.exception)})
            self.assertEqual(ownership.identity_key(ownership.process_identity(owner.process.pid)),
                             ownership.identity_key(identity))
            self.assertIsNone(owner.process.poll())
            self.assertEqual(owner.receipt["signals"], [])
            self.assertEqual(owner.receipt["orphanWaits"], [])
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        def close():
            (owner.output / "finish").touch()
            return {"requestSent": True, "source": "test-owned-file-control"}
        receipt = owner.close(close)
        self.evidence["validCleanupReceipt"] = copy.deepcopy(receipt)
        self.assertEqual(receipt["status"], "PASS", receipt)
        self.assertEqual(receipt["signals"], [])

    def test_terminal_consume_mismatch_is_not_success(self):
        owner, identity = self.thread_leader_pending_owner()
        self.release_fifo(owner.output / "release.fifo")
        real_waitid = os.waitid
        changed = False

        def mismatching_consume(idtype, target, options):
            nonlocal changed
            info = (Path("/proc/self/fdinfo") / str(target)).read_text() if idtype == os.P_PIDFD else ""
            actual_pid = next((int(line.split(":", 1)[1]) for line in info.splitlines()
                               if line.startswith("Pid:")), None)
            result = real_waitid(idtype, target, options)
            if actual_pid == identity["pid"]:
                raw = {field: getattr(result, field) for field in
                       ("si_pid", "si_uid", "si_signo", "si_code", "si_status")} if result is not None else None
                record = {"monotonicNs": time.monotonic_ns(), "idtype": idtype,
                          "pidfdTarget": actual_pid, "options": options, "actualKernelReturn": raw}
                self.evidence["waitCalls"].append(record)
                if result is not None and not options & os.WNOWAIT:
                    supplied = dict(raw)
                    supplied["si_status"] += 1
                    record["injectedReturn"] = supplied
                    changed = True
                    return SimpleNamespace(**supplied)
            return result

        def close():
            self.release_fifo(owner.output / "finish.fifo")
            return {"requestSent": True, "source": "test-owned-fifo-control"}

        try:
            with patch.object(ownership.os, "waitid", side_effect=mismatching_consume):
                receipt = owner.close(close)
            self.evidence["receiptBeforeTestFallback"] = copy.deepcopy(receipt)
            self.evidence["faultBoundary"] = "Only delivered si_status is changed after real matching consume; not a real kernel mismatch"
            self.assertTrue(changed, self.evidence)
            self.assertEqual(receipt["status"], "FAIL")
            self.assertTrue(receipt["errors"])
            self.assertFalse(any(w["consumed"]["si_pid"] == identity["pid"] for w in receipt["orphanWaits"]))
            self.assertEqual(receipt["signals"], [])
            self.assertEqual(receipt["remaining"], [])
            self.assertEqual(receipt["exitCode"], 0)
            self.assertTrue(receipt["reaped"])
        finally:
            self.finish_thread_control(owner, identity)

    def test_new_orphan_terminal_is_reaped_with_real_status(self):
        owner = self.owner("""import os,time
from pathlib import Path
root=Path(__file__).parent
pid=os.fork()
if pid==0:
    while not (root/'finish').exists(): time.sleep(.01)
    time.sleep(.05)
    os._exit(27)
(root/'ready').write_text(str(pid))
while not (root/'finish').exists(): time.sleep(.01)
os._exit(0)
""")
        child = int(self.wait_file(owner.output / "ready", content=True))
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        def close():
            (owner.output / "finish").touch()
            return {"requestSent": True, "source": "test-owned-file-control"}
        receipt = owner.close(close)
        self.assertEqual(receipt["status"], "PASS", receipt)
        waits = [w for w in receipt["orphanWaits"] if w["consumed"]["si_pid"] == child]
        self.assertEqual(len(waits), 1)
        self.assertEqual(waits[0]["consumed"]["si_status"], 27)
        self.assertEqual(waits[0]["peek"], waits[0]["consumed"])
        self.assertEqual(receipt["remaining"], [])

    def test_early_exit_is_not_a_successful_api_close(self):
        owner = self.owner("pass\n")
        owner.process.wait(timeout=3)
        receipt = owner.close(None)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(receipt["reaped"])
        self.assertTrue(receipt["profileRemoved"])

    def test_missing_native_observations_cannot_qualify(self):
        original = qualification.load_original()
        class ObservationFault:
            def send(self, method, params):
                raise RuntimeError("controlled bounds observation failure")
        phases = ["before-minimize", "hidden-confirmed", "visible-confirmed",
                  "before-restore-cleanup", "after-restore-cleanup"]
        cases = []
        for arm, _, width, _ in qualification.CASE_MATRIX:
            case = {"arm": arm, "width": width, "pageErrors": [], "unverified": [],
                    "checks": [{"id": key, "status": "PASS"} for key in ("S5-AC07-stdio", "S5-AC07-native-hidden")]}
            for phase in phases:
                original.native_snapshot(None, ObservationFault(), 123, width, phase, case)
            with self.assertRaisesRegex(AssertionError, "native observation error"):
                qualification.case_status(case)
            case["status"] = "FAIL"
            cases.append(case)
        tree = ast.parse((ROOT / "scripts/qualify_resource_native.py").read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
        body = next(n for n in main.body if isinstance(n, ast.Try)).body
        start = next(i for i, n in enumerate(body) if isinstance(n, ast.Assign)
                     and isinstance(n.targets[0], ast.Name) and n.targets[0].id == "candidates")
        aggregate = {"cases": cases}
        namespace = {"report": aggregate, "baseline_reproduced": qualification.baseline_reproduced}
        exec(compile(ast.Module(body=body[start:start+6], type_ignores=[]), "actual-aggregate-gate", "exec"), namespace)
        self.assertFalse(aggregate["candidateQualified"])
        self.assertEqual(aggregate["status"], "FAIL")
        self.evidence = {"kind": "synthetic functional premises; real frozen native_snapshot/gates, no browser",
                         "originalCounterexample": aggregate}

        valid = copy.deepcopy(cases[0]); valid.pop("status")
        for item in valid["nativeWindowEvidence"]:
            item.pop("observationError")
            hidden = item["phase"] == "hidden-confirmed"
            item["bounds"] = {"bounds": {"left": 0, "top": 0, "width": 1448, "height": 1085,
                                           "windowState": "minimized" if hidden else "normal"}}
            item["page"] = {"visibility": "hidden" if hidden else "visible", "focus": not hidden,
                            "visibilityEvents": [], "windowEvents": []}
        self.assertEqual(qualification.case_status(valid), "PASS")
        faults = [lambda c: c["nativeWindowEvidence"].pop(),
                  lambda c: c["nativeWindowEvidence"][1].pop("page"),
                  lambda c: c["nativeWindowEvidence"][1]["bounds"]["bounds"].pop("windowState"),
                  lambda c: c["nativeWindowEvidence"][1].update(windowId=124),
                  lambda c: c["nativeWindowEvidence"][1]["page"].pop("visibilityEvents"),
                  lambda c: c["nativeWindowEvidence"][1].update(observationError="late read failure")]
        for index, fault in enumerate(faults):
            broken = copy.deepcopy(valid); fault(broken)
            with self.subTest(missingObservation=index), self.assertRaises(AssertionError):
                qualification.case_status(broken)
        incomplete = copy.deepcopy(valid)
        incomplete["nativeWindowEvidence"].pop(2)
        failed = incomplete["nativeWindowEvidence"][1]
        failed["phase"] = "hidden-wait-failed"; failed["page"]["visibility"] = "visible"
        incomplete["unverified"] = [{"id": "S5-AC07-native-hidden", "width": 1440, "status": "INCONCLUSIVE"}]
        incomplete["checks"] = incomplete["checks"][:1]
        self.assertEqual(qualification.case_status(incomplete), "INCONCLUSIVE")
        self.evidence["nearby"] = {"completeSyntheticGate": "PASS", "missingFieldsRejected": len(faults),
                                   "completeNativeTimeoutGate": "INCONCLUSIVE"}

    def test_sdk_cleanup_deadlines_restore_handler_and_preserve_original_error(self):
        report = {"cleanupErrors": [], "error": "original-product-error"}
        previous = signal.getsignal(signal.SIGALRM)
        for stage in ("trace", "config CDP", "disconnect", "driver-stop"):
            self.assertFalse(qualification.sdk_cleanup(report, stage, lambda: time.sleep(60), seconds=.05))
            self.assertIs(signal.getsignal(signal.SIGALRM), previous)
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        self.assertEqual(report["error"], "original-product-error")
        self.assertEqual(len(report["cleanupErrors"]), 4)
        self.assertTrue(all(item["elapsedMs"] < 1000 for item in report["sdkCleanup"]))
        self.evidence = {"kind": "real SIGALRM with controlled blocking callbacks; no SDK/browser", "report": report}

    def test_actual_sdk_normal_stop_has_real_driver_exit(self):
        report = {"cleanupErrors": []}
        with qualification.bounded_playwright(report):
            pass  # 只启动真实 SDK driver，绝不 launch Chromium。
        self.assertEqual(report["cleanupErrors"], [], report)
        self.assertEqual(report["driverCleanup"]["status"], "PASS")
        self.assertTrue(report["driverCleanup"]["reaped"])
        self.assertEqual(report["driverCleanup"]["exitCode"], 0)
        self.assertEqual(report["driverCleanup"]["signals"], [])
        self.evidence = report

    def test_actual_stalled_sdk_reaches_owned_cleanup_and_remains_failure(self):
        report = {"status": "PASS", "cleanupErrors": [], "error": "original-product-error"}
        reached = []
        started = time.monotonic()
        try:
            with qualification.bounded_playwright(report) as playwright:
                owner = self.owner("""import time
from pathlib import Path
root=Path(__file__).parent
(root/'ready').touch()
while not (root/'finish').exists(): time.sleep(.01)
""")
                self.wait_file(owner.output / "ready")
                owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
                owner.receipt["endpoint"] = "test-owned-file-control"
                driver = report["driverIdentity"]["identity"]
                fd = os.pidfd_open(driver["pid"])
                try:
                    self.assertEqual(qualification.identity_key(qualification.process_identity(driver["pid"])), qualification.identity_key(driver))
                    signal.pidfd_send_signal(fd, signal.SIGSTOP)
                finally:
                    os.close(fd)
                def close_owned(_):
                    reached.append("owned close reached")
                    (owner.output / "finish").touch()
                    return {"requestSent": True, "source": "test-owned-file-control"}
                # 真正挂起本次 Node driver 后，让实际 SDK _sync/channel 等待真实响应。
                # 注入点是 trace 回调，不伪称实际 tracing.stop 或浏览器已运行。
                context = SimpleNamespace(tracing=SimpleNamespace(stop=lambda **_: playwright.request.new_context()))
                with patch.object(qualification, "close_browser_endpoint", close_owned):
                    qualification.cleanup_case(owner, None, context, None, True, self.output, report)
                reached.append("case cleanup returned")
                self.assertEqual(report["chromeCleanup"]["status"], "PASS", report)
                self.assertEqual(report["status"], "FAIL")
        finally:
            reached += ["fixture cleanup boundary reached", "desktop cleanup boundary reached"]
            self.evidence = {"kind": "actual SDK driver stop + real owned process; no Chromium/native/desktop run",
                             "elapsedMs": round((time.monotonic()-started)*1000), "reached": reached, "report": report}
        self.assertEqual(report["error"], "original-product-error")
        self.assertEqual(report["driverCleanup"]["status"], "FAIL")
        self.assertTrue(report["driverCleanup"]["reaped"])
        self.assertEqual(report["driverCleanup"]["exitCode"], -signal.SIGKILL)
        self.assertTrue(report["driverCleanup"]["pidfdClosed"])
        self.assertLess(time.monotonic()-started, 25)
        self.assertEqual(reached, ["owned close reached", "case cleanup returned",
                                  "fixture cleanup boundary reached", "desktop cleanup boundary reached"])


if __name__ == "__main__":
    unittest.main()
