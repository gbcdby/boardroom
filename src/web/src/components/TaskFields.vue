<script setup lang="ts">
import { computed } from "vue";
import type { MemberDto, OrgNodeDto } from "../api/client.ts";
import type { TaskDraft } from "../api/tasks.ts";
const draft = defineModel<TaskDraft>({ required: true });
const props = defineProps<{ members: MemberDto[]; nodes: OrgNodeDto[]; disabled: boolean; defaultReviewer?: string | null; editing?: boolean }>();
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
    <label class="field">标题<input v-model="draft.title" maxlength="200" required data-testid="task-title" placeholder="用一句话说明要完成什么" /></label>
    <label class="field">任务正文<textarea v-model="draft.body" rows="6" data-testid="task-body" aria-describedby="task-body-help" placeholder="目标、范围与验收条件" /><span id="task-body-help" class="muted small">支持纯文本或 Markdown。进入评审前需要填写正文。</span></label>
    <div class="task-field-grid">
      <label class="field">负责人<select v-model="draft.assigneeMemberId" required data-testid="task-assignee"><option value="" disabled>选择在岗成员</option><option v-if="draft.assigneeMemberId && !activeMembers.some((member) => member.id === draft.assigneeMemberId)" :value="draft.assigneeMemberId" disabled>原负责人已不可用，请重新选择</option><option v-for="member in activeMembers" :key="member.id" :value="member.id">{{ memberLabel(member) }}</option></select></label>
      <label class="field">Reviewer<select v-model="draft.reviewerMemberId" :required="editing" data-testid="task-reviewer"><option value="" :disabled="editing">{{ editing ? '选择评审 Agent' : defaultReviewer ? `使用项目默认：${defaultReviewer}` : '选择评审 Agent（尚无有效默认）' }}</option><option v-if="draft.reviewerMemberId && !reviewers.some((member) => member.id === draft.reviewerMemberId)" :value="draft.reviewerMemberId" disabled>当前 reviewer 不可用，请重新选择</option><option v-for="member in reviewers" :key="member.id" :value="member.id">{{ memberLabel(member) }}</option></select><span class="muted small">在岗 Agent，且不能与负责人相同。</span></label>
    </div>
    <label class="field">标签<input v-model="draft.labelsText" data-testid="task-labels" placeholder="以逗号分隔，例如：前端，体验" /><span class="muted small">最多 20 个，每个最多 40 字。</span></label>
    <details class="task-candidate-fields" :open="editing || undefined">
      <summary>评审候选 <span class="muted small">创建时可稍后补齐</span></summary>
      <div class="task-field-grid">
        <label class="field">仓库路径<input v-model="draft.repoPath" maxlength="4096" data-testid="task-repo-path" placeholder="服务所在设备上的 Git 仓库路径" /></label>
        <label class="field">对比基准<input v-model="draft.fixedPoint" maxlength="512" data-testid="task-fixed-point" placeholder="commit SHA、分支或 tag" /></label>
      </div>
      <p class="muted small">提交评审时固定干净、已提交的 HEAD，并与对比基准生成候选。仓库中的未提交改动需先处理。</p>
    </details>
  </fieldset>
</template>

<style scoped>
.task-fields { padding: 0; border: 0; display: grid; gap: 1rem; }
.task-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.task-fields textarea { min-height: 150px; }
.task-candidate-fields { border-top: 1px solid var(--border); padding-top: .5rem; }
.task-candidate-fields summary { margin-bottom: .5rem; }
@media (max-width: 720px) { .task-field-grid { grid-template-columns: 1fr; } }
</style>
