import { M2_HISTORY_TABLES } from '../../src/server/identity/m2-history-contracts.ts';
import type { HistoryObservationInput, RawCell } from '../../src/server/identity/m2-history-contracts.ts';

const ref=()=>({ref:'typed/grammar-only',sha256:'a'.repeat(64),bytes:'1'});
/** Every fixed table and column is populated. This tests only the typed grammar,
 * not relational validity or a physical source/closure. */
export function typedObservationFixture(backend:'sqlite'|'postgres',phase:'p0'|'p1'|'p1-bootstrap'):HistoryObservationInput {
  return {contract:'m2-history-observation/r1',backend,phase,configFormat:1,
    source:{kind:backend,databaseInstanceId:'1'.repeat(32),identityDigest:'2'.repeat(64)},
    physicalSourceRef:{artifactId:'physical',digest:'3'.repeat(64)},snapshotReceiptRef:{artifactId:'receipt',digest:'4'.repeat(64)},
    catalog:ref(),textEncoding:{backend,name:backend==='sqlite'?'UTF-8':'UTF8'},
    tables:M2_HISTORY_TABLES.filter(t=>phase!=='p0'||t.columnsP0.length>0).map(t=>{
      const cols=phase==='p0'?t.columnsP0:t.columnsP1;
      const cells:RawCell[]=cols.map((c,i)=>{
        if(backend==='postgres')return ['pg-binary',c.postgresTypeOid,c.postgresTypeOid==='25'?'c3a9f0908080':c.postgresTypeOid==='23'?'00000001':'0000000000000001'];
        if(c.name===t.sqliteRowidAlias)return ['integer','1'];
        return i%5===0?['null']:i%5===1?['text','c3a9f0908080']:i%5===2?['blob','0001ff']:i%5===3?['real64be','8000000000000000']:['integer','-9223372036854775808'];
      });
      const rows=t.name==='config_authority'&&phase!=='p1'?[]:[{rowid:backend==='sqlite'?'1':null,cells}];
      return {name:t.name,columnContract:ref(),columnContractValueDigest:'5'.repeat(64),columns:cols.map(c=>c.name),count:String(rows.length),rows};
    }),sequences:backend==='sqlite'?[]:[{contract:'m2-pc-pg-sequence-observation/r1',name:'schema_migrations_version_seq',relationIdentity:ref(),lastValue:'9223372036854775807',isCalled:false}]};
}
export type TypedMutation=readonly [string,(value:any)=>void];
export const commonTypedMutations:readonly TypedMutation[]=[
  ['root extra key',v=>{v.extra=1;}],['contract',v=>{v.contract='different';}],['backend',v=>{v.backend='other';}],
  ['phase',v=>{v.phase='p2';}],['format integer',v=>{v.configFormat=1.5;}],['format registration',v=>{v.configFormat=2;}],
  ['source kind',v=>{v.source.kind='other';}],['source id',v=>{v.source.databaseInstanceId='A'.repeat(32);}],
  ['source hash',v=>{v.source.identityDigest='a'.repeat(63);}],['physical extra key',v=>{v.physicalSourceRef.other=0;}],
  ['receipt hash',v=>{v.snapshotReceiptRef.digest='x'.repeat(64);}],['artifact ref',v=>{v.catalog.ref='';}],
  ['artifact bytes',v=>{v.catalog.bytes='-1';}],['encoding kind',v=>{v.textEncoding.backend='other';}],['encoding name',v=>{v.textEncoding.name='';}],
  ['table omitted',v=>{v.tables.pop();}],['table repeated',v=>{v.tables[1]=structuredClone(v.tables[0]);}],
  ['table extra key',v=>{v.tables[0].extra=0;}],['column contract ref',v=>{v.tables[0].columnContract.bytes='01';}],
  ['column digest',v=>{v.tables[0].columnContractValueDigest='a';}],['column order',v=>{v.tables[0].columns.reverse();}],
  ['column missing',v=>{v.tables[0].columns.pop();}],['rows object',v=>{v.tables[0].rows={};}],
  ['count',v=>{v.tables[0].count='2';}],['row extra key',v=>{v.tables[0].rows[0].extra=0;}],
  ['row cells count',v=>{v.tables[0].rows[0].cells.pop();}],['cell not array',v=>{v.tables[0].rows[0].cells[0]={};}],
  ['null length',v=>{v.tables[0].rows[0].cells[0]=['null','extra'];}],['unknown tag',v=>{v.tables[0].rows[0].cells[0]=['unknown','00'];}],
];
export const sqliteTypedMutations:readonly TypedMutation[]=[
  ['rowid null',v=>{v.tables[0].rows[0].rowid=null;}],['rowid negative zero',v=>{v.tables[0].rows[0].rowid='-0';}],
  ['rowid leading zero',v=>{v.tables[0].rows[0].rowid='01';}],['rowid high overflow',v=>{v.tables[0].rows[0].rowid='9223372036854775808';}],
  ['rowid low overflow',v=>{v.tables[0].rows[0].rowid='-9223372036854775809';}],
  ['integer overflow',v=>{v.tables[0].rows[0].cells[0]=['integer','9223372036854775808'];}],
  ['integer long',v=>{v.tables[0].rows[0].cells[0]=['integer','1'.repeat(1000)];}],
  ['text odd',v=>{v.tables[0].rows[0].cells[0]=['text','a'];}],['blob uppercase',v=>{v.tables[0].rows[0].cells[0]=['blob','AF'];}],
  ['real short',v=>{v.tables[0].rows[0].cells[0]=['real64be','00000000'];}],
  ['rowid alias value',v=>{v.tables.find((t:any)=>t.name==='schema_migrations').rows[0].cells[0]=['integer','2'];}],
  ['rowid alias storage',v=>{v.tables.find((t:any)=>t.name==='schema_migrations').rows[0].cells[0]=['text','31'];}],
  ['SQLite sequence',v=>{v.sequences=[{}];}],
];
export const pgTypedMutations:readonly TypedMutation[]=[
  ['PG rowid',v=>{v.tables[0].rows[0].rowid='1';}],['PG storage',v=>{v.tables[0].rows[0].cells[0]=['text','00'];}],
  ['PG arity',v=>{v.tables[0].rows[0].cells[0]=['pg-binary','25','00','extra'];}],
  ['PG OID',v=>{v.tables[0].rows[0].cells[0]=['pg-binary','23','00000001'];}],
  ['PG hex',v=>{v.tables[0].rows[0].cells[0]=['pg-binary','25','FF'];}],
  ['PG int32 size',v=>{v.tables.find((t:any)=>t.name==='schema_migrations').rows[0].cells[0]=['pg-binary','23','0000000000000001'];}],
  ['PG timestamptz size',v=>{v.tables.find((t:any)=>t.name==='schema_migrations').rows[0].cells[3]=['pg-binary','1184','00000001'];}],
  ['PG sequence missing',v=>{v.sequences=[];}],['PG sequence extra',v=>{v.sequences.push(structuredClone(v.sequences[0]));}],
  ['PG sequence shape',v=>{v.sequences[0].extra=0;}],['PG sequence name',v=>{v.sequences[0].name='else';}],
  ['PG sequence contract',v=>{v.sequences[0].contract='else';}],['PG sequence ref',v=>{v.sequences[0].relationIdentity.ref='';}],
  ['PG sequence integer',v=>{v.sequences[0].lastValue='9223372036854775808';}],['PG sequence called',v=>{v.sequences[0].isCalled=1;}],
];
