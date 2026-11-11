import { z } from "zod";
import { MemoryError } from "./errors.ts";

export const memoryId = z.string().trim().min(1).max(200);
export const memoryRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const markdown = z.string().refine(value => !/[\uD800-\uDFFF]/u.test(value) && Buffer.byteLength(value, "utf8") <= 1048576,
  "记忆必须为有效 Unicode，且不超过系统文档上限。");
export const writeMemorySchema = z.object({ expectedVersion: memoryRevision, clientMutationId: memoryId, markdown }).strict();
export const memoryMutationSchema = z.object({ clientMutationId: memoryId }).strict();
export const beginMemorySummarySchema = memoryMutationSchema.extend({ expectedRevision: memoryRevision.min(1) }).strict();
export const failMemorySummarySchema = z.object({ expectedRevision: memoryRevision.min(1), attemptId: memoryId,
  code: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/) }).strict();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)), "时间格式无效。");
export const selfSummaryEvidenceSchema = z.object({
  provenance: z.literal("agent-declared"), host: z.string().trim().min(1).max(100), hostVersion: z.string().trim().min(1).max(200),
  invocationId: memoryId, contextId: memoryId, startedAt: timestamp, completedAt: timestamp,
  promptSha256: sha256, outputSha256: sha256, evidenceRef: z.string().trim().min(1).max(4096),
}).strict();
export const submitMemorySummarySchema = z.object({ expectedRequestRevision: memoryRevision.min(1),
  attemptId: memoryId, markdown, evidence: selfSummaryEvidenceSchema }).strict();
export const memoryHistoryQuerySchema = z.object({ beforeVersion: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict();

export function parseMemoryInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new MemoryError("memory_input_invalid", "记忆请求字段、修订或证据格式无效。");
  return result.data;
}
