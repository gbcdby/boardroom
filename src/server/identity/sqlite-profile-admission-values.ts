import { boundary, type AuditRequest } from "./internal/m2-audit-boundary.ts";
import { observeSqliteProfileAdmissionRaw } from "./internal/sqlite-profile-admission-values.ts";
export type { SqliteProfileAdmissionObservation, SqliteProfileRawCell, SqliteProfileRawRow,
  SqliteProfileRawPart, SqliteProfileTextEncoding } from "./internal/sqlite-profile-admission-values.ts";

/** Primitive JSON only; the detached observation never grants admission, a native handle or writer authority. */
export function inspectSqliteProfileAdmissionValue(input: unknown) {
  return boundary(input, (value: unknown, request: AuditRequest) => observeSqliteProfileAdmissionRaw(value, request));
}
