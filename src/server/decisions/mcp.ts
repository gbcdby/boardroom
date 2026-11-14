import { z } from 'zod';
import type { TaskAccess } from '../tasks/service.ts';
import { taskIdSchema } from '../tasks/schemas.ts';
import { McpToolError } from '../mcp/errors.ts';
import type { DecisionService } from './service.ts';
import { requestReviewDecisionSchema,resolveDecisionSchema,refreshDecisionSchema,listDecisionsSchema,parseDecisionInput } from './schemas.ts';
import { decisionToolResult } from './protocol.ts';

const project={projectId:taskIdSchema.optional()},target={...project,decisionId:taskIdSchema};
export const DECISION_COMMANDS={
  list:{name:'list_decisions',title:'列出当前绑定项目的决策',schema:listDecisionsSchema.extend(project).strict()},
  read:{name:'read_decision',title:'读取决策、回执与当前状态',schema:z.object(target).strict()},
  request:{name:'request_review_decision',title:'明确提出评审提案或后继',schema:requestReviewDecisionSchema.extend({...project,taskId:taskIdSchema,roundId:taskIdSchema}).strict()},
  resolve:{name:'resolve_decision',title:'以当前成员权限处理决策选择',schema:resolveDecisionSchema.extend(target).strict()},
  refresh:{name:'refresh_decision',title:'刷新当前决策的策略观察',schema:refreshDecisionSchema.extend(target).strict()},
} as const;
export type DecisionOperation=keyof typeof DECISION_COMMANDS;
export const DECISION_OBSERVATIONS:ReadonlySet<DecisionOperation>=new Set(['list','read']);
export async function invokeDecisionOperation(service:DecisionService,access:TaskAccess,projectId:string,operation:DecisionOperation,raw:unknown):Promise<Record<string,unknown>> {
  const definition=DECISION_COMMANDS[operation];if(!definition)throw new McpToolError('INVALID_ARGUMENT','未知决策操作。');
  const parsed=parseDecisionInput(definition.schema as z.AnyZodObject,raw);
  if(parsed.projectId!==undefined&&parsed.projectId!==projectId)throw new McpToolError('FORBIDDEN','只能访问当前 MCP 绑定项目。',{reason:'out_of_connection'});
  const {projectId:_project,decisionId,taskId,roundId,...input}=parsed;
  switch(operation) {
    case 'list':return {ok:true,...await service.list(access,projectId,{...input,...(taskId===undefined?{}:{taskId})})};
    case 'read':return {ok:true,decision:await service.get(access,projectId,decisionId)};
    case 'request':return decisionToolResult(await service.request(access,{projectId,taskId,roundId},parseDecisionInput(requestReviewDecisionSchema,input)));
    case 'resolve':return decisionToolResult(await service.resolve(access,projectId,decisionId,parseDecisionInput(resolveDecisionSchema,input)));
    case 'refresh':return decisionToolResult(await service.refresh(access,projectId,decisionId,parseDecisionInput(refreshDecisionSchema,input)));
  }
}
