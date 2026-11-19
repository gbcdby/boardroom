import { sha256 } from "./canonical.ts";
import { buildLayoutMemoryInventory } from "./layout-memory-inventory.ts";
import type { EncodedCell, FrozenMemoryInputValue, LayoutMemoryInventoryValue, PlannedMemoryObjectRefValue } from "./layout-memory-inventory.ts";
import { copyLayoutInternalData, LayoutValueError } from "./layout-values.ts";
import type { ReadonlyDeep } from "./layout-values.ts";

export type MemoryObjectPayloadValues = ReadonlyDeep<{
  contract: "layout-memory-object-payload-values/r1";
  classification: "observation";
  coverage: "memory-body-projection";
  inventory: LayoutMemoryInventoryValue;
  objects: {
    object: PlannedMemoryObjectRefValue;
    relativePath: string;
    payload: { bytesHex: string; sha256: string; bytes: string };
  }[];
}>;

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new LayoutValueError("inventory_integrity");
}
function originalTextBytes(cell: ReadonlyDeep<EncodedCell>, dialect: FrozenMemoryInputValue["dialect"]): Buffer {
  // The original builder has already checked exact tags, column positions and UTF-8.
  // Recover bytes from the same snapshot without normalizing or decoding SQLite bodies again.
  requireValue(typeof cell[1] === "string");
  return Buffer.from(cell[1], dialect === "sqlite" ? "hex" : "utf8");
}

/** Complete historical body projection only; these values grant no publication or recovery authority. */
export function buildLayoutMemoryObjectPayloadValues(value: unknown): MemoryObjectPayloadValues {
  const safe = copyLayoutInternalData(value, "inventory");
  const inventory = buildLayoutMemoryInventory(safe);
  const input = safe as ReadonlyDeep<FrozenMemoryInputValue>;
  const bodyByVersion = new Map<string, ReadonlyDeep<EncodedCell>>();
  for (const row of input.tables[1]!.rows) {
    const versionId = originalTextBytes(row[0]!, input.dialect).toString("utf8");
    requireValue(!bodyByVersion.has(versionId));
    bodyByVersion.set(versionId, row[4]!);
  }
  requireValue(bodyByVersion.size === inventory.versions.length);
  const payloads = new Map<string, { bytesHex: string; sha256: string; bytes: string }>();
  for (const version of inventory.versions) {
    const cell = bodyByVersion.get(version.versionId);
    requireValue(cell !== undefined);
    const bytes = originalTextBytes(cell, input.dialect);
    const digest = sha256(bytes);
    requireValue(digest === version.object.contentSha256 && bytes.length === version.object.byteLength);
    const bytesHex = bytes.toString("hex"), prior = payloads.get(digest);
    requireValue(prior === undefined || prior.bytesHex === bytesHex);
    if (prior === undefined) payloads.set(digest, { bytesHex, sha256: digest, bytes: String(bytes.length) });
  }
  requireValue(payloads.size === inventory.objects.length);
  const objects = inventory.objects.map(object => {
    const payload = payloads.get(object.contentSha256);
    requireValue(payload !== undefined && payload.bytes === String(object.byteLength));
    return { object, relativePath: `objects/sha256/${object.contentSha256.slice(0, 2)}/${object.contentSha256}.md`, payload };
  });
  // The returned hex bodies share the existing bounded, deeply frozen value contract.
  return copyLayoutInternalData({ contract: "layout-memory-object-payload-values/r1", classification: "observation",
    coverage: "memory-body-projection", inventory, objects }, "inventory") as MemoryObjectPayloadValues;
}
