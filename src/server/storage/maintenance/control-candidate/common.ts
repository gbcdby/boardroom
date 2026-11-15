import { canonicalJson } from "../canonical.ts";
import { MaintenanceFailure } from "../error.ts";

export function requireCandidate(condition: unknown): asserts condition {
  if (!condition) throw new MaintenanceFailure("journal_invalid", "control-successor");
}
export const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export const compareText = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const compareNumber = (a: number | bigint, b: number | bigint): number => a < b ? -1 : a > b ? 1 : 0;
export function ordered<T>(items: readonly T[], compare: (a: T, b: T) => number): void {
  requireCandidate(items.every((item, index) => index === 0 || compare(items[index - 1]!, item) < 0));
}
