<script setup lang="ts">
import { computed,ref,watch } from 'vue';
import { ApiError } from '../api/client.ts';
import { acceptsDecisions,readTaskDecisions,decisionUrl,postDecision,decisionResultMessage,
  type DecisionSnapshot,type LiveDecisionView,type DecisionRef,type ChooseLocalUiDecisionInput,type RefreshDecisionInput,type DecisionChoice } from '../api/decisions.ts';
import { useResourceReconciliation } from '../composables/useResourceReconciliation.ts';
import { useCurrentProject,useProjectDraft } from '../composables/useCurrentProject.ts';
import ResourceSyncStatus from './ResourceSyncStatus.vue';
const props=defineProps<{taskId:string;roundId:string|null;roundState:string|null;blocked?:boolean}>();
const emit=defineEmits<{current:[value:LiveDecisionView|null];committed:[];locked:[value:boolean]}>();
const context=useCurrentProject();
const reason=ref(''),choice=ref<DecisionChoice>('approve'),base=ref<DecisionRef|null>(null);
const busy=ref(false),unknown=ref(false),message=ref<string|null>(null),failure=ref<string|null>(null);
const frozen=ref<{kind:'choice'|'refresh';url:string;input:ChooseLocalUiDecisionInput|RefreshDecisionInput}|null>(null);
watch(unknown,value=>emit('locked',value),{flush:'sync'});
let generation=0;
const resource=useResourceReconciliation<DecisionSnapshot,{projectId:string;key:string;taskId:string}>({
  // Decision 的五秒可见性门槛另由真实浏览器验收；四秒轮询为请求/绘制留出余量。
  pollIntervalMs:4000,read:(scope,reader)=>readTaskDecisions(reader,scope.projectId,scope.taskId),accepts:acceptsDecisions,
  relevant:(change,scope)=>change.entity==='decision'||change.entity==='task'&&change.id===scope.taskId,
  onValue(value){emit('current',value.decisions.find((d):d is LiveDecisionView=>d.recordKind==='live-review-decision'&&d.isCurrent&&d.actionRequest.roundId===props.roundId)??null);},
});
const current=computed(()=>resource.value.value?.decisions.find((d):d is LiveDecisionView=>d.recordKind==='live-review-decision'&&d.isCurrent&&d.actionRequest.roundId===props.roundId)??null);
const legacy=computed(()=>resource.value.value?.decisions.filter(d=>d.recordKind==='legacy-review-fact')??[]);
const changed=computed(()=>!!base.value&&JSON.stringify(base.value)!==JSON.stringify(current.value?.ref));
watch(reason,value=>{if(!value.trim()&&!unknown.value){base.value=null;frozen.value=null;}else if(!base.value&&current.value)base.value={...current.value.ref};},{flush:'sync'});
const canChoose=computed(()=>!!current.value&&current.value.status==='pending'&&current.value.allowedOperations.includes(choice.value)
  &&!!reason.value.trim()&&!!base.value&&!changed.value&&!busy.value&&!unknown.value&&!props.blocked&&!context.readonly.value&&!resource.error.value);
useProjectDraft(()=>!!reason.value||unknown.value,()=>{reason.value='';base.value=null;frozen.value=null;unknown.value=false;});
function rebase(){if(!current.value||busy.value||unknown.value||props.blocked||resource.error.value)return;base.value={...current.value.ref};frozen.value=null;failure.value=null;message.value='已采用当前决定，保留理由。请再核对拟议动作后选择。';}
async function send(retry=false){
  if(!retry&&!canChoose.value||retry&&(!unknown.value||!frozen.value)||busy.value)return;
  if(!retry)frozen.value={kind:'choice',url:`${decisionUrl(context.currentProjectId.value!,base.value!.decisionId)}/choices`,
    input:{decisionRef:{...base.value!},choiceId:choice.value,reason:reason.value.trim(),clientMutationId:crypto.randomUUID()}};
  await submitFrozen(retry);
}
async function submitFrozen(retry:boolean){
  const command=frozen.value!,g=generation;busy.value=true;failure.value=null;
  try {
    const result=await postDecision(command.url,command.input);if(g!==generation)return;
    unknown.value=false;message.value=decisionResultMessage(result);
    if(command.kind==='choice'&&result.state!=='refreshed'){reason.value='';base.value=null;frozen.value=null;}
    await resource.committed();if(g===generation)emit('committed');
  }catch(error){if(g!==generation)return;unknown.value=retry||!(error instanceof ApiError)||error.status>=500||error.status===408;
    failure.value=unknown.value?'本次结果尚未确认。原决定、选择、理由和请求标识已锁定，只能原样重试确认。':`${error instanceof Error?error.message:'操作失败'} 已保留原输入，请读取并核对当前决定。`;
  }finally{if(g===generation)busy.value=false;}
}
async function refresh(){
  if(!current.value||busy.value||unknown.value||props.blocked||context.readonly.value)return;
  frozen.value={kind:'refresh',url:`${decisionUrl(context.currentProjectId.value!,current.value.ref.decisionId)}/refresh`,
    input:{decisionRef:{...current.value.ref},idempotencyKey:crypto.randomUUID()}};
  unknown.value=true;
  // This is the first refresh attempt. Only a retry of an earlier unknown
  // command must stay locked when a later response merely rejects that retry.
  await submitFrozen(false);
}
watch([context.currentProjectId,()=>props.taskId,context.generation],()=>{
  generation++;busy.value=false;reason.value='';base.value=null;frozen.value=null;unknown.value=false;message.value=null;failure.value=null;
  const projectId=context.currentProjectId.value;
  void resource.setScope(projectId&&props.taskId?{projectId,taskId:props.taskId,key:`${projectId}:${props.taskId}:${context.generation.value}:decisions`}:null);
},{immediate:true});
watch(()=>props.roundId,()=>{emit('current',current.value);});
</script>
<template>
  <section class="decision-panel" data-testid="decision-panel">
    <h3>评审提案与选择</h3>
    <ResourceSyncStatus :failed="!!resource.error.value" :last-read-at="resource.lastSuccessAt.value" :connection="resource.connection.value" />
    <button v-if="resource.error.value" type="button" @click="resource.refresh(true)">重新读取决定</button>
    <p v-if="failure" class="error" role="status">{{failure}}</p><p v-if="message" class="notice" role="status">{{message}}</p>
    <template v-if="current">
      <p data-testid="decision-proposed-action">拟议动作：{{current.actionRequest.action.payload.choice==='pass'?'通过评审并标记任务完成':'要求修改并返回进行中'}}。</p>
      <p class="muted small">{{current.actionRequest.proposalReason}}</p>
      <p data-testid="decision-state">{{current.status==='pending'?'提案待决':current.status==='resolved'?'选择已记录':current.status==='cancelled'?'提案已失效':'提案已被后继取代'}} · 决定版本 {{current.ref.revision}}</p>
      <p v-if="current.status==='pending'" class="muted">{{current.requiredAuthority==='human'?'等待人的明确选择':current.requiredAuthority==='owner'?'等待有权负责人处理':'等待当前有权主体处理'}}。选择前会重新核对当前任务、权限和策略。</p>
      <p v-if="current.blockedReason" class="warning-text">当前阻塞：{{current.blockedReason}}</p>
      <p v-if="current.freshness!=='current'" class="notice">当前任务、生命周期或策略已变化。原提案不会据此自动执行。<button v-if="current.allowedOperations.includes('refresh')" type="button" :disabled="busy||unknown||context.readonly.value" @click="refresh">读取当前策略并刷新提案</button></p>
      <p v-if="current.resolution" class="notice">已选择：{{current.resolution.choiceId==='approve'?'同意应用':current.resolution.choiceId==='reject'?'拒绝提案':'退回提案'}} · {{current.resolution.reason}}</p>
    </template>
    <p v-else class="muted">{{roundState==='ready'||roundState==='running'?'等待两份独立评审报告；齐备后建立提案。':'当前没有可处理的评审提案。'}}已有草稿与旧评审结论不会自动应用。</p>
      <form v-if="current?.status==='pending'||reason||unknown" @submit.prevent="send()">
        <label class="field">对这个提案的选择<select v-model="choice" :disabled="busy||unknown||blocked||context.readonly.value" data-testid="decision-choice"><option value="approve">同意应用上述拟议动作</option><option value="reject">拒绝提案，不改任务</option><option value="request_changes">退回提案，不改任务</option></select></label>
        <label class="field">选择理由<textarea v-model="reason" rows="3" maxlength="2000" :disabled="busy||unknown||blocked||context.readonly.value" data-testid="decision-choice-reason" /></label>
        <p v-if="changed" class="notice">此草稿仍绑定原决定，当前决定已变化；请核对后明确采用当前决定。<button type="button" :disabled="busy||unknown||!!resource.error.value" data-testid="decision-choice-rebase" @click="rebase">保留理由并采用当前决定</button></p>
        <button v-if="unknown" type="button" :disabled="busy" data-testid="decision-retry" @click="send(true)">原样重试并确认结果</button>
        <button v-else type="submit" class="primary" :disabled="!canChoose" data-testid="decision-submit">保存这个选择</button>
        <button v-if="reason&&!unknown" type="button" :disabled="busy" @click="reason=''">丢弃选择草稿</button>
      </form>
    <details v-if="legacy.length"><summary>旧裁决来源与诊断</summary><p v-for="record in legacy" :key="record.legacyId" class="muted small">{{record.roundId?'评审轮次 '+record.roundId:'无有效评审轮次'}} · {{record.chainStatus}} · {{record.diagnosticCodes.join('、')}}。旧事实只读，不代表新批准。</p></details>
  </section>
</template>
<style scoped>
.decision-panel{border-top:1px solid var(--border);margin-top:1rem;padding-top:1rem}.decision-panel form{display:grid;gap:.75rem}.decision-panel form button{justify-self:start}.decision-panel p{overflow-wrap:anywhere}
</style>
