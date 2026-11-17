import { sourceClientColumns } from "./source-clients-read.ts";
import type { Json, SourceClientRawRow } from "./types.ts";

const maximum = "9223372036854775807";
function integer(value: Json | undefined): string | null {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? String(value) : null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)
    || value.length > maximum.length || value.length === maximum.length && value > maximum) return null;
  return value;
}

/** Only the four native integer columns admit exact number/decimal equivalence.
 * Text stays exact, nullable columns alone admit null, and no coercion rounds data. */
export function sameSourceClientCell(column: keyof SourceClientRawRow, left: Json | undefined, right: Json | undefined): boolean {
  const profile = sourceClientColumns.find(item => item.name === column);
  if (!profile) return false;
  if (left === null || right === null) return profile.nullable && left === null && right === null;
  if (profile.postgres === "25") return typeof left === "string" && typeof right === "string" && left === right;
  const a = integer(left), b = integer(right);
  return a !== null && a === b && (column !== "protocol_version" || a === "1");
}

function dataRow(row: Readonly<Record<string, Json>>): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(row))
    || Reflect.ownKeys(row).length !== sourceClientColumns.length) return false;
  return sourceClientColumns.every(({ name }) => {
    const descriptor = Object.getOwnPropertyDescriptor(row, name);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

/** Both inputs must have exactly the fixed 16-column native profile. */
export function sameSourceClientRow(left: Readonly<Record<string, Json>>, right: Readonly<Record<string, Json>>): boolean {
  return dataRow(left) && dataRow(right)
    && sourceClientColumns.every(({ name }) => sameSourceClientCell(name, left[name], right[name]));
}
