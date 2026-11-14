import type { IncomingMessage } from 'node:http';
import type { Actor } from '../authz/authorize.ts';
import { DecisionCommandError } from './errors.ts';

declare const localRequestBrand:unique symbol;
export interface TrustedLocalDecisionRequest {readonly [localRequestBrand]:true}
const requests=new WeakMap<object,IncomingMessage>();
/** 仅 HTTP adapter 调用；不接受 body 中的来源、actor 或任何 transferable token。 */
export function trustedLocalDecisionRequest(request:IncomingMessage,actor:Actor):TrustedLocalDecisionRequest {
  const host=request.headers.host;
  if(request.method!=='POST'||actor.kind!=='human'||actor.actorId!=='human:local'||!host
    ||!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
    ||request.headers.origin!==undefined&&request.headers.origin!==`http://${host}`) {
    throw new DecisionCommandError('forbidden','人类裁决须来自当前本地同源 UI 请求。',403);
  }
  const proof=Object.freeze({}) as TrustedLocalDecisionRequest;
  requests.set(proof,request);return proof;
}
export function assertTrustedLocalRequest(proof:TrustedLocalDecisionRequest|undefined,actor:Actor):void {
  if(!proof||!requests.has(proof)||actor.kind!=='human'||actor.actorId!=='human:local') {
    throw new DecisionCommandError('source_binding_mismatch','缺少本地 UI 的当前请求来源。',403);
  }
}
