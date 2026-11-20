import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { SQLITE_PROFILE_READ_TABLES as tables } from "../src/server/storage/internal/sqlite-profile-read-source.ts";
import { F_MIGRATIONS } from "../src/server/identity/internal/m2-p0-artifacts-catalog.ts";
import { p1 } from "./helpers/sqlite-profile-observation-fixture.ts";

const linux = process.platform === "linux", root = path.resolve(import.meta.dirname, "..");
let project: string;
before(() => {
  if (!linux) return;
  // Byte-identical product sources in an isolated project prevent cross-file tests from mutating a shared build pointer.
  project = mkdtempSync(path.join(tmpdir(), "boardroom-i02-native-project-"));
  cpSync(path.join(root, "src"), path.join(project, "src"), { recursive: true });
  assert.deepEqual(readFileSync(path.join(project, "src/server/storage/internal/sqlite-path-observation.ts")),
    readFileSync(path.join(root, "src/server/storage/internal/sqlite-path-observation.ts")));
  for (const file of ["package.json", "package-lock.json", "native/maintenance-sqlite.c", "scripts/build-sqlite-path-check.mjs"]) {
    const target = path.join(project, file); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(path.join(root, file), target);
  }
  symlinkSync(path.join(root, "node_modules"), path.join(project, "node_modules"), "dir");
  const built = spawnSync(process.execPath, [path.join(project, "scripts/build-sqlite-path-check.mjs")], { cwd: project, encoding: "utf8", timeout: 60_000 });
  assert.equal(built.status, 0, built.stderr);
});
after(() => { if (project) rmSync(project, { recursive: true, force: true }); });
function fixture(body: (directory: string, source: string) => void, encoding = "UTF-8") {
  const directory = mkdtempSync(path.join(tmpdir(), "boardroom-i02-native-source-")), selected = path.join(directory, "selected");
  mkdirSync(selected); const source = path.join(selected, "agent-studio.db"), db = new Database(source);
  try {
    db.pragma(`encoding='${encoding}'`);
    // Finite five-table shape fixture only; it makes no full G1/schema/native qualification claim.
    for (const table of tables) db.exec(`CREATE TABLE "${table.table}"(${table.columns.map(c => `"${c.name}" ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PRIMARY KEY" : ""}${c.default === null ? "" : ` DEFAULT ${c.default}`}`).join(",")});`);
    db.prepare("INSERT INTO storage_maintenance VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(1, "a".repeat(32), null, null, 0,
      "open", null, null, 0, null, null, 0, 1, "b".repeat(64), null);
    const insert = db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)");
    for (const migration of F_MIGRATIONS.sqlite) insert.run(migration.version, migration.name, migration.checksum, "2026-11-20 00:00:00");
  } finally { db.close(); }
  try { body(directory, source); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const moduleUrl = () => pathToFileURL(path.join(project, "src/server/storage/internal/sqlite-path-observation.ts")).href;
function run(directory: string, code: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: project,
    env: { BOARDROOM_HOME: path.join(directory, "home"), AGENT_STUDIO_DB_DRIVER: "sqlite", AGENT_STUDIO_DATA_DIR: path.join(directory, "selected") },
    encoding: "utf8", timeout: 20_000 });
}
function observe(directory: string, prefix = "") {
  const url = moduleUrl();
  const code = `import{inspectSelectedSqliteProfileObservation as inspect}from ${JSON.stringify(url)};${prefix}
    try{console.log(JSON.stringify({ok:true,arity:inspect.length,value:await inspect(),probe:globalThis.__probe??null}))}
    catch(error){console.log(JSON.stringify({ok:false,code:error.code,probe:globalThis.__probe??null}));process.exitCode=1}`;
  return run(directory, code);
}
function instrument(afterFirstMetadata = ""): string {
  const database = pathToFileURL(path.join(project, "node_modules/better-sqlite3/lib/index.js")).href;
  return `import Database from ${JSON.stringify(database)};
    globalThis.__probe={events:[],values:0};const handles=new WeakMap();let handleId=0,changed=false;
    const originalPrepare=Database.prototype.prepare;
    Database.prototype.prepare=function(sql){const db=this;let id=handles.get(db);if(id===undefined){id=++handleId;handles.set(db,id)}
      const statement=originalPrepare.call(db,sql),get=statement.get;
      if(sql.includes(' AS t0,')||sql.startsWith('SELECT rowid AS _rowid, CASE typeof'))statement.get=function(...args){
        const value=sql.startsWith('SELECT rowid AS _rowid, CASE typeof');if(value)globalThis.__probe.values++;
        globalThis.__probe.events.push({id,transaction:db.inTransaction,kind:value?'value':'metadata'});
        const result=get.apply(statement,args);
        if(!value&&!changed&&sql.includes('FROM "main"."storage_maintenance"')){changed=true;${afterFirstMetadata}}
        return result};return statement};`;
}
for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"]) test(`SQ-D02 I02：零参数原入口同handle/T观察 ${encoding} 的15/17列protocol1形状fixture后退休，不发准入`, { skip: !linux }, () => fixture((directory, source) => {
  const before = readFileSync(source), result = observe(directory);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.arity, 0); assert.equal(output.value.scope, "sqlite-selected-profile-observation/v1");
  assert.equal(output.value.retirement, "closed");
  assert.equal(output.value.observation.scope, "raw-and-metadata-links");
  assert.equal(output.value.observation.raw.textEncoding.name, encoding);
  assert.equal(output.value.observation.raw.migrations.rows.length, 21);
  assert.equal(output.value.observation.terminalClosure, "not_run");
  assert.equal(output.value.sourceFileDescriptorQualification, "not_qualified");
  assert.equal(Object.hasOwn(output.value, "admitted"), false); assert.deepEqual(readFileSync(source), before);
}, encoding));
test("SQ-D02 I02：metadata/value 全部来自同一真实 handle 与同一 T；WAL 后续提交不混入当前快照", { skip: !linux }, () => fixture((directory, source) => {
  const db = new Database(source); db.pragma("journal_mode=WAL"); db.close();
  const writer = `const other=new Database(${JSON.stringify(source)});other.prepare('UPDATE storage_maintenance SET database_instance_id=?').run('c'.repeat(32));other.close();`;
  const result = observe(directory, instrument(writer));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.ok(output.probe.events.length > 40); assert.ok(output.probe.events.every((event: { transaction: boolean }) => event.transaction));
  assert.equal(new Set(output.probe.events.map((event: { id: number }) => event.id)).size, 1);
  assert.equal(output.value.observation.raw.control.rows[0].cells[1][1], Buffer.from("a".repeat(32)).toString("hex"));
  const later = new Database(source, { readonly: true });
  try { assert.equal((later.prepare("SELECT database_instance_id AS id FROM storage_maintenance").get() as { id: string }).id, "c".repeat(32)); }
  finally { later.close(); }
}));
test("SQ-D02 I02：旧14/16列布局明确只读拒绝，不CREATE、不变更、不回退到新P0准入", { skip: !linux }, () => fixture((directory, source) => {
  const db = new Database(source);
  db.exec("ALTER TABLE storage_maintenance DROP COLUMN profile_takeover_terminal_json; ALTER TABLE storage_source_clients DROP COLUMN writer_format_digest; DROP TABLE config_authority; DROP TABLE config_activation_receipts;");
  assert.equal((db.pragma("table_info(storage_maintenance)") as unknown[]).length, 14);
  assert.equal((db.pragma("table_info(storage_source_clients)") as unknown[]).length, 16); db.close();
  const before = readFileSync(source), result = observe(directory, instrument());
  assert.equal(result.status, 1, result.stderr + result.stdout); assert.equal(JSON.parse(result.stdout).code, "source_contract_mismatch");
  assert.deepEqual(readFileSync(source), before);
  const after = new Database(source, { readonly: true });
  try { assert.equal((after.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('config_authority','config_activation_receipts')").get() as { n: number }).n, 0); }
  finally { after.close(); }
}));
test("SQ-D02 I02：超过field的 TEXT 或错误 BLOB storage 在第一次 raw value get 前拒绝", { skip: !linux }, () => {
  for (const value of ["x".repeat(32 * 1024 + 1), Buffer.from([0, 255])]) fixture((directory, source) => {
    const db = new Database(source); db.prepare("UPDATE storage_maintenance SET database_instance_id=?").run(value); db.close();
    const result = observe(directory, instrument()); assert.equal(result.status, 1, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout); assert.equal(output.code, typeof value === "string" ? "resource_limit" : "source_contract_mismatch");
    assert.equal(output.probe.values, 0);
  });
});
test("SQ-D02 I02：实际额外列、缺列、错误type和hidden元数据均拒绝", { skip: !linux }, () => {
  for (const variation of ["extra", "missing", "type", "hidden"]) fixture((directory, source) => {
    const db = new Database(source);
    if (variation === "extra") db.exec("ALTER TABLE storage_maintenance ADD COLUMN extra TEXT;");
    else if (variation === "missing") db.exec("ALTER TABLE storage_maintenance DROP COLUMN profile_takeover_terminal_json;");
    else {
      const table = tables[0]!;
      const declaration = table.columns.map(c => `"${c.name}" ${c.name === "database_instance_id" && variation === "type" ? "BLOB" : c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PRIMARY KEY" : ""}${c.default === null ? "" : ` DEFAULT ${c.default}`}${c.name === "profile_takeover_terminal_json" && variation === "hidden" ? " GENERATED ALWAYS AS ('hidden') VIRTUAL" : ""}`).join(",");
      db.exec(`ALTER TABLE storage_maintenance RENAME TO previous_control; CREATE TABLE storage_maintenance(${declaration});`);
    }
    db.close();
    const result = observe(directory, instrument()); assert.equal(result.status, 1, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout); assert.equal(output.code, "source_contract_mismatch"); assert.equal(output.probe.values, 0);
  });
});
test("SQ-D02 I02：原入口不读取伪造参数且实际source/binary fd已关闭", { skip: !linux }, () => fixture((directory, source) => {
  const code = `import{inspectSelectedSqliteProfileObservation as inspect}from ${JSON.stringify(moduleUrl())};
    import{readdirSync,readlinkSync}from'node:fs';let effects=0;
    const trap=()=>{effects++;throw Error('must-not-run')},fake=new Proxy({},{get:trap,ownKeys:trap,getPrototypeOf:trap});
    const value=await inspect(fake),remaining=readdirSync('/proc/self/fd').flatMap(n=>{try{return[readlinkSync('/proc/self/fd/'+n)]}catch{return[]}})
      .filter(p=>p===${JSON.stringify(source)}||p.endsWith('/extension.so'));
    console.log(JSON.stringify({effects,remaining,scope:value.scope}));`;
  const result = run(directory, code); assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout); assert.equal(output.effects, 0); assert.deepEqual(output.remaining, []);
}));
test("SQ-D02 I02：预算失败加close未知仍保留原失败和真实资源owner，后续调用不重开（派生私有观察）", { skip: !linux }, t => fixture((directory, source) => {
  const db = new Database(source); db.prepare("UPDATE storage_maintenance SET database_instance_id=?").run("x".repeat(32 * 1024 + 1)); db.close();
  const originalFile = path.join(project, "src/server/storage/internal/sqlite-path-observation.ts"), original = readFileSync(originalFile, "utf8");
  const derived = original.replace('s.db.close(); if (s.db.open) throw new Error("close_not_terminal"); s.dbPhase = "closed";',
    'throw new Error("isolated-unknown-close");')
    + '\nexport function __privateState(){return [...pendingOwners].map(s=>({dbPhase:s.dbPhase,files:s.files.map(f=>f.phase),failures:s.failures.map(f=>s.request?.failures.get(f.error)?.error.code??f.phase)}))}\n';
  assert.notEqual(original, derived);
  const file = path.join(project, "src/server/storage/internal/sqlite-profile-unknown-derived.ts"); writeFileSync(file, derived);
  t.diagnostic(JSON.stringify({ scope: "derived private observation, original public cases run separately",
    originalSHA256: createHash("sha256").update(original).digest("hex"), derivedSHA256: createHash("sha256").update(derived).digest("hex") }));
  const code = `import{inspectSelectedSqliteProfileObservation as inspect,__privateState as state}from ${JSON.stringify(pathToFileURL(file).href)};
    import{readdirSync,readlinkSync}from'node:fs';const codes=[];
    for(let i=0;i<2;i++){try{await inspect();codes.push('unexpected-success')}catch(e){codes.push(e.code)}}
    const files=readdirSync('/proc/self/fd').flatMap(n=>{try{return[readlinkSync('/proc/self/fd/'+n)]}catch{return[]}});
    console.log(JSON.stringify({codes,state:state(),sourcePins:files.filter(p=>p===${JSON.stringify(source)}).length,binaryPins:files.filter(p=>p.endsWith('/extension.so')).length}));`;
  const result = run(directory, code); assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.codes, ["native_retirement_unknown", "native_retirement_unknown"]);
  assert.equal(output.state.length, 1); assert.equal(output.state[0].dbPhase, "unknown");
  assert.deepEqual(output.state[0].failures, ["resource_limit", "database-close"]);
  assert.ok(output.state[0].files.every((phase: string) => phase === "open")); assert.ok(output.sourcePins >= 1); assert.equal(output.binaryPins, 1);
}));
test("SQ-D02 I02+I03：原生有限P1元数据fixture从raw读取到terminal只使用一个请求预算，仍不授予closure/native资格", { skip: !linux }, () => {
  for (const terminal of [false, true]) fixture((directory, source) => {
    const input = p1("UTF-16be", terminal), db = new Database(source);
    try {
      db.exec("BEGIN");
      for (const table of tables) {
        db.exec(`DELETE FROM main."${table.table}"`);
        const insert = db.prepare(`INSERT INTO main."${table.table}"(rowid,${table.columns.map(c => `"${c.name}"`).join(",")}) VALUES (${Array(table.columns.length + 1).fill("?").join(",")})`);
        for (const row of input[table.inputKey].rows) insert.run(BigInt(row.rowid), ...row.cells.map(cell => {
          if (cell[0] === "null") return null;
          if (cell[0] === "integer") return BigInt(cell[1]);
          assert.equal(cell[0], "text");
          return new TextDecoder("UTF-16be", { fatal: true, ignoreBOM: true }).decode(Buffer.from(cell[1], "hex"));
        }));
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    const boundary = pathToFileURL(path.join(project, "src/server/identity/internal/m2-audit-boundary.ts")).href;
    const probe = `import{AuditRequest}from ${JSON.stringify(boundary)};const requests=new Set(),units=AuditRequest.prototype.units;
      globalThis.__probe={requestCount:0};AuditRequest.prototype.units=function(n){requests.add(this);globalThis.__probe.requestCount=requests.size;return units.call(this,n)};`;
    const result = observe(directory, probe); assert.equal(result.status, 0, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout); assert.equal(output.probe.requestCount, 1);
    assert.equal(output.value.observation.phase, terminal ? "terminal-present" : "sealed-awaiting-b");
    assert.equal(output.value.observation.terminalClosure, "not_run"); assert.equal(output.value.sourceFileDescriptorQualification, "not_qualified");
    assert.deepEqual(output.value.observation.raw, input);
  }, "UTF-16be");
});
