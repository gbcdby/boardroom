// Private result provenance only. Weak identity adds no field to the public Stage1a DTO,
// retains no thrown value, and cannot turn a failed observation into a successful one.
const unknownFailures = new WeakSet<object>();

export function markUnknownHistoryFailure<T extends object>(result: T): T {
  unknownFailures.add(result);
  return result;
}

export function isUnknownHistoryFailure(result: object): boolean {
  return unknownFailures.has(result);
}
