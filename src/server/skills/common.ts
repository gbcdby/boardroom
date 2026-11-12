import { createHash } from "node:crypto";

/** 不依赖 locale、对象插入顺序或目录枚举顺序。数组由所属协议显式排序。 */
export function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => compare(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return sha256(canonical(value)); }
export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function uniqueSorted<T>(items: readonly T[]): T[] {
  return [...new Map(items.map(item => [canonical(item), item])).entries()].sort(([a], [b]) => compare(a, b)).map(([, value]) => value);
}
export function relativePath(value: string): boolean {
  return value.length > 0 && !value.includes("\\") && !value.includes("\0") && !value.includes(":")
    && !value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
