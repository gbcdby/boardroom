import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import { maintenanceHostIdentityDigest } from "../src/server/storage/maintenance/host.ts";
import type { PostgresDescriptor } from "../src/server/storage/maintenance/postgres-tools.ts";
import type { Json, MaintenanceAdapter, OperationMutex } from "../src/server/storage/maintenance/types.ts";

// Explicit acceptance entry, excluded from npm test's *.test.ts glob. Never skips to green.
type Scenario = "normal" | "archive-replace" | "selection-replace" | "sql-replace" | "sql-truncate";
interface NativeEvent { event: string; program: string; stage: string; pid?: number; code?: number; signal?: string | null;
  fds?: { fd: number; name: string; device: string; inode: string; bytes: string; mode: string }[]; target?: string }
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const connect = async (url: string) => {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 5000,
    application_name: "boardroom-r05-fixture" });
  client.on("error", () => {}); await client.connect(); return client;
};

function wrapper(program: "pg_restore" | "psql", native: string, directory: string, log: string, scenario: Scenario) {
  // Metadata reads do not change file offsets. Native argv, input/output FDs and SQL stay unchanged.
  // Matching inherited FDs by fstat against our private files works on Darwin without procfs.
  return `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';
const program=${JSON.stringify(program)}, native=${JSON.stringify(native)}, directory=${JSON.stringify(directory)}, log=${JSON.stringify(log)}, scenario=${JSON.stringify(scenario)};
const args=process.argv.slice(2), version=args.length===1&&args[0]==='--version';
const stage=version?'version':program==='psql'?'execute':args.includes('--list')?'list':'render';
const append=body=>fs.appendFileSync(log,JSON.stringify({program,stage,...body})+'\\n');
function locate(fd){
 const info=fs.fstatSync(fd,{bigint:true});
 if(!info.isFile()||info.nlink!==1n||(info.mode&0o777n)!==0o600n||info.uid!==BigInt(process.getuid()))throw Error('owned FD shape');
 const names=fs.readdirSync(directory);if(names.length>40)throw Error('fixture file bound');
 const matches=names.filter(name=>{if(!name.startsWith('.public-'))return false;const s=fs.lstatSync(path.join(directory,name),{bigint:true});return s.isFile()&&s.dev===info.dev&&s.ino===info.ino;});
 if(matches.length!==1)throw Error('owned FD identity');
 return {fd,name:matches[0],device:String(info.dev),inode:String(info.ino),bytes:String(info.size),mode:String(info.mode&0o777n)};
}
let fds=[];
try{
 if(!version){fds=(stage==='list'?[3]:[3,4]).map(locate);
  if(program==='pg_restore'&&!fds[0].name.endsWith('-archive.dump'))throw Error('archive fd3');
  if(stage==='render'&&!/-(namespace|body)\\.list$/.test(fds[1].name))throw Error('selection fd4');
  if(stage==='execute'&&(!fds[0].name.endsWith('-namespace.sql')||!fds[1].name.endsWith('-body.sql')))throw Error('SQL fd3/fd4');
 }
 const child=spawn(native,args,{shell:false,env:process.env,stdio:[0,1,2,...(version?[]:stage==='list'?[3]:[3,4])]});
 append({event:'start',pid:child.pid??null,fds});
 let timedOut=false,killTimer;
 const stop=()=>{timedOut=true;child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),1000);};
 const timer=setTimeout(stop,15000);process.on('SIGTERM',stop);process.on('SIGINT',stop);
 child.on('error',()=>{append({event:'spawn-error'});});
 child.on('close',(code,signal)=>{
  clearTimeout(timer);clearTimeout(killTimer);append({event:'close',pid:child.pid??null,code,signal,timedOut});
  if(code!==0||signal||timedOut){process.exitCode=9;return;}
  try{
   let target;
   if(scenario==='archive-replace'&&stage==='list')target=locate(3).name;
   if(scenario==='selection-replace'&&stage==='render')target=locate(4).name;
   if(scenario.startsWith('sql-')&&stage==='render'&&locate(4).name.endsWith('-body.list')){
    const names=fs.readdirSync(directory).filter(n=>n.startsWith('.public-')&&n.endsWith('-namespace.sql'));
    if(names.length!==1)throw Error('namespace SQL identity');target=names[0];
   }
   if(target){const file=path.join(directory,target),info=fs.lstatSync(file,{bigint:true});
    if(!info.isFile()||info.nlink!==1n||info.uid!==BigInt(process.getuid()))throw Error('tamper ownership');
    if(scenario==='sql-truncate')fs.truncateSync(file,0);
    else{fs.renameSync(file,file+'.original');fs.copyFileSync(file+'.original',file,fs.constants.COPYFILE_EXCL);fs.chmodSync(file,0o600);}
    append({event:'injected',target});
   }
  }catch{append({event:'fixture-error'});process.exitCode=8;}
 });
}catch{append({event:'fixture-error'});process.exitCode=8;}
`;
}

async function fixture(url: string, binary: string, scenario: Scenario) {
  const token = randomUUID().replaceAll("-", ""), sourceName = `br_r05_src_${token}`, targetName = `br_r05_ver_${token}`;
  const hostIdentityDigest = await maintenanceHostIdentityDigest();
  const role = `br_r05_reader_${token}`, admin = await connect(url);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "br-r05-case-"))); await chmod(directory, 0o700);
  const info = await lstat(directory, { bigint: true });
  const root = { path: directory, device: String(info.dev), inode: String(info.ino), hostIdentityDigest };
  const dbs: { name: string; oid: string }[] = []; let roleOid: string | undefined;
  const descriptor = (name: string): PostgresDescriptor => { const u = new URL(url); u.pathname = `/${name}`; return { kind: "postgres", connectionString: u.toString(), schema: "public" }; };
  const source = descriptor(sourceName), target = descriptor(targetName), log = join(directory, "native-events.jsonl");
  const close = async () => {
    try {
      for (const db of [...dbs].reverse()) {
        const actual = (await admin.query("SELECT oid::text FROM pg_database WHERE datname=$1", [db.name])).rows;
        assert.deepEqual(actual, [{ oid: db.oid }], "never drop a replaced fixture database");
        await admin.query(`DROP DATABASE ${quote(db.name)}`);
      }
      if (roleOid) {
        assert.deepEqual((await admin.query("SELECT oid::text FROM pg_roles WHERE rolname=$1", [role])).rows, [{ oid: roleOid }]);
        await admin.query(`DROP ROLE ${quote(role)}`);
      }
    } finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
  };
  try {
    await admin.query(`CREATE ROLE ${quote(role)} NOLOGIN`);
    roleOid = (await admin.query("SELECT oid::text FROM pg_roles WHERE rolname=$1", [role])).rows[0].oid;
    for (const name of [sourceName, targetName]) {
      await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`);
      dbs.push({ name, oid: (await admin.query("SELECT oid::text FROM pg_database WHERE datname=$1", [name])).rows[0].oid });
    }
    const driver = new PostgresDriver({ connectionString: source.connectionString, schema: "public" });
    try { await driver.connect(); await driver.migrate(migrations);
      await driver.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('r05','Darwin controlled FD','t','t')");
      await driver.exec(`GRANT SELECT ON projects TO ${quote(role)}`);
    } finally { await driver.close(); }
    const t = await connect(target.connectionString);
    try { await t.query("REVOKE ALL ON SCHEMA public FROM PUBLIC; COMMENT ON SCHEMA public IS 'r05 target prestate'"); } finally { await t.end(); }
    await writeFile(log, "", { mode: 0o600, flag: "wx" });
    const tools = join(directory, "tools"); await mkdir(tools, { mode: 0o700 });
    for (const program of ["pg_restore", "psql"] as const)
      await writeFile(join(tools, program), wrapper(program, join(binary, program), directory, log, scenario), { mode: 0o700, flag: "wx" });
    const oldPath = process.env.PATH; let adapter: MaintenanceAdapter;
    try { process.env.PATH = `${tools}:${binary}:${oldPath ?? ""}`; adapter = await createPostgresMaintenanceAdapter(source, target); }
    finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
    return { source, target, directory, root, admin, adapter, close, log };
  } catch (error) { await close(); throw error; }
}

async function namespace(url: string) {
  const client = await connect(url);
  try { return (await client.query(`SELECT oid::text,nspowner::text,nspacl::text,pg_catalog.obj_description(oid,'pg_namespace') AS comment
    FROM pg_namespace WHERE nspname='public'`)).rows; } finally { await client.end(); }
}

async function seal(adapter: MaintenanceAdapter, root: Awaited<ReturnType<typeof fixture>>["root"], mutex: OperationMutex) {
  // These fixture anchors exercise the adapter only. No claim of a real durable journal/service.
  for (const admission of ["draining", "sealed"] as const) await adapter.withSourceLock("control", async lock => {
    const before = await lock.observe();
    await lock.anchor({ expected: before.state, admission, fenceEpoch: before.state.fenceEpoch + (admission === "draining" ? 1 : 0),
      ownerGeneration: before.state.ownerGeneration + (admission === "draining" ? 1 : 0), activeMigrationId: "darwin-r05",
      planDigest: "c".repeat(64), controlRootIdentity: root, mutexIdentity: mutex.identity,
      journalSequence: before.state.journalSequence + 1,
      journal: { ref: `fixture-${admission}`, sha256: (admission === "draining" ? "d" : "e").repeat(64), bytes: "1" } });
  });
}

test("#152 PUB-R05 Darwin native public FD pipeline and immutable-input controls", { timeout: 120_000 }, async t => {
  assert.equal(process.platform, "darwin", "this acceptance requires actual Darwin, not emulation or a platform override");
  assert.equal(process.arch, "arm64"); assert.ok(process.getuid?.() !== 0);
  const url = process.env.AGENT_STUDIO_PG_TEST_URL, binary = process.env.BOARDROOM_PUB_R05_PG_BIN;
  const output = process.env.BOARDROOM_PUB_R05_EVIDENCE, ownedData = process.env.BOARDROOM_PUB_R05_OWNED_DATA;
  assert.ok(url && binary && output && ownedData, "use the owned-cluster runner; absence is not a skip");
  assert.equal(await realpath(binary), resolve(binary)); assert.equal(await realpath(output), resolve(output));
  const parsed = new URL(url); assert.equal(parsed.hostname, "127.0.0.1"); assert.notEqual(parsed.port, "5432");
  assert.match(parsed.username, /^br_pub_r05_[a-f0-9]{12}$/);
  const admin = await connect(url);
  try {
    const actual = (await admin.query("SELECT current_setting('data_directory') AS data,current_setting('server_version_num') AS version")).rows[0];
    assert.equal(await realpath(actual.data), await realpath(ownedData)); assert.equal(actual.version, "160015");
  } finally { await admin.end(); }
  const outcomes: Record<string, unknown>[] = [];
  for (const scenario of ["normal", "archive-replace", "selection-replace", "sql-replace", "sql-truncate"] as const)
    await t.test(scenario, async () => {
      const result: Record<string, unknown> = { scenario, status: "RUNNING", phase: "fixture", native: [] };
      outcomes.push(result); let f: Awaited<ReturnType<typeof fixture>> | undefined;
      try {
        f = await fixture(url, binary, scenario);
        result.phase = "source-and-target-preconditions";
        const before = await namespace(f.target.connectionString), observed = await f.adapter.observe();
        const mutex = await f.adapter.acquireMutex(f.root, observed.state); await seal(f.adapter, f.root, mutex);
        await f.adapter.withSourceLock("snapshot", async lock => {
          result.phase = "backup";
          const archive = join(f!.directory, "source.dump"), backup = await lock.backup(archive);
          result.archiveSha256 = digest(await readFile(archive));
          result.phase = "production-public-verification";
          if (scenario === "normal") {
            const verified = await f!.adapter.verifyDatabase(archive, backup.manifests, f!.directory) as Record<string, Json>;
            const restored = verified.restoredWith as Record<string, Json>;
            assert.equal(restored.profile, "pg16-public-native-segments-v1");
            assert.equal(restored.pgRestore, "16.15"); assert.equal(restored.psql, "16.15");
            assert.equal(restored.singleTransaction, true); assert.equal(restored.ownershipPreserved, true); assert.equal(restored.aclPreserved, true);
            assert.equal(verified.exactFullDataAndControlMatched, true);
            result.verification = verified;
          } else await assert.rejects(f!.adapter.verifyDatabase(archive, backup.manifests, f!.directory), /snapshot_invalid/);
        });
        result.phase = "native-evidence-and-postconditions";
        const events = (await readFile(f.log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as NativeEvent);
        result.native = events;
        const started = events.filter(e => e.event === "start"), closed = events.filter(e => e.event === "close");
        assert.ok(started.length > 0); assert.equal(started.length, closed.length);
        for (const event of started) {
          assert.ok(event.pid); assert.ok(closed.some(e => e.pid === event.pid && e.code === 0 && e.signal === null));
          assert.throws(() => process.kill(event.pid!, 0), { code: "ESRCH" }, "real native child must have exited");
        }
        assert.equal(events.some(e => e.event === "fixture-error" || e.event === "spawn-error"), false);
        if (scenario === "normal") {
          const list = started.filter(e => e.stage === "list"), render = started.filter(e => e.stage === "render"), execution = started.filter(e => e.stage === "execute");
          assert.equal(list.length, 1); assert.equal(render.length, 2); assert.equal(execution.length, 1);
          const archives = [...list, ...render].map(e => `${e.fds![0]!.device}:${e.fds![0]!.inode}`);
          assert.equal(new Set(archives).size, 1, "all independent archive reads bind the same inode");
          assert.equal(events.some(e => e.event === "injected"), false);
          const target = await connect(f.target.connectionString);
          try { assert.deepEqual((await target.query("SELECT id,name FROM projects")).rows, [{ id: "r05", name: "Darwin controlled FD" }]); }
          finally { await target.end(); }
        } else {
          assert.equal(events.filter(e => e.event === "injected").length, 1, "the native stage and requested fault must really occur");
          assert.equal(started.filter(e => e.stage === "execute").length, 0, "no target execution after bound input tampering");
          assert.deepEqual(await namespace(f.target.connectionString), before);
        }
        assert.equal(Number((await f.admin.query("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name='boardroom-maintenance-tool'")).rows[0].n), 0);
        assert.equal((await f.adapter.observe()).state.admission, "sealed");
        await mutex.release(); result.status = "PASS";
      } catch (error) {
        result.status = "FAIL"; result.error = { name: (error as Error).name, message: String((error as Error).message).slice(0,1000) };
        throw error;
      } finally {
        if (f) {
          result.native = (await readFile(f.log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
          try { try { await f.adapter.close(); } finally { await f.close(); } result.cleanup = "PASS"; }
          catch (error) { result.cleanup = "FAIL"; throw error; }
          finally { await writeFile(join(output, `${scenario}.json`), JSON.stringify(result,null,2)+"\n", { mode: 0o600 }); }
        } else await writeFile(join(output, `${scenario}.json`), JSON.stringify(result,null,2)+"\n", { mode: 0o600 });
      }
    });
  await writeFile(join(output, "acceptance.json"), JSON.stringify({ profile: "pg16-public-native-segments-v1", platform: process.platform,
    architecture: process.arch, node: process.version, cases: outcomes.map(r => ({scenario:r.scenario,status:r.status,phase:r.phase,cleanup:r.cleanup})),
    actualDarwinExecution: true, fixtureAnchorsAreNotServiceProof: true },null,2)+"\n", { mode: 0o600 });
});
