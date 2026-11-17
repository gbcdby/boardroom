import { canonicalJson, parseCanonical, sha256 } from "../canonical.ts";
import { ref } from "../parse-primitives.ts";
import { parseVerificationJournal } from "../parse.ts";
import type { ArtifactRef, JournalRecordV3 } from "../types.ts";
import { requireCandidate } from "./common.ts";

/** #152 A12-A private data only. Neither this type nor its decoder is a production journal/permit. */
export type UntrustedJournalCandidate = JournalRecordV3;

export function parseControlJournalCandidate(value: unknown): UntrustedJournalCandidate {
  const record = parseVerificationJournal(value);
  requireCandidate(record.formatVersion === 3);
  return record;
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
