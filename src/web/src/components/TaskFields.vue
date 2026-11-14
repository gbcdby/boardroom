<script setup lang="ts">
import { computed } from "vue";
import type { MemberDto, OrgNodeDto } from "../api/client.ts";
import { NO_REVIEWER, type TaskDraft, type TaskFieldErrors } from "../api/tasks.ts";
const draft = defineModel<TaskDraft>({ required: true });
const props = withDefaults(defineProps<{ members: MemberDto[]; nodes: OrgNodeDto[]; disabled: boolean; defaultReviewer?: string | null; editing?: boolean; errors?: TaskFieldErrors }>(), { errors: () => ({}) });
const activeMembers = computed(() => props.members.filter((member) => member.status === "active"));
const reviewers = computed(() => activeMembers.value.filter((member) => member.kind === "agent" && member.id !== draft.value.assigneeMemberId));
function memberLabel(member: MemberDto): string {
  const position = props.nodes.find((node) => node.memberId === member.id)?.name;
  return `${member.displayName} · ${position ?? (member.kind === "agent" ? "Agent · 未分配岗位" : "人类成员")}`;
}
</script>

<template>
  <fieldset class="task-fields" :disabled="disabled">
    <legend class="visually-hidden">任务内容与指派</legend>
    <label class="field">标题<input v-model="draft.title" maxlength="200" required data-testid="task-title" :aria-invalid="!!errors.title" :aria-describedby="errors.title ? 'task-title-error' : undefined" placeholder="用一句话说明要完成什么" /><span v-if="errors.title" id="task-title-error" class="error-text small" role="alert">{{ errors.title }}</span></label>
    <details class="task-optional-fields" :open="editing || Object.keys(errors).some(key => key !== 'title') || undefined" data-testid="task-optional-fields">
    <summary>补充目标、验收与分派 <span class="muted small">保存后仍可完善</span></summary>
    <label class="field">目标与范围<textarea v-model="draft.body" rows="3" data-testid="task-body" :aria-invalid="!!errors.body" :aria-describedby="errors.body ? 'task-body-help task-body-error' : 'task-body-help'" placeholder="说明要解决的问题和范围" /><span id="task-body-help" class="muted small">支持纯文本或 Markdown。开始执行前需补齐。</span><span v-if="errors.body" id="task-body-error" class="error-text small" role="alert">{{ errors.body }}</span></label>
    <label class="field">验收条件<textarea v-model="draft.acceptanceText" rows="3" data-testid="task-acceptance" :aria-invalid="!!errors.acceptanceText" :aria-describedby="errors.acceptanceText ? 'task-acceptance-error' : undefined" placeholder="怎样判断这项任务已经完成" /><span v-if="errors.acceptanceText" id="task-acceptance-error" class="error-text small" role="alert">{{ errors.acceptanceText }}</span></label>
    <label class="field">交付类型<select v-model="draft.deliveryKind" data-testid="task-delivery-kind" :aria-invalid="!!errors.deliveryKind" :aria-describedby="errors.deliveryKind ? 'task-kind-error' : undefined"><option value="">待确定</option><option value="code">代码</option><option value="artifact">文件产物</option><option value="finding">调查结论</option></select><span v-if="errors.deliveryKind" id="task-kind-error" class="error-text small" role="alert">{{ errors.deliveryKind }}</span><span v-if="draft.deliveryKind === 'artifact' || draft.deliveryKind === 'finding'" class="muted small">可先保存与完善。分类产物评审尚未接入，当前不能通过代码评审路径完成。</span></label>
    <div class="task-field-grid">
      <label class="field">负责人<select v-model="draft.assigneeMemberId" data-testid="task-assignee" :aria-invalid="!!errors.assigneeMemberId" :aria-describedby="errors.assigneeMemberId ? 'task-assignee-error' : undefined"><option value="">待分派</option><option v-if="draft.assigneeMemberId && !activeMembers.some((member) => member.id === draft.assigneeMemberId)" :value="draft.assigneeMemberId" disabled>原负责人已不可用，请重新选择</option><option v-for="member in activeMembers" :key="member.id" :value="member.id">{{ memberLabel(member) }}</option></select><span v-if="errors.assigneeMemberId" id="task-assignee-error" class="error-text small" role="alert">{{ errors.assigneeMemberId }}</span></label>
      <label class="field">评审人<select v-model="draft.reviewerMemberId" data-testid="task-reviewer" :aria-invalid="!!errors.reviewerMemberId" :aria-describedby="errors.reviewerMemberId ? 'task-reviewer-error' : undefined"><option v-if="!editing" value="">{{ defaultReviewer ? `使用有效项目默认：${defaultReviewer}` : '使用有效项目默认（当前未配置）' }}</option><option :value="NO_REVIEWER">暂不选择</option><option v-if="draft.reviewerMemberId && draft.reviewerMemberId !== NO_REVIEWER && !reviewers.some((member) => member.id === draft.reviewerMemberId)" :value="draft.reviewerMemberId" disabled>原评审人已不可用，请重新选择</option><option v-for="member in reviewers" :key="member.id" :value="member.id">{{ memberLabel(member) }}</option></select><span v-if="errors.reviewerMemberId" id="task-reviewer-error" class="error-text small" role="alert">{{ errors.reviewerMemberId }}</span><span class="muted small">开始任务不要求评审人；提交评审前须选择另一位在岗 Agent。</span></label>
    </div>
    <label class="field">标签<input v-model="draft.labelsText" data-testid="task-labels" :aria-invalid="!!errors.labels" :aria-describedby="errors.labels ? 'task-labels-error' : undefined" placeholder="以逗号分隔，例如：前端，体验" /><span class="muted small">最多 20 个，每个最多 40 字。</span><span v-if="errors.labels" id="task-labels-error" class="error-text small" role="alert">{{ errors.labels }}</span></label>
    <details class="task-candidate-fields" :open="editing || !!errors.repoPath || !!errors.fixedPoint || undefined">
      <summary>评审候选 <span class="muted small">创建时可稍后补齐</span></summary>
      <div class="task-field-grid">
        <label class="field">仓库路径<input v-model="draft.repoPath" maxlength="4096" data-testid="task-repo-path" :aria-invalid="!!errors.repoPath" :aria-describedby="errors.repoPath ? 'task-repo-error' : undefined" placeholder="服务所在设备上的 Git 仓库路径" /><span v-if="errors.repoPath" id="task-repo-error" class="error-text small" role="alert">{{ errors.repoPath }}</span></label>
        <label class="field">对比基准<input v-model="draft.fixedPoint" maxlength="512" data-testid="task-fixed-point" :aria-invalid="!!errors.fixedPoint" :aria-describedby="errors.fixedPoint ? 'task-fixed-error' : undefined" placeholder="commit SHA、分支或 tag" /><span v-if="errors.fixedPoint" id="task-fixed-error" class="error-text small" role="alert">{{ errors.fixedPoint }}</span></label>
      </div>
      <p class="muted small">提交评审时固定干净、已提交的 HEAD，并与对比基准生成候选。仓库中的未提交改动需先处理。</p>
    </details>
    </details>
  </fieldset>
</template>

<style scoped>
.task-fields { padding: 0; border: 0; display: grid; gap: 1rem; }
.task-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.task-fields textarea { min-height: 96px; }
.error-text { color: var(--bad); }
.task-optional-fields > summary { margin-bottom: 1rem; }.task-optional-fields > .field, .task-optional-fields > .task-field-grid { margin-bottom: 1rem; }
.task-candidate-fields { border-top: 1px solid var(--border); padding-top: .5rem; }
.task-candidate-fields summary { margin-bottom: .5rem; }
@media (max-width: 720px) { .task-field-grid { grid-template-columns: 1fr; } }
</style>
