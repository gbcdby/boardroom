import { z } from "zod";
import { InvalidArgumentError } from "../db/errors.ts";

// HTTP、MCP 和领域入口共用输入边界；主体与项目绑定始终由受信入口提供。
export const taskIdSchema = z.string().trim().min(1).max(100);
export const taskRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const taskStateSchema = z.enum(["todo", "in-progress", "review", "blocked", "done"]);
const title = z.string().trim().min(1).max(200);
const text = z.string().refine(value => Buffer.byteLength(value, "utf8") <= 65_536, "正文不能超过 64 KiB");
const nonemptyText = text.refine(value => value.trim().length > 0, "正文不能为空");
const labels = z.array(z.string().trim().min(1).max(40)).max(20).transform(values => [...new Set(values)]);
const repoPath = z.string().trim().min(1).max(4096).nullable();
const fixedPoint = z.string().trim().min(1).max(512).nullable();
const reason = z.string().trim().min(1).max(2000);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const timestamp = z.string().max(40).datetime({ offset: true });

export const createTaskSchema = z.object({ title, body: text, labels: labels.optional(),
  assigneeMemberId: taskIdSchema, reviewerMemberId: taskIdSchema.optional(),
  repoPath: repoPath.optional(), fixedPoint: fixedPoint.optional() }).strict();
export const updateTaskSchema = z.object({ expectedRevision: taskRevisionSchema,
  title: title.optional(), body: text.optional(), labels: labels.optional(),
  assigneeMemberId: taskIdSchema.optional(), reviewerMemberId: taskIdSchema.optional(),
  repoPath: repoPath.optional(), fixedPoint: fixedPoint.optional() }).strict();
export const transitionTaskSchema = z.object({ expectedRevision: taskRevisionSchema,
  state: z.enum(["todo", "in-progress", "blocked"]), reason: reason.optional() }).strict();
export const commentTaskSchema = z.object({ body: nonemptyText }).strict();
export const linkTaskMessageSchema = z.object({ messageId: taskIdSchema }).strict();
export const startTaskReviewSchema = z.object({ expectedRevision: taskRevisionSchema }).strict();
export const beginTaskReviewSchema = z.object({ expectedTaskRevision: taskRevisionSchema, expectedRoundRevision: taskRevisionSchema }).strict();
export const taskSettingsSchema = z.object({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  defaultReviewerMemberId: taskIdSchema.nullable() }).strict();
export const listTasksSchema = z.object({ state: taskStateSchema.optional(), assigneeMemberId: taskIdSchema.optional() }).strict();

export const reviewCommandSchema = z.object({
  argv: z.array(z.string().max(8192)).min(1).max(100), cwd: z.string().min(1).max(4096),
  startedAt: timestamp, completedAt: timestamp, exitCode: z.number().int().min(0).max(255),
}).strict();
export const reviewEvidenceSchema = z.object({
  provenance: z.literal("reviewer-declared"), host: z.string().trim().min(1).max(100), hostVersion: z.string().trim().min(1).max(200),
  parentRunId: taskIdSchema, invocationId: taskIdSchema, contextId: taskIdSchema,
  startedAt: timestamp, completedAt: timestamp, command: reviewCommandSchema,
  promptSha256: hash, transcriptSha256: hash, evidenceRef: z.string().trim().min(1).max(4096),
  baseCommit: commit, candidateCommit: commit, diffSha256: hash,
}).strict();
export const submitReviewReportSchema = beginTaskReviewSchema.extend({
  axis: z.enum(["spec", "standards"]), verdict: z.enum(["pass", "changes_requested"]), body: nonemptyText,
  sources: z.array(z.string().trim().min(1).max(4096)).min(1).max(100), evidence: reviewEvidenceSchema,
}).strict();
export const decideTaskReviewSchema = beginTaskReviewSchema.extend({
  verdict: z.enum(["pass", "changes_requested"]), reason, override: z.boolean().optional(),
}).strict();

export function parseTaskInput<T extends object>(schema: z.ZodType<T>, input: unknown): { [K in keyof T]: Exclude<T[K], undefined> } {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join(".") || "请求"))].slice(0, 5).join("、");
    throw new InvalidArgumentError(`task_input_invalid：任务参数无效，请检查${fields}。`);
  }
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
