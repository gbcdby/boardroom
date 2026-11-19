import {createHash} from 'node:crypto';
import type {RawCell} from '../m2-history-contracts.ts';
import type {ReadonlyDeep} from '../m2-value-contracts.ts';
import type {DatabaseManifests,Json} from '../../storage/maintenance/types.ts';
import { readP0Int64,readP0Text } from './m2-p0.ts';
import type {P0Row,P0Table} from './m2-p0.ts';
import {F_COLUMNS,F_SQLITE_CATALOG_DIGEST,F_MIGRATIONS} from './m2-p0-artifacts-catalog.ts';
import type {FixedColumn} from './m2-p0-artifacts-catalog.ts';
import type {FState,FObject} from './m2-p0-artifacts-common.ts';

const sqliteMetadataKeys=Object.freeze(['cid','name','type','notnull','dflt_value','pk','hidden']);
const sqliteSchemaKeys=Object.freeze(['catalog','migrations']);
const pgSchemaKeys=Object.freeze(['profile','serverMajor','scope','typeProfile','namespace','relations','columns','constraints','indexes','functions','triggers','internalTriggers','defaultPrivileges','environment','requiredRoles','migrationIdentitySequence','migrations']);
const pgScopeKeys=Object.freeze(['kind','name','clusterRolesIncluded']);

const floor=(a:bigint,b:bigint)=>{const q=a/b;return a%b<0n?q-1n:q;};
/** Exact frozen MD02 PG16 UTC/ISO,YMD binary timestamp bridge, including BC/infinity. */
export function pgTimestampValue(f:FState,us:bigint):string{
  f.charge(50,200);
  if(us===9223372036854775807n)return 'infinity';if(us===-9223372036854775808n)return '-infinity';
  f.require(us>=-211813488000000000n&&us<9223371331200000000n,'semantic_unsupported');
  const days=floor(us,86400000000n);let clock=us-days*86400000000n,z=days+10957n+719468n;
  const era=floor(z,146097n),doe=z-era*146097n,yoe=(doe-doe/1460n+doe/36524n-doe/146096n)/365n;
  let y=yoe+era*400n;const doy=doe-(365n*yoe+yoe/4n-yoe/100n),mp=(5n*doy+2n)/153n,d=doy-(153n*mp+2n)/5n+1n,m=mp+(mp<10n?3n:-9n);y+=m<=2n?1n:0n;
  const h=clock/3600000000n;clock%=3600000000n;const minute=clock/60000000n;clock%=60000000n;const s=clock/1000000n,micro=clock%1000000n;
  const pad=(n:bigint,w=2)=>String(n).padStart(w,'0');let fraction=micro===0n?'':pad(micro,6);while(fraction.endsWith('0'))fraction=fraction.slice(0,-1);
  return `${pad(y>0n?y:1n-y,4)}-${pad(m)}-${pad(d)} ${pad(h)}:${pad(minute)}:${pad(s)}${fraction?'.'+fraction:''}+00${y<=0n?' BC':''}`;
}
function pgCell(f:FState,row:P0Row,column:string,cell:ReadonlyDeep<RawCell>,oid:string):Json{
  if(cell[0]==='null')return [`pg:${oid}`,null];f.require(cell[0]==='pg-binary'&&cell[1]===oid);
  if(oid==='25')return ['pg:25',readP0Text(f.request,row,column)];
  f.charge(2,cell[2]!.length+cell[2]!.length/2);const b=Buffer.from(cell[2]!, 'hex'),n=oid==='23'?BigInt(b.readInt32BE()):b.readBigInt64BE();
  return [`pg:${oid}`,oid==='1184'?pgTimestampValue(f,n):n.toString()];
}
function sqliteCell(f:FState,cell:ReadonlyDeep<RawCell>):Json{
  f.charge(1,cell[0]!.length*2);
  if(cell[0]==='real64be'){f.charge(1,cell[1]!.length*2,0,3);f.require((BigInt('0x'+cell[1])>>52n&0x7ffn)!==0x7ffn,'semantic_unsupported');return ['real-ieee754',cell[1]!];}
  // All other SQLite tags are already exactly the S4 representation. Retain the
  // authenticated immutable cell instead of allocating and recoding an equal tuple.
  f.require(cell[0]!=='pg-binary');return cell as unknown as Json;
}
/** Stable UTF16 order; compute each sort key once and pay before each comparison.
 * This replaces native name sorting and its quadratic conservative reservation. */
function sortedByText<T>(f:FState,input:readonly T[],key:(value:T)=>string):T[]{
  // One array shell, n slots and n key records. Reuse this array for the final
  // values; neither a merge target nor a result-map array is materialized.
  f.charge(input.length*2+1,0,input.length*2+1);
  const source=new Array<{value:T;key:string}>(input.length);
  for(let i=0;i<input.length;i++){f.charge(1);const value=input[i]!;source[i]={value,key:key(value)};}
  for(let i=1;i<source.length;i++){
    f.charge(1);const value=source[i]!;let at=i;
    while(at>0&&f.compareText(source[at-1]!.key,value.key)>0){f.charge(1);source[at]=source[at-1]!;at--;}
    f.charge(1);source[at]=value;
  }
  const result=source as unknown as T[];
  for(let i=0;i<source.length;i++){f.charge(1);result[i]=source[i]!.value;}
  return result;
}
export function sortedStrings(f:FState,input:readonly string[]):string[]{return sortedByText(f,input,s=>s);}
export function rowDigest(f:FState,rows:readonly Json[]):{count:string;digest:string}{
  // Compare the exact canonical token streams. No whole-row string or wrapper
  // projection is materialized merely to sort/hash the immutable typed rows.
  f.charge(rows.length*2,0,rows.length*2+2,2);let encoded=rows.map(row=>f.encode(row)),target=new Array<(typeof encoded)[number]>(encoded.length);
  for(let width=1;width<encoded.length;width*=2){for(let start=0;start<encoded.length;start+=width*2){const middle=Math.min(start+width,encoded.length),end=Math.min(start+width*2,encoded.length);let l=start,r=middle;
    for(let out=start;out<end;out++){f.charge(1);const left=r===end||l<middle&&f.compareEncodings(encoded[l]!,encoded[r]!)<=0;target[out]=left?encoded[l++]!:encoded[r++]!;}}
    const previous=encoded;encoded=target;target=previous;}
  const h=createHash('sha256');
  for(const row of encoded){f.charge(1,32);const prefix=`${row.bytes}:`;f.charge(2,row.bytes+prefix.length);h.update(prefix);f.hashEncoding(h,row);}f.charge(1,32,0,5);return {count:String(rows.length),digest:h.digest('hex')};
}
interface MdData { readonly dialect:'sqlite'|'postgres'; readonly schema:Json; readonly controls:DatabaseManifests['controlRows']; readonly result:DatabaseManifests }
const manifestData=new WeakMap<FState,WeakMap<object,MdData>>();
export function buildMdValue(f:FState,dialect:'sqlite'|'postgres',schema:Json,tables:DatabaseManifests['tables'],controlRows:DatabaseManifests['controlRows']):DatabaseManifests{
  const immutable=f.immutable.has(tables)&&f.immutable.has(controlRows)&&schema!==null&&typeof schema==='object'&&f.immutable.has(schema);
  let cache=manifestData.get(f);if(!cache){f.charge(1,0,2);cache=new WeakMap();manifestData.set(f,cache);}
  f.charge(1);const prior=immutable?cache.get(tables):undefined;
  if(prior&&prior.dialect===dialect&&prior.schema===schema&&prior.controls===controlRows)return prior.result;
  // Shallow JSON wrappers/ordered and filtered arrays are new; their immutable
  // schema/table/control subtrees are retained rather than cloned.
  f.charge(tables.length,0,tables.length+2,45); // the two filter shells; their total slots are at most tables.length
  const ordered=sortedByText(f,tables,t=>t.name),isControl=(t:{name:string})=>{f.charge(2,t.name.length*4);return t.name==='storage_maintenance'||t.name==='storage_source_clients';};
  f.freeze(ordered);
  const schemaManifestDigest=f.digest(schema);
  const result:DatabaseManifests={formatVersion:1,kind:'database-manifests',dialect,schema,schemaManifestDigest,tables:ordered,controlRows,
    fullDataManifestDigest:f.digest({dialect,schemaManifestDigest,tables:ordered}),
    frozenBusinessManifestDigest:f.digest({dialect,schemaManifestDigest,tables:ordered.filter(t=>!isControl(t))}),
    capturedControlManifestDigest:f.digest({dialect,tables:ordered.filter(isControl),controlRows})};
  f.freeze(result);if(immutable){f.charge(1,0,cache.has(tables)?1:2);cache.set(tables,{dialect,schema,controls:controlRows,result});}return result;
}
function controlObject(f:FState,row:P0Row):Record<string,Json>{
  const backend=f.request.input.graph.observation.backend,fixed=F_COLUMNS[row.tableOrdinal]![1];f.charge(fixed.length,0,fixed.length);
  f.charge(1,0,0,1+fixed.length*2);
  const result:Record<string,Json>={};
  for(let index=0;index<fixed.length;index++){const c=fixed[index]!,cell=row.raw.cells[index]!;let v:Json;
    if(cell[0]==='null')v=null;
    else if(backend==='sqlite'&&cell[0]==='integer')v=cell[1]!;
    else if(backend==='sqlite'){f.require(cell[0]==='text');v=readP0Text(f.request,row,c[0]);}
    else if(c[5]==='25')v=readP0Text(f.request,row,c[0]);
    else {const n=readP0Int64(f.request,row,c[0]);f.require(n!==null);v=c[5]==='23'?Number(n):String(n);}
    result[c[0]]=v;
  }
  return result;
}
interface OriginalTableData { readonly count:string; readonly digest:string; readonly controls:Record<string,Json>[]|null }
const originalTables=new WeakMap<FState,Map<number,OriginalTableData>>();
interface OriginalManifestData { readonly tables:DatabaseManifests['tables']; readonly controls:DatabaseManifests['controlRows'] }
const originalManifestData=new WeakMap<FState,OriginalManifestData>();
/** Byte projections of the one authenticated immutable original G. This cache has
 * no selected manifest/column input and stores no validity or pass result. Each
 * caller still compares the data with its complete S4 metadata/digest/context. */
function originalTableData(f:FState,ordinal:number):OriginalTableData{
  let tables=originalTables.get(f);if(!tables){f.charge(1,0,2);tables=new Map();originalTables.set(f,tables);}
  f.charge(1,0,1);const prior=tables.get(ordinal);if(prior)return prior;
  const o=f.request.input.graph.observation,raw=o.tables[ordinal]!,fixed=F_COLUMNS[ordinal]![1],handles=f.request.original.rows(raw.name as P0Table);
  // The outer row lists are newly allocated; reused SQLite cells keep their existing
  // JSON nodes. PG's new two-element cells each allocate three nodes.
  f.charge(handles.length,0,handles.length,1+handles.length+(o.backend==='postgres'?handles.length*fixed.length*3:0));
  const encoded=handles.map(r=>r.raw.cells.map((cell,j)=>o.backend==='sqlite'?sqliteCell(f,cell):pgCell(f,r,raw.columns[j]!,cell,fixed[j]![5])));
  f.freeze(encoded);const digest=rowDigest(f,encoded);let controls:Record<string,Json>[]|null=null;
  if(raw.name==='storage_maintenance'||raw.name==='storage_source_clients'){
    f.charge(handles.length,0,0,1);controls=handles.map(r=>controlObject(f,r));
    if(o.backend==='sqlite')controls.sort((a,b)=>{if(raw.name==='storage_maintenance'){f.charge(2,40);return BigInt(a.singleton as string)<BigInt(b.singleton as string)?-1:BigInt(a.singleton as string)>BigInt(b.singleton as string)?1:0;}
      const x=a.client_id as string,y=b.client_id as string;f.charge(3,(x.length+y.length)*8);return Buffer.compare(Buffer.from(x),Buffer.from(y));});
    else controls=sortedByText(f,controls,row=>f.canonical(row));
    f.freeze(controls);
  }
  f.charge(1,0,1,7);const result={...digest,controls};f.freeze(result);tables.set(ordinal,result);return result;
}
/** The two fields use the original PG collector's values, without making a qualified
 * collation name. The complete native descriptor, including namespace, must be the same G. */
export function checkPgColumnMetadata(f:FState,meta:FObject,owner:FObject,col:FObject,table:string,ordinal:number,oid:string):void{
  f.require(f.equal(meta,owner));
  f.require(meta.table_name===table&&meta.name===col.name&&meta.position===String(ordinal)&&meta.type_oid===oid&&meta.type_modifier===-1
    &&typeof meta.type==='string'&&meta.type===col.declaredType&&meta.not_null===!col.nullable&&meta.default_expression===col.defaultExpression
    &&meta.identity===(col.identity??'')&&meta.generated===(col.generated??'')&&meta.collation===col.collation);
  f.require(meta.collation===null?meta.collation_schema===null:typeof meta.collation==='string'&&typeof meta.collation_schema==='string');
}
function sqliteColumnMetadata(f:FState,meta:FObject,column:FixedColumn,ordinal:number):void{
  f.object(meta,sqliteMetadataKeys);f.charge(7,64);
  const same=(value:unknown,expected:string)=>typeof value==='string'&&f.sameText(value,expected);
  f.require(same(meta.cid,String(ordinal))&&same(meta.name,column[0])&&same(meta.type,column[1])
    &&same(meta.notnull,column[2]?'1':'0')&&same(meta.pk,String(column[3]))&&same(meta.hidden,'0')
    &&(column[4]===null?meta.dflt_value===null:same(meta.dflt_value,column[4])));
}
function requireSupportedOutputObservation(f:FState):void{
  // MD02 requires the original session's DateStyle/TimeZone, 64-bit pg_time_t,
  // and builtin send/out identities. The fixed old S4 owner only records
  // database/settings/extensions; pg_db_role_setting is not that session.
  // Its profile/typeProfile constants, or caller-added fields, cannot supply
  // these absent observations. Reject before any PG cell/output conversion;
  // the standalone integer formatting algorithm is not a proof of this bridge.
  if(f.request.input.graph.observation.backend==='postgres')f.require(false,'semantic_unsupported','format-mismatch');
}
export function compareP0Manifests(f:FState,md:DatabaseManifests,columns:readonly FObject[]):void{
  const o=f.request.input.graph.observation;f.require(md.dialect===o.backend);const schema=f.object(md.schema);
  requireSupportedOutputObservation(f);
  const migrations=f.request.original.rows('schema_migrations');f.require(migrations.length===21);
  f.charge(migrations.length,0,migrations.length+1,1);
  const ordered=[...migrations].sort((a,b)=>{const x=readP0Int64(f.request,a,'version')!,y=readP0Int64(f.request,b,'version')!;return x<y?-1:x>y?1:0;});
  f.charge(ordered.length,0,ordered.length,1+ordered.length*(1+4*2));
  const applied=ordered.map((r,i)=>{const v=readP0Int64(f.request,r,'version'),name=readP0Text(f.request,r,'name'),checksum=readP0Text(f.request,r,'checksum'),expected=F_MIGRATIONS[o.backend][i]!;f.require(v===BigInt(expected.version)&&name===expected.name&&checksum===expected.checksum);
    const cell=r.raw.cells[3]!,applied_at=o.backend==='sqlite'?readP0Text(f.request,r,'applied_at'):(pgCell(f,r,'applied_at',cell,'1184') as [string,string])[1];return {version:String(v),name,checksum,applied_at};});
  f.require(f.equal(schema.migrations,applied));
  if(o.backend==='sqlite'){f.object(schema,sqliteSchemaKeys);f.require(f.digest(schema.catalog)===F_SQLITE_CATALOG_DIGEST);}
  else {
    f.object(schema,pgSchemaKeys);
    const scope=f.object(schema.scope,pgScopeKeys),namespace=f.array(schema.namespace),environment=f.object(schema.environment),database=f.array(environment.database);
    f.require(schema.profile==='boardroom-pg16-closed-schema-v1'&&schema.serverMajor===16&&scope.kind==='schema'&&scope.clusterRolesIncluded===false&&namespace.length===1&&f.object(namespace[0]).name===scope.name&&database.length===1&&f.object(database[0]).encoding==='UTF8');
    const relations=f.array(schema.relations);f.require(relations.length===o.tables.length);
    for(const [i,relation] of relations.entries())f.require(f.object(relation).name===o.tables[i]!.name);
  }
  const allPgColumns=o.backend==='postgres'?f.array(schema.columns):[];let pgOrdinal=0;
  f.require(md.tables.length===o.tables.length+(o.backend==='postgres'?1:0));
  f.charge(md.tables.length);let tableKeyBytes=0;for(const table of md.tables)tableKeyBytes+=table.name.length*2;
  f.charge(md.tables.length,tableKeyBytes,md.tables.length+1);const tableMap=new Map<string,DatabaseManifests['tables'][number]>();
  for(const table of md.tables)tableMap.set(table.name,table);f.require(tableMap.size===md.tables.length);
  f.charge(3,0,o.tables.length+1,6); // projected table index shell and one slot per original table
  const prior=originalManifestData.get(f);
  const projected:DatabaseManifests['tables'][number][]=[];
  const controls:{storage_maintenance:Record<string,Json>[];storage_source_clients:Record<string,Json>[]}={storage_maintenance:[],storage_source_clients:[]};
  for(const [i,raw] of o.tables.entries()){
    f.charge(1,raw.name.length*2);const m=tableMap.get(raw.name);f.require(m);const fixed=F_COLUMNS[i]![1],pcColumns=f.array(columns[i]!.columns),nativeColumns=f.array(m.columns);f.require(nativeColumns.length===fixed.length);
    for(const [j,c] of nativeColumns.entries()){
      const meta=f.object(c),col=f.object(pcColumns[j]);
      if(o.backend==='sqlite')sqliteColumnMetadata(f,meta,fixed[j]!,j);
      else checkPgColumnMetadata(f,meta,f.object(allPgColumns[pgOrdinal++]),col,raw.name,j+1,fixed[j]![5]);
    }
    const data=originalTableData(f,i);f.require(f.sameText(m.count,data.count)&&f.sameText(m.digest,data.digest));
    const old=prior?.tables[i];
    if(old&&old.name===raw.name&&old.columns===m.columns&&old.count===data.count&&old.digest===data.digest)projected.push(old);
    else {f.charge(1,0,0,9);projected.push({name:raw.name,columns:m.columns,count:data.count,digest:data.digest});}
    if(raw.name==='storage_maintenance'||raw.name==='storage_source_clients'){
      f.require(data.controls!==null);controls[raw.name]=data.controls;f.require(f.equal(data.controls,md.controlRows[raw.name]));
    }
  }
  if(o.backend==='postgres'){
    f.require(pgOrdinal===allPgColumns.length);
    const s=o.sequences[0]!;const m=tableMap.get(s.name);f.require(m);const cols=[{name:'last_value',type_oid:'20'},{name:'is_called',type_oid:'16'}];f.require(f.equal(m.columns,cols));
    const digest=rowDigest(f,[[['pg:20',s.lastValue],['pg:16',s.isCalled?'true':'false']]]);f.require(m.count===digest.count&&m.digest===digest.digest);projected.push({name:s.name,columns:cols,...digest});
  }
  f.charge(projected.length);
  const same=prior&&prior.tables.length===projected.length&&projected.every((table,i)=>table===prior.tables[i])
    &&prior.controls.storage_maintenance===controls.storage_maintenance&&prior.controls.storage_source_clients===controls.storage_source_clients;
  let projection:OriginalManifestData;
  if(same)projection=prior;
  else {f.freeze(projected);f.freeze(controls);f.charge(1,0,originalManifestData.has(f)?1:2);projection={tables:projected,controls};originalManifestData.set(f,projection);}
  f.require(f.equal(buildMdValue(f,o.backend,md.schema,projection.tables,projection.controls),md));
}
