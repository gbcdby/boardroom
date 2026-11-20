import { runP0Closure } from "./internal/m2-p0-closure.ts";
import { createM2HistoryRequest } from "./internal/m2-p0-request.ts";
import { runM2OriginHistoryClosure } from "./internal/m2-origin-history-closure.ts";
import type { ClosureResult } from "./m2-history-closure-contracts.ts";
export type { ClosureResult, ClosureValue, ClosureError } from "./m2-history-closure-contracts.ts";

/** Pure value observation; never a native writer, commit or authorization permit. */
export function validateM2HistoryClosure(input: unknown): ClosureResult {
  const admitted = createM2HistoryRequest(input);
  return admitted.ok ? admitted.value.input.graph.observation.phase==='p0'?runP0Closure(admitted.value):runM2OriginHistoryClosure(admitted.value) : admitted;
}
