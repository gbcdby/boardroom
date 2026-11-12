import { channel } from "node:diagnostics_channel";
import { constants, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

const source = channel("boardroom.maintenance.postgres.writer-observation");
const limits = { events: 256, rows: 32, string: 128, eventBytes: 32_768, totalBytes: 262_144 } as const;
type Scenario = "archive-replace" | "selection-replace" | "sql-replace" | "sql-truncate";
type Stage = "scenario-start" | "backup-start" | "backup-returned" | "verify-start" | "verify-rejected-as-expected"
  | "assertions-complete" | "adapter-close-start" | "adapter-close-returned" | "fixture-close-start" | "fixture-close-returned";
type ObjectValue = Record<string, unknown>;
const scenarios: readonly string[] = ["archive-replace", "selection-replace", "sql-replace", "sql-truncate"];
const stages: readonly string[] = ["scenario-start", "backup-start", "backup-returned", "verify-start", "verify-rejected-as-expected",
  "assertions-complete", "adapter-close-start", "adapter-close-returned", "fixture-close-start", "fixture-close-returned"];

/** Test-only, source-scoped observation. Recording failure never replaces the
 * original business result/error. Missing or truncated evidence is INCOMPLETE,
 * never an empty writer inventory or a product PASS. */
export function observePostgresWriters(input: { sourceDescriptorDigest: string; scenario: Scenario; directory?: string }) {
  const digest = /^[a-f0-9]{64}$/.test(input.sourceDescriptorDigest) ? input.sourceDescriptorDigest : "";
  const scenario = scenarios.includes(input.scenario) ? input.scenario : "invalid";
  const reasons = new Set<string>();
  let directory: string | undefined, descriptor: number | undefined, closed = false, recordingStopped = false;
  let received = 0, foreignIgnored = 0, written = 0, dropped = 0, bytes = 0, sequence = 0;
  const phases = { external: 0, "backup-before": 0, "backup-after": 0 };
  const failures: { stage: "case" | "cleanup"; code: string | null; name: string | null }[] = [];
  const incomplete = (reason: string) => { if (reasons.size < 12) reasons.add(reason); };
  const number = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    incomplete("invalid_metadata"); return null;
  };
  const text = (value: unknown) => {
    if (value === null) return null;
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
      if (written >= limits.events) { dropped++; incomplete("event_limit"); return; }
      const line = JSON.stringify({ version: 1, sourceDescriptorDigest: digest,
        scenario, sequence: ++sequence, recordedAtMilliseconds: performance.now(), ...event }) + "\n";
      const length = Buffer.byteLength(line);
      if (length > limits.eventBytes || bytes + length > limits.totalBytes) { dropped++; incomplete("byte_limit"); return; }
      const buffer = Buffer.from(line);
      let offset = 0;
      while (offset < buffer.length) {
        const count = writeSync(descriptor, buffer, offset, buffer.length - offset);
        if (count <= 0) throw new Error("incomplete observation write");
        offset += count;
      }
      written++; bytes += length;
    } catch { dropped++; recordingStopped = true; incomplete("event_write_failed"); }
  };
  const listener = (message: unknown) => {
    try {
      if (!digest || !message || typeof message !== "object" || (message as ObjectValue).sourceDescriptorDigest !== digest) {
        foreignIgnored++; return;
      }
      received++;
      const value = message as ObjectValue;
      if (value.version !== 1) { incomplete("unknown_version"); return; }
      if (value.truncated) incomplete("producer_truncated");
      const common = { kind: value.kind, atMilliseconds: number(value.atMilliseconds) };
      if (value.kind === "inspection") {
        if (value.truncated) incomplete("producer_truncated");
        const phase = text(value.phase);
        if (phase !== "external" && phase !== "backup-before" && phase !== "backup-after") incomplete("unknown_phase");
        else phases[phase]++;
        record({ ...common, phase, inspectionId: number(value.inspectionId), databaseOid: text(value.databaseOid),
          activityAtMilliseconds: number(value.activityAtMilliseconds), preparedAtMilliseconds: number(value.preparedAtMilliseconds),
          actualCount: number(value.actualCount), registeredCount: number(value.registeredCount), ownSessionCount: number(value.ownSessionCount),
          ownSessions: array(value.ownSessions, session),
          rows: array(value.rows, row => ({ pid: number(row.pid), backendStart: text(row.backendStart), backendType: text(row.backendType),
            state: text(row.state), writeLock: boolean(row.writeLock, true), own: boolean(row.own), registered: boolean(row.registered, true) })),
          prepared: boolean(value.prepared), blockerCount: number(value.blockerCount),
          blockers: array(value.blockers, blocker => ({ code: text(blocker.code), subjectRef: text(blocker.subjectRef) })),
          truncated: boolean(value.truncated) });
      } else if (value.kind === "inspection-error") record({ ...common, phase: text(value.phase), inspectionId: number(value.inspectionId),
        stage: text(value.stage), code: text(value.code) });
      else if (value.kind === "session-end-start" || value.kind === "session-end-complete") {
        record({ ...common, session: session(object(value.session)),
          ...(value.kind === "session-end-complete" ? { outcome: text(value.outcome) } : {}) });
      } else if (value.kind === "backup-file-complete") record(common);
      else incomplete("unknown_kind");
    } catch { incomplete("observer_exception"); }
  };
  try {
    if (!digest || scenario === "invalid") throw new Error("invalid observation scope");
    const base = resolve(input.directory ?? process.env.BOARDROOM_PG_WRITER_OBSERVATION_DIRECTORY
      ?? ".agent-output/maintenance-native-diagnostics/pg-writer-observations");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const info = lstatSync(base);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error("invalid observation directory");
    directory = mkdtempSync(join(base, `${scenario}-`));
    descriptor = openSync(join(directory, "events.jsonl"), constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
  } catch { incomplete("setup_failed"); }
  source.subscribe(listener);
  return {
    directory,
    mark(stage: Stage) { if (stages.includes(stage)) record({ kind: "test-stage", stage }); else incomplete("unknown_test_stage"); },
    failure(stage: "case" | "cleanup", error: unknown) {
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
    close() {
      if (closed) return;
      closed = true;
      let unsubscribed = false, logClosed = descriptor === undefined;
      try { source.unsubscribe(listener); unsubscribed = true; }
      catch { incomplete("unsubscribe_failed"); }
      try { if (descriptor !== undefined) { const owned = descriptor; descriptor = undefined; closeSync(owned); logClosed = true; } }
      catch { incomplete("log_close_failed"); }
      const receipt = { version: 1, scenario, sourceDescriptorDigest: digest,
        observationStatus: reasons.size === 0 ? "COMPLETE" : "INCOMPLETE", incompleteReasons: [...reasons],
        receivedSourceEvents: received, foreignEventsIgnored: foreignIgnored, eventsWritten: written, droppedEvents: dropped, bytesWritten: bytes,
        phaseCounts: phases, businessErrors: failures, limits, cleanup: { unsubscribed, logClosed },
        absentObservation: "NOT_OBSERVED; never infer an empty inventory", timing: "subscriber and synchronous bounded recording perturb timing" };
      try {
        if (!directory) throw new Error("no observation directory");
        writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n",
          { mode: 0o600, flag: "wx" });
      } catch {
        // Writable.write can emit EPIPE after this stack has returned. Use the
        // existing bounded synchronous writer so a failed fallback stays local;
        // never attach an error handler to the caller's shared stderr stream.
        try { writeSync(process.stderr.fd, JSON.stringify({ postgresWriterObservation: "INCOMPLETE", scenario,
          sourceDescriptorDigest: digest, reason: "receipt_write_failed" }) + "\n"); } catch { /* Business outcome is preserved. */ }
      }
    },
  };
}
