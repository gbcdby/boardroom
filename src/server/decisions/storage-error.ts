type StorageIdentity = Readonly<{ column: string; stage: string; row?: object }>;
const identities = new WeakMap<object, StorageIdentity>();
/** Only errors made here carry trusted metadata. Unknown throws are never inspected. */
export function getStorageInvalidIdentity(value: unknown): StorageIdentity | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function') ? identities.get(value) : undefined;
}
/** Nested synchronous consumers retain the innermost actual row. No ambient current-row state. */
export function withStorageInvalidRow<T>(row: object, work: () => T): T {
  try { return work(); } catch (error) {
    const identity = getStorageInvalidIdentity(error);
    if (identity && identity.row === undefined) identities.set(error as object, Object.freeze({ ...identity, row }));
    throw error;
  }
}
export class StorageInvalid extends Error {
  readonly code = 'decision_storage_invalid';
  readonly column: string;
  readonly stage: string;
  constructor(column:string, stage:string) {
    super(`decision_storage_invalid:${column}:${stage}`);
    this.column=column; this.stage=stage;
    identities.set(this, Object.freeze({ column, stage }));
  }
}
