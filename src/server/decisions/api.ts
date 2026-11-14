import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbDriver } from '../db/driver.ts';
import { createRepositories } from '../db/repositories.ts';
import { RepositoryError, InvalidArgumentError } from '../db/errors.ts';
import type { ActorResolution } from '../api.ts';
import { ForbiddenError, type Actor } from '../authz/authorize.ts';
import { ownerActor } from '../authz/actors.ts';
import { conditionalJson } from '../conditional-json.ts';
import { PolicyConfigurationError } from '../policy/configuration-errors.ts';
import { StorageInvalid } from './storage-error.ts';
import { DecisionCommandError } from './errors.ts';
import { createDecisionService } from './service.ts';
import { trustedLocalDecisionRequest } from './trusted-local.ts';
import { parseDecisionInput, requestReviewDecisionSchema, chooseLocalDecisionSchema, refreshDecisionSchema } from './schemas.ts';

function json(response:ServerResponse,status:number,body:unknown) {
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(body));
}
export function writeDecisionError(response:ServerResponse,error:unknown):boolean {
  if(error instanceof DecisionCommandError)json(response,error.status,{error:{code:error.reason,message:error.message,...error.details}});
  else if(error instanceof StorageInvalid)json(response,500,{error:{code:'decision_storage_invalid',message:'决策存储校验失败。'}});
  else if(error instanceof PolicyConfigurationError)json(response,error.status,{error:{code:error.reason,message:error.message,fields:error.fields,current:error.current,conflicts:error.conflicts}});
  else return false;
  return true;
}
function local(request:IncomingMessage) {
  const host=request.headers.host;
  return !!host&&/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)&&(request.headers.origin===undefined||request.headers.origin===`http://${host}`);
}
async function body(request:IncomingMessage):Promise<unknown> {
  if(!request.headers['content-type']?.toLowerCase().startsWith('application/json'))throw new InvalidArgumentError('需要 application/json。');
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of request){const value=Buffer.from(chunk);length+=value.length;if(length>1_500_000)throw new InvalidArgumentError('请求过大。');chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new InvalidArgumentError('请求不是有效 JSON。');}
}
export function createDecisionApi(options:{db:DbDriver;resolveActor?:(resolution:ActorResolution)=>Promise<Actor|null>}) {
  const service=createDecisionService(options.db),repos=createRepositories(options.db);
  return {async handle(request:IncomingMessage,response:ServerResponse,pathname:string):Promise<boolean> {
    const aggregate=pathname==='/api/decisions';
    if(!aggregate&&!/^\/api\/projects\/[^/]+\/(decisions(\/|$)|tasks\/[^/]+\/reviews\/[^/]+\/decision-requests$)/.test(pathname))return false;
    try {
      if(!local(request))throw new DecisionCommandError('forbidden','仅接受本地同源决策请求。',403);
      let parts:string[];try{parts=pathname.split('/').filter(Boolean).map(decodeURIComponent);}catch{throw new InvalidArgumentError('路径编码无效。');}
      const projectId=aggregate?null:parts[2]!;
      const actor=options.resolveActor?await options.resolveActor({request,projectId}):ownerActor(projectId);
      if(!actor)throw new DecisionCommandError('forbidden','无法确定当前主体。',403);
      const access={actor},method=request.method??'GET';
      if(aggregate) {
        if(method!=='GET'){json(response,405,{error:{code:'method_not_allowed'}});return true;}
        if(actor.kind!=='human')throw new DecisionCommandError('forbidden','Agent 查询只允许绑定项目。',403);
        const decisions:unknown[]=[];
        for(const project of await repos.projects.list({includeArchived:true})) {
          try{decisions.push(...(await service.list(access,project.id)).decisions);}catch(error){if(!(error instanceof ForbiddenError))throw error;}
        }
        conditionalJson(request,response,{decisions});return true;
      }
      if(parts[3]==='tasks'&&method==='POST') {
        const result=await service.request(access,{projectId:projectId!,taskId:parts[4]!,roundId:parts[6]!},
          parseDecisionInput(requestReviewDecisionSchema,await body(request)));
        json(response,result.receipt.httpStatus,result);return true;
      }
      const id=parts[4];
      if(method==='GET'&&parts.length===4) {
        const query=Object.fromEntries(new URL(request.url??pathname,'http://127.0.0.1').searchParams);
        conditionalJson(request,response,await service.list(access,projectId!,query));
      } else if(method==='GET'&&id==='changes'&&parts.length===5) {
        const query=new URL(request.url??pathname,'http://127.0.0.1').searchParams;
        conditionalJson(request,response,await service.changes(access,projectId!,Number(query.get('afterRevision')??0)));
      } else if(method==='GET'&&id&&parts.length===5)conditionalJson(request,response,{decision:await service.get(access,projectId!,id)});
      else if(method==='POST'&&id&&parts.length===6&&parts[5]==='choices') {
        const proof=trustedLocalDecisionRequest(request,actor);
        const result=await service.chooseLocal(access,projectId!,id,parseDecisionInput(chooseLocalDecisionSchema,await body(request)),proof);
        json(response,result.receipt.httpStatus,result);
      } else if(method==='POST'&&id&&parts.length===6&&parts[5]==='refresh') {
        const result=await service.refresh(access,projectId!,id,parseDecisionInput(refreshDecisionSchema,await body(request)));
        json(response,result.receipt.httpStatus,result);
      } else json(response,404,{error:{code:'not_found',message:'决策接口不存在。'}});
    } catch(error) {
      if(writeDecisionError(response,error))return true;
      if(error instanceof ForbiddenError)json(response,403,{error:{code:error.code,message:error.message}});
      else if(error instanceof RepositoryError)json(response,error.code==='not_found'?404:error.code==='archived'||error.code==='conflict'?409:error.code==='write_failed'?500:400,
        {error:{code:error.code,message:error.message}});
      else json(response,500,{error:{code:'internal_error',message:'决策操作失败。'}});
    }
    return true;
  }};
}
