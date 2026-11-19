import { z } from "zod";
import type { ControlRootIdentity, MigrationPlan } from "../../storage/maintenance/types.ts";
import { F_COLUMNS, F_MIGRATIONS } from "./m2-p0-artifacts-catalog.ts";
import type { FState, FObject } from "./m2-p0-artifacts-common.ts";

const catalogKeys=Object.freeze(['contract','source','backend','phase','constraints','migrations','tables','sequences']);
const catalogTableKeys=Object.freeze(['name','columnContract','columnContractValueDigest']);
const columnContractKeys=Object.freeze(['contract','backend','stage','table','columns','rowid']);
const columnKeys=Object.freeze(['ordinal','name','declaredType','nullable','primaryKeyOrdinal','hidden','generated','identity','defaultExpression','collation']);
const sequenceKeys=Object.freeze(['name','relationIdentity']);

const decimal=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
const path=z.string().min(1).max(4096).regex(/^\/[^\u0000]*$/);
const source=z.object({kind:z.enum(['sqlite','postgres']),databaseInstanceId:z.string().regex(/^[a-f0-9]{32}$/),identityDigest:hash}).strict();
const ref=z.object({ref:z.string().min(1).max(4096),sha256:hash,bytes:decimal}).strict();
const root=z.object({path,device:decimal,inode:decimal,hostIdentityDigest:hash}).strict();
const sqlite=z.object({kind:z.literal('sqlite'),sourcePath:path,sqlitePath:path,device:decimal,inode:decimal}).strict();
const pg=z.object({formatVersion:z.literal(1),kind:z.literal('postgres'),systemIdentifier:decimal,databaseOid:decimal,databaseName:z.string().max(1048576),schemaOid:decimal,schemaName:z.string().max(1048576),serverAddress:z.string().max(1048576).nullable(),serverPort:z.number().int().min(1).max(65535).nullable(),descriptorDigest:hash,databaseInstanceId:z.string().regex(/^[a-f0-9]{32}$/)}).strict();
const physical=z.object({formatVersion:z.literal(1),kind:z.literal('m2-physical-source'),payload:z.object({contract:z.literal('m2-physical-source-observation/r1'),source,sourceIdentity:z.discriminatedUnion('kind',[sqlite,pg]),observedAt:z.string().max(64).datetime({offset:true}),controlRoot:root,sourcePlan:ref}).strict()}).strict();
const uint64Max=18446744073709551615n,uint32Max=4294967295n;
/** Called only after the strict physical schema has proved canonical decimal
 * spelling and at most 20 digits. No physical identifier passes through Number. */
function physicalInteger(f:FState,text:string,minimum:bigint,maximum:bigint):void{
  // Prepay the bounded digit read and integer comparisons on every pass.
  f.charge(4,text.length*2);
  const value=BigInt(text);f.require(value>=minimum&&value<=maximum);
}
export function physicalP0(f:FState):{plan:MigrationPlan;root:ControlRootIdentity}{
  const o=f.request.input.graph.observation,entry=f.bridge(o.physicalSourceRef,'m2-physical-source'),value=f.json(entry),size=f.size(value);
  f.charge(size.nodes*5,size.text*2,0,size.nodes);
  const result=physical.safeParse(value);f.require(result.success);const p=result.data.payload;
  physicalInteger(f,p.controlRoot.device,0n,uint64Max);
  physicalInteger(f,p.controlRoot.inode,1n,uint64Max);
  if(p.sourceIdentity.kind==='sqlite'){
    physicalInteger(f,p.sourceIdentity.device,0n,uint64Max);
    physicalInteger(f,p.sourceIdentity.inode,1n,uint64Max);
  }else{
    physicalInteger(f,p.sourceIdentity.systemIdentifier,1n,uint64Max);
    physicalInteger(f,p.sourceIdentity.databaseOid,1n,uint32Max);
    physicalInteger(f,p.sourceIdentity.schemaOid,1n,uint32Max);
  }
  f.require(f.equal(p.source,o.source)&&p.sourceIdentity.kind===o.backend,'artifact_semantic_mismatch','source-mismatch');
  if(p.sourceIdentity.kind==='postgres')f.require(p.sourceIdentity.databaseInstanceId===o.source.databaseInstanceId);
  // Source path/physical SQLite path are independent original fields; never normalize or equate them.
  // sourceIdentity is the strict clone of the already R3-admitted PC value.
  f.require(f.digest(p.sourceIdentity)===o.source.identityDigest);
  const plan=f.decode(p.sourcePlan,'plan');
  f.require(f.equal(plan.source,o.source)&&f.equal(plan.sourceIdentity,p.sourceIdentity)&&plan.controlRoot.path===p.controlRoot.path);
  f.charge(3,0,1,3);return {plan,root:p.controlRoot};
}
export function catalogP0(f:FState):readonly FObject[]{
  const o=f.request.input.graph.observation,entry=f.select(o.catalog,'pc-catalog'),v=f.object(f.json(entry),catalogKeys);
  f.require(v.contract==='m2-pc-catalog/r1'&&v.backend===o.backend&&v.phase==='p0'&&v.constraints==='boardroom-p0-1-21-p1-22/r1'&&f.equal(v.source,o.source));
  f.require(f.equal(v.migrations,F_MIGRATIONS[o.backend]));
  const tables=f.array(v.tables);f.require(tables.length===o.tables.length);
  f.charge(1,0,1,1);const columnValues:FObject[]=[];
  for(const [i,raw] of o.tables.entries()){
    const t=f.object(tables[i],catalogTableKeys);
    f.require(t.name===raw.name&&t.columnContractValueDigest===raw.columnContractValueDigest&&f.refEqual(f.reference(t.columnContract),raw.columnContract));
    const selected=f.select(raw.columnContract,'pc-column-contract'),column=f.object(f.json(selected),columnContractKeys);
    f.require(column.contract==='m2-pc-column-contract/r1'&&column.backend===o.backend&&column.stage==='schema1-21'&&column.table===raw.name&&column.rowid===(o.backend==='sqlite'?'signed-int64':'none'));
    // json(selected) admitted the whole immutable PC value to the R3 domain.
    f.require(f.digest(column)===raw.columnContractValueDigest);
    const fixed=F_COLUMNS[i]!,cols=f.array(column.columns);f.require(fixed[0]===raw.name&&cols.length===fixed[1].length);
    for(const [j,item] of cols.entries()){
      const c=f.object(item,columnKeys),expected=fixed[1][j]!;
      f.require(c.ordinal===j+1&&c.name===expected[0]&&c.primaryKeyOrdinal===expected[3]&&c.hidden===0);
      if(o.backend==='sqlite')f.require(c.declaredType===expected[1]&&c.nullable===!expected[2]&&c.defaultExpression===expected[4]&&c.generated===null&&c.identity===null&&c.collation===null);
      else f.require(c.nullable===!expected[6]&&c.defaultExpression===expected[9]&&c.generated===(expected[8]||null)&&c.identity===(expected[7]||null));
    }
    f.charge(1,0,1);columnValues.push(column);
  }
  const sequences=f.array(v.sequences);f.require(sequences.length===o.sequences.length);
  for(const [i,s] of o.sequences.entries()){
    const selected=f.object(sequences[i],sequenceKeys);f.require(selected.name===s.name&&f.refEqual(f.reference(selected.relationIdentity),s.relationIdentity));
  }
  return columnValues;
}
