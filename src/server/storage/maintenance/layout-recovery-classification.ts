import { z } from "zod";
import { canonicalJson, sha256 } from "./canonical.ts";
import { ref } from "./parse-primitives.ts";
import { copyLayoutInternalData, LayoutValueError } from "./layout-values.ts";
import { parseLayoutMemoryInventoryValue } from "./layout-memory-inventory.ts";
import type { ReadonlyDeep } from "./layout-values.ts";
import type { InventoryDocumentValue, InventoryVersionValue, LayoutMemoryInventoryValue } from "./layout-memory-inventory.ts";

const storageId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const format = { storageId, layoutVersion: z.literal(2), objectFormat: z.literal("utf8-sha256-v1"), formatContract: ref,
  generation: z.number().int().positive().safe() };
const currentSchema = z.object({ ...format, activationTerminal: ref.nullable(), gate: z.enum(["open", "sealed", "unknown"]), inventory: z.unknown() }).strict();
const candidateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("object-bytes"), contentHex: z.string() }).strict(),
  z.object({ kind: z.literal("database-bundle"), ...format, databaseSnapshot: ref, inventory: z.unknown(), consistencyEvidence: ref.nullable() }).strict(),
]);
const inputSchema = z.object({ contract: z.literal("layout-recovery-input/r1"), current: currentSchema, candidate: candidateSchema }).strict();
type Classification = "activation-not-established" | "current-reference-repair-candidate" | "unreferenced-object-candidate"
  | "storage-conflict" | "format-conflict" | "historical-overwrite-prohibited" | "future-generation-conflict"
  | "current-facts-not-covered" | "consistent-restore-review-required";
export type RecoveryClassificationValue = { contract: "layout-recovery-classification/r1"; classification: Classification;
  currentInventoryDigest: string; currentGate: "open" | "sealed" | "unknown" };

function requireValue(condition: unknown, code: LayoutValueError["code"]): asserts condition {
  if (!condition) throw new LayoutValueError(code);
}
function versionFacts(value: ReadonlyDeep<InventoryVersionValue>) {
  const { sourceRowDigest, relativePath, ...facts } = value;
  return facts;
}
function documentFacts(value: ReadonlyDeep<InventoryDocumentValue>) {
  const { sourceRowDigest, ...facts } = value;
  return facts;
}
function covers(current: ReadonlyDeep<LayoutMemoryInventoryValue>, candidate: ReadonlyDeep<LayoutMemoryInventoryValue>): boolean {
  const versions = new Map(candidate.versions.map(value => [value.versionId, value]));
  const documents = new Map(candidate.documents.map(value => [value.documentId, value]));
  return current.versions.every(value => {
    const found = versions.get(value.versionId);
    return found !== undefined && canonicalJson(versionFacts(found)) === canonicalJson(versionFacts(value));
  }) && current.documents.every(value => {
    const found = documents.get(value.documentId);
    return found !== undefined && canonicalJson(documentFacts(found)) === canonicalJson(documentFacts(value));
  });
}

/** Data candidates only. Even complete value coverage never permits a restore or opens a gate. */
export function classifyLayoutRecoveryValue(value: unknown): ReadonlyDeep<RecoveryClassificationValue> {
  const safe = copyLayoutInternalData(value, "inventory");
  if (safe && typeof safe === "object" && "contract" in safe && typeof safe.contract === "string")
    requireValue(safe.contract === "layout-recovery-input/r1", "unsupported_shape");
  const parsed = inputSchema.safeParse(safe);
  if (!parsed.success) throw new LayoutValueError("invalid_value");
  const { current, candidate } = parsed.data;
  const inventory = parseLayoutMemoryInventoryValue(current.inventory);
  requireValue(inventory.storageId === current.storageId, "value_conflict");
  const result = (classification: Classification): ReadonlyDeep<RecoveryClassificationValue> => Object.freeze({
    contract: "layout-recovery-classification/r1", classification, currentInventoryDigest: inventory.inventoryDigest, currentGate: current.gate,
  });
  if (candidate.kind === "object-bytes") {
    requireValue(candidate.contentHex.length <= 2 * 1_048_576, "budget_exceeded");
    requireValue(candidate.contentHex.length % 2 === 0 && /^[0-9a-f]*$/.test(candidate.contentHex), "invalid_value");
    const bytes = Buffer.from(candidate.contentHex, "hex");
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      requireValue(Buffer.from(text, "utf8").equals(bytes), "inventory_integrity");
    } catch { throw new LayoutValueError("inventory_integrity"); }
    if (current.activationTerminal === null) return result("activation-not-established");
    const digest = sha256(bytes);
    return result(inventory.versions.some(version => version.object.storageId === current.storageId
      && version.object.objectFormat === current.objectFormat && version.object.contentSha256 === digest
      && version.object.byteLength === bytes.length) ? "current-reference-repair-candidate" : "unreferenced-object-candidate");
  }
  const proposed = parseLayoutMemoryInventoryValue(candidate.inventory);
  requireValue(proposed.storageId === candidate.storageId, "value_conflict");
  if (current.activationTerminal === null) return result("activation-not-established");
  if (candidate.storageId !== current.storageId) return result("storage-conflict");
  if (canonicalJson(candidate.formatContract) !== canonicalJson(current.formatContract)) return result("format-conflict");
  if (candidate.generation < current.generation) return result("historical-overwrite-prohibited");
  if (candidate.generation > current.generation) return result("future-generation-conflict");
  if (!covers(inventory, proposed)) return result("current-facts-not-covered");
  return result("consistent-restore-review-required");
}
