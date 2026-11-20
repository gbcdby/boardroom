// Closed, compiled owner grammar. No caller schema, extension, callback or registry.
import definitions from "./m2-durable-definitions.json" with { type: "json" };
import { wellFormedP0 } from "./m2-p0-lexical.ts";
import { assertP0FState } from "./m2-p0-artifacts-common.ts";
import type { FState } from "./m2-p0-artifacts-common.ts";
import { p0State } from './m2-p0-budget.ts';
import { m2OwnedUnicode } from './m2-owned-json.ts';
import type { M2Definitions } from "./m2-durable-types.ts";

type Schema = { readonly $ref?: string; readonly type?: string; readonly const?: unknown;
  readonly enum?: readonly unknown[]; readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[]; readonly additionalProperties?: boolean;
  readonly anyOf?: readonly Schema[]; readonly oneOf?: readonly Schema[];
  readonly items?: Schema | boolean; readonly prefixItems?: readonly Schema[];
  readonly minItems?: number; readonly maxItems?: number; readonly minLength?: number; readonly maxLength?: number;
  readonly minimum?: number; readonly maximum?: number; readonly exclusiveMinimum?: number;
  readonly pattern?: string; readonly format?: string; readonly boardroomStringDomain?: string };
const fixed = definitions as unknown as Readonly<Record<string, Schema>>;
const patterns = new Map<string, RegExp>();
const enums = new WeakMap<Schema, ReadonlySet<unknown>>();
const tupleChoices = new WeakMap<Schema, ReadonlyMap<string, Schema>>();
function collect(schema: Schema): void {
  if (schema.pattern) patterns.set(schema.pattern, new RegExp(schema.pattern, "u"));
  if (schema.enum) enums.set(schema, new Set(schema.enum));
  if (schema.oneOf) {
    const choices=new Map<string,Schema>();let disjoint=true;
    for(const branch of schema.oneOf){const tag=branch.prefixItems?.[0]?.const;
      if(branch.type!=='array'||(branch.minItems??0)<1||typeof tag!=='string'||choices.has(tag)){disjoint=false;break;}
      choices.set(tag,branch);
    }
    // This static proof applies only to the fixed disjoint first-tag tuples.
    // Other oneOfs retain the exhaustive exactly-one rule below.
    if(disjoint)tupleChoices.set(schema,choices);
  }
  for (const value of Object.values(schema.properties ?? {})) collect(value);
  for (const value of [...schema.anyOf ?? [], ...schema.oneOf ?? [], ...schema.prefixItems ?? []]) collect(value);
  if (schema.items && typeof schema.items === "object") collect(schema.items);
}
for (const schema of Object.values(fixed)) collect(schema);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function dateTime(value:string):boolean {
  const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-](\d\d):(\d\d))$/.exec(value);
  if(!m)return false;const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  return month>=1&&month<=12&&day>=1&&day<=days[month-1]!&&Number(m[4])<24&&Number(m[5])<60&&Number(m[6])<60
    &&(m[7]===undefined||Number(m[7])<24&&Number(m[8])<60);
}
function matches(f: FState, schema: Schema, value: unknown, depth: number, ownedUnicode: boolean): boolean {
  f.charge(1); f.require(depth <= 64, "resource_limit");
  if (schema.$ref !== undefined) {
    const name=schema.$ref.slice(8);
    if(!matches(f,fixed[name]!,value,depth,ownedUnicode))return false;
    if(name==='Int64'||name==='SP_Int64'){
      const n=BigInt(value as string);return n>=-9223372036854775808n&&n<=9223372036854775807n;
    }
    return true;
  }
  if (Object.hasOwn(schema, "const")) {
    if (typeof value === "string") f.charge(1, value.length * 2);
    if (value !== schema.const) return false;
  }
  if (schema.enum) {
    // Compile the closed contract's literal set once. Each call still hashes
    // and checks the actual value; no per-input schema decision is retained.
    f.charge(1, typeof value === "string" ? value.length * 2 : 0);
    if (!enums.get(schema)!.has(value)) return false;
  }
  if (schema.oneOf) {
    const choices=tupleChoices.get(schema);
    if(choices){
      if(!Array.isArray(value)||typeof value[0]!=='string')return false;
      f.charge(1,value[0].length*2);const branch=choices.get(value[0]);
      if(branch===undefined||!matches(f,branch,value,depth,ownedUnicode))return false;
    }else{
      let count = 0;
      for (const branch of schema.oneOf) if (matches(f, branch, value, depth,ownedUnicode) && ++count > 1) return false;
      if (count !== 1) return false;
    }
  }
  if (schema.anyOf) {
    let found = false;
    for (const branch of schema.anyOf) if (matches(f, branch, value, depth,ownedUnicode)) { found = true; break; }
    if (!found) return false;
  }
  if (schema.type === "null") return value === null;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) return false;
    return (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum)
      && (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum);
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    // The actual strict canonical owner already scanned every decoded UTF-16
    // unit. Reuse only that syntax fact; lengths, patterns, formats and every
    // enclosing schema relation are still evaluated for this occurrence.
    const textPasses=ownedUnicode?Number(Boolean(schema.boardroomStringDomain||schema.pattern))+Number(Boolean(schema.format)):2;
    f.charge(2, value.length * 2 * textPasses);
    if(!ownedUnicode&&!wellFormedP0(value))return false;
    if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if(schema.boardroomStringDomain){
      if(value.includes('\0'))return false;
    }else if (schema.pattern && !patterns.get(schema.pattern)!.test(value)) return false;
    if (schema.format === "uuid" && !uuid.test(value)) return false;
    if (schema.format === "date-time" && !dateTime(value)) return false;
    return true;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    for (let i = 0; i < value.length; i++) {
      const child = schema.prefixItems?.[i] ?? schema.items;
      if (child === false || child !== true && child !== undefined && !matches(f, child, value[i], depth + 1,ownedUnicode)) return false;
    }
    return true;
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>, fields = schema.properties ?? {};
    f.charge(schema.required?.length ?? 0);
    for (const key of schema.required ?? []) if (!Object.hasOwn(item, key)) return false;
    for (const key in item) {
      f.charge(1, key.length * 2);
      if (!Object.hasOwn(fields, key)) { if (schema.additionalProperties === false) return false; }
      else if (!matches(f, fields[key]!, item[key], depth + 1,ownedUnicode)) return false;
    }
  }
  return true;
}
export function m2Definition<K extends keyof M2Definitions>(f: FState, name: K, value: unknown): M2Definitions[K] {
  assertP0FState(f);
  const ownedUnicode=m2OwnedUnicode(p0State(f.request),value);
  f.require(Object.hasOwn(fixed, name) && matches(f, fixed[name]!, value, 0,ownedUnicode), "artifact_semantic_mismatch", "format-mismatch");
  // Safe-counter and canonical decimal grammars are followed by exact range refinement.
  if (name === "Int64" || name === "SP_Int64") {
    const n = BigInt(value as string); f.require(n >= -9223372036854775808n && n <= 9223372036854775807n);
  }
  return value as M2Definitions[K];
}
