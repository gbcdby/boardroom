import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { identityEngines,identityFixture,identitySkip } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { initializePolicyConfiguration } from '../src/server/policy/configuration.ts';
import { createMcpCore } from '../src/server/mcp/core.ts';
import { createMcpServer } from '../src/server/mcp/server.ts';
import { createLogger } from '../src/server/logger.ts';
import type { LiveDecisionView } from '../src/shared/decisions.ts';

for(const engine of identityEngines)test(`${engine}: Decision registered MCP uses current binding and forbids transplanted human source`,{skip:identitySkip(engine)},async()=>{
  const f=await identityFixture(engine);let close:(()=>Promise<void>)|undefined;
  try{
    await initializePolicyConfiguration(f.repos);const p=await decisionDomainFixture(f.repos);
    const group=await f.repos.groups.create({projectId:p.project.id,name:'决策绑定',participantMemberIds:[p.manager.id]});
    const logger=createLogger({write:()=>{}}),core=createMcpCore({db:f.db,logger,memberKey:'decision-protocol-fixture'}),server=createMcpServer({core,logger});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();const client=new Client({name:'decision-contract',version:'1'});
    await server.connect(serverTransport);await client.connect(clientTransport);
    close=async()=>{await client.close();await server.close();await core.close({drain:true});};
    const call=async(name:string,args:Record<string,unknown>)=>{
      const result=await client.callTool({name,arguments:args});const first=(result.content as {type:string;text?:string}[]).find(p=>p.type==='text');assert.ok(first?.text);
      try{return JSON.parse(first.text) as Record<string,any>;}catch{assert.equal(result.isError,true);return {ok:false,error:{code:'INVALID_ARGUMENT',message:first.text}};}
    };
    const tools=(await client.listTools()).tools.map(t=>t.name);
    for(const name of ['list_decisions','read_decision','request_review_decision','resolve_decision','refresh_decision'])assert.ok(tools.includes(name));
    const agent=(await f.repos.agents.get(p.manager.agentId!))!;
    const joined=await call('join',{displayName:agent.displayName,hostType:agent.hostType,projectId:p.project.id,groupId:group.id,role:'manager'});assert.equal(joined.ok,true);
    let second=await p.service.create(p.owner,p.project.id,{title:'同项目另一任务',body:'独立候选',deliveryKind:'code',acceptanceText:'按任务过滤',assigneeMemberId:p.worker.id,reviewerMemberId:p.reviewer.id,repoPath:'/fixture',fixedPoint:'base'});
    second=await p.service.transition(p.workerAccess,p.project.id,second.id,{expectedRevision:second.revision,state:'in-progress'});
    const prepared=await p.service.startReview(p.workerAccess,p.project.id,second.id,{expectedRevision:second.revision});assert.ok(prepared.ready);second=prepared.task;
    let secondRound=await p.service.beginReview(p.reviewerAccess,p.project.id,second.id,prepared.round.id,{expectedTaskRevision:second.revision,expectedRoundRevision:prepared.round.revision});
    for(const report of await f.repos.tasks.listReports(p.project.id,p.task.id,p.round.id)){
      await p.service.submitReport(p.reviewerAccess,p.project.id,second.id,secondRound.id,{expectedTaskRevision:second.revision,expectedRoundRevision:secondRound.revision,
        axis:report.axis,verdict:report.verdict,body:report.body,sources:report.sources,evidence:report.evidence});
      secondRound=(await f.repos.tasks.getRound(p.project.id,second.id,secondRound.id))!;
    }
    assert.equal((await call('list_decisions',{})).decisions.length,2);
    const listed=await call('list_decisions',{taskId:p.task.id});assert.equal(listed.ok,true,JSON.stringify(listed));
    assert.equal(listed.decisions.length,1,'MCP task filter cannot be dropped when separating request routing fields');
    const decision=(listed.decisions as LiveDecisionView[]).find(d=>d.recordKind==='live-review-decision')!;assert.ok(decision);
    const input={decisionId:decision.ref.decisionId,decisionRef:decision.ref,choiceId:'approve',reason:'MCP 管理者当前权限',idempotencyKey:'mcp-actual'};
    const forged=await call('resolve_decision',{...input,userInitiationRef:'human-source',actor:{kind:'human',id:'human:local'}});assert.equal(forged.ok,false);
    const foreign=await call('read_decision',{decisionId:decision.ref.decisionId,projectId:'other-project'});assert.equal(foreign.ok,false);assert.equal(foreign.error.code,'FORBIDDEN');
    const applied=await call('resolve_decision',input);assert.equal(applied.ok,true);assert.equal(applied.state,'applied');assert.equal(applied.current.resolution.authority,'owner');
    assert.equal((await f.db.query('SELECT * FROM decision_local_initiations')).length,0);
    await f.db.exec('UPDATE members SET membership_revision=membership_revision+1 WHERE id=?',[p.manager.id]);
    const stale=await call('resolve_decision',input);assert.equal(stale.ok,false);assert.equal(stale.error.code,'FORBIDDEN');
    assert.equal((await f.db.query('SELECT * FROM decision_executions')).length,1);
  }finally{await close?.();await f.close();}
});
