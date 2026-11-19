import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { convertUbuntuSources } from '../scripts/ci/ubuntu-apt-https.ts';

const noble = '# fixed container sources\r\nTypes: deb deb-src\r\nURIs: http://archive.ubuntu.com/ubuntu/\r\n'
  + 'Suites: noble noble-updates noble-backports\r\nComponents: main restricted universe multiverse\r\n'
  + 'Architectures: amd64\r\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\r\n\r\n'
  + 'Types: deb\r\nURIs: http://security.ubuntu.com/ubuntu\r\nSuites: noble-security\r\nComponents: main universe\r\n'
  + 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\r\n';

test('CI273-APT-01: deb822 changes only the two official URI schemes and is idempotent', () => {
  const expected = noble.replace('http://archive.', 'https://archive.').replace('http://security.', 'https://security.');
  const result = convertUbuntuSources(noble, 'sources');
  assert.equal(result.after, expected, 'suite, components, architecture, keyring, comments and CRLF stay byte-identical');
  assert.deepEqual(result.uris, [
    { before: 'http://archive.ubuntu.com/ubuntu/', after: 'https://archive.ubuntu.com/ubuntu/' },
    { before: 'http://security.ubuntu.com/ubuntu', after: 'https://security.ubuntu.com/ubuntu' },
  ]);
  const repeated = convertUbuntuSources(expected, 'sources');
  assert.equal(repeated.after, expected);
  assert.ok(repeated.uris.every(uri => uri.before === uri.after));
});

test('CI273-APT-01: one-line and continued URI fields preserve options, disabled entries and comments', () => {
  const source = '# deb http://unconfigured.example/ubuntu noble main\n'
    + 'deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu noble main universe # retained\n'
    + 'deb-src https://security.ubuntu.com/ubuntu/ noble-security main\n';
  assert.equal(convertUbuntuSources(source, 'list').after,
    source.replace('http://archive.', 'https://archive.'));
  const deb822 = 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\n https://security.ubuntu.com/ubuntu\n'
    + 'Suites: noble\nComponents: main\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\n'
    + 'Enabled: no\nTypes: deb\nURIs: http://disabled.example/ubuntu\nSuites: noble\nComponents: main\n';
  const result = convertUbuntuSources(deb822, 'sources');
  assert.equal(result.after, deb822.replace('http://archive.', 'https://archive.'));
  assert.equal(result.uris.length, 2, 'disabled sources are preserved and never become active');
});

test('CI273-APT-01: unexpected hosts, paths, malformed sources and insecure trust overrides fail explicitly', () => {
  for (const uri of ['http://archive.ubuntu.com.evil/ubuntu', 'https://archive.ubuntu.com:443/ubuntu',
    'http://archive.ubuntu.com/ubuntu/extra', 'http://user:secret@archive.ubuntu.com/ubuntu', 'file:/ubuntu']) {
    assert.throws(() => convertUbuntuSources(`deb ${uri} noble main\n`, 'list'), /unexpected active APT URI/);
  }
  for (const options of ['trusted=yes', 'allow-insecure=true', 'allow-weak=1', 'allow-downgrade-to-insecure=yes']) {
    assert.throws(() => convertUbuntuSources(`deb [${options}] http://archive.ubuntu.com/ubuntu noble main\n`, 'list'), /trust option/);
  }
  for (const source of ['not a source\n', 'deb http://archive.ubuntu.com/ubuntu\n']) {
    assert.throws(() => convertUbuntuSources(source, 'list'), /structure/);
  }
  for (const source of [noble.replace('Types: deb deb-src', 'Types: other'),
    noble.replace('Types: deb deb-src', 'Enabled: perhaps\r\nTypes: deb'),
    noble.replace('Types: deb deb-src', 'Trusted: yes\r\nTypes: deb'),
    noble.replace('Types: deb deb-src', 'Types: deb\r\nTypes: deb'),
    noble.replace('Components: main restricted universe multiverse\r\n', '')]) {
    assert.throws(() => convertUbuntuSources(source, 'sources'), /structure|trust option/);
  }
});

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'boardroom-apt-https-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apt = path.join(root, 'apt'), evidence = path.join(root, 'evidence');
  mkdirSync(path.join(apt, 'sources.list.d'), { recursive: true });
  const source = path.join(apt, 'sources.list.d/ubuntu.sources');
  writeFileSync(source, noble);
  const run = (destination = evidence) => spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/ci/ubuntu-apt-https.ts', import.meta.url)), '--apt-root', apt, '--evidence', destination,
  ], { encoding: 'utf8', timeout: 5_000 });
  return { root, apt, evidence, source, run };
}

test('CI273-APT-01: CLI writes actual before/after evidence and leaves HTTPS and unrelated configuration unchanged', t => {
  const f = fixture(t);
  mkdirSync(path.join(f.apt, 'apt.conf.d'));
  const tls = 'Acquire::https::Verify-Peer "true";\nAcquire::https::Verify-Host "true";\n';
  writeFileSync(path.join(f.apt, 'apt.conf.d/verify'), tls);
  writeFileSync(path.join(f.apt, 'sources.list.d/old.list.disabled'), 'deb http://ignored.example/ubuntu noble main\n');
  const first = f.run(); assert.ifError(first.error); assert.equal(first.status, 0, first.stdout + first.stderr);
  const expected = noble.replace('http://archive.', 'https://archive.').replace('http://security.', 'https://security.');
  assert.equal(readFileSync(f.source, 'utf8'), expected, 'the active source file must actually be converted');
  assert.equal(readFileSync(path.join(f.evidence, 'before/sources.list.d/ubuntu.sources'), 'utf8'), noble);
  assert.equal(readFileSync(path.join(f.evidence, 'after/sources.list.d/ubuntu.sources'), 'utf8'), expected);
  const report = JSON.parse(readFileSync(path.join(f.evidence, 'result.json'), 'utf8'));
  assert.equal(report.status, 'CONVERTED'); assert.equal(report.changedFiles, 1);
  assert.equal(report.files.length, 1); assert.equal(report.files[0].uris.length, 2);
  const secondEvidence = path.join(f.root, 'second-evidence');
  const second = f.run(secondEvidence); assert.ifError(second.error); assert.equal(second.status, 0);
  assert.equal(JSON.parse(readFileSync(path.join(secondEvidence, 'result.json'), 'utf8')).status, 'ALREADY_HTTPS');
  assert.equal(readFileSync(f.source, 'utf8'), expected);
  assert.equal(readFileSync(path.join(f.apt, 'apt.conf.d/verify'), 'utf8'), tls);
  assert.equal(readFileSync(path.join(f.apt, 'sources.list.d/old.list.disabled'), 'utf8'), 'deb http://ignored.example/ubuntu noble main\n');
});

test('CI273-APT-01: all active sources are checked before any source write and rejected URL secrets stay out of evidence', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.apt, 'sources.list.d/z-extra.list'), 'deb https://user:credential-canary@other.example/ubuntu noble main\n');
  const result = f.run(); assert.ifError(result.error); assert.equal(result.status, 1);
  assert.equal(readFileSync(f.source, 'utf8'), noble, 'a valid earlier file must not be partly rewritten');
  const receipt = readFileSync(path.join(f.evidence, 'result.json'), 'utf8');
  assert.equal(JSON.parse(receipt).status, 'FAIL');
  assert.match(receipt, /unexpected active APT URI/);
  assert.ok(!receipt.includes('credential-canary') && !result.stderr.includes('credential-canary'));
  assert.equal(existsSync(path.join(f.evidence, 'after')), false);
});

test('CI273-APT-01: missing expected official sources and symlink sources fail without rewriting files', t => {
  const f = fixture(t);
  writeFileSync(f.source, '# no active configured source\n');
  const absent = f.run(); assert.ifError(absent.error); assert.equal(absent.status, 1);
  assert.match(absent.stderr, /expected official Ubuntu archive\/security/);
  writeFileSync(f.source, noble);
  const outside = path.join(f.root, 'outside.list');
  writeFileSync(outside, 'deb http://archive.ubuntu.com/ubuntu noble main\n');
  symlinkSync(outside, path.join(f.apt, 'sources.list.d/alias.list'));
  const linked = f.run(path.join(f.root, 'symlink-evidence')); assert.ifError(linked.error); assert.equal(linked.status, 1);
  assert.match(linked.stderr, /regular file/); assert.equal(readFileSync(f.source, 'utf8'), noble);
  assert.equal(readFileSync(outside, 'utf8'), 'deb http://archive.ubuntu.com/ubuntu noble main\n');
});

test('CI273-KEEP-01: the original Chromium APT step prepares HTTPS before installation and retains its full contract', () => {
  const document = parseDocument(readFileSync(new URL('../.github/workflows/database-ci.yml', import.meta.url), 'utf8'));
  assert.deepEqual(document.errors, []);
  const browser = document.toJS().jobs['managed-web-browser'];
  assert.equal(browser['timeout-minutes'], 15);
  assert.equal(browser.container.image, 'mcr.microsoft.com/playwright/python:v1.62.0-noble@sha256:aa81288e738725378becba5b3e06cb0f3a7f012a610e87e8d767a090ea3f740d');
  const run: string = browser.steps.find((step: { name: string }) => step.name === '提交后资源刷新、断线对账与草稿真实浏览器验证').run;
  const helper = run.indexOf('node scripts/ci/ubuntu-apt-https.ts --apt-root /etc/apt');
  const prepare = run.indexOf('bash scripts/ci/prepare-native-desktop-apt.sh .agent-output/resource-web-e2e/native-desktop');
  assert.ok(helper >= 0 && helper < prepare && prepare < run.indexOf('command -v Xvfb openbox xprop xauth'));
  const preparation = readFileSync(new URL('../scripts/ci/prepare-native-desktop-apt.sh', import.meta.url), 'utf8');
  assert.match(preparation, /apt-\$stage\.log/);
  assert.match(preparation, /openbox=3\.6\.1-12build5 x11-utils=7\.7\+6build2/);
  assert.match(run, /dpkg-query -W/); assert.match(run, /packages\.tsv/);
  assert.match(run, /scripts\/e2e-resource-web\.py --native-desktop/);
  assert.ok(!/allow-unauthenticated|allow-insecure|trusted=yes|Verify-Peer=false|Verify-Host=false/.test(run + preparation));
});

test('CI273-KEEP-01: captured output cannot hide source preparation or any APT stage failure', t => {
  const browser = parseDocument(readFileSync(new URL('../.github/workflows/database-ci.yml', import.meta.url), 'utf8')).toJS().jobs['managed-web-browser'];
  const run: string = browser.steps.find((step: { name: string }) => step.name === '提交后资源刷新、断线对账与草稿真实浏览器验证').run;
  for (const [failed, code, calls] of [['helper', 53, []], ['update', 41, ['update']],
    ['download', 42, ['update', 'download']], ['install', 43, ['update', 'download', 'install']]] as const) {
    const f = fixture(t), bin = path.join(f.root, 'bin'); mkdirSync(bin);
    mkdirSync(path.join(f.root, 'scripts/ci'), { recursive: true });
    writeFileSync(path.join(f.root, 'scripts/ci/prepare-native-desktop-apt.sh'),
      readFileSync(new URL('../scripts/ci/prepare-native-desktop-apt.sh', import.meta.url)));
    // Exercise the real workflow and preparation script with owned commands.
    // No host APT, source configuration or browser process is changed.
    writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexit ${failed === 'helper' ? code : 0}\n`);
    writeFileSync(path.join(bin, 'apt-get'), '#!/bin/sh\n'
      + 'case " $* " in *" update "*) stage=update;; *" --download-only "*) stage=download;; *) stage=install;; esac\n'
      + 'printf "%s\\n" "$stage" >> apt-calls.txt\n'
      + `if [ "$stage" = '${failed}' ]; then echo expected-apt-failure; exit ${code}; fi\nexit 0\n`);
    writeFileSync(path.join(bin, 'timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n');
    for (const command of ['node', 'apt-get', 'timeout']) chmodSync(path.join(bin, command), 0o755);
    const result = spawnSync('bash', ['-e', '-c', run], { cwd: f.root, encoding: 'utf8', timeout: 5_000,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } });
    assert.ifError(result.error); assert.equal(result.status, code, result.stdout + result.stderr);
    const actual = existsSync(path.join(f.root, 'apt-calls.txt')) ? readFileSync(path.join(f.root, 'apt-calls.txt'), 'utf8').trim().split('\n') : [];
    assert.deepEqual(actual, calls);
    if (failed !== 'helper') assert.match(readFileSync(path.join(f.root, `.agent-output/resource-web-e2e/native-desktop/apt-${failed}.log`), 'utf8'), /expected-apt-failure/);
    assert.equal(existsSync(path.join(f.root, '.agent-output/resource-web-e2e/native-desktop/packages.tsv')), false);
  }
});
