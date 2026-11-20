/** Closed module values only; these parsing bounds are not a database-operation budget. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const MODULE_VALUE_MAX_BYTES = 16 * 1024 * 1024;

export function readModuleJson(input: unknown): JsonValue {
  if (typeof input !== "string" || input.length > MODULE_VALUE_MAX_BYTES
    || Buffer.byteLength(input, "utf8") > MODULE_VALUE_MAX_BYTES) throw new Error("module_value_invalid");
  let offset = 0, nodes = 0;
  const invalid = (): never => { throw new Error("module_value_invalid"); };
  const space = () => { while (offset < input.length && /[\x20\t\r\n]/.test(input[offset]!)) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < input.length) {
      const character = input[offset++]!;
      if (character === '"') {
        const value: string = JSON.parse(input.slice(start, offset));
        for (let i = 0; i < value.length; i++) {
          const code = value.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            const low = value.charCodeAt(++i);
            if (!(low >= 0xdc00 && low <= 0xdfff)) invalid();
          } else if (code >= 0xdc00 && code <= 0xdfff) invalid();
        }
        return value;
      }
      if (character === "\\") {
        const escape = input[offset++];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(input.slice(offset, offset + 4))) invalid();
          offset += 4;
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) invalid();
      } else if (character.charCodeAt(0) < 0x20) invalid();
    }
    return invalid();
  };
  const value = (depth: number): JsonValue => {
    if (depth > 64 || ++nodes > 250_000) invalid();
    space();
    const character = input[offset];
    if (character === '"') return string();
    if (character === "{") {
      offset++; space();
      const result: { [key: string]: JsonValue } = {};
      if (input[offset] === "}") { offset++; return result; }
      for (;;) {
        if (input[offset] !== '"') invalid();
        const key = string();
        if (Object.hasOwn(result, key)) invalid();
        space(); if (input[offset++] !== ":") invalid();
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        space();
        const separator = input[offset++];
        if (separator === "}") return result;
        if (separator !== ",") invalid();
        space();
      }
    }
    if (character === "[") {
      offset++; space();
      const result: JsonValue[] = [];
      if (input[offset] === "]") { offset++; return result; }
      for (;;) {
        result.push(value(depth + 1)); space();
        const separator = input[offset++];
        if (separator === "]") return result;
        if (separator !== ",") invalid();
      }
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
      if (input.startsWith(literal, offset)) { offset += literal.length; return parsed; }
    }
    // This closed schema has only integer numeric fields. OIDs/costs remain exact strings.
    const number = /^-?(?:0|[1-9][0-9]*)/.exec(input.slice(offset));
    if (!number) return invalid();
    offset += number[0].length;
    const parsed = Number(number[0]);
    if (!Number.isSafeInteger(parsed) || Object.is(parsed, -0)) invalid();
    return parsed;
  };
  const result = value(0); space();
  if (offset !== input.length) invalid();
  return result;
}
