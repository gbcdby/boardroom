"""Optional, bounded observation of the owned resource-browser fixture.

No routes, headers, cache settings, visibility values or request deadlines are changed.
NetLog is a fresh-browser log in Chromium's default private-data-stripping mode.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from time import monotonic_ns
from urllib.parse import urlsplit


class BrowserDiagnostics:
    def __init__(self, output, max_events=4096, max_bytes=2 * 1024 * 1024):
        self.output = Path(output)
        self.max_events, self.max_bytes = max_events, max_bytes
        self.count = self.bytes = self.dropped = 0
        self.errors, self.sessions, self.checkpoints = [], {}, []
        self.checkpoint_done = False
        self.file = None
        self.netlog = self.output / 'chromium-netlog.json'
        self.owns_netlog = not self.netlog.exists() and not self.netlog.with_name(self.netlog.name + '.inprogress').exists()
        if not self.owns_netlog: self.problem('netlog.preexisting_output')
        try: self.file = (self.output / 'browser-observer.jsonl').open('x', encoding='utf-8')
        except OSError as error:
            self.owns_netlog = False; self.problem('observer.open', error)

    def problem(self, where, error=None):
        if len(self.errors) < 16:
            self.errors.append({'where': where, 'error': type(error).__name__ if error else None})

    def event(self, kind, fields=None):
        try:
            row = {'kind': kind, 'at': datetime.now(timezone.utc).isoformat(),
                   'monotonicNs': monotonic_ns(), **(fields or {})}
            line = json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n'
            size = len(line.encode())
            if self.file is None or self.count >= self.max_events or self.bytes + size > self.max_bytes or size > 32768:
                self.dropped += 1
                return
            self.file.write(line); self.file.flush()
            self.count += 1; self.bytes += size
        except Exception as error:
            self.dropped += 1; self.problem('observer.write', error)

    def launch_args(self):
        # Chromium bounds event storage; constants/JSON framing are additional bytes.
        # Do not add IncludeSensitive/Everything, cache-disable, interception or timing flags.
        return [f'--log-net-log={self.netlog}', '--net-log-max-size-mb=8'] if self.owns_netlog else []

    @staticmethod
    def headers(value):
        allowed = {'etag', 'if-none-match', 'cache-control', 'content-length', 'content-type'}
        return {str(k).lower(): str(v)[:2048] for k, v in (value or {}).items() if str(k).lower() in allowed}

    def attach(self, context, page, width, origins):
        try:
            session = context.new_cdp_session(page)
            self.attach_session(session, width, origins)
            return session
        except Exception as error:
            self.problem('network.attach', error)
            return None

    def attach_session(self, session, width, origins):
        state = {'width': width, 'owned': set(origins), 'requests': {}, 'pending': [], 'stage': 'exercise'}
        self.sessions[id(session)] = state
        for name in ['requestWillBeSent', 'requestWillBeSentExtraInfo', 'responseReceived',
                     'responseReceivedExtraInfo', 'requestServedFromCache', 'loadingFinished', 'loadingFailed']:
            session.on('Network.' + name, lambda params, name=name: self.network(state, name, params))
        try: session.send('Network.enable')
        except Exception as error: self.problem('network.enable', error)
        self.event('network.attached', {'width': width, 'origins': sorted(origins)})

    def network(self, state, name, value):
        try:
            request_id = value.get('requestId')
            base = {'width': state['width'], 'requestId': request_id, 'stage': state['stage'],
                    'observedNs': monotonic_ns(), 'timestamp': value.get('timestamp')}
            fields = {}
            if name == 'requestWillBeSent':
                request = value.get('request', {}); raw_url = request.get('url', '')
                url = urlsplit(raw_url)
                if f'{url.scheme}://{url.netloc}' not in state['owned']: return
                if len(state['requests']) >= 1024 and request_id not in state['requests']:
                    self.problem('network.request_map_cap'); return
                # No body or auth/cookie headers in the sidecar; no request mutation to inject IDs.
                fields = {'url': raw_url[:4096], 'method': request.get('method'), 'wallTime': value.get('wallTime'),
                          'loaderId': value.get('loaderId'), 'type': value.get('type'),
                          'headers': self.headers(request.get('headers'))}
                if len(raw_url) > 4096: self.problem('network.url_truncated')
                if isinstance(request.get('postData'), str):
                    fields['postDataSha256'] = hashlib.sha256(request['postData'].encode()).hexdigest()
                state['requests'][request_id] = {'url': fields['url'], 'method': fields['method']}
            elif name == 'requestWillBeSentExtraInfo':
                fields = {'headers': self.headers(value.get('headers')), 'connectTiming': value.get('connectTiming')}
            elif name == 'responseReceived':
                response = value.get('response', {})
                fields = {key: response.get(key) for key in ['status', 'connectionId', 'connectionReused', 'remoteIPAddress',
                    'remotePort', 'protocol', 'fromDiskCache', 'fromServiceWorker', 'fromPrefetchCache', 'timing']}
                fields['headers'] = self.headers(response.get('headers'))
            elif name == 'responseReceivedExtraInfo':
                fields = {'statusCode': value.get('statusCode'), 'headers': self.headers(value.get('headers'))}
            elif name == 'loadingFinished': fields = {'encodedDataLength': value.get('encodedDataLength')}
            elif name == 'loadingFailed':
                fields = {key: value.get(key) for key in ['canceled', 'blockedReason', 'type']}
                fields['errorText'] = str(value.get('errorText', ''))[:1024]
            row = {**base, **fields}
            if request_id not in state['requests']:
                if len(state['pending']) < 256: state['pending'].append((name, row))
                else: self.problem('network.unassociated_cap')
                return
            self.event('Network.' + name, row)
            if name == 'requestWillBeSent':
                remaining = []
                for pending_name, pending in state['pending']:
                    if pending['requestId'] == request_id: self.event('Network.' + pending_name, pending)
                    else: remaining.append((pending_name, pending))
                state['pending'] = remaining
        except Exception as error: self.problem('network.projection', error)

    def mark_cleanup(self, session):
        if session and id(session) in self.sessions:
            self.sessions[id(session)]['stage'] = 'context-cleanup'
            self.event('context.cleanup.before', {'width': self.sessions[id(session)]['width']})

    def close_session(self, session):
        if session is None: return
        state = self.sessions.pop(id(session), {})
        self.event('network.detaching', {'width': state.get('width'),
                   'unassociatedEvents': len(state.get('pending', []))})
        try: session.detach()
        except Exception:
            # Context closure normally already detaches this owned observation session.
            self.event('network.already_detached', {'width': state.get('width')})

    def control(self, session, name, params, width):
        try: result = session.send(name, params)
        except Exception as error:
            self.event('native.control', {'width': width, 'command': name, 'params': params,
                       'outcome': 'rejected', 'errorType': type(error).__name__})
            raise
        self.event('native.control', {'width': width, 'command': name, 'params': params,
                   'outcome': 'fulfilled', 'result': result})
        return result

    def native_start(self, page):
        try:
            page.evaluate("""() => {
              const record = { events: [], dropped: 0 };
              const listener = event => {
                if (record.events.length >= 128) { record.dropped++; return; }
                record.events.push({ type: event.type, state: document.visibilityState,
                  focus: document.hasFocus(), trusted: event.isTrusted, at: Date.now(), performanceMs: performance.now() });
              };
              document.addEventListener('visibilitychange', listener);
              window.addEventListener('focus', listener); window.addEventListener('blur', listener);
              window.__resourceDiagnosticVisibility = record;
              window.__resourceDiagnosticRemove = () => {
                document.removeEventListener('visibilitychange', listener);
                window.removeEventListener('focus', listener); window.removeEventListener('blur', listener);
              };
            }""")
        except Exception as error: self.problem('native.listener', error)

    def native_snapshot(self, session, page, window, width, stage):
        row = {'width': width, 'windowId': window, 'stage': stage}
        try: row['target'] = session.send('Target.getTargetInfo').get('targetInfo', {}).get('targetId')
        except Exception as error: row['targetError'] = type(error).__name__; self.problem('native.target', error)
        if window is not None:
            try: row['bounds'] = session.send('Browser.getWindowBounds', {'windowId': window})
            except Exception as error: row['boundsError'] = type(error).__name__; self.problem('native.bounds', error)
        try:
            row['page'] = page.evaluate("""() => ({ visibility: document.visibilityState, focus: document.hasFocus(),
              at: Date.now(), performanceMs: performance.now(),
              events: window.__resourceDiagnosticVisibility?.events ?? [],
              dropped: window.__resourceDiagnosticVisibility?.dropped ?? 0 })""")
            if row['page'].get('dropped'): self.problem('native.events_cap')
        except Exception as error: row['pageError'] = type(error).__name__; self.problem('native.page', error)
        self.event('native.snapshot', row)

    def native_stop(self, page):
        try: page.evaluate('() => window.__resourceDiagnosticRemove?.()')
        except Exception as error: self.problem('native.listener_remove', error)

    def checkpoint_netlog(self):
        """Preserve bounded real in-progress fragments before original cleanup cancels requests."""
        if self.checkpoint_done or not self.owns_netlog: return
        self.checkpoint_done = True
        try:
            sources = [self.netlog] if self.netlog.is_file() else []
            progress = self.netlog.with_name(self.netlog.name + '.inprogress')
            if progress.is_dir(): sources += sorted(progress.iterdir())
            destination = self.output / 'netlog-before-cleanup'; destination.mkdir(exist_ok=True)
            remaining = 16 * 1024 * 1024
            for source in sources[:16]:
                if not source.is_file() or source.is_symlink(): continue
                with source.open('rb') as stream: data = stream.read(remaining + 1)
                truncated = len(data) > remaining; data = data[:remaining]
                target = destination / source.name; target.write_bytes(data); remaining -= len(data)
                self.checkpoints.append({'file': str(target.relative_to(self.output)), 'source': source.name,
                    'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'truncated': truncated})
                if truncated or not remaining: self.problem('netlog.checkpoint_cap'); break
            if len(sources) > 16: self.problem('netlog.checkpoint_file_cap')
        except Exception as error: self.problem('netlog.checkpoint', error)

    def finish(self):
        if self.file:
            try: self.file.close()
            except Exception as error: self.problem('observer.close', error)
            self.file = None
        netlog = {'status': 'PARTIAL' if self.checkpoints else 'NOT_OBSERVED', 'configuredEventLimitMiB': 8,
                  'checkpointLimitBytes': 16 * 1024 * 1024, 'checkpointFiles': self.checkpoints,
                  'captureMode': 'Chromium default; no sensitive/raw-byte mode',
                  'association': 'CDP IDs and proxy IDs are separate namespaces; use URL/method/time, connection/source dependencies and socket tuples; no fabricated ID equality'}
        try:
            if self.owns_netlog and self.netlog.is_file():
                size = self.netlog.stat().st_size; netlog['bytes'] = size
                if size <= 16 * 1024 * 1024:
                    data = self.netlog.read_bytes(); netlog['sha256'] = hashlib.sha256(data).hexdigest()
                    parsed = json.loads(data)
                    if not isinstance(parsed.get('events'), list) or not isinstance(parsed.get('constants'), dict):
                        raise ValueError('invalid_netlog_structure')
                    netlog['eventCount'] = len(parsed['events'])
                    netlog['status'] = 'CAPTURED' if parsed['events'] else 'NOT_OBSERVED'
                    netlog['file'] = self.netlog.name; netlog['constantsPresent'] = True
                else: self.problem('netlog.read_cap')
        except Exception as error: self.problem('netlog.final_parse', error)
        return {'mode': 'OBSERVATION_ONLY', 'observer': {'status': 'INCOMPLETE' if self.errors or self.dropped else 'COMPLETE',
                    'events': self.count, 'bytes': self.bytes, 'dropped': self.dropped, 'errors': self.errors,
                    'maxEvents': self.max_events, 'maxBytes': self.max_bytes}, 'netlog': netlog,
                'limits': 'No browser capability or product PASS follows from capture. Ring overwrite/partial fragments require request-specific completeness review.'}
