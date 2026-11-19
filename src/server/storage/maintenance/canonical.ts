import { createHash } from "node:crypto";
import { MaintenanceFailure } from "./error.ts";
import { reserveP0FNativeCanonical, reserveP0FNativeText, reuseP0FNativeCanonical,reuseP0FNativeDigest,checkP0FNativePrototype,sortP0FNativeKeys } from '../../identity/internal/m2-p0-artifacts-frame.ts';

/** Version 1 canonical JSON: lexical UTF-16 keys, ordered arrays, no omitted/rounded fields. */
export function canonicalJson(value: unknown): string {
  const reused = reuseP0FNativeCanonical(value); if (reused !== undefined) return reused;
  reserveP0FNativeCanonical(value);
  const seen = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 128) throw new MaintenanceFailure("journal_invalid");
    const reused = reuseP0FNativeCanonical(item); if (reused !== undefined) return reused;
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
      const nativePrototype=checkP0FNativePrototype(item);
      if (nativePrototype===undefined?![Object.prototype, null].includes(Object.getPrototypeOf(item)):!nativePrototype) throw new MaintenanceFailure("journal_invalid");
      const keys = Object.keys(item);if(!sortP0FNativeKeys(keys))keys.sort();
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
export function sha256(bytes: string | Uint8Array): string {
  if (typeof bytes === 'string') reserveP0FNativeText(bytes, true);
  return createHash("sha256").update(bytes).digest("hex");
}
export function digestJson(value: unknown): string { const reused=reuseP0FNativeDigest(value);return reused===undefined?sha256(canonicalJson(value)):reused; }
export function parseCanonical(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new Error("noncanonical");
    return value;
  } catch { throw new MaintenanceFailure("journal_invalid"); }
}
