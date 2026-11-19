import { chargeState, freezeP0Data, p0State, P0_LIMITS, siteData, throwP0 } from "./m2-p0-budget.ts";
import type { P0State } from "./m2-p0-budget.ts";
import type { P0JsonPolicy, P0Request, P0Site } from "./m2-p0-types.ts";

export function wellFormedP0(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
// Exact mathematical integer test before Number conversion. Long exponents never reach BigInt.
function exactInteger(token: string, negativeZero: boolean): boolean {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!match) return false;
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
  if (!digits) return negativeZero || match[1] !== "-";
  const exponentText = (match[4] ?? "0").replace(/^[+-]/, "").replace(/^0+/, "");
  if (exponentText.length > 8) return false;
  const exponent = Number(exponentText || "0") * (match[4]?.startsWith("-") ? -1 : 1);
  // A trailing /0+$/ retries through every internal run before a nonzero end.
  // This scan is linear within the token reservation, and rejected large
  // integers never allocate a second significant-digit string.
  let significantLength = digits.length;
  while (significantLength > 0 && digits.charCodeAt(significantLength - 1) === 0x30) significantLength--;
  const shift = exponent - (match[3]?.length ?? 0) + digits.length - significantLength;
  if (shift < 0 || significantLength + shift > 16) return false;
  const integer = digits.slice(0, significantLength) + "0".repeat(shift);
  return integer.length < 16 || integer <= "9007199254740991";
}
export interface JsonScanOptions { readonly policy: P0JsonPolicy; readonly outer: boolean }
export function scanP0Json(state: P0State, text: string, site: P0Site, options: JsonScanOptions): unknown {
  const { depth: baseDepth } = siteData(state, site);
  const invalidLegacySyntax = Object.freeze({});
  const fail = (): never => {
    if (!options.outer && options.policy === "legacy-display") throw invalidLegacySyntax;
    throwP0(state, { code: options.outer ? "invalid_value" : "semantic_unsupported", rule: "PC1B-RAW01", site });
  };
  const limit = (): never => throwP0(state, { code: "resource_limit", rule: "PC1B-RAW01", site });
  if (typeof text !== "string") return fail();
  if (!["reference", "finite", "legacy-display"].includes(options.policy)) return fail();
  if (text.length > P0_LIMITS.outerBytes) return limit();
  // Reserve the first size scan before performing it. UTF-8 bytes are never fewer
  // than UTF-16 code units; add the exact difference before any JSON token decoding.
  chargeState(state, { bytes: text.length * 5, work: 1 }, site);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > P0_LIMITS.outerBytes) return limit();
  // Includes size measurement, scanner, token decoding/well-formedness and JSON.parse.
  chargeState(state, { bytes: (bytes - text.length) * 5 }, site);
  let at = 0, maximumDepth = baseDepth;
  const node = (depth: number): void => {
    if (depth > P0_LIMITS.depth) limit();
    maximumDepth = Math.max(maximumDepth, depth);
    chargeState(state, { nodes: 1, work: 1 }, site);
  };
  const space = (): void => { while (at < text.length && (text[at] === " " || text[at] === "\t" || text[at] === "\r" || text[at] === "\n")) at++; };
  const string = (): string => {
    if (text[at++] !== '"') return fail();
    const start = at - 1;
    let complete = false;
    while (at < text.length) {
      const char = text[at++]!;
      if (char === '"') { complete = true; break; }
      if (char.charCodeAt(0) < 32) return fail();
      if (char === "\\") {
        const escape = text[at++];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4))) return fail();
          at += 4;
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return fail();
      }
    }
    if (!complete) return fail();
    chargeState(state, { work: 1 + Math.ceil((at - start) / 64) }, site);
    const decoded: string = JSON.parse(text.slice(start, at));
    // Semantic TEXT may contain escaped lone surrogates where its original owner codec allows them.
    if (options.outer && !wellFormedP0(decoded)) return fail();
    return decoded;
  };
  const value = (depth: number): void => {
    space(); node(depth);
    if (text[at] === '"') { string(); return; }
    if (text[at] === "{") {
      at++; space();
      const keys = options.policy === "legacy-display" ? null : new Set<string>();
      if (text[at] === "}") { at++; return; }
      for (;;) {
        // Both the decoded key and its value are JSON nodes, including repeated legacy keys.
        node(depth + 1); const key = string();
        if (keys?.has(key)) return fail(); keys?.add(key);
        space(); if (text[at++] !== ":") return fail();
        value(depth + 1); space();
        const separator = text[at++];
        if (separator === "}") return;
        if (separator !== ",") return fail();
        space();
      }
    }
    if (text[at] === "[") {
      at++; space(); if (text[at] === "]") { at++; return; }
      for (;;) {
        value(depth + 1); space(); const separator = text[at++];
        if (separator === "]") return;
        if (separator !== ",") return fail();
      }
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) at++;
    const token = text.slice(start, at);
    if (token === "true" || token === "false" || token === "null") return;
    chargeState(state, { bytes: token.length * 4, work: 1 }, site);
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token)) return fail();
    if (options.policy === "reference" && !exactInteger(token, !options.outer)) return fail();
    if (options.policy === "finite" && !Number.isFinite(Number(token))) return fail();
  };
  try {
    value(baseDepth); space(); if (at !== text.length) return fail();
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") state.jsonHeights.set(parsed, maximumDepth - baseDepth);
    const remember = (child: unknown, depth: number): void => {
      chargeState(state, { work: 1 }, site);
      if (child !== null && typeof child === "object") {
        state.depths.set(child, depth);
        for (const key of Object.keys(child)) { chargeState(state, { work: 1 }, site); remember((child as Record<string, unknown>)[key], depth + 1); }
      }
    };
    remember(parsed, baseDepth);
    return freezeP0Data(state, parsed);
  } catch (error) {
    // Only this scanner's syntax token is an unavailable legacy display. Resource,
    // encoding, known semantic failures and unknown exceptions are never swallowed.
    if (error === invalidLegacySyntax) return undefined;
    throw error;
  }
}
export function parseP0Json(request: P0Request, text: string, site: P0Site, policy: P0JsonPolicy = "reference"): unknown {
  return scanP0Json(p0State(request), text, site, { policy, outer: false });
}
