import { verifyRestoreBundle } from "../../src/server/storage/maintenance/verify-bundle.ts";
import type { ContinueRequest, SourceLock } from "../../src/server/storage/maintenance/types.ts";
import { verificationBundleFixture } from "./maintenance-verify-bundle.ts";

/** Real D/V and native locks. The inherited Fs/Jq remain explicit protocol fixtures;
 * they never qualify a production source or authorize a public ready transition. */
export async function snapshotReadyFixture(kind: "sqlite" | "postgres" = "sqlite") {
  const f = await verificationBundleFixture(kind);
  const request: ContinueRequest = { ...f.request, expectedPhase: "quiesced",
    expectedJournalDigest: f.capture.reference.sha256, requestId: "fixture-ready" };
  let snapshotLock: SourceLock | undefined;
  // D/V must share the actual snapshot authority, including PG public backup
  // authority. Await its complete COMMIT/close before lending a new control lock.
  const prepare = () => f.run(async lock => {
    snapshotLock = lock;
    const refs = await f.publish(lock);
    const verification = await verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication);
    return { ...refs, verification };
  });
  const run = <T>(consume: (lock: SourceLock) => Promise<T>): Promise<T> => f.adapter.withSourceLock("control", consume);
  return { ...f, run, request, prepare, get snapshotLock() { return snapshotLock; } };
}
