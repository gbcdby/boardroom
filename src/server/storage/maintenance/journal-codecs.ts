// Strict value codecs are kept separate from replay orchestration so existing
// direct schema/codec entry points do not initialize the replay module early.
import { parseBundle, parseCapability, parseJournal, parseManifests, parsePlan, parsePublication, parseReceipt, parseVerification, parseSourceFiles } from './parse.ts';
import type { ActualRestoreVerification, DatabaseManifests, DurabilityCapability, JournalRecord, MigrationPlan, PublicationEvidence, RestoreBundleManifest, SnapshotReceipt, SourceFilesManifest } from './types.ts';
import type { P0FArtifactSyntaxFrame } from '../../identity/internal/m2-p0-artifacts-frame.ts';

export interface DecodedValues { plan: MigrationPlan; journal: JournalRecord; 'source-files': SourceFilesManifest; capability: DurabilityCapability;
  'restore-bundle': RestoreBundleManifest; publication: PublicationEvidence; verification: ActualRestoreVerification; receipt: SnapshotReceipt; 'database-manifests': DatabaseManifests }
export type JournalDecodedKind = keyof DecodedValues;
/** Value-only structural decoding after the enclosing canonical byte domain has been checked. */
export function decodeJournalParsed<K extends JournalDecodedKind>(kind: K, value: unknown, syntaxFrame?: P0FArtifactSyntaxFrame): DecodedValues[K] {
  if (kind === 'source-files') return parseSourceFiles(value) as DecodedValues[K];
  if (kind === 'journal') return parseJournal(value, syntaxFrame) as DecodedValues[K];
  const decoders = { plan: parsePlan, capability: parseCapability, 'restore-bundle': parseBundle,
    publication: parsePublication, verification: parseVerification, receipt: parseReceipt, 'database-manifests': parseManifests };
  return decoders[kind as Exclude<K, 'source-files' | 'journal'>](value) as DecodedValues[K];
}
