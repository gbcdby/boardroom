import { z } from 'zod';
import { taskIdSchema } from '../tasks/schemas.ts';
import { InvalidArgumentError } from '../db/errors.ts';

const revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reason=z.string().trim().min(1).max(2000);
export const decisionRefSchema=z.object({decisionId:taskIdSchema,projectId:taskIdSchema,revision,
  actionDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict();
export const reviewHeadSchema=z.object({projectId:taskIdSchema,taskId:taskIdSchema,roundId:taskIdSchema,
  headRevision:revision,currentDecisionId:taskIdSchema}).strict();
export const requestReviewDecisionSchema=z.object({expectedTaskRevision:revision,expectedRoundRevision:revision,
  proposedVerdict:z.enum(['pass','changes_requested']),reason,requestedPath:z.enum(['reviewer','management']),
  expectedHead:reviewHeadSchema.optional(),idempotencyKey:taskIdSchema}).strict();
export const resolveDecisionSchema=z.object({decisionRef:decisionRefSchema,choiceId:z.enum(['approve','reject','request_changes']),
  reason,idempotencyKey:taskIdSchema}).strict();
export const chooseLocalDecisionSchema=resolveDecisionSchema.omit({idempotencyKey:true}).extend({clientMutationId:taskIdSchema}).strict();
export const refreshDecisionSchema=z.object({decisionRef:decisionRefSchema,idempotencyKey:taskIdSchema}).strict();
export const listDecisionsSchema=z.object({taskId:taskIdSchema.optional(),status:z.enum(['pending','resolved','superseded','cancelled','expired']).optional()}).strict();
export function parseDecisionInput<S extends z.ZodTypeAny>(schema:S,raw:unknown):z.output<S> {
  const parsed=schema.safeParse(raw);
  if(!parsed.success)throw new InvalidArgumentError('决策请求字段无效；不得提交 actor、authority、source 或 nonce。');
  return parsed.data;
}
