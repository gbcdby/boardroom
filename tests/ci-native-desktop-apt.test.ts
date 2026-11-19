import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/ci/prepare-native-desktop-apt.sh', import.meta.url));
const pins = ['openbox=3.6.1-12build5', 'x11-utils=7.7+6build2'];
const acquire = ['-o', 'Acquire::Retries=2', '-o', 'Acquire::https::Timeout=15'];
type Stage = 'update' | 'download' | 'install';
type Call = { command: string; stage?: Stage; args: string[] };

function fixture(t: { after: (fn: () => void) => void }, options: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'boardroom-desktop-apt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), evidence = path.join(root, 'evidence'); mkdirSync(bin);
  const prelude = `#!${process.execPath}\nimport fs from 'node:fs';\n`
    + `const args=process.argv.slice(2); const record=value=>fs.appendFileSync(${JSON.stringify(path.join(root, 'calls.jsonl'))},JSON.stringify(value)+'\\n');\n`;
  writeFileSync(path.join(bin, 'apt-get'), prelude
    + `const stage=args.includes('update')?'update':args.includes('--download-only')?'download':'install';\n`
    + `record({command:'apt-get',stage,args}); console.log('owned APT '+stage);\n`
    + `if(process.env.BOARDROOM_TEST_STALL_STAGE===stage){\n`
    + ` if(process.env.BOARDROOM_TEST_IGNORE_TERM==='1')process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n`
    + `}else if(process.env.BOARDROOM_TEST_FAIL_STAGE===stage){console.error(process.env.BOARDROOM_TEST_ERROR??'owned failure');process.exit(Number(process.env.BOARDROOM_TEST_EXIT??'100'));}\n`);
  writeFileSync(path.join(bin, 'timeout'), prelude + `import {spawnSync} from 'node:child_process';\n`
    + `record({command:'timeout',args});\n`
    + `if(args[0]!=='--signal=TERM'||args[1]!=='--kill-after=5s'||!['120s','240s'].includes(args[2]))process.exit(72);\n`
    + `const command=args[3],childArgs=args.slice(4);\n`
    // The owned wrapper records the actual 120/240s policy. On Linux only, it
    // shortens the test's wait while using GNU timeout for real TERM/KILL behavior.
    + `const stage=childArgs.includes('update')?'update':'download';\n`
    + `const useReal=process.env.BOARDROOM_TEST_REAL_TIMEOUT==='1'&&process.env.BOARDROOM_TEST_STALL_STAGE===stage;\n`
    + `const result=spawnSync(useReal?'/usr/bin/timeout':command,useReal?['--signal=TERM','--kill-after=0.3s','2s',command,...childArgs]:childArgs,{stdio:'inherit',env:process.env});\n`
    + `if(result.error)throw result.error;process.exit(result.status??(result.signal==='SIGKILL'?137:143));\n`);
  writeFileSync(path.join(bin, 'tee'), prelude
    + `const data=fs.readFileSync(0);fs.writeFileSync(args[0],data);process.stdout.write(data);\n`
    + `if(args[0].endsWith('apt-'+process.env.BOARDROOM_TEST_LOG_FAIL_STAGE+'.log'))process.exit(74);\n`);
  for (const name of ['apt-get', 'timeout', 'tee']) chmodSync(path.join(bin, name), 0o755);
  const result = spawnSync('bash', [helper, evidence], { cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, ...options } });
  assert.ifError(result.error);
  const calls: Call[] = existsSync(path.join(root, 'calls.jsonl'))
    ? readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const receipt = (stage: Stage) => JSON.parse(readFileSync(path.join(evidence, `apt-${stage}.result.json`), 'utf8'));
  return { root, evidence, result, calls, receipt };
}

test('CI-R2: exact pins use strict update, bounded acquisition and one offline install', t => {
  const f = fixture(t); assert.equal(f.result.status, 0, f.result.stdout + f.result.stderr);
  const apt = f.calls.filter(call => call.command === 'apt-get');
  assert.deepEqual(apt.map(call => call.args), [
    [...acquire, '--error-on=any', 'update'],
    [...acquire, '--download-only', 'install', '-y', '--no-install-recommends', ...pins],
    ['--no-download', 'install', '-y', '--no-install-recommends', ...pins],
  ]);
  const deadlines = f.calls.filter(call => call.command === 'timeout');
  assert.equal(deadlines.length, 2, 'dpkg installation must never be wrapped in a new timeout');
  assert.deepEqual(deadlines.map(call => call.args.slice(0, 4)), [
    ['--signal=TERM', '--kill-after=5s', '120s', 'apt-get'],
    ['--signal=TERM', '--kill-after=5s', '240s', 'apt-get'],
  ]);
  for (const stage of ['update', 'download', 'install'] as const) {
    const receipt = f.receipt(stage);
    assert.equal(receipt.stage, stage); assert.equal(receipt.commandExit, 0); assert.equal(receipt.logExit, 0); assert.equal(receipt.exit, 0);
    assert.equal(receipt.acquisitionDeadlineSeconds, stage === 'update' ? 120 : stage === 'download' ? 240 : null);
    assert.match(receipt.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
    assert.match(readFileSync(path.join(f.evidence, `apt-${stage}.log`), 'utf8'), new RegExp(`owned APT ${stage}`));
    assert.match(readFileSync(path.join(f.evidence, `apt-${stage}.command.txt`), 'utf8'), /apt-get/);
  }
});

test('CI-R2: any terminal APT failure keeps its actual exit and prevents later stages', t => {
  for (const [stage, code, expected] of [
    ['update', 41, ['update']], ['download', 42, ['update', 'download']], ['install', 43, ['update', 'download', 'install']],
  ] as const) {
    const f = fixture(t, { BOARDROOM_TEST_FAIL_STAGE: stage, BOARDROOM_TEST_EXIT: String(code) });
    assert.equal(f.result.status, code, f.result.stdout + f.result.stderr);
    assert.deepEqual(f.calls.filter(call => call.command === 'apt-get').map(call => call.stage), expected);
    assert.equal(f.receipt(stage).commandExit, code); assert.equal(f.receipt(stage).exit, code);
    if (stage !== 'install') assert.equal(existsSync(path.join(f.evidence, 'apt-install.started.json')), false);
  }
});

test('CI-R2: permanent authentication, hash and missing-version failures get no wrapper retry', t => {
  for (const [stage, error] of [['update', 'BADSIG owned fixture'], ['download', 'Hash Sum mismatch'],
    ['download', "Version 'pinned' was not found"]] as const) {
    const f = fixture(t, { BOARDROOM_TEST_FAIL_STAGE: stage, BOARDROOM_TEST_ERROR: error });
    assert.equal(f.result.status, 100);
    assert.equal(f.calls.filter(call => call.command === 'apt-get' && call.stage === stage).length, 1);
    assert.equal(existsSync(path.join(f.evidence, 'apt-install.started.json')), false);
    assert.ok(readFileSync(path.join(f.evidence, `apt-${stage}.log`), 'utf8').includes(error));
  }
});

test('CI-R2: log-pipeline failure cannot turn a stage green or replace a failing command status', t => {
  for (const commandExit of [0, 42]) {
    const f = fixture(t, { BOARDROOM_TEST_LOG_FAIL_STAGE: 'download',
      ...(commandExit ? { BOARDROOM_TEST_FAIL_STAGE: 'download', BOARDROOM_TEST_EXIT: String(commandExit) } : {}) });
    assert.equal(f.result.status, commandExit || 74);
    assert.deepEqual(f.calls.filter(call => call.command === 'apt-get').map(call => call.stage), ['update', 'download']);
    const receipt = f.receipt('download');
    assert.equal(receipt.commandExit, commandExit); assert.equal(receipt.logExit, 74); assert.equal(receipt.exit, commandExit || 74);
  }
});

test('CI-R2: real GNU TERM/KILL acquisition deadlines stop before installation', { skip: process.platform !== 'linux' }, t => {
  for (const [stage, ignoreTerm, code] of [['update', '0', 124], ['download', '1', 137]] as const) {
    const f = fixture(t, { BOARDROOM_TEST_REAL_TIMEOUT: '1', BOARDROOM_TEST_STALL_STAGE: stage, BOARDROOM_TEST_IGNORE_TERM: ignoreTerm });
    assert.equal(f.result.status, code, f.result.stdout + f.result.stderr);
    assert.equal(f.receipt(stage).commandExit, code); assert.equal(f.receipt(stage).exit, code);
    assert.equal(f.calls.filter(call => call.command === 'apt-get' && call.stage === 'install').length, 0);
    assert.equal(existsSync(path.join(f.evidence, 'apt-install.started.json')), false);
  }
});
