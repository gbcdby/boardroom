import { canonicalJson, parseCanonical, sha256 } from "../canonical.ts";
import { ref } from "../parse-primitives.ts";
import { parseJournal } from "../parse.ts";
import type { ArtifactRef, JournalRecordV2 } from "../types.ts";
import { requireCandidate } from "./common.ts";
import { checkFactsShape, controlProofSchema, type ControlProof } from "./schema.ts";

/** #152 A12-A private data only. Neither this type nor its decoder is a production journal/permit. */
export interface UntrustedJournalCandidate extends Omit<JournalRecordV2, "formatVersion"> {
  readonly formatVersion: 3;
  readonly controlProof: ControlProof | null;
}

export function parseControlJournalCandidate(value: unknown): UntrustedJournalCandidate {
  canonicalJson(value);
  requireCandidate(value !== null && typeof value === "object" && !Array.isArray(value));
  const { controlProof, ...body } = value as Record<string, unknown>;
  requireCandidate(body.formatVersion === 3 && Object.hasOwn(value, "controlProof"));
  // Reuse the exact v2 envelope without widening its production decoder or persisted type union.
  const record = parseJournal({ ...body, formatVersion: 2 });
  requireCandidate(record.formatVersion === 2
    && (record.event === "ready") === (record.snapshot !== null)
    && (record.event === "capture") === (record.frozen !== null));
  if (["cancel_intent", "cancelled"].includes(record.event)
    || record.phase === "planned" && (record.event === "enter" || record.event === "observation")) {
    requireCandidate(controlProof === null);
    return { ...record, formatVersion: 3, controlProof: null };
  }
  requireCandidate(record.event === "capture" && record.phase === "quiesced"
    || record.event === "ready" && record.phase === "snapshot_ready"
    || (record.event === "observation" || record.event === "takeover") && record.phase !== "planned");
  const proof = controlProofSchema.safeParse(controlProof);
  requireCandidate(proof.success);
  if (proof.data.kind === "capture-controls") requireCandidate(record.event === "capture");
  if (proof.data.kind === "legacy-first-capture-bridge") requireCandidate(record.phase === "snapshot_ready" && record.event === "observation"
    && proof.data.changes.length === 0 && proof.data.beforeRowsDigest === proof.data.afterRowsDigest);
  checkFactsShape(proof.data.facts, record.source);
  return { ...record, formatVersion: 3, controlProof: proof.data };
}

export function encodeControlJournalCandidate(value: unknown): Buffer {
  return Buffer.from(canonicalJson(parseControlJournalCandidate(value)), "utf8");
}

export function readControlJournalCandidate(reference: ArtifactRef, bytes: Uint8Array): UntrustedJournalCandidate {
  requireCandidate(ref.safeParse(reference).success && reference.sha256 === sha256(bytes)
    && reference.bytes === String(bytes.byteLength));
  const value = parseCanonical(bytes);
  requireCandidate(Buffer.from(canonicalJson(value), "utf8").equals(bytes));
  const record = parseControlJournalCandidate(value);
  requireCandidate(reference.ref === `journals/${record.migrationId}/${record.sequence}-${reference.sha256}.json`);
  return record;
}
