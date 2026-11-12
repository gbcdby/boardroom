import { channel } from "node:diagnostics_channel";
import { constants, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

const source = channel("boardroom.maintenance.postgres.writer-observation");
const limits = { events: 256, rows: 32, string: 128, eventBytes: 32_768, totalBytes: 262_144 } as const;
const processLimits = { scopes: 64, events: 4096, eventBytes: 2_097_152, receiptBytes: 8192,
  summaryBytes: 8192, fallbackBytes: 512, digestsPerScope: 8, adaptersPerScope: 32 } as const;
type Stage = "scenario-start" | "backup-start" | "backup-returned" | "verify-start" | "verify-rejected-as-expected"
  | "assertions-complete" | "adapter-close-start" | "adapter-close-returned" | "fixture-close-start" | "fixture-close-returned"
  | "fixture-start" | "fixture-returned";
type ObjectValue = Record<string, unknown>;
const stages: readonly string[] = ["scenario-start", "backup-start", "backup-returned", "verify-start", "verify-rejected-as-expected",
  "assertions-complete", "adapter-close-start", "adapter-close-returned", "fixture-close-start", "fixture-close-returned", "fixture-start", "fixture-returned"];
interface Observation {
  readonly directory: string | undefined;
  mark(stage: Stage): void;
  failure(stage: "setup" | "case" | "cleanup", error: unknown): void;
  registerAlias(digest: string): void;
  close(reason?: "test-hook" | "process-hook"): void;
}
const active = new Set<Observation>();
const digestOwners = new Map<string, number>();
const processReasons = new Set<string>();
const budget = { scopes: 0, rejectedScopes: 0, closedScopes: 0, incompleteScopes: 0,
  eventAttempts: 0, eventBytesReserved: 0, eventBytesWritten: 0,
  receiptAttempts: 0, receiptsWritten: 0, receiptBytesReserved: 0, fallbackAttempts: 0 };
let summaryDirectory: string | undefined, processClosed = false;
const processIncomplete = (reason: string) => { if (processReasons.size < 12) processReasons.add(reason); };
const absentObservation = "NOT_OBSERVED; never infer an empty inventory";
const timing = "subscriber and synchronous bounded recording perturb timing";
const noop: Observation = Object.freeze({ directory: undefined, mark() {}, failure() {}, registerAlias() {}, close() {} });

/** One bounded receipt for this test-file process, including scopes denied by the
 * shared cap. Denied scopes cannot each create another receipt or stderr line. */
export function closePostgresWriterObservations(): void {
  if (processClosed || budget.scopes === 0 && budget.rejectedScopes === 0) return;
  processClosed = true;
  for (const observation of [...active]) observation.close("process-hook");
  const receipt = { version: 1, kind: "process-receipt", observationStatus: processReasons.size ? "INCOMPLETE" : "COMPLETE",
    incompleteReasons: [...processReasons], ...budget, limits: processLimits, activeScopes: active.size,
    filesMaximumBytes: processLimits.eventBytes + processLimits.scopes * processLimits.receiptBytes + processLimits.summaryBytes,
    stderrMaximumBytes: (processLimits.scopes + 1) * processLimits.fallbackBytes, absentObservation, timing };
  try {
    const json = JSON.stringify(receipt, null, 2) + "\n";
    if (!summaryDirectory || Buffer.byteLength(json) > processLimits.summaryBytes) throw new Error("incomplete process receipt");
    writeFileSync(join(summaryDirectory, `process-${process.pid}-receipt.json`), json, { mode: 0o600, flag: "wx" });
  } catch {
    try { writeSync(process.stderr.fd, JSON.stringify({ postgresWriterObservation: "INCOMPLETE", reason: "process_receipt_write_failed" }) + "\n"); } catch { /* Business outcome is preserved. */ }
  }
}

/** Test-only, source-scoped observation. Recording failure never replaces the
 * original business result/error. Missing or truncated evidence is INCOMPLETE,
 * never an empty writer inventory or a product PASS. */
export function observePostgresWriters(input: { sourceDescriptorDigest: string; scenario: string; caseId?: string; directory?: string }): Observation {
  if (processClosed || budget.scopes >= processLimits.scopes) {
    budget.rejectedScopes++; processIncomplete(processClosed ? "scope_after_process_close" : "scope_limit"); return noop;
  }
  const scopeId = ++budget.scopes;
  const digest = /^[a-f0-9]{64}$/.test(input.sourceDescriptorDigest) ? input.sourceDescriptorDigest : "";
  const label = (value: unknown) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : "invalid";
  const scenario = label(input.scenario), caseId = label(input.caseId ?? "public-input-fault");
  const digests = new Set<string>(), aliasRegistrations: string[] = [];
  const adapters = new Map<number, { adapterObservationId: number; ordinal: number; sourceDescriptorDigest: string; createdObserved: boolean }>();
  const reasons = new Set<string>();
  let directory: string | undefined, descriptor: number | undefined, closed = false, recordingStopped = false, subscribed = false;
  let received = 0, foreignIgnored = 0, written = 0, dropped = 0, bytes = 0, sequence = 0, attempts = 0;
  const phases = { external: 0, "backup-before": 0, "backup-after": 0, "snapshot-final": 0 };
  const failures: { stage: "setup" | "case" | "cleanup"; code: string | null; name: string | null }[] = [];
  const incomplete = (reason: string) => { if (reasons.size < 12) reasons.add(reason); processIncomplete("scope_incomplete"); };
  const registerDigest = (value: string): boolean => {
    if (!/^[a-f0-9]{64}$/.test(value)) { incomplete("invalid_scope_digest"); return false; }
    if (digestOwners.has(value) && digestOwners.get(value) !== scopeId) { incomplete("scope_digest_conflict"); return false; }
    if (!digests.has(value) && digests.size >= processLimits.digestsPerScope) { incomplete("digest_limit"); return false; }
    digests.add(value); digestOwners.set(value, scopeId); return true;
  };
  registerDigest(digest);
  const number = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    incomplete("invalid_metadata"); return null;
  };
  const text = (value: unknown, nullable = false) => {
    if (value === null && nullable) return null;
    if (typeof value !== "string") { incomplete("invalid_metadata"); return null; }
    if (value.length > limits.string) incomplete("string_truncated");
    return value.slice(0, limits.string);
  };
  const boolean = (value: unknown, nullable = false) => {
    if (typeof value === "boolean" || nullable && value === null) return value;
    incomplete("invalid_metadata"); return null;
  };
  const object = (value: unknown): ObjectValue => {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as ObjectValue;
    incomplete("invalid_metadata"); return {};
  };
  const array = (value: unknown, project: (value: ObjectValue) => ObjectValue) => {
    if (!Array.isArray(value)) { incomplete("missing_array"); return []; }
    if (value.length > limits.rows) incomplete("rows_truncated");
    return value.slice(0, limits.rows).map(item => project(object(item)));
  };
  const session = (value: ObjectValue): ObjectValue => {
    if (value.truncated) incomplete("producer_truncated");
    return { pid: number(value.pid), backendStart: text(value.backendStart), source: boolean(value.source),
      critical: boolean(value.critical), ending: boolean(value.ending), ended: boolean(value.ended) };
  };
  const record = (event: ObjectValue) => {
    if (closed) return;
    try {
      if (recordingStopped || descriptor === undefined) { dropped++; incomplete("event_not_written"); return; }
      if (attempts >= limits.events) { dropped++; incomplete("event_limit"); return; }
      if (budget.eventAttempts >= processLimits.events) { dropped++; incomplete("process_event_limit"); return; }
      const line = JSON.stringify({ version: 1, sourceDescriptorDigest: digest,
        caseId, scenario, scopeId, sequence: sequence + 1, recordedAtMilliseconds: performance.now(), ...event }) + "\n";
      const length = Buffer.byteLength(line);
      if (length > limits.eventBytes || bytes + length > limits.totalBytes) { dropped++; incomplete("byte_limit"); return; }
      if (budget.eventBytesReserved + length > processLimits.eventBytes) { dropped++; incomplete("process_byte_limit"); return; }
      // Charge before the write; a partial write or failed attempt is never
      // refunded, so failure cannot bypass the process cap.
      attempts++; sequence++; budget.eventAttempts++; budget.eventBytesReserved += length;
      const buffer = Buffer.from(line);
      let offset = 0;
      while (offset < buffer.length) {
        const count = writeSync(descriptor, buffer, offset, buffer.length - offset);
        if (count <= 0) throw new Error("incomplete observation write");
        offset += count; bytes += count; budget.eventBytesWritten += count;
      }
      written++;
    } catch { dropped++; recordingStopped = true; incomplete("event_write_failed"); }
  };
  const listener = (message: unknown) => {
    try {
      if (closed || !message || typeof message !== "object" || typeof (message as ObjectValue).sourceDescriptorDigest !== "string"
        || !digests.has((message as ObjectValue).sourceDescriptorDigest as string)) {
        foreignIgnored++; return;
      }
      received++;
      const value = message as ObjectValue;
      if (value.version !== 1) { incomplete("unknown_version"); return; }
      if (value.truncated) incomplete("producer_truncated");
      const eventDigest = value.sourceDescriptorDigest as string;
      const adapterId = value.adapterObservationId;
      if (typeof adapterId !== "number" || !Number.isSafeInteger(adapterId) || adapterId < 1) { incomplete("invalid_adapter_identity"); return; }
      let adapter = adapters.get(adapterId as number);
      if (!adapter) {
        if (adapters.size >= processLimits.adaptersPerScope) { incomplete("adapter_limit"); return; }
        adapter = { adapterObservationId: adapterId as number, ordinal: adapters.size + 1,
          sourceDescriptorDigest: eventDigest, createdObserved: value.kind === "adapter-created" };
        adapters.set(adapterId as number, adapter);
        if (!adapter.createdObserved) incomplete("adapter_start_not_observed");
      } else if (adapter.sourceDescriptorDigest !== eventDigest) { incomplete("adapter_digest_conflict"); return; }
      const common = { kind: value.kind, sourceDescriptorDigest: eventDigest, adapterObservationId: adapter.adapterObservationId,
        adapterOrdinal: adapter.ordinal, atMilliseconds: number(value.atMilliseconds) };
      if (value.kind === "adapter-created") { record(common); return; }
      if (value.kind === "inspection") {
        if (value.truncated) incomplete("producer_truncated");
        const phase = text(value.phase);
        if (phase !== "external" && phase !== "backup-before" && phase !== "backup-after" && phase !== "snapshot-final") incomplete("unknown_phase");
        else phases[phase]++;
        record({ ...common, phase, inspectionId: number(value.inspectionId), databaseOid: text(value.databaseOid),
          activityAtMilliseconds: number(value.activityAtMilliseconds), preparedAtMilliseconds: number(value.preparedAtMilliseconds),
          actualCount: number(value.actualCount), registeredCount: number(value.registeredCount), ownSessionCount: number(value.ownSessionCount),
          ownSessions: array(value.ownSessions, session),
          rows: array(value.rows, row => ({ pid: number(row.pid), backendStart: text(row.backendStart, true), backendType: text(row.backendType, true),
            state: text(row.state, true), writeLock: boolean(row.writeLock, true), own: boolean(row.own), registered: boolean(row.registered, true) })),
          prepared: boolean(value.prepared), blockerCount: number(value.blockerCount),
          blockers: array(value.blockers, blocker => ({ code: text(blocker.code), subjectRef: text(blocker.subjectRef) })),
          truncated: boolean(value.truncated) });
      } else if (value.kind === "inspection-error") record({ ...common, phase: text(value.phase), inspectionId: number(value.inspectionId),
        stage: text(value.stage), code: text(value.code, true) });
      else if (value.kind === "session-end-start" || value.kind === "session-end-complete") {
        record({ ...common, session: session(object(value.session)),
          ...(value.kind === "session-end-complete" ? { outcome: text(value.outcome) } : {}) });
      } else if (value.kind === "backup-file-complete") record(common);
      else incomplete("unknown_kind");
    } catch { incomplete("observer_exception"); }
  };
  try {
    if (!digests.has(digest) || scenario === "invalid" || caseId === "invalid") throw new Error("invalid observation scope");
    const base = resolve(input.directory ?? process.env.BOARDROOM_PG_WRITER_OBSERVATION_DIRECTORY
      ?? ".agent-output/maintenance-native-diagnostics/pg-writer-observations");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const info = lstatSync(base);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error("invalid observation directory");
    summaryDirectory ??= base;
    directory = mkdtempSync(join(base, `${caseId}-${scenario}-`));
    descriptor = openSync(join(directory, "events.jsonl"), constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
  } catch { incomplete("setup_failed"); }
  try { if (digests.size) { source.subscribe(listener); subscribed = true; } }
  catch { incomplete("subscribe_failed"); }
  const observation: Observation = {
    directory,
    mark(stage: Stage) { if (stages.includes(stage)) record({ kind: "test-stage", stage }); else incomplete("unknown_test_stage"); },
    registerAlias(alias: string) {
      if (closed) return;
      if (aliasRegistrations.length >= processLimits.digestsPerScope) { incomplete("alias_limit"); return; }
      if (registerDigest(alias)) { aliasRegistrations.push(alias); record({ kind: "scope-alias", aliasDigest: alias }); }
    },
    failure(stage: "setup" | "case" | "cleanup", error: unknown) {
      if (closed) return;
      try {
        const value = error as { code?: unknown; name?: unknown } | null;
        if (typeof value?.code === "string" && value.code.length > 64 || typeof value?.name === "string" && value.name.length > 64)
          incomplete("failure_metadata_truncated");
        const entry = { stage, code: typeof value?.code === "string" ? value.code.slice(0, 64) : null,
          name: typeof value?.name === "string" ? value.name.slice(0, 64) : null };
        if (failures.length < 4) failures.push(entry); else incomplete("failure_limit");
        record({ kind: "business-error", ...entry });
      } catch { incomplete("failure_record_failed"); }
    },
    close(reason) {
      if (closed) return;
      if (reason) incomplete(reason === "test-hook" ? "fixture_close_not_observed" : "scope_left_at_process_close");
      closed = true;
      let unsubscribed = !subscribed, logClosed = descriptor === undefined;
      try { if (subscribed) source.unsubscribe(listener); unsubscribed = true; }
      catch { incomplete("unsubscribe_failed"); }
      for (const value of digests) if (digestOwners.get(value) === scopeId) digestOwners.delete(value);
      try { if (descriptor !== undefined) { const owned = descriptor; descriptor = undefined; closeSync(owned); logClosed = true; } }
      catch { incomplete("log_close_failed"); }
      const receipt = { version: 1, caseId, scenario, scopeId, sourceDescriptorDigest: digest, registeredDigests: [...digests],
        aliasRegistrations, adapters: [...adapters.values()],
        observationStatus: reasons.size === 0 ? "COMPLETE" : "INCOMPLETE", incompleteReasons: [...reasons],
        receivedSourceEvents: received, foreignEventsIgnored: foreignIgnored, eventAttempts: attempts, eventsWritten: written, droppedEvents: dropped, bytesWritten: bytes,
        phaseCounts: phases, phaseObservation: Object.fromEntries(Object.entries(phases).map(([phase, count]) => [phase, count ? "OBSERVED" : "NOT_OBSERVED"])),
        businessErrors: failures, limits, processLimits, cleanup: { unsubscribed, logClosed }, absentObservation, timing };
      try {
        if (!directory) throw new Error("no observation directory");
        let json = JSON.stringify(receipt, null, 2) + "\n";
        if (Buffer.byteLength(json) > processLimits.receiptBytes) {
          incomplete("receipt_byte_limit");
          json = JSON.stringify({ version: 1, caseId, scenario, scopeId, sourceDescriptorDigest: digest,
            observationStatus: "INCOMPLETE", incompleteReasons: [...reasons], cleanup: { unsubscribed, logClosed }, absentObservation }) + "\n";
        }
        budget.receiptAttempts++; budget.receiptBytesReserved += Buffer.byteLength(json);
        writeFileSync(join(directory, "receipt.json"), json, { mode: 0o600, flag: "wx" });
        budget.receiptsWritten++;
      } catch {
        incomplete("receipt_write_failed"); budget.fallbackAttempts++;
        // Writable.write can emit EPIPE after this stack has returned. Use the
        // existing bounded synchronous writer so a failed fallback stays local;
        // never attach an error handler to the caller's shared stderr stream.
        try { writeSync(process.stderr.fd, JSON.stringify({ postgresWriterObservation: "INCOMPLETE", scenario,
          sourceDescriptorDigest: digest, reason: "receipt_write_failed" }) + "\n"); } catch { /* Business outcome is preserved. */ }
      }
      budget.closedScopes++; if (reasons.size) budget.incompleteScopes++;
      active.delete(observation);
    },
  };
  active.add(observation);
  return observation;
}
