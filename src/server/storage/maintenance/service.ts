import path from "node:path";
import { canonicalJson } from "./canonical.ts";
import { advanceControllerCancellation } from "./cancel.ts";
import { parseControllerCommand } from "./controller-command.ts";
import type { ControllerServiceCommand } from "./controller-command.ts";
import { awaitControllerAdmission, createControllerOwner, finishControllerCommandOwner, recordControllerFailure, rememberControllerStore } from "./controller-owner.ts";
import { assertControllerCommandWindow, assertControllerLockCompleted, beginControllerCommand, commitControllerStep } from "./controller-write.ts";
import type { ControllerCommandScope, ControllerStep } from "./controller-write.ts";
import { controlSqlOutcome } from "./control-sql.ts";
import { stageControllerEnter } from "./enter.ts";
import { MaintenanceFailure } from "./error.ts";
import { inspectMaintenance } from "./inspect.ts";
import { captureReference } from "./journal.ts";
import type { JournalNode, UntrustedRequestPrefix } from "./journal.ts";
import { ArtifactStore } from "./objects.ts";
import { loadPersistedPlan, observeCapturePlanSelection } from "./plan.ts";
import { maintenanceFilesystem } from "./platform.ts";
import { SourceFilesFailure } from "./source-files.ts";
import type { MaintenanceResult, MaintenanceServiceOptions, ObservedMaintenanceAnchor, OperationMutex, SourceLock } from "./types.ts";

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: ConstructorParameters<typeof MaintenanceFailure>[0] = "maintenance_lost"): asserts value {
  if (!value) throw new MaintenanceFailure(code, "maintenance-service");
}
type CommandWindow = Awaited<ReturnType<typeof assertControllerCommandWindow>>;
type TransactionView = Awaited<ReturnType<typeof commitControllerStep>>;
type Start = { readonly mode: "replay"; readonly result: MaintenanceResult }
  | { readonly mode: "capture"; readonly first: "enter" | "first-capture" | "takeover"; readonly view: TransactionView }
  | { readonly mode: "historical-ready"; readonly view: TransactionView }
  | { readonly mode: "cancel"; readonly view: TransactionView };

function anchor(node: JournalNode): ObservedMaintenanceAnchor {
  return { ...captureReference(node), phase: node.record.phase,
    admission: node.record.event === "cancelled" ? "open" : node.record.phase === "planned" ? "draining" : "sealed",
    authority: "observation-only" };
}
/** Only ordinary precondition failures with no embedded failure/cleanup graph
 * can become a domain blocker after all original cleanup actually completed. */
function policyFailure(error: unknown): error is MaintenanceFailure {
  if (!(error instanceof MaintenanceFailure) || Object.hasOwn(error, "nativeCleanupOwner")) return false;
  if (error instanceof SourceFilesFailure)
    return error.closeErrors.length === 0 && policyFailure(error.cause) && error.code === error.cause.code;
  return !Object.hasOwn(error, "cause") && !Object.hasOwn(error, "closeErrors");
}

async function replayPrefix(scope: ControllerCommandScope, lock: SourceLock, prefix: UntrustedRequestPrefix,
  current: CommandWindow): Promise<MaintenanceResult> {
  const head = current.chain?.nodes.at(-1); requireValue(head && prefix.status !== "new", "journal_invalid");
  const observedAnchor = anchor(head), ref = captureReference(head);
  if (prefix.status === "cancelled") {
    requireValue(head.record.event === "cancelled" && current.observation.state.admission === "open", "journal_invalid");
    return { status: "cancelled", lastPhase: head.record.phase, terminalJournal: head.reference,
      openedFenceEpoch: head.record.fenceEpoch, restartRequired: true, observedAnchor };
  }
  if (prefix.status === "cancel_pending") return { status: "cancel_pending", phase: head.record.phase, ref,
    blockers: [{ code: "drain_incomplete", subjectRef: "new-cancellation-command-required" }], observedAnchor };
  if (prefix.status === "paused") {
    requireValue(head.record.phase !== "snapshot_ready", "journal_invalid");
    return { status: "paused", phase: head.record.phase, ref, observedAnchor };
  }
  // This finite consumer performs the complete read-only S/native/closure
  // window. It creates neither an attempt/restore target nor a write permit.
  const { assertControllerReadyCurrent } = await import("./restore-authorization.ts");
  const ready = await assertControllerReadyCurrent(scope, lock); await ready.assertCurrent();
  return { status: "snapshot_ready", phase: "snapshot_ready", ref: ready.ref, snapshot: ready.receiptRef, observedAnchor };
}

/** Fixed executor entry. Values are parsed again; the service creates its own
 * actual adapter/owner and retains that one mutex across every separate source
 * transaction. No host callback, caller adapter, SQL, stage proof or permit is
 * an input. A transaction view never substitutes for the original COMMIT and
 * source-close Promise. The executor still owns actual process exit afterwards. */
export async function runMaintenanceServiceCommand(options: MaintenanceServiceOptions,
  value: ControllerServiceCommand): Promise<MaintenanceResult> {
  const command = parseControllerCommand(value);
  if (command.operation === "inspect-migration") return inspectMaintenance(options, command);
  const request = command.request, plan = await loadPersistedPlan(request.plan, request.expectedSource);
  const owner = await createControllerOwner(options, plan), { adapter, descriptor } = owner, failures: unknown[] = [];
  let mutex: OperationMutex | undefined, sourceLock: SourceLock | undefined, scope: ControllerCommandScope | undefined;
  let lastObserved: ObservedMaintenanceAnchor | undefined, result: MaintenanceResult | undefined;
  let cancellation = command.operation === "cancel-migration";
  const remember = (current: CommandWindow) => {
    rememberControllerStore(owner, current.store);
    const node = current.chain?.nodes.at(-1);
    if (node?.record.migrationId === plan.migrationId) lastObserved = anchor(node);
  };
  try {
    await awaitControllerAdmission(owner);
    const initial = await adapter.observe();
    requireValue(same(initial.source, plan.source) && same(initial.sourceIdentity, plan.sourceIdentity), "source_changed");
    requireValue(options.controlRoot === request.plan.controlRoot
      && options.expectedSourceId === options.environment.inventory.selectedSourceId, "source_changed");
    // An open cancelled head is historical: ordinary writes/config changes do
    // not require the old frozen image. New enter independently revalidates its
    // new plan in the original first source lock.
    const observed = initial.state.admission === "open" && initial.state.journalSequence > 0 ? initial
      : await observeCapturePlanSelection(plan, options, adapter);
    const store = await ArtifactStore.open(request.plan.controlRoot, request.expectedSource);
    rememberControllerStore(owner, store); await maintenanceFilesystem(store.root);
    if (descriptor.kind === "sqlite") await maintenanceFilesystem(path.dirname(descriptor.sqlitePath));
    await awaitControllerAdmission(owner);
    mutex = await adapter.acquireMutex(store.identity, observed.state);
    await awaitControllerAdmission(owner);
    const held = mutex;
    const withWindow = async <T>(kind: "control" | "snapshot", consume: (lock: SourceLock) => Promise<T>): Promise<T> => {
      await awaitControllerAdmission(owner); await held.assertHeld();
      sourceLock = undefined;
      let entered: SourceLock | undefined;
      const view = await adapter.withSourceLock(kind, async lock => {
        sourceLock = entered = lock;
        try {
          await awaitControllerAdmission(owner);
          if (scope) remember(await assertControllerCommandWindow(scope, lock));
          return await consume(lock);
        } catch (error) { recordControllerFailure(owner, failures, error); throw error; }
      });
      requireValue(scope && entered);
      assertControllerLockCompleted(scope, entered);
      return view;
    };
    const advance = async (step: ControllerStep): Promise<TransactionView> => {
      const next = await withWindow("control", lock => commitControllerStep(scope!, lock, step));
      lastObserved = anchor(next.node); return next;
    };
    const start: Start = await withWindow("control", async lock => {
      const begun = await beginControllerCommand(adapter, held, lock, command, options); scope = begun.scope;
      const current = await assertControllerCommandWindow(scope, lock); remember(current);
      if (begun.prefix.status !== "new") return { mode: "replay", result: await replayPrefix(scope, lock, begun.prefix, current) };
      const chain = current.chain, head = chain?.nodes.at(-1);
      cancellation ||= command.operation === "resume-migration" && !!chain?.nodes.some(node => node.record.event === "cancel_intent");
      if (cancellation) return { mode: "cancel", view: await advanceControllerCancellation(scope, lock) };
      if (!head || head.record.event === "cancelled") return { mode: "capture", first: "enter",
        view: await stageControllerEnter(scope, lock, options) };
      if (head.record.phase === "planned") return { mode: "capture", first: "first-capture",
        view: await commitControllerStep(scope, lock, { kind: "first-capture" }) };
      const view = await commitControllerStep(scope, lock, { kind: "takeover" });
      return head.record.phase === "snapshot_ready" ? { mode: "historical-ready", view }
        : { mode: "capture", first: "takeover", view };
    });
    if (start.mode === "replay") result = start.result;
    else {
      lastObserved = anchor(start.view.node);
      if (start.mode === "cancel") {
        let terminal = start.view;
        for (let remaining = 2; terminal.node.record.event !== "cancelled" && remaining > 0; remaining--) {
          terminal = await withWindow("control", lock => advanceControllerCancellation(scope!, lock));
          lastObserved = anchor(terminal.node);
        }
        requireValue(terminal.node.record.event === "cancelled", "phase_conflict");
        result = { status: "cancelled", lastPhase: terminal.node.record.phase, terminalJournal: terminal.node.reference,
          openedFenceEpoch: terminal.node.record.fenceEpoch, restartRequired: true, observedAnchor: lastObserved };
      } else if (start.mode === "historical-ready") {
        const { revalidateControllerReady } = await import("./restore-authorization.ts");
        result = await withWindow("snapshot", async lock => {
          const ready = await revalidateControllerReady(scope!, lock); await ready.assertCurrent();
          return { status: "snapshot_ready", phase: "snapshot_ready", ref: ready.ref, snapshot: ready.receiptRef,
            ...(lastObserved ? { observedAnchor: lastObserved } : {}) };
        });
      } else {
        if (start.first === "enter") await advance({ kind: "first-capture" });
        if (start.first !== "takeover") await advance({ kind: "takeover" });
        await advance({ kind: "recapture" });
        const { prepareControllerSnapshot } = await import("./restore-authorization.ts");
        await withWindow("snapshot", lock => prepareControllerSnapshot(scope!, lock));
        const ready = await advance({ kind: "ready" });
        requireValue(ready.node.record.phase === "snapshot_ready" && ready.node.record.event === "ready"
          && ready.node.record.snapshot, "journal_invalid");
        result = { status: "snapshot_ready", phase: "snapshot_ready", ref: ready.ref, snapshot: ready.node.record.snapshot,
          ...(lastObserved ? { observedAnchor: lastObserved } : {}) };
      }
    }
  } catch (error) { recordControllerFailure(owner, failures, error); }
  const original = failures.length === 1 ? failures[0] : undefined;
  const outcome = sourceLock && controlSqlOutcome(sourceLock);
  const canReportPolicy = failures.length === 1 && policyFailure(original)
    && (!outcome || outcome.localSourceHandleClosed === true && !outcome.commitStarted
      && !outcome.rollbackFailureObserved && !outcome.closeFailureObserved);
  try { await finishControllerCommandOwner(owner, mutex, sourceLock, failures, "maintenance-command"); }
  catch (error) {
    // If any independent cleanup failed, finishControllerCommandOwner retains the
    // original first value plus every cleanup occurrence. Never project that
    // aggregate, an undefined throw or an unknown COMMIT into a successful result.
    if (!canReportPolicy || error !== original || failures.length !== 1 || !policyFailure(original)) throw error;
    const blockers = [{ code: original.code, subjectRef: "maintenance-command" }];
    if (cancellation && lastObserved && lastObserved.phase !== "planned"
      && ["source_writer_active", "source_writer_unknown", "drain_incomplete"].includes(original.code)) {
      const { phase, admission: _admission, authority: _authority, ...ref } = lastObserved;
      return { status: "cancel_pending", phase, ref, blockers, observedAnchor: lastObserved };
    }
    const status = ["journal_invalid", "snapshot_invalid"].includes(original.code) ? "recovery_required" : "blocked";
    return { status, lastVerifiedPhase: lastObserved?.phase ?? null, blockers,
      ...(lastObserved && status === "blocked" ? { observedAnchor: lastObserved } : {}) };
  }
  requireValue(result, "maintenance_lost"); return result;
}
