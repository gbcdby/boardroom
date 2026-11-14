/** Cleanup is exhaustive; the failure that caused rollback remains the thrown value. */
const cleanupFailures = new WeakMap<object, readonly unknown[]>();

export function m1CleanupFailures(error: unknown): readonly unknown[] {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? cleanupFailures.get(error) ?? [] : [];
}

export async function withM1Cleanup<T>(
  use: () => Promise<T>,
  close: readonly (() => Promise<void>)[],
): Promise<T> {
  let failed = false;
  let original: unknown;
  try { return await use(); }
  catch (error) { failed = true; original = error; throw error; }
  finally {
    const errors: unknown[] = [];
    for (const release of close) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      if (!failed) throw new AggregateError(errors, "m1_cleanup_failed");
      if (original !== null && (typeof original === "object" || typeof original === "function")) {
        cleanupFailures.set(original, Object.freeze([...m1CleanupFailures(original), ...errors]));
      } else {
        // Primitive throws have no identity to associate with a WeakMap. Keep them as cause.
        throw new AggregateError(errors, "m1_cleanup_failed", { cause: original });
      }
    }
  }
}
