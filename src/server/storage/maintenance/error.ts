import type { BlockerCode } from "./types.ts";

const failures = new WeakMap<object, BlockerCode>();
/** Internal identity adapter. Unknown thrown values are never inspected. */
export function maintenanceFailureCode(value: unknown): BlockerCode | undefined {
  return failures.get(value as object);
}

/** Diagnostics intentionally contain no path, DSN, raw SQL or source content. */
export class MaintenanceFailure extends Error {
  override readonly name = "MaintenanceFailure";
  readonly code: BlockerCode;
  constructor(code: BlockerCode, subjectRef = "source") {
    super(`storage_maintenance: ${code} (${subjectRef})`);
    this.code = code;
    failures.set(this, code);
  }
}
