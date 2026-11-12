import { RepositoryError } from "../db/errors.ts";
import type { PolicyCombinationConflict, PolicyDocumentRef } from "../../shared/policy.ts";

export class PolicyConfigurationError extends RepositoryError {
  readonly reason: string;
  readonly status: 400 | 404 | 409 | 500;
  readonly fields: readonly string[];
  readonly current: PolicyDocumentRef | null;
  readonly conflicts: readonly PolicyCombinationConflict[];
  constructor(reason: string, status: 400 | 404 | 409 | 500 = 400, options: {
    fields?: readonly string[]; current?: PolicyDocumentRef | null; conflicts?: readonly PolicyCombinationConflict[];
  } = {}) {
    super(status === 409 ? "conflict" : status === 404 ? "not_found" : status === 500 ? "write_failed" : "invalid_argument", reason);
    this.reason = reason; this.status = status;
    this.fields = options.fields ?? []; this.current = options.current ?? null; this.conflicts = options.conflicts ?? [];
  }
}
