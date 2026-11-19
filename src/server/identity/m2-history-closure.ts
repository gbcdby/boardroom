import { runP0Closure } from "./internal/m2-p0-closure.ts";
import { createP0Request } from "./internal/m2-p0.ts";
import type { ClosureResult } from "./m2-history-closure-contracts.ts";
export type { ClosureResult, ClosureValue, ClosureError } from "./m2-history-closure-contracts.ts";

/** Pure value observation; never a native writer, commit or authorization permit. */
export function validateM2HistoryClosure(input: unknown): ClosureResult {
  const admitted = createP0Request(input);
  return admitted.ok ? runP0Closure(admitted.value) : admitted;
}
