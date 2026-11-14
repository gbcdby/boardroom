import type { BlockerCode } from "./types.ts";

/** Diagnostics intentionally contain no path, DSN, raw SQL or source content. */
export class MaintenanceFailure extends Error {
  override readonly name = "MaintenanceFailure";
  readonly code: BlockerCode;
  constructor(code: BlockerCode, subjectRef = "source") {
    super(`storage_maintenance: ${code} (${subjectRef})`);
    this.code = code;
  }
}
