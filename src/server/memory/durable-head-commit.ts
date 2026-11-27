import { createHash } from "node:crypto";
import type { Actor } from "../authz/authorize.ts";
import { appendAuditEntry, auditActorFrom } from "../audit.ts";
import type { RepositorySet } from "../db/repositories.ts";
import { RepositoryError } from "../db/errors.ts";
import { newId } from "../db/ids.ts";
import { digestJson } from "../storage/maintenance/canonical.ts";
import type { MemoryConfig, MemoryAuthor, MemoryDocument, MemoryKey, MemoryVersion, MemoryWriteSource, WriteMemoryResult } from "../../shared/memory.ts";
import { MemoryError } from "./errors.ts";
import type {
  MemoryHeadCommitAllowedValue, MemoryHeadCommitAlreadyCommittedValue, MemoryHeadCommitDecisionCode,
  MemoryHeadCommitDecisionValue, MemoryHeadCommitHeadValue,
} from "./head-commit-value.ts";
import { assertMemoryMarkdown } from "./injection.ts";
import type { MemoryObjectDurabilityConfirmation, MemoryObjectStore } from "./object-store.ts";
import type { MemoryObjectRef } from "./object-ref.ts";
import { memoryObjectRelativeKey } from "./object-ref.ts";
import type { MemoryPublicationPlanValue } from "./publication-plan.ts";

const PLAN_CONTRACT = "memory-publication-plan-value/r1" as const;
const PLAN_TAG = "memory-durable-write-plan/r1" as const;
const HEAD_TAG = "memory-durable-head/r1" as const;
const VIRTUAL_ZERO = "memory-durable-virtual-zero" as const;
const ZERO_DIGEST = "0".repeat(64);
const GATE_REASONS: Readonly<Record<MemoryHeadCommitDecisionCode, string>> = Object.freeze({
  incomplete_durability: "memory_durable_gate_incomplete",
  head_conflict: "memory_version_conflict",
  mutation_conflict: "memory_mutation_conflict",
  receipt_mismatch: "memory_receipt_mismatch",
});

export type { MemoryHeadCommitDecisionCode, MemoryHeadCommitDecisionValue, MemoryHeadCommitHeadValue } from "./head-commit-value.ts";
export type { MemoryObjectRef } from "./object-ref.ts";

export interface DurableHeadCommitterOptions {
  readonly repos: RepositorySet;
  readonly store: MemoryObjectStore;
  readonly config: Pick<MemoryConfig, "maxDocumentBytes">;
}

/** The only state carried from durability preparation into the locked commit: no authorization conclusion. */
export interface DurableHeadCommitPrepared {
  readonly ref: Readonly<MemoryObjectRef>;
  readonly confirmation: Readonly<MemoryObjectDurabilityConfirmation>;
}

export interface DurableHeadCommitInput {
  readonly key: MemoryKey;
  readonly markdown: string;
  readonly expectedVersion: number;
  readonly clientMutationId: string;
  readonly actor: Actor;
  readonly author: MemoryAuthor;
  readonly at: string;
  readonly source: MemoryWriteSource;
  readonly summaryRequestId?: string | null;
}

export interface DurableHeadCommitResult extends WriteMemoryResult {
  readonly decision: Readonly<MemoryHeadCommitDecisionValue>;
  readonly ref: Readonly<MemoryObjectRef>;
}

export interface DurableHeadCommitter {
  prepare(markdown: unknown): Promise<Readonly<DurableHeadCommitPrepared>>;
  commit(prepared: Readonly<DurableHeadCommitPrepared>, input: DurableHeadCommitInput): Promise<DurableHeadCommitResult>;
}

interface DurableHeadSource {
  readonly documentId: string;
  readonly dbVersion: number;
  readonly actorId: string;
  readonly clientMutationId: string;
  readonly contentSha256: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function conflict(reason: string, message: string): MemoryError {
  return new MemoryError(reason, message, "conflict");
}

/** Fixed gate rejection code → stable domain reason; the body is never included. */
export function durableGateErrorReason(code: MemoryHeadCommitDecisionCode): string {
  return GATE_REASONS[code];
}

/** Exact receipt contract; DB version is the version of the row the head is projected from. */
export function durableHeadReceipt(input: DurableHeadSource): string {
  return digestJson({ documentId: input.documentId, dbVersion: input.dbVersion, actorId: input.actorId,
    clientMutationId: input.clientMutationId, contentSha256: input.contentSha256 });
}

/** A DB row at version N projects to head N+1; the receipt binds its source row. */
export function durableHeadValue(input: DurableHeadSource): Readonly<MemoryHeadCommitHeadValue> {
  const version = input.dbVersion + 1;
  const receipt = durableHeadReceipt(input);
  const mutationKey = digestJson({ actorId: input.actorId, clientMutationId: input.clientMutationId });
  const body = { version, receipt, digest: digestJson([HEAD_TAG, version, receipt, mutationKey, input.contentSha256]),
    mutationKey, contentDigest: input.contentSha256 };
  return Object.freeze(body) as Readonly<MemoryHeadCommitHeadValue>;
}

/** No DB document means version 0: derive a stable virtual zero head at version 1. */
export function virtualZeroDurableHead(documentId: string): Readonly<MemoryHeadCommitHeadValue> {
  return durableHeadValue({ documentId, dbVersion: 0, actorId: VIRTUAL_ZERO,
    clientMutationId: VIRTUAL_ZERO, contentSha256: ZERO_DIGEST });
}

/**
 * Single-object plan for the seam. `authorityDigest` is deliberately derived locally and is NOT an authority
 * conclusion: #162 must replace it with the real authority plan before activating this write path.
 */
export function durableWritePlan(input: {
  readonly ref: Readonly<MemoryObjectRef>;
  readonly mutationKey: string;
  readonly nextVersion: number;
}): Readonly<MemoryPublicationPlanValue> {
  const key = memoryObjectRelativeKey(input.ref);
  const objects = Object.freeze([Object.freeze({
    relativePath: key, refDigest: digestJson(input.ref),
    byteLength: input.ref.byteLength, objectDigest: input.ref.contentSha256,
  })]);
  const payload = { contract: PLAN_CONTRACT,
    authorityDigest: digestJson([PLAN_TAG, key, input.mutationKey, input.nextVersion]), objects };
  return Object.freeze({ ...payload, digest: digestJson(payload) }) as Readonly<MemoryPublicationPlanValue>;
}

function preparedRef(prepared: unknown): Readonly<DurableHeadCommitPrepared> {
  if (prepared === null || typeof prepared !== "object") {
    throw new MemoryError("memory_durable_prepare_invalid", "耐久准备结果无效。", "write_failed");
  }
  const { ref, confirmation } = prepared as Partial<DurableHeadCommitPrepared>;
  if (!ref || !confirmation || !confirmation.ref || confirmation.objectDigest !== ref.contentSha256
    || confirmation.ref.objectFormat !== ref.objectFormat || confirmation.ref.storageId !== ref.storageId
    || confirmation.ref.contentSha256 !== ref.contentSha256 || confirmation.ref.byteLength !== ref.byteLength
    || confirmation.completed.length !== 3
    || confirmation.completed[0] !== "file_sync" || confirmation.completed[1] !== "immutable_name_verified"
    || confirmation.completed[2] !== "directory_sync") {
    throw new MemoryError("memory_durable_prepare_invalid", "耐久确认与对象引用不一致。", "write_failed");
  }
  return Object.freeze({ ref, confirmation });
}

function decisionOrThrow(decision: Readonly<MemoryHeadCommitDecisionValue>):
  Readonly<MemoryHeadCommitAllowedValue | MemoryHeadCommitAlreadyCommittedValue> {
  if (decision.outcome === "rejected") {
    throw conflict(GATE_REASONS[decision.code], "耐久提交门禁拒绝本次写入。");
  }
  return decision;
}

/**
 * Production write-path seam only: publish/freeze the object before taking the project lock, then atomically
 * commit head, version, object ref and audit inside the caller's lock and transaction. It never switches the
 * default write path, never re-confirms durability inside the lock, and grants no #162 activation authority.
 */
export function createDurableHeadCommitter(options: DurableHeadCommitterOptions): DurableHeadCommitter {
  const { repos, store, config } = options;
  function gate(plan: Readonly<MemoryPublicationPlanValue>, ref: Readonly<MemoryObjectRef>,
    confirmation: Readonly<MemoryObjectDurabilityConfirmation>, currentHead: Readonly<MemoryHeadCommitHeadValue>,
    expectedHead: Readonly<MemoryHeadCommitHeadValue>, targetHead: Readonly<MemoryHeadCommitHeadValue>,
    mutationKey: string, contentDigest: string): Readonly<MemoryHeadCommitDecisionValue> {
    try {
      return store.decideHeadCommit(Object.freeze({
        durableObjectDigests: Object.freeze([confirmation.objectDigest]), plan,
        currentHead, expectedHead, targetHead,
        mutation: Object.freeze({ key: mutationKey, contentDigest }),
      }));
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError("memory_durable_gate_invalid", "耐久提交门禁输入无效。", "write_failed");
    }
  }
  return {
    async prepare(markdown) {
      assertMemoryMarkdown(markdown, config.maxDocumentBytes);
      const ref = await store.put(markdown);
      const confirmation = await store.confirmDurable(ref);
      if (ref.byteLength !== confirmation.ref.byteLength || ref.contentSha256 !== confirmation.ref.contentSha256) {
        throw new MemoryError("memory_durable_prepare_invalid", "耐久确认与对象字节数不一致。", "write_failed");
      }
      return Object.freeze({ ref, confirmation });
    },
    async commit(candidate, input) {
      const { ref, confirmation } = preparedRef(candidate);
      if (!input || typeof input !== "object" || !input.key || typeof input.markdown !== "string"
        || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
        || typeof input.clientMutationId !== "string" || input.clientMutationId.trim() === ""
        || typeof input.at !== "string" || !input.author || !input.actor
        || input.author.actorId !== input.actor.actorId) {
        throw new MemoryError("memory_durable_input_invalid", "耐久提交输入无效。", "invalid_argument");
      }
      const key = input.key;
      const contentSha256 = hash(input.markdown);
      const byteLength = assertMemoryMarkdown(input.markdown, config.maxDocumentBytes);
      const actorId = input.actor.actorId;
      const mutationKey = digestJson({ actorId, clientMutationId: input.clientMutationId });
      const current = await repos.memory.get(key);
      const dbVersion = current?.version ?? 0;
      const documentId = current?.id ?? newId();
      const previous = current ? await repos.memory.findMutation(documentId, actorId, input.clientMutationId) : null;
      if (previous) {
        if (previous.contentSha256 !== contentSha256) {
          throw conflict("memory_mutation_conflict", "同一保存标识不能对应不同内容。");
        }
        const replayHead = durableHeadValue({ documentId, dbVersion: previous.version, actorId,
          clientMutationId: input.clientMutationId, contentSha256 });
        const plan = durableWritePlan({ ref, mutationKey, nextVersion: replayHead.version });
        const decision = gate(plan, ref, confirmation, replayHead, replayHead, replayHead,
          mutationKey, contentSha256);
        decisionOrThrow(decision);
        if (decision.outcome !== "already-committed") {
          throw new MemoryError("memory_durable_gate_unexpected", "重放门禁未确认已提交。", "write_failed");
        }
        return Object.freeze({ document: current!, writtenVersion: previous, duplicate: true,
          decision, ref }) as DurableHeadCommitResult;
      }
      if (dbVersion !== input.expectedVersion) {
        throw conflict("memory_version_conflict", "记忆已更新，请保留草稿并读取最新版本。");
      }
      let expectedHead: Readonly<MemoryHeadCommitHeadValue>;
      if (current) {
        const source = await repos.memory.getVersion(documentId, dbVersion);
        if (!source) throw new MemoryError("memory_durable_head_unavailable", "当前记忆版本快照不可用。", "write_failed");
        expectedHead = durableHeadValue({ documentId, dbVersion, actorId: source.author.actorId,
          clientMutationId: source.clientMutationId, contentSha256: source.contentSha256 });
      } else {
        expectedHead = virtualZeroDurableHead(documentId);
      }
      const targetHead = durableHeadValue({ documentId, dbVersion: dbVersion + 1, actorId,
        clientMutationId: input.clientMutationId, contentSha256 });
      const plan = durableWritePlan({ ref, mutationKey, nextVersion: targetHead.version });
      const decision = gate(plan, ref, confirmation, expectedHead, expectedHead, targetHead, mutationKey, contentSha256);
      const advanced = decisionOrThrow(decision);
      if (advanced.outcome === "already-committed") {
        throw conflict("memory_durable_already_committed", "该提交已落库。");
      }
      const next: MemoryDocument = { id: documentId, key: { ...key }, version: dbVersion + 1,
        markdown: input.markdown, byteLength, updatedAt: input.at, updatedBy: input.author, source: input.source };
      return await repos.context.withTransaction(async () => {
        let document: MemoryDocument;
        try {
          document = current ? await repos.memory.updateHeadCas(current.id, dbVersion, next)
            : await repos.memory.insertHead(next);
        } catch (error) {
          if (error instanceof RepositoryError && error.code === "conflict") {
            throw conflict("memory_version_conflict", "记忆已更新，请保留草稿并读取最新版本。");
          }
          throw error;
        }
        const writtenVersion: MemoryVersion = await repos.memory.insertVersion({ id: newId(), documentId: document.id,
          version: document.version, parentVersion: dbVersion, markdown: document.markdown, byteLength,
          contentSha256, author: input.author, source: document.source,
          clientMutationId: input.clientMutationId, summaryRequestId: input.summaryRequestId ?? null,
          createdAt: input.at });
        await repos.memory.insertObjectRef({ id: newId(), documentId: document.id, version: document.version,
          key, documentKind: "note", storageId: ref.storageId, objectFormat: ref.objectFormat,
          contentSha256: ref.contentSha256, byteLength: ref.byteLength, createdAt: input.at });
        if (key.projectId !== null) {
          await appendAuditEntry(repos.audit, { projectId: key.projectId, actor: auditActorFrom(input.actor),
            action: "memory.updated", targetKind: "memory", targetId: document.id, targetName: "记忆",
            detail: { scope: key.scope, documentId: document.id, agentId: key.agentId, parentVersion: dbVersion,
              version: document.version, source: document.source, receipt: advanced.head.receipt,
              head: advanced.head, headVersion: advanced.head.version, mutationKey: advanced.mutation.key,
              objectDigest: ref.contentSha256, refDigest: digestJson(ref), planDigest: plan.digest,
              decisionDigest: decision.digest } }, { createdAt: input.at });
        }
        return Object.freeze({ document, writtenVersion, duplicate: false, decision, ref }) as DurableHeadCommitResult;
      });
    },
  };
}
