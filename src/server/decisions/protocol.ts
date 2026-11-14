import { McpToolError } from '../mcp/errors.ts';
import { DecisionCommandError } from './errors.ts';
import { StorageInvalid } from './storage-error.ts';
import { PolicyConfigurationError } from '../policy/configuration-errors.ts';
import type { DecisionCommandResult } from './types.ts';

export function decisionToolError(error:unknown):McpToolError|null {
  if(error instanceof DecisionCommandError)return new McpToolError(error.status===403?'FORBIDDEN':error.status>=500?'INTERNAL':'CONFLICT',error.message,{reason:error.reason,...error.details});
  if(error instanceof StorageInvalid)return new McpToolError('INTERNAL','决策存储校验失败。',{reason:'decision_storage_invalid'});
  if(error instanceof PolicyConfigurationError)return new McpToolError(error.status===500?'INTERNAL':error.status===409?'CONFLICT':'INVALID_ARGUMENT',error.message,
    {reason:error.reason,fields:error.fields,current:error.current,conflicts:error.conflicts});
  return null;
}
export function decisionToolResult(result:DecisionCommandResult):Record<string,unknown> {
  if(result.receipt.httpStatus===409)throw new McpToolError('CONFLICT','策略已变化；本次只刷新评估。请阅读新引用后发起新的明确选择。',
    {reason:'policy_changed',result,receipt:result.receipt,current:result.current});
  return {ok:true,...result};
}
