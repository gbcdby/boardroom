import { createHash } from "node:crypto";
import { MaintenanceFailure } from "./error.ts";

/** Version 1 canonical JSON: lexical UTF-16 keys, ordered arrays, no omitted/rounded fields. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 128) throw new MaintenanceFailure("journal_invalid");
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Object.is(item, -0) || Number.isInteger(item) && !Number.isSafeInteger(item))
        throw new MaintenanceFailure("journal_invalid");
      return JSON.stringify(item);
    }
    if (typeof item !== "object" || seen.has(item)) throw new MaintenanceFailure("journal_invalid");
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) throw new MaintenanceFailure("journal_invalid");
        return `[${item.map(entry => encode(entry, depth + 1)).join(",")}]`;
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new MaintenanceFailure("journal_invalid");
      const keys = Object.keys(item).sort();
      if (Reflect.ownKeys(item).length !== keys.length) throw new MaintenanceFailure("journal_invalid");
      return `{${keys.map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor)) throw new MaintenanceFailure("journal_invalid");
        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
      }).join(",")}}`;
    } finally { seen.delete(item); }
  }
  return encode(value, 0);
}
export function sha256(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function digestJson(value: unknown): string { return sha256(canonicalJson(value)); }
export function parseCanonical(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new Error("noncanonical");
    return value;
  } catch { throw new MaintenanceFailure("journal_invalid"); }
}
