import { canonicalJson } from "../canonical.ts";
import { MaintenanceFailure } from "../error.ts";
import { reuseP0FNativeEquality,reserveP0FNativeText,reserveP0FNativeComparisons,reserveP0FNativeWork } from '../../../identity/internal/m2-p0-artifacts-frame.ts';

export function requireCandidate(condition: unknown): asserts condition {
  if (!condition) throw new MaintenanceFailure("journal_invalid", "control-successor");
}
export const equal = (a: unknown, b: unknown): boolean => {
  const reused=reuseP0FNativeEquality(a,b);return reused===undefined?canonicalJson(a)===canonicalJson(b):reused;
};
export const compareText = (a: string, b: string): number => {
  reserveP0FNativeText(a,true);reserveP0FNativeText(b,true);
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
};
export const compareNumber = (a: number | bigint, b: number | bigint): number => a < b ? -1 : a > b ? 1 : 0;
export function ordered<T>(items: readonly T[], compare: (a: T, b: T) => number): void {
  requireCandidate(items.every((item, index) => index === 0 || compare(items[index - 1]!, item) < 0));
}

/** Repeated joins pay for their actual compared fields before each comparison.
 * Primitive null checks do not scan either nullable string. */
export function sameJoinedText(a:string|null,b:string|null):boolean {
  if(typeof a==='string'&&typeof b==='string')reserveP0FNativeComparisons(a,b);
  else reserveP0FNativeWork(1);
  return a===b;
}
