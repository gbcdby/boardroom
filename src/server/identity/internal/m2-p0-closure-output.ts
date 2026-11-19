import { createHash } from "node:crypto";
import { chargeP0, failP0 } from "./m2-p0.ts";
import { freezeP0Data, p0State, P0_LIMITS } from "./m2-p0-budget.ts";
import { P0_TABLE_NAMES } from "./m2-p0-types.ts";
import type { P0Request } from "./m2-p0-types.ts";
import { historyFrameSortCost } from "./m2-history-sort.ts";
import type { RawRow } from "../m2-history-contracts.ts";
import type { ReadonlyDeep } from "../m2-value-contracts.ts";

interface Encoding { readonly parts: readonly (string | Encoding)[]; readonly bytes: number; text?: string; digest?: string; }
interface RawFrame { readonly text: string; readonly quoted: Encoding; }

/** Read complete frames only as far as their actual lexical comparison needs.
 * Every block is prepaid at two bytes per UTF-16 unit on BOTH sides. Numerical
 * comparisons are charged before charCodeAt, including equal/common prefixes. */
function asciiBefore(request: P0Request, left: string, right: string): boolean {
  const length = Math.min(left.length, right.length);
  for (let start = 0; start < length; start += 64) {
    const end = Math.min(start + 64, length);
    chargeP0(request, { work: 1, bytes: (end - start) * 4 });
    for (let at = start; at < end; at++) {
      chargeP0(request, { work: 2 });
      const a = left.charCodeAt(at), b = right.charCodeAt(at);
      if (a !== b) return a < b;
    }
  }
  chargeP0(request, { work: 1 });
  return left.length <= right.length;
}

function sortFrames<T extends string | RawFrame>(request: P0Request, frames: readonly T[]): T[] {
  const cost = historyFrameSortCost(frames.length);
  chargeP0(request, { work: cost.comparisons + cost.moves, tuples: cost.slots });
  let source = [...frames];
  if (source.length < 2) return source;
  let target = new Array<T>(source.length);
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length), end = Math.min(start + width * 2, source.length);
      let left = start, right = middle;
      for (let output = start; output < end; output++) {
        let before = false;
        if (left < middle && right < end) {
          const a = source[left]!, b = source[right]!;
          before = asciiBefore(request, typeof a === "string" ? a : a.text, typeof b === "string" ? b : b.text);
        }
        target[output] = right === end || left < middle && before ? source[left++]! : source[right++]!;
      }
    }
    const previous = source; source = target; target = previous;
  }
  return source;
}
/** Fixed stable merge of complete ASCII frame values; never a digest-only key. */
export function sortedClosureFrames(request: P0Request, frames: readonly string[]): string[] {
  return sortFrames(request, frames);
}

/** Request-local byte data, not a semantic receipt. The only unescaped strings
 * are immutable RawCell members and selected bytesHex already checked by A.
 * Their identity is recorded from this request, never inferred from a key name.
 * Other strings keep the full R3 escaping and Unicode/codepoint-key rules. */
export class ClosureEncoder {
  readonly request: P0Request;
  private readonly cells: WeakSet<object>;
  private readonly selected: WeakSet<object>;
  private readonly encodings: WeakMap<object, Encoding>;
  private readonly strings: Map<string, Encoding>;
  constructor(request: P0Request) {
    this.request = request;
    chargeP0(request, { work: 5, tuples: 4 });
    this.cells = new WeakSet(); this.selected = new WeakSet(); this.encodings = new WeakMap(); this.strings = new Map();
    for (const table of P0_TABLE_NAMES) for (const row of request.original.rows(table)) {
      chargeP0(request, { work: row.raw.cells.length, tuples: row.raw.cells.length });
      for (const cell of row.raw.cells) this.cells.add(cell);
    }
    for (const selector of request.input.proposedDeletion?.rows ?? []) {
      chargeP0(request, { work: selector.key.length, tuples: selector.key.length });
      for (const cell of selector.key) this.cells.add(cell);
    }
    chargeP0(request, { work: request.input.artifacts.length, tuples: request.input.artifacts.length });
    for (const item of request.input.artifacts) this.selected.add(item);
  }
  private ascii(text: string): Encoding {
    // No character traversal or copied quoted string: three existing chunks are
    // consumed later by the metered join or SHA stream.
    chargeP0(this.request, { work: 1, tuples: 4 });
    return { parts: ['"', text, '"'], bytes: text.length + 2 };
  }
  /** Only tableRowsDigest can call this, with this request's admitted raw rows.
   * A proved every cell member/rowid to be closed ASCII without quote/backslash.
   * Construct the complete sort frame and its second-level JSON emission plan
   * together: no scan/stringify/copy of the complete frame to quote it again. */
  private rawFrame(row: ReadonlyDeep<RawRow>): RawFrame {
    chargeP0(this.request, { work: 1, tuples: 6 });
    const parts: string[] = [], quoted: string[] = ['"'];
    let bytes = 0, quotedBytes = 1;
    const emit = (part: string, escaped = part): void => {
      chargeP0(this.request, { work: 1, tuples: 2 });
      parts.push(part); quoted.push(escaped); bytes += part.length; quotedBytes += escaped.length;
    };
    if (row.rowid === null) emit("[null,[");
    else { emit('["', '[\\"'); emit(row.rowid); emit('",[', '\\",['); }
    for (let column = 0; column < row.cells.length; column++) {
      chargeP0(this.request, { work: 1 });
      if (column) emit(",");
      emit('["', '[\\"');
      const cell = row.cells[column]!;
      for (let part = 0; part < cell.length; part++) {
        if (part) emit('\",\"', '\\",\\"');
        emit(cell[part]!);
      }
      emit('\"]', '\\\"]');
    }
    emit("]]");
    chargeP0(this.request, { work: parts.length + 1, bytes: bytes * 2, tuples: 1 });
    quoted.push('"'); quotedBytes++;
    return { text: parts.join(""), quoted: { parts: quoted, bytes: quotedBytes } };
  }
  /** Exact original table domain; the digest array still contains JSON strings
   * of FULL sorted frames. The private frame record is never public JSON. */
  tableRowsDigest(ordinal: number): string {
    chargeP0(this.request, { work: 1 });
    const observation = this.request.input.graph.observation;
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= observation.tables.length)
      failP0(this.request, { code: "invalid_value", rule: null });
    const table = observation.tables[ordinal]!;
    chargeP0(this.request, { work: table.rows.length + 6, tuples: table.rows.length + 10 });
    const frames = new Array<RawFrame>(table.rows.length);
    for (let index = 0; index < table.rows.length; index++) frames[index] = this.rawFrame(table.rows[index]!);
    const sorted = sortFrames(this.request, frames), parts: (string | Encoding)[] = [];
    let bytes = 0;
    const emit = (part: string | Encoding): void => {
      chargeP0(this.request, { work: 1, tuples: 1 });
      parts.push(part); bytes += typeof part === "string" ? part.length : part.bytes;
    };
    const header = ["m2-pc-table-rows/r1", observation.backend, table.name, table.columnContractValueDigest, table.count];
    emit("[");
    for (let index = 0; index < header.length; index++) {
      if (index) emit(",");
      emit(this.quote(header[index]!));
    }
    emit(",[");
    for (let index = 0; index < sorted.length; index++) {
      if (index) emit(",");
      emit(sorted[index]!.quoted);
    }
    emit("]]");
    return this.hash({ parts, bytes });
  }
  private quote(text: string): Encoding {
    const small = text.length <= 128;
    if (small) {
      chargeP0(this.request, { work: 1, bytes: text.length * 2 });
      const known = this.strings.get(text); if (known) return known;
    }
    chargeP0(this.request, { work: 1, bytes: text.length * 2 });
    let bytes = 2;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit === 34 || unit === 92 || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13) bytes += 2;
      else if (unit < 32) bytes += 6;
      else if (unit < 128) bytes++;
      else if (unit < 2048) bytes += 2;
      else if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = text.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) failP0(this.request, { code: "invalid_value", rule: null });
        bytes += 4;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) failP0(this.request, { code: "invalid_value", rule: null });
      else bytes += 3;
    }
    chargeP0(this.request, { work: 1, bytes: text.length * 2 + bytes, tuples: small ? 3 : 2 });
    const encoded = JSON.stringify(text), result = { parts: [encoded], bytes, text: encoded };
    if (small) this.strings.set(text, result);
    return result;
  }
  private keys(value: object): string[] {
    let count = 0;
    for (const key in value) { chargeP0(this.request, { work: 1 }); if (Object.hasOwn(value, key)) count++; }
    const cost = historyFrameSortCost(count);
    chargeP0(this.request, { work: count + cost.comparisons + cost.moves, tuples: cost.slots + 2 });
    if (count < 2) return Object.keys(value);
    let source = Object.keys(value), target = new Array<string>(source.length);
    const before = (left: string, right: string): boolean => {
      chargeP0(this.request, { bytes: (left.length + right.length) * 2 });
      let a = 0, b = 0;
      while (a < left.length && b < right.length) {
        const x = left.codePointAt(a)!, y = right.codePointAt(b)!;
        if (x !== y) return x < y;
        a += x > 0xffff ? 2 : 1; b += y > 0xffff ? 2 : 1;
      }
      return left.length <= right.length;
    };
    for (let width = 1; width < source.length; width *= 2) {
      for (let start = 0; start < source.length; start += width * 2) {
        const middle = Math.min(start + width, source.length), end = Math.min(start + width * 2, source.length);
        let left = start, right = middle;
        for (let out = start; out < end; out++) target[out] = right === end || left < middle && before(source[left]!, source[right]!)
          ? source[left++]! : source[right++]!;
      }
      [source, target] = [target, source];
    }
    return source;
  }
  private encode(value: unknown): Encoding {
    chargeP0(this.request, { work: 1 });
    if (value !== null && typeof value === "object") {
      const previous = this.encodings.get(value); if (previous) return previous;
    }
    if (typeof value === "string") return this.quote(value);
    if (value === null || typeof value === "boolean") {
      chargeP0(this.request, { tuples: 2 });
      return { parts: [value === null ? "null" : value ? "true" : "false"], bytes: value === null ? 4 : value ? 4 : 5 };
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) failP0(this.request, { code: "invalid_value", rule: null });
      chargeP0(this.request, { work: 1, bytes: 64, tuples: 2 });
      const text = JSON.stringify(value); return { parts: [text], bytes: text.length };
    }
    if (typeof value !== "object") failP0(this.request, { code: "unsupported_shape", rule: null });
    if (Array.isArray(value) && this.cells.has(value)) {
      // This exact frozen cell was admitted by A. Emit its closed ASCII members
      // as one flat token plan, without per-string Encoding objects or recursion.
      chargeP0(this.request, { work: value.length * 2 + 3, tuples: value.length * 2 + 4 });
      const parts: string[] = ['["']; let bytes = 4;
      for (let index = 0; index < value.length; index++) {
        if (index) { parts.push('\",\"'); bytes += 3; }
        const member = value[index] as string; parts.push(member); bytes += member.length;
      }
      parts.push('\"]');
      const encoded: Encoding = { parts, bytes }; this.encodings.set(value, encoded); return encoded;
    }
    chargeP0(this.request, { work: 1, tuples: 2 });
    const parts: (string | Encoding)[] = [];
    let bytes = 0;
    const emit = (part: string | Encoding): void => {
      chargeP0(this.request, { work: 1, tuples: 1 }); parts.push(part);
      bytes += typeof part === "string" ? part.length : part.bytes;
    };
    if (Array.isArray(value)) {
      emit("[");
      for (let i = 0; i < value.length; i++) { if (i) emit(","); emit(this.encode(value[i])); }
      emit("]");
    } else {
      const object = value as Record<string, unknown>, keys = this.keys(object), selected = this.selected.has(object);
      emit("{");
      for (let i = 0; i < keys.length; i++) {
        if (i) emit(",");
        const key = keys[i]!; emit(this.quote(key)); emit(":");
        emit(selected && key === "bytesHex" ? this.ascii(object[key] as string) : this.encode(object[key]));
      }
      emit("}");
    }
    chargeP0(this.request, { work: 1, tuples: 2 });
    const encoded: Encoding = { parts, bytes }; this.encodings.set(value, encoded); return encoded;
  }
  private owned(value: unknown): Encoding {
    // Callers are the fixed G composition. New domain arrays and result records
    // are frozen before their encodings can enter this request's identity cache.
    freezeP0Data(p0State(this.request), value);
    return this.encode(value);
  }
  private *chunks(value: Encoding): Generator<string> {
    chargeP0(this.request, { work: 1 });
    if (value.text !== undefined) { yield value.text; return; }
    for (const part of value.parts) {
      chargeP0(this.request, { work: 1 });
      if (typeof part === "string") yield part; else yield* this.chunks(part);
    }
  }
  text(value: unknown): string {
    const encoded = this.owned(value); if (encoded.text !== undefined) return encoded.text;
    chargeP0(this.request, { work: 1, bytes: encoded.bytes * 2 });
    const parts: string[] = [];
    for (const part of this.chunks(encoded)) { chargeP0(this.request, { work: 1, tuples: 1 }); parts.push(part); }
    encoded.text = parts.join(""); return encoded.text;
  }
  private hash(encoded: Encoding): string {
    if (encoded.digest !== undefined) return encoded.digest;
    // One exact UTF-8 encoding/read and one SHA input read. Each update is also
    // charged before execution; no full canonical string or Buffer is joined.
    chargeP0(this.request, { work: 2, bytes: encoded.bytes * 2 + 64 });
    const hash = createHash("sha256");
    for (const part of this.chunks(encoded)) { chargeP0(this.request, { work: 1 }); hash.update(part, "utf8"); }
    encoded.digest = hash.digest("hex"); return encoded.digest;
  }
  digest(value: unknown): string { return this.hash(this.owned(value)); }
  bytes(value: unknown): number { return this.owned(value).bytes; }
}

/** Output is all-or-error. Neither coverage nor availability can be truncated. */
export function freezeClosureOutput<T>(request: P0Request, result: T, encoder: ClosureEncoder): T {
  // The fixed public {"ok":true,"value":...} envelope adds exactly 20 bytes.
  // Its object and eventual encoding belong to the same complete output limit.
  const bytes = encoder.bytes(result) + 20;
  if (bytes > P0_LIMITS.output) failP0(request, { code: "resource_limit", rule: null });
  chargeP0(request, { work: 1, bytes: bytes * 2, tuples: 1 });
  return result;
}
