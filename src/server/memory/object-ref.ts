import { createHash } from "node:crypto";

/** Pure object values only. A parsed ref never grants storage or publication authority. */
export interface MemoryObjectRef {
  readonly objectFormat: "utf8-sha256-v1";
  readonly storageId: string;
  readonly contentSha256: string;
  readonly byteLength: number;
}

export interface MemoryObjectBodyValue {
  readonly bytes: Uint8Array;
  readonly markdown: string;
  readonly contentSha256: string;
  readonly byteLength: number;
}

export type MemoryObjectValueErrorCode = "invalid_ref" | "invalid_body" | "invalid_limit"
  | "body_limit_exceeded" | "invalid_utf8";

const ERROR_CODES = new Set<unknown>([
  "invalid_ref", "invalid_body", "invalid_limit", "body_limit_exceeded", "invalid_utf8",
]);

export class MemoryObjectValueError extends Error {
  override readonly name = "MemoryObjectValueError";
  readonly code: MemoryObjectValueErrorCode;

  constructor(code: MemoryObjectValueErrorCode) {
    const fixed = ERROR_CODES.has(code) ? code : "invalid_body";
    super(`memory_object_value:${fixed}`);
    this.code = fixed;
  }
}

const MAX_BODY_BYTES = 1048576;
const REF_FIELDS = ["objectFormat", "storageId", "contentSha256", "byteLength"] as const;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_NAME = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)!.get!;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")!.get!;
const COPY_TYPED_ARRAY = Uint8Array.prototype.set;

export function parseMemoryObjectRef(value: unknown): Readonly<MemoryObjectRef> {
  try {
    if (value === null || typeof value !== "object") throw new MemoryObjectValueError("invalid_ref");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new MemoryObjectValueError("invalid_ref");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== REF_FIELDS.length || !REF_FIELDS.every(field => keys.includes(field)))
      throw new MemoryObjectValueError("invalid_ref");
    const fields: Record<string, unknown> = {};
    for (const field of REF_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        throw new MemoryObjectValueError("invalid_ref");
      fields[field] = descriptor.value;
    }
    const { objectFormat, storageId, contentSha256, byteLength } = fields;
    if (objectFormat !== "utf8-sha256-v1" || typeof storageId !== "string" || storageId.length > 128
        || !/^[A-Za-z0-9]/.test(storageId) || /[^A-Za-z0-9._:-]/.test(storageId)
        || typeof contentSha256 !== "string" || contentSha256.length !== 64 || /[^0-9a-f]/.test(contentSha256)
        || typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || Object.is(byteLength, -0)
        || byteLength < 0 || byteLength > MAX_BODY_BYTES)
      throw new MemoryObjectValueError("invalid_ref");
    return Object.freeze({ objectFormat, storageId, contentSha256, byteLength });
  } catch {
    // Inspection failures must not expose caller-defined exception messages or causes.
    throw new MemoryObjectValueError("invalid_ref");
  }
}

export function memoryObjectRefEquals(left: unknown, right: unknown): boolean {
  const a = parseMemoryObjectRef(left), b = parseMemoryObjectRef(right);
  return a.objectFormat === b.objectFormat && a.storageId === b.storageId
    && a.contentSha256 === b.contentSha256 && a.byteLength === b.byteLength;
}

export function memoryObjectRelativeKey(value: unknown): string {
  const ref = parseMemoryObjectRef(value);
  return `objects/sha256/${ref.contentSha256.slice(0, 2)}/${ref.contentSha256}.md`;
}

function bodyLimit(value: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)
      || value < 0 || value > MAX_BODY_BYTES)
    throw new MemoryObjectValueError("invalid_limit");
  return value;
}

function bodyValue(markdown: string, bytes: Uint8Array): Readonly<MemoryObjectBodyValue> {
  // The caller owns these bytes. No retained state treats this data as verified authority.
  return Object.freeze({ bytes, markdown, contentSha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength });
}

export function encodeMemoryObjectBody(value: unknown, maxDocumentBytes: number): Readonly<MemoryObjectBodyValue> {
  const limit = bodyLimit(maxDocumentBytes);
  if (typeof value !== "string") throw new MemoryObjectValueError("invalid_body");
  // UTF-8 is never shorter than a valid string's UTF-16 code-unit count. Bound scanning before encoding.
  if (value.length > limit) throw new MemoryObjectValueError("body_limit_exceeded");
  if (/[\uD800-\uDFFF]/u.test(value)) throw new MemoryObjectValueError("invalid_body");
  if (Buffer.byteLength(value, "utf8") > limit) throw new MemoryObjectValueError("body_limit_exceeded");
  return bodyValue(value, new TextEncoder().encode(value));
}

function copyBytes(value: Uint8Array, limit: number): Uint8Array {
  let length: number;
  try {
    if (!ArrayBuffer.isView(value) || TYPED_ARRAY_NAME.call(value) !== "Uint8Array")
      throw new MemoryObjectValueError("invalid_body");
    length = TYPED_ARRAY_BYTE_LENGTH.call(value) as number;
  } catch {
    throw new MemoryObjectValueError("invalid_body");
  }
  if (length > limit) throw new MemoryObjectValueError("body_limit_exceeded");
  try {
    const copy = new Uint8Array(length);
    // Intrinsics use the actual view, without caller getters, iterators or species constructors.
    COPY_TYPED_ARRAY.call(copy, value);
    return copy;
  } catch {
    // Detached or concurrently resized views do not become empty or truncated successful inputs.
    throw new MemoryObjectValueError("invalid_body");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
  return true;
}

export function decodeMemoryObjectBody(value: Uint8Array, maxDocumentBytes: number): Readonly<MemoryObjectBodyValue> {
  const bytes = copyBytes(value, bodyLimit(maxDocumentBytes));
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!equalBytes(bytes, new TextEncoder().encode(markdown))) throw new MemoryObjectValueError("invalid_utf8");
  } catch {
    throw new MemoryObjectValueError("invalid_utf8");
  }
  return bodyValue(markdown, bytes);
}

export function memoryObjectBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const a = copyBytes(left, MAX_BODY_BYTES), b = copyBytes(right, MAX_BODY_BYTES);
  return equalBytes(a, b);
}
