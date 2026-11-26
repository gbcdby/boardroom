import Database from 'better-sqlite3';
import {runMigrations,checksumOf} from '../../src/server/db/migrate.ts';
import {migrations} from '../../src/server/db/migrations/index.ts';
import {assertSqliteGuardCoverage} from '../../src/server/storage/schema-guards.ts';
import {MaintenanceFailure} from '../../src/server/storage/maintenance/error.ts';
import {buildDatabaseManifests,digestRowMultiset} from '../../src/server/storage/maintenance/manifests.ts';
import {quoteSqliteIdentifier} from '../../src/server/storage/maintenance/sqlite-manifests.ts';
import {canonicalJson,digestJson,sha256} from '../../src/server/storage/maintenance/canonical.ts';
import type {DatabaseManifests,Json} from '../../src/server/storage/maintenance/types.ts';
import {controlVector,historicalClient} from '../fixtures/maintenance-control-candidate.ts';
import {sourceClientColumns} from '../../src/server/storage/maintenance/source-clients-read.ts';
import type {ArtifactRef, ObjectKind,SourceClientRawRow} from '../../src/server/storage/maintenance/types.ts';
import type {HistoryObservationInput,RawCell} from '../../src/server/identity/m2-history-contracts.ts';

/** P0 旧源夹具必须停在 v21：v22 属于迁移后的配置权威，不进入旧库观察。 */
const legacyMigrations = migrations.filter(m => m.version <= 21);

function legacyJsonCell(value: unknown): Json {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (Buffer.isBuffer(value)) return {type:'blob',hex:value.toString('hex')};
  throw new MaintenanceFailure('snapshot_invalid');
}
function legacyObjectRows(db: Database.Database, sql: string): Readonly<Record<string, Json>>[] {
  return (db.prepare(sql).safeIntegers(true).all() as Record<string, unknown>[]).map(row =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, legacyJsonCell(value)])));
}
/** Same reader as production, but validates the frozen v1–v21 source catalog instead of the global list. */
export function readLegacySqliteManifests(db: Database.Database): DatabaseManifests {
  try { assertSqliteGuardCoverage(db); }
  catch { throw new MaintenanceFailure('schema_guard_incomplete'); }
  const applied = legacyObjectRows(db, 'SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version');
  if (applied.length !== legacyMigrations.length || applied.some((row, i) => String(row.version) !== String(legacyMigrations[i]!.version)
    || row.name !== legacyMigrations[i]!.name || row.checksum !== checksumOf(legacyMigrations[i]!.up)))
    throw new MaintenanceFailure('schema_guard_incomplete');
  const catalog = legacyObjectRows(db, 'SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name');
  const names = catalog.filter(row => row.type === 'table').map(row => String(row.name)).sort();
  const tables: DatabaseManifests['tables'][number][] = [];
  for (const name of names) {
    const columns = legacyObjectRows(db, `PRAGMA main.table_xinfo(${quoteSqliteIdentifier(name)})`);
    if (!columns.length) throw new MaintenanceFailure('schema_guard_incomplete');
    const expressions = columns.flatMap(column => {
      const quoted = quoteSqliteIdentifier(String(column.name));
      return [`typeof(${quoted})`, `CASE WHEN typeof(${quoted}) IN ('text','blob') THEN hex(${quoted}) ELSE ${quoted} END`];
    });
    const records = db.prepare(`SELECT ${expressions.join(',')} FROM main.${quoteSqliteIdentifier(name)}`).raw(true).safeIntegers(true).all() as unknown[][];
    const rows: Json[] = records.map(record => columns.map((_, i): Json => {
      const type = record[i * 2], value = record[i * 2 + 1];
      if (type === 'null' && value === null) return ['null'];
      if (type === 'integer' && typeof value === 'bigint') return ['integer', value.toString()];
      if (type === 'real' && typeof value === 'number' && Number.isFinite(value)) {
        const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return ['real-ieee754', bytes.toString('hex')];
      }
      if ((type === 'text' || type === 'blob') && typeof value === 'string') return [type, value.toLowerCase()];
      throw new MaintenanceFailure('snapshot_invalid');
    }));
    tables.push({name, columns, ...digestRowMultiset(rows)});
  }
  return buildDatabaseManifests('sqlite', {catalog, migrations: applied}, tables, {
    storage_maintenance: legacyObjectRows(db, 'SELECT * FROM storage_maintenance ORDER BY singleton'),
    storage_source_clients: legacyObjectRows(db, 'SELECT * FROM storage_source_clients ORDER BY client_id'),
  });
}

/** Full original 61-table native SQLite observation, independent S4 reader/digests.
 * S4 platform/backup facts are explicit value fixtures, never qualification evidence. */
export function p0ArtifactFixture(options:{sourceClient?:boolean;journalVersion?:2|3;client?:(vector:ReturnType<typeof controlVector>)=>{row:SourceClientRawRow;fact:unknown;runtime?:unknown};change?:(kind:string,value:any)=>void;bytes?:(kind:string,bytes:Buffer)=>Buffer}={}){
  const db=new Database(':memory:');
  try{
    runMigrations(db,legacyMigrations);const initial=readLegacySqliteManifests(db);
    const f=controlVector({initialVersion:options.journalVersion??3,mechanism:{sourceIdentity:{kind:'sqlite',sourcePath:'/a12/source-alias.sqlite',sqlitePath:'/a12/source.sqlite',device:'1',inode:'2'},databaseInstanceId:'1'.repeat(32),root:{path:'/a12/control',device:'1',inode:'3',hostIdentityDigest:'b'.repeat(64)},mutex:{kind:'fixture-only-mutex'},schemaManifestDigest:initial.schemaManifestDigest,guardManifestDigest:String(initial.controlRows.storage_maintenance[0]!.guard_manifest_digest)}});
    f.captured.frozen.frozenBusinessManifestDigest=initial.frozenBusinessManifestDigest;
    const sourceClientValues:(string|bigint|null)[]=[];
    if(options.sourceClient||options.client){
      const client=options.client?.(f)??historicalClient(f);
      Object.assign(f.roster,{rows:[client.row]});
      Object.assign(f.facts,{beforeCount:'1',beforeRowsDigest:f.rowsDigest([client.row]),clients:[client.fact]});
      if('runtime' in client)Object.assign(f.facts,{runtime:client.runtime});
      f.captured.frozen.sourceClientsDigest=digestJson(f.roster);
      sourceClientValues.push(...sourceClientColumns.map(({name})=>{const cell=client.row[name];return cell[0]==='null'?null:cell[0]==='integer'?BigInt(cell[1]):Buffer.from(cell[1],'hex').toString('utf8');}));
    }
    if(options.journalVersion===2){f.captured.formatVersion=2;delete (f.captured as {controlProof?:unknown}).controlProof;}
    const captureRef=f.pack('journal',f.captured);
    db.prepare(`UPDATE storage_maintenance SET database_instance_id=?,control_root_json=?,mutex_identity_json=?,fence_epoch=2,owner_generation=7,admission='sealed',active_migration_id='a12',plan_digest=?,journal_record_ref=?,journal_digest=?,journal_sequence=2`).run(f.source.databaseInstanceId,canonicalJson(f.root),canonicalJson(f.mutex),f.planRef.sha256,captureRef.ref,captureRef.sha256);
    if(sourceClientValues.length)db.prepare(`INSERT INTO storage_source_clients (${sourceClientColumns.map(c=>c.name).join(',')}) VALUES (${sourceClientValues.map(()=>'?').join(',')})`).run(...sourceClientValues);
    const manifests=readLegacySqliteManifests(db);
    const artifacts:{kind:string;artifact:ArtifactRef;bytesHex:string}[]=f.objects.map(item=>({kind:item.reference.ref.startsWith('plans/')?'plan':item.reference.ref.startsWith('journals/')?'journal':'source-files',artifact:item.reference,bytesHex:item.bytes.toString('hex')}));
    const pack=(kind:string,value:any):ArtifactRef=>{
      options.change?.(kind,value);let bytes=kind==='database-snapshot'||kind==='source-file-payload'?Buffer.from(value):Buffer.from(canonicalJson(value));bytes=options.bytes?.(kind,bytes)??bytes;
      const digest=sha256(bytes),pc=kind.startsWith('pc-')||kind==='m2-physical-source';
      const artifact={ref:pc?`m2/sha256/${digest}/${kind}.json`:`snapshots/${digest}/${kind}.${kind==='database-snapshot'||kind==='source-file-payload'?'bin':'json'}`,sha256:digest,bytes:String(bytes.length)};
      artifacts.push({kind,artifact,bytesHex:bytes.toString('hex')});return artifact;
    };
    const source=f.source,capture={migrationId:'a12',source,planDigest:f.planRef.sha256,fenceEpoch:2,journal:captureRef,journalSequence:2,ownerGeneration:7};
    const md=pack('database-manifests',manifests),database=pack('database-snapshot',Buffer.from('opaque value fixture; SQL equality is separately derived'));
    const capability=pack('capability',{formatVersion:1,kind:'capability',node:'fixture',rootIdentity:f.root,powerLossTested:false,probeDigest:'a'.repeat(64),platform:'linux',filesystemType:'61267',guarantee:'observed-file-fsync-rename-directory-fsync'});
    const partial={capture,sourceFilesManifest:f.filesRef,database,manifests:md,schemaManifestDigest:manifests.schemaManifestDigest,frozenBusinessManifestDigest:manifests.frozenBusinessManifestDigest},restorePointDigest=digestJson(partial);
    const entries=[{role:'plan',object:f.planRef},{role:'journal-prefix',object:f.enterRef},{role:'capture-journal',object:captureRef},{role:'source-files-manifest',object:f.filesRef},{role:'database-snapshot',object:database},{role:'database-expected-manifests',object:md},{role:'capability-evidence',object:capability}];
    const bundle=pack('restore-bundle',{formatVersion:1,kind:'restore-bundle',capture,sourceFilesManifest:f.filesRef,restorePointDigest,entries});
    const publication=pack('publication',{formatVersion:1,kind:'publication',bundle,capability,observedOperations:[...entries.map(e=>e.object),bundle].map(artifact=>({artifact,completed:['file_sync','rename','directory_sync']}))});
    const verification=pack('verification',{formatVersion:1,kind:'verification',bundle,publication,verificationTargetIdentity:{kind:'value-only',fraction:1.25,'\u{10000}':'astral','\ue000':'bmp'},exactFullDataAndControlMatched:true,sourceFilePayloadsMatched:true,schemaAndScopeMatched:true});
    const receipt=pack('receipt',{formatVersion:1,kind:'receipt',snapshotId:'value-only',...partial,restorePointDigest,bundle,publication,verification,capability,fullDataManifestDigest:manifests.fullDataManifestDigest,capturedControlManifestDigest:manifests.capturedControlManifestDigest});
    const tables:HistoryObservationInput['tables']=manifests.tables.map(table=>{
      const columns=table.columns as {cid:string;name:string;type:string;notnull:string;dflt_value:string|null;pk:string;hidden:string}[];
      const body={contract:'m2-pc-column-contract/r1',backend:'sqlite',stage:'schema1-21',table:table.name,columns:columns.map(c=>({ordinal:Number(c.cid)+1,name:c.name,declaredType:c.type,nullable:c.notnull==='0',primaryKeyOrdinal:Number(c.pk),hidden:Number(c.hidden),generated:null,identity:null,defaultExpression:c.dflt_value,collation:null})),rowid:'signed-int64'};
      const columnContract=pack('pc-column-contract',body),names=columns.map(c=>c.name),quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
      const records=db.prepare(`SELECT rowid,${names.flatMap(n=>[`typeof(${quote(n)})`,`CASE WHEN typeof(${quote(n)}) IN ('text','blob') THEN hex(${quote(n)}) ELSE ${quote(n)} END`]).join(',')} FROM ${quote(table.name)}`).raw(true).safeIntegers(true).all() as unknown[][];
      const rows=records.map(record=>({rowid:String(record[0]),cells:names.map((_,i):RawCell=>{const kind=record[i*2+1],v=record[i*2+2];if(kind==='null')return ['null'];if(kind==='integer')return ['integer',String(v)];if(kind==='text'||kind==='blob')return [kind,String(v).toLowerCase()];if(kind==='real'){const bytes=Buffer.alloc(8);bytes.writeDoubleBE(v as number);return ['real64be',bytes.toString('hex')];}throw Error('fixture raw class');})}));
      return {name:table.name,columnContract,columnContractValueDigest:columnContract.sha256,columns:names,count:String(rows.length),rows};
    });
    const applied=(manifests.schema as {migrations:{version:string;name:string;checksum:string}[]}).migrations;
    const catalog=pack('pc-catalog',{contract:'m2-pc-catalog/r1',source,backend:'sqlite',phase:'p0',constraints:'boardroom-p0-1-21-p1-22/r1',migrations:applied.map(m=>({version:Number(m.version),name:m.name,checksum:m.checksum})),tables:tables.map(t=>({name:t.name,columnContract:t.columnContract,columnContractValueDigest:t.columnContractValueDigest})),sequences:[]});
    const physicalPayload={contract:'m2-physical-source-observation/r1',source,sourceIdentity:f.sourceIdentity,observedAt:'2026-11-19T00:00:00.000Z',controlRoot:f.root,sourcePlan:f.planRef};
    const physical=pack('m2-physical-source',{formatVersion:1,kind:'m2-physical-source',payload:physicalPayload});
    const physicalSourceRef={artifactId:'independent-physical-id',digest:digestJson(physicalPayload)},snapshotReceiptRef={artifactId:'independent-snapshot-id',digest:receipt.sha256};
    const observation:HistoryObservationInput={contract:'m2-history-observation/r1',backend:'sqlite',phase:'p0',configFormat:1,source,physicalSourceRef,snapshotReceiptRef,catalog,textEncoding:{backend:'sqlite',name:'UTF-8'},tables,sequences:[]};
    return {contract:'m2-history-closure-input/r2',graph:{kind:'m2-observation',observation,origin:null},artifacts,evidence:[{kind:'m2-physical-source',artifact:physical,evidence:physicalSourceRef},{kind:'receipt',artifact:receipt,evidence:snapshotReceiptRef}],proposedDeletion:null};
  }finally{db.close();}
}
