import { z } from "zod";
import { TaskError } from "./errors.ts";

// HTTP、MCP 和领域入口共用输入边界；主体与项目绑定始终由受信入口提供。
export const taskIdSchema = z.string().trim().min(1).max(100);
export const taskRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const taskStateSchema = z.enum(["todo", "in-progress", "review", "blocked", "done"]);
const title = z.string().trim().min(1).max(200);
// 每个文本字段新建内部 string 实例，避免 MCP 导出兄弟属性 $ref。
const text = () => z.string().refine(value => Buffer.byteLength(value, "utf8") <= 65_536, "正文不能超过 64 KiB");
const nonemptyText = text().refine(value => value.trim().length > 0, "正文不能为空");
const labels = z.array(z.string().trim().min(1).max(40)).max(20).transform(values => [...new Set(values)]);
const repoPath = z.string().trim().min(1).max(4096).nullable();
const fixedPoint = z.string().trim().min(1).max(512).nullable();
const reason = z.string().trim().min(1).max(2000);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const timestamp = z.string().max(40).datetime({ offset: true });

export const createTaskSchema = z.object({ title, body: text().default(""), labels: labels.optional(),
  assigneeMemberId: taskIdSchema.describe("任务负责人成员 ID，null 表示待分派").nullable().optional(), reviewerMemberId: taskIdSchema.describe("指定评审成员 ID，null 表示不使用默认评审人").nullable().optional(),
  deliveryKind: z.enum(["code", "artifact", "finding"]).nullable().optional(), acceptanceText: text().describe("明确的任务验收条件").optional(),
  repoPath: repoPath.optional(), fixedPoint: fixedPoint.optional() }).strict();
export const updateTaskSchema = z.object({ expectedRevision: taskRevisionSchema,
  title: title.optional(), body: text().optional(), labels: labels.optional(),
  assigneeMemberId: taskIdSchema.describe("任务负责人成员 ID，null 表示清除分派").nullable().optional(), reviewerMemberId: taskIdSchema.describe("指定评审成员 ID，null 表示清除分派").nullable().optional(),
  deliveryKind: z.enum(["code", "artifact", "finding"]).nullable().optional(), acceptanceText: text().describe("明确的任务验收条件").optional(),
  repoPath: repoPath.optional(), fixedPoint: fixedPoint.optional() }).strict();
export const transitionTaskSchema = z.object({ expectedRevision: taskRevisionSchema,
  state: z.enum(["todo", "in-progress", "blocked"]), reason: reason.optional() }).strict();
export const commentTaskSchema = z.object({ body: nonemptyText }).strict();
export const linkTaskMessageSchema = z.object({ messageId: taskIdSchema }).strict();
export const startTaskReviewSchema = z.object({ expectedRevision: taskRevisionSchema }).strict();
// 每个公开字段使用独立实例，使 MCP JSON Schema 内联类型；部分原生宿主不解析兄弟属性 $ref。
// describe 只补充说明和实例身份，不改变 HTTP/MCP 共用的严格整数范围。
export const beginTaskReviewSchema = z.object({
  expectedTaskRevision: taskRevisionSchema.describe("当前任务修订号，必须为整数"),
  expectedRoundRevision: taskRevisionSchema.describe("当前评审轮次修订号，必须为整数"),
}).strict();
export const taskSettingsSchema = z.object({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  defaultReviewerMemberId: taskIdSchema.nullable() }).strict();
export const listTasksSchema = z.object({ state: taskStateSchema.optional(), assigneeMemberId: taskIdSchema.optional() }).strict();

export const reviewCommandSchema = z.object({
  argv: z.array(z.string().max(8192)).min(1).max(100), cwd: z.string().min(1).max(4096),
  startedAt: timestamp.describe("命令启动时间"), completedAt: timestamp.describe("命令结束时间"), exitCode: z.number().int().min(0).max(255),
}).strict();
export const reviewEvidenceSchema = z.object({
  provenance: z.literal("reviewer-declared"), host: z.string().trim().min(1).max(100), hostVersion: z.string().trim().min(1).max(200),
  parentRunId: taskIdSchema.describe("两轴共享的执行批次 ID"), invocationId: taskIdSchema.describe("本轴调用 ID"), contextId: taskIdSchema.describe("本轴独立上下文 ID"),
  startedAt: timestamp.describe("本轴执行开始时间"), completedAt: timestamp.describe("本轴执行完成时间"), command: reviewCommandSchema,
  promptSha256: hash.describe("提示词 SHA-256"), transcriptSha256: hash.describe("执行记录 SHA-256"), evidenceRef: z.string().trim().min(1).max(4096),
  baseCommit: commit.describe("固定基线提交"), candidateCommit: commit.describe("固定候选提交"), diffSha256: hash.describe("候选差异 SHA-256"),
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
    const names: Record<string, string> = { title: "标题", body: "目标与范围", acceptanceText: "验收条件", deliveryKind: "交付类型", assigneeMemberId: "负责人", reviewerMemberId: "评审人", labels: "标签", repoPath: "仓库路径", fixedPoint: "对比基准", expectedRevision: "任务版本" };
    const fields = parsed.error.issues.map(issue => {
      const field = String(issue.path[0] ?? "request"), label = names[field] ?? field;
      const message = issue.code === "too_big" ? `${label}超过允许的长度或数量。` : issue.code === "too_small" ? `${label}不能为空或小于允许的范围。` : issue.code === "custom" ? `${label}：${issue.message}` : `请检查${label}的格式或取值。`;
      return { code: "task_input_invalid", field, message };
    });
    throw new TaskError("task_input_invalid", `task_input_invalid：任务参数无效，请检查${[...new Set(fields.map(issue => names[issue.field] ?? issue.field))].slice(0, 5).join("、")}。`, "invalid_argument", { fields });
  }
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
