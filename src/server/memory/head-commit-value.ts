import { digestJson } from "../storage/maintenance/canonical.ts";
import { getLayoutValueErrorCode, LayoutValueError } from "../storage/maintenance/layout-values.ts";
import type { MemoryPublicationPlanValue } from "./publication-plan.ts";

export type ErrorCode = LayoutValueError["code"];

const INPUT_CONTRACT = "memory-head-commit-input/r1" as const;
const DECISION_CONTRACT = "memory-head-commit-decision/r1" as const;
const PLAN_CONTRACT = "memory-publication-plan-value/r1" as const;
const HASH = /^[0-9a-f]{64}$/;
const INPUT_FIELDS = Object.freeze(["contract", "plan", "durableObjectDigests", "currentHead", "expectedHead", "targetHead", "mutation"] as const);
const HEAD_FIELDS = Object.freeze(["version", "receipt", "digest", "mutationKey", "contentDigest"] as const);
const MUTATION_FIELDS = Object.freeze(["key", "contentDigest"] as const);
const PLAN_FIELDS = Object.freeze(["contract", "authorityDigest", "objects", "digest"] as const);
const OBJECT_FIELDS = Object.freeze(["relativePath", "refDigest", "byteLength", "objectDigest"] as const);
const MAX_NODES = 250_000;
const MAX_BYTES = 32 * 1_048_576;
const MAX_DEPTH = 128;
const MAX_TEXT = 4096;

/** Immutable DB head projection supplied by the caller; it carries no write or receipt-generation authority. */
export interface MemoryHeadCommitHeadValue {
  readonly version: number;
  readonly receipt: string;
  readonly digest: string;
  readonly mutationKey: string;
  readonly contentDigest: string;
}

/** Stable mutation identity and its content digest; no body bytes are carried. */
export interface MemoryHeadCommitMutationValue {
  readonly key: string;
  readonly contentDigest: string;
}

/** Frozen value input for one head-commit decision. Durability evidence is external and is never read here. */
export interface MemoryHeadCommitInputValue {
  readonly contract: typeof INPUT_CONTRACT;
  readonly plan: Readonly<MemoryPublicationPlanValue>;
  readonly durableObjectDigests: readonly string[];
  readonly currentHead: Readonly<MemoryHeadCommitHeadValue>;
  readonly expectedHead: Readonly<MemoryHeadCommitHeadValue>;
  readonly targetHead: Readonly<MemoryHeadCommitHeadValue>;
  readonly mutation: Readonly<MemoryHeadCommitMutationValue>;
}

/**
 * Fixed, self-contained rejection codes. They do not grant or withhold execution authority.
 * `incomplete_durability` also rejects an empty plan or a target content digest outside the plan:
 * no durable body evidence can exist for a body the plan never references.
 */
export type MemoryHeadCommitDecisionCode = "incomplete_durability" | "head_conflict" | "mutation_conflict" | "receipt_mismatch";
export type MemoryHeadCommitOutcome = "commit-allowed" | "already-committed" | "rejected";

interface DecisionBase {
  readonly contract: typeof DECISION_CONTRACT;
  readonly mutation: Readonly<MemoryHeadCommitMutationValue>;
  readonly planDigest: string;
  readonly digest: string;
}

export interface MemoryHeadCommitAllowedValue extends DecisionBase {
  readonly outcome: "commit-allowed";
  readonly head: Readonly<MemoryHeadCommitHeadValue>;
  readonly objectDigests: readonly string[];
}

export interface MemoryHeadCommitAlreadyCommittedValue extends DecisionBase {
  readonly outcome: "already-committed";
  readonly head: Readonly<MemoryHeadCommitHeadValue>;
  readonly objectDigests: readonly string[];
}

export interface MemoryHeadCommitRejectedValue extends DecisionBase {
  readonly outcome: "rejected";
  readonly code: MemoryHeadCommitDecisionCode;
}

export type MemoryHeadCommitDecisionValue = MemoryHeadCommitAllowedValue | MemoryHeadCommitAlreadyCommittedValue | MemoryHeadCommitRejectedValue;

interface SnapshotBudget { nodes: number; bytes: number }

function fail(code: ErrorCode): never { throw new LayoutValueError(code); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function requireValue(condition: unknown, code: ErrorCode = "invalid_value"): asserts condition {
  if (!condition) fail(code);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}
function isStableText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !value.includes("\0");
}
function charge(budget: SnapshotBudget, count: number): void {
  budget.bytes += count;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_BYTES) fail("budget_exceeded");
}
function chargeText(budget: SnapshotBudget, text: string): void {
  if (text.length > MAX_BYTES) fail("budget_exceeded");
  charge(budget, Buffer.byteLength(text, "utf8") + 2);
}
function objectKeys(value: unknown): readonly string[] {
  requireValue(value !== null && typeof value === "object");
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value);
  requireValue(keys.every(key => typeof key === "string"));
  return keys as string[];
}
function ownFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const keys = objectKeys(value);
  requireValue(keys.length === fields.length && fields.every(field => keys.includes(field)));
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    requireValue(descriptor && descriptor.enumerable && "value" in descriptor);
    result[field] = descriptor.value;
  }
  return result;
}

/** Descriptor-only copy of frozen caller data: no getter, coercion, prototype or mutation is observed. */
function snapshot(value: unknown, budget: SnapshotBudget, depth = 0): unknown {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) fail("budget_exceeded");
  if (value === null) { charge(budget, 4); return null; }
  if (typeof value === "string") { chargeText(budget, value); return value; }
  if (typeof value === "boolean") { charge(budget, value ? 4 : 5); return value; }
  if (typeof value === "number") {
    requireValue(Number.isSafeInteger(value) && !Object.is(value, -0));
    charge(budget, String(value).length);
    return value;
  }
  requireValue(typeof value === "object" && Object.isFrozen(value));
  if (Array.isArray(value)) {
    requireValue(Object.getPrototypeOf(value) === Array.prototype);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    requireValue(lengthDescriptor && "value" in lengthDescriptor && typeof lengthDescriptor.value === "number"
      && Number.isSafeInteger(lengthDescriptor.value) && lengthDescriptor.value >= 0 && lengthDescriptor.value <= MAX_NODES);
    const length = lengthDescriptor.value;
    requireValue(Reflect.ownKeys(value).length === length + 1);
    charge(budget, 2 + Math.max(0, length - 1));
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      requireValue(descriptor && descriptor.enumerable && "value" in descriptor);
      result.push(snapshot(descriptor.value, budget, depth + 1));
    }
    return Object.freeze(result);
  }
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value);
  charge(budget, 2 + Math.max(0, keys.length - 1));
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    requireValue(typeof key === "string");
    chargeText(budget, key);
    charge(budget, 1);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor && descriptor.enumerable && "value" in descriptor);
    Object.defineProperty(result, key, { value: snapshot(descriptor.value, budget, depth + 1), enumerable: true });
  }
  return Object.freeze(result);
}

function validateHashList(value: unknown): readonly string[] {
  requireValue(Array.isArray(value));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    requireValue(isHash(item));
    requireValue(!seen.has(item), "inventory_integrity");
    seen.add(item);
    result.push(item);
  }
  return Object.freeze(result);
}

function validatePlan(value: unknown): Readonly<MemoryPublicationPlanValue> {
  const fields = ownFields(value, [...PLAN_FIELDS]);
  requireValue(fields.contract === PLAN_CONTRACT, "unsupported_shape");
  requireValue(isHash(fields.authorityDigest) && isHash(fields.digest), "inventory_integrity");
  requireValue(Array.isArray(fields.objects));
  const digests = new Set<string>();
  const objects = fields.objects.map(item => {
    const entry = ownFields(item, [...OBJECT_FIELDS]);
    requireValue(isHash(entry.objectDigest) && isHash(entry.refDigest), "inventory_integrity");
    requireValue(isStableText(entry.relativePath) && entry.relativePath.length <= 4096, "inventory_integrity");
    requireValue(typeof entry.byteLength === "number" && Number.isSafeInteger(entry.byteLength) && entry.byteLength >= 0, "inventory_integrity");
    requireValue(!digests.has(entry.objectDigest), "inventory_integrity");
    digests.add(entry.objectDigest);
    return Object.freeze({ relativePath: entry.relativePath, refDigest: entry.refDigest,
      byteLength: entry.byteLength, objectDigest: entry.objectDigest });
  });
  requireValue(digestJson({ contract: PLAN_CONTRACT, authorityDigest: fields.authorityDigest, objects }) === fields.digest,
    "inventory_integrity");
  return Object.freeze({ contract: PLAN_CONTRACT, authorityDigest: fields.authorityDigest,
    objects: Object.freeze(objects), digest: fields.digest }) as Readonly<MemoryPublicationPlanValue>;
}

function validateHead(value: unknown): Readonly<MemoryHeadCommitHeadValue> {
  const fields = ownFields(value, [...HEAD_FIELDS]);
  requireValue(typeof fields.version === "number" && Number.isSafeInteger(fields.version) && fields.version > 0, "inventory_integrity");
  requireValue(isHash(fields.receipt) && isHash(fields.digest) && isHash(fields.contentDigest), "inventory_integrity");
  requireValue(isStableText(fields.mutationKey), "inventory_integrity");
  return Object.freeze({ version: fields.version, receipt: fields.receipt, digest: fields.digest,
    mutationKey: fields.mutationKey, contentDigest: fields.contentDigest }) as Readonly<MemoryHeadCommitHeadValue>;
}

function validateMutation(value: unknown): Readonly<MemoryHeadCommitMutationValue> {
  const fields = ownFields(value, [...MUTATION_FIELDS]);
  requireValue(isStableText(fields.key) && isHash(fields.contentDigest), "inventory_integrity");
  return Object.freeze({ key: fields.key, contentDigest: fields.contentDigest }) as Readonly<MemoryHeadCommitMutationValue>;
}

function validateInput(value: unknown): Readonly<MemoryHeadCommitInputValue> {
  const safe = snapshot(value, { nodes: 0, bytes: 0 });
  const fields = ownFields(safe, [...INPUT_FIELDS]);
  requireValue(fields.contract === INPUT_CONTRACT, "unsupported_shape");
  const plan = validatePlan(fields.plan);
  const mutation = validateMutation(fields.mutation);
  const durableObjectDigests = validateHashList(fields.durableObjectDigests);
  const currentHead = validateHead(fields.currentHead);
  const expectedHead = validateHead(fields.expectedHead);
  const targetHead = validateHead(fields.targetHead);
  return Object.freeze({ contract: INPUT_CONTRACT, plan, durableObjectDigests, currentHead, expectedHead, targetHead,
    mutation }) as Readonly<MemoryHeadCommitInputValue>;
}

function sameHead(left: Readonly<MemoryHeadCommitHeadValue>, right: Readonly<MemoryHeadCommitHeadValue>): boolean {
  return left.version === right.version && left.receipt === right.receipt && left.digest === right.digest
    && left.mutationKey === right.mutationKey && left.contentDigest === right.contentDigest;
}
function rejection(input: Readonly<MemoryHeadCommitInputValue>, code: MemoryHeadCommitDecisionCode): Readonly<MemoryHeadCommitRejectedValue> {
  const body = { contract: DECISION_CONTRACT, outcome: "rejected" as const, code,
    mutation: input.mutation, planDigest: input.plan.digest };
  return Object.freeze({ ...body, digest: digestJson(body) }) as Readonly<MemoryHeadCommitRejectedValue>;
}
function advancement(input: Readonly<MemoryHeadCommitInputValue>, outcome: "commit-allowed" | "already-committed",
  objectDigests: readonly string[]): Readonly<MemoryHeadCommitDecisionValue> {
  const body = { contract: DECISION_CONTRACT, outcome, head: input.targetHead, objectDigests,
    mutation: input.mutation, planDigest: input.plan.digest };
  return Object.freeze({ ...body, digest: digestJson(body) }) as Readonly<MemoryHeadCommitDecisionValue>;
}

function decide(value: unknown): Readonly<MemoryHeadCommitDecisionValue> {
  const input = validateInput(value);
  const objectDigests = Object.freeze(input.plan.objects.map(item => item.objectDigest).sort(compareText));
  const durable = new Set<string>(input.durableObjectDigests);
  const plannedObjectDigests = new Set<string>(objectDigests);
  // The target body must be a planned object; otherwise no durability evidence can bind to it.
  if (objectDigests.length === 0 || !plannedObjectDigests.has(input.targetHead.contentDigest)
    || !objectDigests.every(digest => durable.has(digest))) return rejection(input, "incomplete_durability");

  if (input.targetHead.mutationKey !== input.mutation.key
    || input.targetHead.contentDigest !== input.mutation.contentDigest) return rejection(input, "mutation_conflict");
  if ((input.currentHead.mutationKey === input.mutation.key
      || input.expectedHead.mutationKey === input.mutation.key)
    && input.currentHead.contentDigest !== input.mutation.contentDigest
    && input.expectedHead.contentDigest !== input.mutation.contentDigest) return rejection(input, "mutation_conflict");

  const matchingVersionDigest = input.currentHead.version === input.expectedHead.version
    && input.currentHead.digest === input.expectedHead.digest;
  if (matchingVersionDigest && input.currentHead.receipt !== input.expectedHead.receipt) return rejection(input, "receipt_mismatch");
  if (sameHead(input.currentHead, input.targetHead)) return advancement(input, "already-committed", objectDigests);
  if (!sameHead(input.currentHead, input.expectedHead)
    || input.targetHead.version !== input.expectedHead.version + 1
    || input.targetHead.digest === input.expectedHead.digest
    || input.targetHead.receipt === input.expectedHead.receipt) return rejection(input, "head_conflict");
  return advancement(input, "commit-allowed", objectDigests);
}

/**
 * Pure value-layer decision for one DB head advancement. Core invariant: DB head 不能领先耐久正文 — a head never
 * advances to a body without confirmed durability. It checks that the target content digest is one of the
 * planned objects, that all planned objects are durably confirmed, and that the observed DB head still matches
 * the caller's expected head. It grants no storage, publication, CAS, receipt-generation or execution authority
 * and performs no filesystem or database access.
 */
export function decideHeadCommit(input: Readonly<MemoryHeadCommitInputValue>): Readonly<MemoryHeadCommitDecisionValue> {
  try { return decide(input); }
  catch (error) { throw new LayoutValueError(getLayoutValueErrorCode(error) ?? "invalid_value"); }
}
