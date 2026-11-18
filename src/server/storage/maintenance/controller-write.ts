import { canonicalJson, digestJson } from "./canonical.ts";
import { applyControllerControlSql, assertControllerControlSqlActive, controlSqlOutcome, observedControlState,
  trackControllerControlSql, type ControlSqlPlan } from "./control-sql.ts";
import { applyControlNode, rowsDigest, type ControlReplayState } from "./control-candidate/replay-core.ts";
import { invariantFromManifests } from "./control-candidate/closure.ts";
import { bindSourceClientManifestRows, encodeText, supportedEncoding } from "./control-candidate/rows.ts";
import type { ControlProof, SuccessorProof } from "./control-candidate/schema.ts";
import { MaintenanceFailure } from "./error.ts";
import { assertFrozenSourceUnchanged, captureReference, classifyMaintenanceRequest, verifyJournalChain, verifySnapshotClosure, verifySourceFilesClosure,
  type JournalNode, type UntrustedRequestPrefix, type VerifiedJournalChain } from "./journal.ts";
import type { SourceClientAudit } from "./native-audit.ts";
import { ArtifactStore } from "./objects.ts";
import { maintenanceRequestDigest, parseJournal, parseMaintenanceCommand, parseManifests, readSourceFiles } from "./parse.ts";
import { loadPersistedPlan } from "./plan.ts";
import { postgresControllerSourceAccess } from "./postgres.ts";
import { consumeControllerRestoreAuthorization } from "./restore-authorization.ts";
import { sqliteControllerSourceAccess } from "./sqlite.ts";
import { captureSourceFiles, verifyLiveSourceFiles } from "./source-files.ts";
import { buildSourceClientsRoster, sourceClientRawRowSchema, sourceClientsEncodingSchema } from "./source-clients.ts";
import { assertCapturedSourceClientBinding } from "./source-client-binding.ts";
import type { ArtifactRef, ControlRootIdentity, JournalFrozenV2, JournalRecord, MaintenanceAdapter, MaintenanceCommand,
  MigrationPlan, OperationMutex, PersistedPlanRef, SourceClientFactsWindow, SourceClientRawRow, SourceClientsObservation,
  SourceLock, SourceObservation } from "./types.ts";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function requireValue(value: unknown, code: ConstructorParameters<typeof MaintenanceFailure>[0] = "source_changed"): asserts value {
  if (!value) throw new MaintenanceFailure(code, "controller-write");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Internal shape only. The runtime writer obtains this from an adapter's own
 * original-lock table; a caller-provided object of this shape is never accepted. */
export interface ControllerSourceAccess {
  readonly kind: "control" | "snapshot";
  readonly root: ControlRootIdentity;
  assertHeld(): Promise<void>;
  withAdvanceFacts<T>(plan: PersistedPlanRef, consume: (audit: SourceClientAudit, window: SourceClientFactsWindow) => Promise<T>): Promise<T>;
  withCancellationFacts<T>(plan: PersistedPlanRef, consume: (audit: SourceClientAudit, window: SourceClientFactsWindow) => Promise<T>): Promise<T>;
  stageRegistration(): Promise<SourceClientRawRow>;
  stageCandidate(reference: ArtifactRef, record: JournalRecord): Promise<void>;
  invalidate(): void;
}
async function accessFor(adapter: MaintenanceAdapter, mutex: OperationMutex, lock: SourceLock): Promise<ControllerSourceAccess> {
  const access = adapter.dialect === "sqlite" ? await sqliteControllerSourceAccess(adapter, mutex, lock)
    : await postgresControllerSourceAccess(adapter, mutex, lock);
  await access.assertHeld(); return access;
}

/** This opaque object is useful only while its original adapter/mutex remain held.
 * Copying it, serializing it, or recreating its public fields does not create a scope. */
export interface ControllerCommandScope { readonly kind: "controller-command-scope" }
interface CommandState {
  readonly adapter: MaintenanceAdapter;
  readonly mutex: OperationMutex;
  readonly command: MaintenanceCommand;
  readonly digest: string;
  readonly plan: MigrationPlan;
  readonly root: ControlRootIdentity;
  readonly prefix: UntrustedRequestPrefix;
  readonly initialLock: SourceLock;
  readonly previousMigration: ArtifactRef | null;
  readonly initialState: SourceClientsObservation["state"];
  readonly locks: WeakSet<SourceLock>;
  head: ArtifactRef | null;
  pending?: { readonly lock: SourceLock; readonly node: JournalNode };
  running: boolean;
  invalid: boolean;
}
const commands = new WeakMap<ControllerCommandScope, CommandState>();
const mutexCommands = new WeakMap<OperationMutex, ControllerCommandScope>();
const scopedLocks = new WeakMap<SourceLock, ControllerCommandScope>();
const sqlPlans = new WeakMap<SourceLock, ControlSqlPlan>();
const operations = new WeakMap<SourceLock, Promise<unknown>>();
/** Kernel-only read of the original running operation; there is no public setter. */
export function controllerWriteOperation(lock: SourceLock): Promise<unknown> {
  const operation = operations.get(lock); requireValue(operation, "maintenance_lost"); return operation;
}
/** Adapter SQL kernel only. There is deliberately no exported setter. */
export function consumeControllerSqlPlan(lock: SourceLock): ControlSqlPlan {
  const plan = sqlPlans.get(lock); requireValue(plan, "maintenance_lost"); sqlPlans.delete(lock); return plan;
}
function stateFor(scope: ControllerCommandScope): CommandState {
  const state = commands.get(scope); requireValue(state && !state.invalid, "maintenance_lost"); return state;
}
async function actualChain(store: ArtifactStore, observed: SourceClientsObservation): Promise<VerifiedJournalChain | null> {
  const state = observed.state;
  if (state.journalSequence === 0) {
    requireValue(state.admission === "open" && state.journalRecordRef === null && state.journalDigest === null
      && state.activeMigrationId === null && state.planDigest === null, "journal_invalid"); return null;
  }
  requireValue(state.journalRecordRef && state.journalDigest, "journal_invalid");
  const exact = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
  const chain = await verifyJournalChain(store, exact), head = chain.nodes.at(-1)!;
  requireValue(head.reference.ref === state.journalRecordRef && head.reference.sha256 === state.journalDigest
    && head.record.sequence === state.journalSequence && head.record.ownerGeneration === state.ownerGeneration
    && head.record.fenceEpoch === state.fenceEpoch && same(head.record.source, observed.source)
    && (head.record.event === "cancelled" ? state.admission === "open" && state.activeMigrationId === null && state.planDigest === null
      : state.activeMigrationId === head.record.migrationId && state.planDigest === head.record.plan.sha256), "journal_invalid");
  return chain;
}
function bindPlan(state: CommandState, raw: SourceClientsObservation): void {
  requireValue(same(raw.source, state.plan.source) && same(raw.sourceIdentity, state.plan.sourceIdentity));
  requireValue(raw.schemaManifestDigest === state.plan.schemaManifestDigest
    && raw.state.guardManifestDigest === state.plan.guardManifestDigest, "plan_stale");
  requireValue(raw.state.controlRootJson === canonicalJson(state.root)
    && raw.state.mutexIdentityJson === canonicalJson(state.mutex.identity), "control_root_mismatch");
}

/** Called once in the first actual lock of a complete command, before enter or
 * any controller mutation. Existing request prefixes are read-only scopes. */
export async function beginControllerCommand(adapter: MaintenanceAdapter, mutex: OperationMutex, lock: SourceLock,
  value: MaintenanceCommand): Promise<{ readonly scope: ControllerCommandScope; readonly prefix: UntrustedRequestPrefix }> {
  const access = await accessFor(adapter, mutex, lock);
  requireValue(access.kind === "control" && !mutexCommands.has(mutex), "maintenance_lost");
  const command = freeze(parseMaintenanceCommand(value)), plan = await loadPersistedPlan(command.request.plan, command.request.expectedSource);
  const raw = await lock.observeSourceClients(), store = await ArtifactStore.open(command.request.plan.controlRoot, plan.source);
  const scope: ControllerCommandScope = Object.freeze({ kind: "controller-command-scope" });
  const provisional: CommandState = { adapter, mutex, command, digest: maintenanceRequestDigest(command), plan, root: access.root,
    prefix: { kind: "untrusted-request-prefix", status: "new", head: null, firstSequence: null }, initialLock: lock,
    previousMigration: null, initialState: freeze({ ...raw.state }),
    locks: new WeakSet([lock]), head: null, running: false, invalid: false };
  bindPlan(provisional, raw); requireValue(same(store.identity, access.root), "control_root_mismatch");
  const chain = await actualChain(store, raw);
  const previousMigration = chain?.nodes.at(-1)?.record.event === "cancelled" && raw.state.admission === "open"
    && command.operation === "execute-migration" && command.request.expectedPhase === null && command.request.expectedJournalDigest === null
    && chain.plan.migrationId !== plan.migrationId ? chain.nodes.at(-1)!.reference : null;
  if (chain && !previousMigration) requireValue(same(chain.plan, plan), "plan_stale");
  const prefix = freeze(classifyMaintenanceRequest(previousMigration ? [] : chain?.nodes ?? [], command));
  const state = { ...provisional, prefix, previousMigration, head: chain?.nodes.at(-1)!.reference ?? null };
  await access.assertHeld(); requireValue(same(await lock.observeSourceClients(), raw));
  commands.set(scope, state); mutexCommands.set(mutex, scope); scopedLocks.set(lock, scope); return Object.freeze({ scope, prefix });
}

/** Phase facts from the original adapter are necessary, never a supplied success
 * bit. PG additionally requires the new source lock before command advancement. */
export function assertControllerLockCompleted(scope: ControllerCommandScope, lock: SourceLock): void {
  const state = stateFor(scope); requireValue(state.locks.has(lock), "maintenance_lost");
  const result = controlSqlOutcome(lock);
  requireValue(result.commitReturned && result.localSourceHandleClosed && !result.failureObserved
    && !result.rollbackFailureObserved && !result.closeFailureObserved, "maintenance_lost");
}

/** Actual scope/lock check for the downstream D/V consumer. Returned values are
 * observations, not a reusable writer/restore permit. */
export async function assertControllerCommandWindow(scope: ControllerCommandScope, lock: SourceLock) {
  const state = stateFor(scope), access = await accessFor(state.adapter, state.mutex, lock);
  const raw = await lock.observeSourceClients(); bindPlan(state, raw);
  const store = await ArtifactStore.open(state.command.request.plan.controlRoot, state.plan.source);
  requireValue(same(store.identity, state.root), "control_root_mismatch");
  const chain = await actualChain(store, raw), head = chain?.nodes.at(-1)?.reference ?? null;
  if (state.pending) {
    requireValue(lock !== state.pending.lock, "maintenance_lost"); assertControllerLockCompleted(scope, state.pending.lock);
    requireValue(same(head, state.pending.node.reference), "maintenance_lost"); state.head = head; delete state.pending;
  } else if (!same(head, state.head)) {
    // I05 enter borrows this scope's first lock. It may create only the one
    // canonical enter record of this original, previously-new command.
    const entered = chain?.nodes[0];
    requireValue((state.head === null || state.previousMigration && same(state.head, state.previousMigration))
      && state.prefix.status === "new" && lock !== state.initialLock
      && state.command.operation === "execute-migration" && chain?.nodes.length === 1 && entered?.record.event === "enter"
      && entered.record.requestId === state.command.request.requestId && entered.record.requestDigest === state.digest
      && same(chain.plan, state.plan) && entered.record.fenceEpoch === state.initialState.fenceEpoch + 1
      && entered.record.ownerGeneration === state.initialState.ownerGeneration + 1,
    "maintenance_lost");
    assertControllerLockCompleted(scope, state.initialLock); state.head = head;
  }
  requireValue(!scopedLocks.has(lock) || scopedLocks.get(lock) === scope, "maintenance_lost");
  state.locks.add(lock); scopedLocks.set(lock, scope); await access.assertHeld();
  return Object.freeze({ adapter: state.adapter, mutex: state.mutex, command: state.command, requestDigest: state.digest,
    plan: state.plan, prefix: state.prefix, store, observation: raw, chain, head, kind: access.kind });
}

/** The enter stage cannot borrow a later source lock or an already-used prefix. */
export async function assertControllerEnterWindow(scope: ControllerCommandScope, lock: SourceLock) {
  const state = stateFor(scope);
  requireValue(state.initialLock === lock && state.prefix.status === "new"
    && (state.head === null || state.previousMigration && same(state.head, state.previousMigration)) && !state.pending
    && state.command.operation === "execute-migration" && state.command.request.expectedPhase === null
    && state.command.request.expectedJournalDigest === null, "phase_conflict");
  const window = await assertControllerCommandWindow(scope, lock);
  requireValue(window.kind === "control" && window.observation.state.admission === "open"
    && (window.chain === null || state.previousMigration && window.chain.nodes.at(-1)?.record.event === "cancelled"
      && window.chain.plan.migrationId !== state.plan.migrationId), "phase_conflict");
  return window;
}

function completeManifests(observed: SourceObservation, raw: SourceClientsObservation, legacy = false): void {
  requireValue(same(observed.source, raw.source) && same(observed.sourceIdentity, raw.sourceIdentity)
    && same(observed.state, raw.state) && observed.manifests.schemaManifestDigest === raw.schemaManifestDigest);
  if (!legacy) bindSourceClientManifestRows(observed.manifests, raw.rows, raw.textEncoding);
}
async function replay(store: ArtifactStore, chain: VerifiedJournalChain, mutex: OperationMutex) {
  const first = chain.nodes.findIndex(node => node.record.event === "capture"), origin = chain.nodes[first];
  requireValue(origin && origin.record.formatVersion !== 1 && origin.record.sourceClients && origin.record.frozen, "journal_invalid");
  const roster = origin.record.sourceClients, state: ControlReplayState = { rows: roster.rows, invariant: null,
    registrations: new Map(), unresolvedEncoding: new Set() };
  for (let index = first; index < chain.nodes.length; index++) {
    const node = chain.nodes[index]!, record = node.record;
    if (record.formatVersion !== 3) continue;
    if (record.controlProof?.kind === "legacy-first-capture-bridge") {
      const manifests = parseManifests(await store.readJson(record.controlProof.legacy.manifests, "database-manifests"));
      state.invariant = invariantFromManifests(manifests, origin, store.identity, mutex.identity);
      bindSourceClientManifestRows(manifests, roster.rows, roster.textEncoding);
    }
    applyControlNode(chain.plan, node, chain.nodes[index - 1], origin, roster,
      { controlRoot: store.identity, mutexIdentity: mutex.identity }, state);
  }
  return { origin, roster, state };
}

/** N07 source selection is internal to the original adapter's verification call.
 * It accepts no archive path, caller candidate or success assertion. An ordinary
 * mechanical D verification without a command does not gain a new archive owner. */
export async function readAnchoredControllerArchive(adapter: MaintenanceAdapter, mutex: OperationMutex, lock: SourceLock) {
  const scope = scopedLocks.get(lock); if (!scope) return undefined;
  const state = stateFor(scope);
  requireValue(state.adapter === adapter && state.mutex === mutex, "maintenance_lost");
  const context = await assertControllerCommandWindow(scope, lock), chain = context.chain;
  requireValue(context.kind === "snapshot" && context.prefix.status === "new", "maintenance_lost");
  if (!chain || chain.nodes.at(-1)!.record.phase !== "snapshot_ready") return undefined;
  requireValue(!chain.nodes.some(node => ["cancel_intent", "cancelled"].includes(node.record.event)), "phase_conflict");
  const head = chain.nodes.at(-1)!, closure = await verifySnapshotClosure(context.store, head.reference);
  const observed = await lock.observe(), raw = await lock.observeSourceClients();
  bindPlan(state, raw); completeManifests(observed, raw, head.record.formatVersion !== 3);
  requireValue(same(context.observation, raw) && same(closure.chain, chain)
    && observed.manifests.schemaManifestDigest === closure.manifests.schemaManifestDigest
    && observed.manifests.frozenBusinessManifestDigest === closure.manifests.frozenBusinessManifestDigest);
  if (head.record.formatVersion === 3) {
    const controls = await replay(context.store, chain, mutex); requireValue(controls.state.invariant, "journal_invalid");
    requireValue(controls.state.unresolvedEncoding.size === 0 && same(controls.state.rows, raw.rows)
      && same(observedControlState(raw), { ...controls.state.invariant, ownerGeneration: String(head.record.ownerGeneration),
        journalRecordRef: head.reference.ref, journalDigest: head.reference.sha256, journalSequence: String(head.record.sequence) }));
  } else {
    const captured = chain.nodes.find(node => same(node.reference, closure.receipt.capture.journal));
    requireValue(captured?.record.formatVersion === 2 && captured.record.sourceClients, "journal_invalid");
    assertFrozenSourceUnchanged(observed, closure.manifests, chain);
    await assertCapturedSourceClientBinding(lock, observed, captured.record.sourceClients, closure.manifests);
  }
  await lock.withSourceClientFacts(state.command.request.plan, async facts => {
    requireValue(same(facts.observation, raw) && same(facts.origin.chain, chain));
    await verifyLiveSourceFiles(context.store, lock, mutex, state.command.request.plan, closure.receipt.sourceFilesManifest);
    await facts.assertCurrent();
  });
  await lock.assertHeld(); await mutex.assertHeld();
  requireValue(same(await lock.observeSourceClients(), raw) && same(await lock.observe(), observed));
  return Object.freeze({ database: closure.receipt.database, databaseFile: context.store.pathFor(closure.receipt.database),
    manifests: closure.manifests, manifestsReference: closure.receipt.manifests, receipt: closure.receiptRef,
    head: head.reference, observation: observed, raw, root: context.store.identity });
}
function successor(audit: SourceClientAudit, origin: JournalNode, changes: SuccessorProof["changes"], generation: number): SuccessorProof {
  const { observation, facts } = audit, state = observation.state;
  requireValue(origin.record.formatVersion !== 1 && origin.record.sourceClients, "journal_invalid");
  const next = new Map(observation.rows.map(row => [row.client_id[1], row]));
  for (const change of changes) next.set(change.after.client_id[1], change.after);
  return { formatVersion: 1, kind: "control-successor", originCapture: origin.reference,
    originSourceClientsDigest: digestJson(origin.record.sourceClients), source: observation.source, plan: origin.record.plan,
    migrationId: origin.record.migrationId, fenceEpoch: String(state.fenceEpoch), receiptGeneration: String(audit.origin.receiptGeneration),
    textEncoding: sourceClientsEncodingSchema.parse(observation.textEncoding), previousAnchor: audit.origin.head, fromGeneration: String(state.ownerGeneration),
    toGeneration: String(generation), targetSequence: String(state.journalSequence + 1), beforeRowsDigest: facts.beforeRowsDigest,
    afterRowsDigest: rowsDigest(observation.source, observation.textEncoding, [...next.values()]), changes, facts };
}

export type ControllerStep = Readonly<{ kind: "first-capture" | "takeover" | "recapture" | "ready" | "legacy-ready-bridge" | "cancel-intent" | "cancelled" }>;
/** This stages one fixed event in the caller's original transaction. It does not
 * claim COMMIT, source close, registration promotion or public command success. */
export function commitControllerStep(scope: ControllerCommandScope, lock: SourceLock, step: ControllerStep) {
  let state: CommandState;
  try {
    state = stateFor(scope); requireValue(state.prefix.status === "new" && !state.running, "maintenance_lost");
  } catch (error) { return Promise.reject(error); }
  state.running = true;
  let start!: () => void, reject!: (error: unknown) => void;
  const gate = new Promise<void>((resolve, failed) => { start = resolve; reject = failed; });
  const operation = gate.then(() => performControllerStep(scope, lock, step)).catch(error => {
    state.invalid = true; throw error;
  }).finally(() => {
    sqlPlans.delete(lock); operations.delete(lock); state.running = false;
  });
  operations.set(lock, operation);
  try { trackControllerControlSql(lock); start(); } catch (error) { state.invalid = true; reject(error); }
  return operation;
}
async function performControllerStep(scope: ControllerCommandScope, lock: SourceLock, step: ControllerStep) {
  const state = stateFor(scope), access = await accessFor(state.adapter, state.mutex, lock);
  requireValue(Object.keys(step).length === 1
    && ["first-capture", "takeover", "recapture", "ready", "legacy-ready-bridge", "cancel-intent", "cancelled"].includes(step.kind), "request_conflict");
  requireValue(state.prefix.status === "new" && state.running && access.kind === "control", "maintenance_lost");
  try {
    assertControllerControlSqlActive(lock);
    const context = await assertControllerCommandWindow(scope, lock), chain = context.chain;
    requireValue(chain && context.head && chain.nodes.length < 4096, "phase_conflict");
    const head = chain.nodes.at(-1)!, raw = context.observation, before = await lock.observe();
    const initialCapture = chain.nodes.find(node => node.record.event === "capture");
    const legacy = initialCapture?.record.formatVersion === 2 && head.record.formatVersion === 2;
    const bridge = step.kind === "legacy-ready-bridge", writeLegacy = legacy && !bridge;
    completeManifests(before, raw, legacy);
    const cancelling = state.command.operation === "cancel-migration" || state.command.operation === "resume-migration"
      && chain.nodes.some(node => node.record.event === "cancel_intent");
    requireValue(cancelling ? ["takeover", "cancel-intent", "cancelled"].includes(step.kind)
      : ["first-capture", "takeover", "recapture", "ready", "legacy-ready-bridge"].includes(step.kind), "phase_conflict");
    requireValue(step.kind === "first-capture" ? !initialCapture && raw.state.admission === "draining"
      : initialCapture && raw.state.admission === "sealed", "phase_conflict");
    const pending = chain.nodes.some(node => node.record.event === "cancel_intent");
    const ownHead = head.record.requestId === state.command.request.requestId && head.record.requestDigest === state.digest;
    const prior = chain.nodes.at(-2);
    const ownTakeover = (node: JournalNode | undefined) => node?.record.event === "takeover"
      && node.record.requestId === state.command.request.requestId && node.record.requestDigest === state.digest;
    requireValue(step.kind !== "takeover" || !ownHead
      || head.record.event === "capture" && initialCapture === head
      || head.record.formatVersion === 3 && head.record.controlProof?.kind === "legacy-first-capture-bridge", "phase_conflict");
    requireValue(step.kind !== "cancel-intent" || !pending, "phase_conflict");
    requireValue(step.kind !== "cancelled" || pending, "phase_conflict");
    requireValue(step.kind !== "cancel-intent" || ownTakeover(head), "phase_conflict");
    requireValue(step.kind !== "cancelled" || ownHead && (head.record.event === "cancel_intent" || ownTakeover(head)), "phase_conflict");
    requireValue(step.kind !== "recapture" || ownTakeover(head) && head.record.phase === "quiesced" && !pending, "phase_conflict");
    requireValue(step.kind !== "ready" || ownHead && ownTakeover(prior)
      && head.record.event === "capture" && head.record.phase === "quiesced" && !pending, "phase_conflict");
    requireValue(!bridge || legacy && head.record.phase === "snapshot_ready" && !pending && supportedEncoding(raw.textEncoding), "phase_conflict");
    requireValue(Number.isSafeInteger(raw.state.journalSequence + 1)
      && Number.isSafeInteger(raw.state.ownerGeneration + (step.kind === "takeover" ? 1 : 0))
      && Number.isSafeInteger(raw.state.fenceEpoch + (step.kind === "cancelled" ? 1 : 0)), "phase_conflict");
    const assertBefore = async () => {
      assertControllerControlSqlActive(lock);
      await access.assertHeld(); requireValue(same(await lock.observeSourceClients(), raw));
      requireValue(same(await lock.observe(), before));
    };
    const store = await ArtifactStore.open(state.command.request.plan.controlRoot, state.plan.source, { assertCurrent: assertBefore });
    // The original completed snapshot association is consumed before opening
    // this step's producer lease. No caller supplies R/V refs, and native facts
    // leases on the same actual source lock are never nested.
    const restored = step.kind === "ready" || step.kind === "legacy-ready-bridge"
      ? await consumeControllerRestoreAuthorization(scope, lock, step.kind) : undefined;
    if (restored) requireValue(restored.kind === step.kind, "snapshot_invalid");
    await assertBefore();
    const collect = cancelling ? access.withCancellationFacts.bind(access) : access.withAdvanceFacts.bind(access);
    let stagedRegistration = false;
    const record = await collect(state.command.request.plan, async (audit, window) => {
      requireValue(same(audit.observation, raw) && same(audit.origin.chain, chain) && same(audit.origin.head, head.reference));
      if (!writeLegacy) requireValue(supportedEncoding(raw.textEncoding), "source_changed");
      let proof: ControlProof | null = null, frozen: JournalFrozenV2 | null = null;
      let sourceClients: NonNullable<Extract<JournalRecord, { formatVersion: 2 }> ["sourceClients"]> | null = null;
      const generation = raw.state.ownerGeneration + (step.kind === "takeover" ? 1 : 0);
      if (step.kind === "first-capture") {
        requireValue(audit.facts.actor.clientId === null && chain.nodes.every(node => ["enter", "observation"].includes(node.record.event)
          && node.record.ownerGeneration === raw.state.ownerGeneration), "phase_conflict");
        sourceClients = buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster", source: raw.source,
          migrationId: state.plan.migrationId, plan: head.record.plan, fenceEpoch: String(raw.state.fenceEpoch),
          receiptGeneration: String(audit.origin.receiptGeneration), textEncoding: raw.textEncoding, rows: raw.rows });
        const captured = await captureSourceFiles(store, lock, state.mutex, state.command.request.plan);
        const files = await readSourceFiles(store, captured.ref); requireValue(same(files, captured.manifest));
        await verifySourceFilesClosure(store, files);
        frozen = { sourceFilesManifest: captured.ref, schemaManifestDigest: before.manifests.schemaManifestDigest,
          frozenBusinessManifestDigest: before.manifests.frozenBusinessManifestDigest, guardManifestDigest: raw.state.guardManifestDigest,
          sourceClientsDigest: digestJson(sourceClients) };
        const observed = observedControlState(raw);
        const { ownerGeneration: _generation, journalRecordRef: _journal, journalDigest: _digest, journalSequence: _sequence, ...invariant } = observed;
        requireValue(invariant.activeMigrationId && invariant.planDigest, "phase_conflict");
        proof = { formatVersion: 1, kind: "capture-controls", maintenanceInvariant: { ...invariant, admission: "sealed",
          activeMigrationId: invariant.activeMigrationId, planDigest: invariant.planDigest }, facts: audit.facts };
      } else {
        const control = await replay(store, chain, state.mutex), origin = control.origin;
        requireValue(origin.record.formatVersion !== 1 && origin.record.frozen && (legacy || control.state.invariant), "phase_conflict");
        requireValue(same(control.state.rows, raw.rows) && control.state.unresolvedEncoding.size === 0);
        if (legacy) await assertCapturedSourceClientBinding(lock, before, control.roster, before.manifests);
        frozen = step.kind === "recapture" ? origin.record.frozen : null;
        sourceClients = step.kind === "recapture" ? control.roster : null;
        const changes: SuccessorProof["changes"] = [];
        if (!legacy && step.kind === "takeover") {
          requireValue(audit.facts.actor.clientId === null, "phase_conflict");
          const own = sourceClientRawRowSchema.parse(await access.stageRegistration()); stagedRegistration = true;
          changes.push({ kind: "maintenance-registration", before: null, after: own, actorId: audit.facts.actor.actorId });
          const time = encodeText(audit.facts.observedAt, raw.textEncoding); requireValue(time);
          for (const fact of audit.facts.clients) if (fact.kind === "maintenance-controller" && fact.registration === "current-chain"
            && fact.classification === "exited-actor") {
            const old = raw.rows.find(row => same(row.client_id, fact.subject)); requireValue(old);
            if (old.ended_at[0] === "null") changes.push({ kind: "client-observation", subject: [...old.client_id], before: sourceClientRawRowSchema.parse(old),
              after: sourceClientRawRowSchema.parse({ ...old, last_observed_at: time, ended_at: time }), effect: "ended-observed" });
          }
        } else requireValue(legacy ? audit.facts.actor.clientId === null : audit.facts.actor.clientId !== null, "maintenance_lost");
        if (!writeLegacy) {
          changes.sort((a, b) => a.after.client_id[1] < b.after.client_id[1] ? -1 : a.after.client_id[1] > b.after.client_id[1] ? 1 : 0);
          const next = successor(audit, origin, changes, generation);
          if (bridge) {
            requireValue(restored?.kind === "legacy-ready-bridge" && changes.length === 0 && origin.record.formatVersion === 2
              && audit.facts.actor.clientId === null, "phase_conflict");
            const manifests = parseManifests(await store.readJson(restored.manifests, "database-manifests"));
            bindSourceClientManifestRows(manifests, control.roster.rows, control.roster.textEncoding);
            proof = { ...next, kind: "legacy-first-capture-bridge", legacy: {
              ready: restored.ready, receipt: restored.receipt, manifests: restored.manifests } };
          } else proof = step.kind === "cancelled" ? { formatVersion: 1, kind: "cancel-terminal-controls", originCapture: origin.reference,
          originSourceClientsDigest: next.originSourceClientsDigest, source: raw.source, plan: head.record.plan,
          migrationId: state.plan.migrationId, epochBefore: String(raw.state.fenceEpoch), epochAfter: String(raw.state.fenceEpoch + 1),
          receiptGeneration: next.receiptGeneration, textEncoding: next.textEncoding, previousAnchor: head.reference,
          ownerGeneration: String(generation), targetSequence: next.targetSequence, beforeRowsDigest: next.beforeRowsDigest,
            afterRowsDigest: next.beforeRowsDigest, changes: [], facts: audit.facts, successorRule: "open-next-epoch-clear-active-v1" } : next;
        }
      }
      const originFrozen = frozen ?? initialCapture?.record.frozen;
      requireValue(originFrozen && before.manifests.schemaManifestDigest === originFrozen.schemaManifestDigest
        && before.manifests.frozenBusinessManifestDigest === originFrozen.frozenBusinessManifestDigest
        && raw.state.guardManifestDigest === originFrozen.guardManifestDigest);
      await verifyLiveSourceFiles(store, lock, state.mutex, state.command.request.plan, originFrozen.sourceFilesManifest);
      await assertBefore(); await window.assertCurrent();
      return parseJournal({ formatVersion: writeLegacy ? 2 : 3, kind: "journal", migrationId: state.plan.migrationId,
        sequence: raw.state.journalSequence + 1, previous: head.reference,
        phase: step.kind === "first-capture" || step.kind === "recapture" ? "quiesced" : step.kind === "ready" ? "snapshot_ready" : head.record.phase,
        event: step.kind === "first-capture" || step.kind === "recapture" ? "capture"
          : step.kind === "cancel-intent" ? "cancel_intent" : bridge ? "observation" : step.kind,
        requestId: state.command.request.requestId, requestDigest: state.digest, source: raw.source, plan: head.record.plan,
        fenceEpoch: raw.state.fenceEpoch + (step.kind === "cancelled" ? 1 : 0), ownerGeneration: generation,
        evidence: [], snapshot: restored?.kind === "ready" ? restored.receipt : null,
        sourceClients, frozen, ...(writeLegacy ? {} : { controlProof: proof }) });
    });
    // The original facts callback has completed its final fresh check and closed.
    await assertBefore();
    const journal = await store.putJson("journal", record); await store.confirmDurable(journal);
    const afterChain = await verifyJournalChain(store, journal);
    requireValue(same(afterChain.nodes.slice(0, -1), chain.nodes) && same(afterChain.nodes.at(-1)?.record, record), "journal_invalid");
    const reconstructed = await replay(store, afterChain, state.mutex);
    requireValue((writeLegacy || reconstructed.state.invariant) && reconstructed.state.unresolvedEncoding.size === 0, "journal_invalid");
    const afterState = { ...observedControlState(raw), ownerGeneration: String(record.ownerGeneration),
      journalRecordRef: journal.ref, journalDigest: journal.sha256, journalSequence: String(record.sequence),
      ...(step.kind === "first-capture" ? { admission: "sealed" as const } : {}),
      ...(step.kind === "cancelled" ? { admission: "open" as const, fenceEpoch: String(record.fenceEpoch), activeMigrationId: null, planDigest: null } : {}) };
    requireValue(record.formatVersion === 2 || record.formatVersion === 3 && record.controlProof, "journal_invalid");
    const sql: ControlSqlPlan = { source: raw.source, textEncoding: raw.textEncoding, schemaManifestDigest: raw.schemaManifestDigest,
      before: { originalRoster: reconstructed.roster, expectedRows: raw.rows, expectedMaintenance: observedControlState(raw) },
      after: { originalRoster: reconstructed.roster, expectedRows: reconstructed.state.rows, expectedMaintenance: afterState },
      transition: step.kind === "first-capture" ? "first-seal" : step.kind === "cancelled" ? "cancel-terminal" : "sealed-successor",
      changes: record.formatVersion === 2 || record.controlProof!.kind === "capture-controls" ? [] : record.controlProof!.changes,
      previous: head.reference, head: journal, input: { head: journal, controlRoot: state.root, mutexIdentity: state.mutex.identity } };
    await assertBefore(); if (stagedRegistration) await access.stageCandidate(journal, record);
    sqlPlans.set(lock, freeze(sql)); await applyControllerControlSql(lock);
    const node = afterChain.nodes.at(-1)!; state.pending = { lock, node };
    return Object.freeze({ kind: "controller-transaction-view" as const, node, ref: captureReference(node) });
  } catch (error) { state.invalid = true; access.invalidate(); throw error; }
}
