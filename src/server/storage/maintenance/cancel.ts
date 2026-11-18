import { assertControllerCommandWindow, commitControllerStep } from "./controller-write.ts";
import type { ControllerCommandScope } from "./controller-write.ts";
import { MaintenanceFailure } from "./error.ts";
import type { SourceLock } from "./types.ts";

/** One cancellation transaction at a time. The actual command's contiguous
 * journal suffix determines the next fixed event; no caller stage key, proof,
 * completion boolean or request rewrite is accepted. The service awaits the
 * original adapter COMMIT/close before calling this again with a new lock. */
export async function advanceControllerCancellation(scope: ControllerCommandScope, lock: SourceLock) {
  const current = await assertControllerCommandWindow(scope, lock), chain = current.chain;
  const pending = chain?.nodes.some(node => node.record.event === "cancel_intent") ?? false;
  if (!chain || !chain.nodes.some(node => node.record.event === "capture")
    || chain.nodes.at(-1)!.record.event === "cancelled"
    || !(current.command.operation === "cancel-migration" || current.command.operation === "resume-migration" && pending))
    throw new MaintenanceFailure("phase_conflict", "controller-cancellation");
  const mine = chain.nodes.filter(node => node.record.requestId === current.command.request.requestId);
  if (mine.some(node => node.record.requestDigest !== current.requestDigest))
    throw new MaintenanceFailure("request_conflict", "controller-cancellation");
  const takenOver = mine.some(node => node.record.event === "takeover");
  return commitControllerStep(scope, lock, { kind: !takenOver ? "takeover" : pending ? "cancelled" : "cancel-intent" });
}
