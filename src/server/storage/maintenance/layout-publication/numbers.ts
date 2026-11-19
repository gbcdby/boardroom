import type { AppConfig } from "../../../config.ts";
import type { Original } from "./schema.ts";
import type { NumberSources } from "./data.ts";
import { fail } from "./data.ts";

/** Compare mathematical integers without ever allocating a caller-sized BigInt or power of ten. */
function spellingEquals(token: string, expected: number): boolean {
  if (!Number.isSafeInteger(expected) || Object.is(expected, -0)) return false;
  const text = token.trim();
  const radix = /^0([xob])([0-9a-f]+)$/i.exec(text);
  if (radix) {
    const prefix = radix[1]!.toLowerCase(), digits = radix[2]!.replace(/^0+/, "") || "0";
    const limits = { x: 14, o: 18, b: 54 } as const;
    if (!(prefix in limits) || digits.length > limits[prefix as keyof typeof limits]) return false;
    if (!(prefix === "x" ? /^[0-9a-f]+$/i : prefix === "o" ? /^[0-7]+$/ : /^[01]+$/).test(digits)) return false;
    return BigInt(`0${prefix}${digits}`) === BigInt(expected);
  }
  const decimal = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (!decimal || (decimal[2]!.length === 0 && (decimal[3]?.length ?? 0) === 0)) return false;
  const fraction = decimal[3] ?? "";
  const digits = (decimal[2]! + fraction).replace(/^0+/, "");
  if (digits === "") return expected === 0;
  const significant = digits.replace(/0+$/, "");
  if (significant.length > 16) return false;
  const rawExponent = decimal[4] ?? "0";
  const exponentDigits = rawExponent.replace(/^[+-]/, "").replace(/^0+/, "") || "0";
  const exponentText = (rawExponent.startsWith("-") ? "-" : "") + exponentDigits;
  // A nonzero bounded coefficient with a larger exponent cannot equal a safe integer.
  // This still allows long exact spellings such as 5000...e-<matching zero count>.
  if (exponentText.length > 8) return false;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > text.length + 16) return false;
  const shift = exponent - fraction.length + digits.length - significant.length;
  if (shift < 0 || significant.length + shift > 16) return false;
  const integer = BigInt(significant + "0".repeat(shift));
  return (decimal[1] === "-" ? -integer : integer) === BigInt(expected);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function exact(value: unknown, holder: object, key: string, expected: number, sources: NumberSources): boolean {
  if (typeof value === "number") {
    const token = sources.get(holder)?.get(key);
    return token !== undefined && spellingEquals(token, expected);
  }
  if (typeof value === "string") return spellingEquals(value, expected);
  if (typeof value === "boolean") return (value ? 1 : 0) === expected;
  if (value === null) return expected === 0;
  // For a positive Number(array), only a single nested string/number can work.
  // Inspect that original leaf rather than the already-rounded Array.toString().
  if (Array.isArray(value) && value.length === 1 && typeof value[0] !== "boolean")
    return exact(value[0], value, "0", expected, sources);
  return false;
}
export function checkNumbers(original: Original, file: Record<string, unknown>, sources: NumberSources, parsed: AppConfig): void {
  const heartbeat = record(file.heartbeat), antiLoop = record(file.antiLoop), memory = record(file.memory);
  const fields: readonly [keyof Original["environment"], Record<string, unknown>, string, number][] = [
    ["AGENT_STUDIO_PORT", file, "port", parsed.port],
    ["AGENT_STUDIO_HEARTBEAT_INTERVAL_MS", heartbeat, "intervalMs", parsed.heartbeat.intervalMs],
    ["AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS", heartbeat, "timeoutMs", parsed.heartbeat.timeoutMs],
    ["AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES", antiLoop, "maxConsecutiveAutoReplies", parsed.antiLoop!.maxConsecutiveAutoReplies],
    ["AGENT_STUDIO_MAX_WAKES_PER_MINUTE_PER_MEMBER", antiLoop, "maxWakesPerMinutePerMember", parsed.antiLoop!.maxWakesPerMinutePerMember],
    ["AGENT_STUDIO_MEMORY_MESSAGE_THRESHOLD", memory, "messageThreshold", parsed.memory!.messageThreshold],
    ["AGENT_STUDIO_MEMORY_MAX_DOCUMENT_BYTES", memory, "maxDocumentBytes", parsed.memory!.maxDocumentBytes],
    ["AGENT_STUDIO_MEMORY_MAX_INJECTED_BYTES", memory, "maxInjectedBytes", parsed.memory!.maxInjectedBytes],
    ["AGENT_STUDIO_MEMORY_SUMMARY_INPUT_BYTES", memory, "summaryInputBytes", parsed.memory!.summaryInputBytes],
    ["AGENT_STUDIO_MEMORY_SUMMARY_ATTEMPT_TIMEOUT_MS", memory, "summaryAttemptTimeoutMs", parsed.memory!.summaryAttemptTimeoutMs],
  ];
  for (const [environmentKey, holder, key, expected] of fields) {
    if (!Number.isSafeInteger(expected) || Object.is(expected, -0)) fail("semantic_unsupported", "E1_NUMBER");
    const environmentValue = original.environment[environmentKey];
    const valid = environmentValue !== null ? spellingEquals(environmentValue, expected)
      : holder[key] === undefined || exact(holder[key], holder, key, expected, sources);
    if (!valid) fail("semantic_unsupported", "E1_NUMBER");
  }
}
