<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ApiError, type MemberDto, type OrgNodeDto } from "../api/client.ts";
import { changedTaskInput, deliveryKindLabel, emptyTaskDraft, NO_REVIEWER, taskDraft, taskFieldErrors, taskStateLabel, tasksApi, type ReviewRound, type TaskDetail, type ReviewVerdict, type TaskDraft, type TaskFieldErrors } from "../api/tasks.ts";
import TaskFields from "../components/TaskFields.vue";
import ResourceSyncStatus from "../components/ResourceSyncStatus.vue";
import DecisionPanel from "../components/DecisionPanel.vue";
import { decisionResultMessage, postDecision, type DecisionRef, type LiveDecisionView, type RequestReviewDecisionInput, type ReviewHeadRef } from "../api/decisions.ts";
import type { DecideReviewInput } from "../../../shared/tasks.ts";
import { acceptsTaskDetail, readTaskDetail, type TaskDetailResource } from "../api/task-resources.ts";
import { useResourceReconciliation } from "../composables/useResourceReconciliation.ts";
import { projectPath, useCurrentProject, useProjectDraft } from "../composables/useCurrentProject.ts";
import { useToast } from "../composables/useToast.ts";

const context = useCurrentProject();
const toast = useToast();
const { currentProjectId, readonly: projectReadonly } = context;
const route = useRoute();
const taskId = computed(() => typeof route.params["taskId"] === "string" ? route.params["taskId"] : "");
const detail = ref<TaskDetail | null>(null);
const task = computed(() => detail.value?.task ?? null);
const members = ref<MemberDto[]>([]);
const nodes = ref<OrgNodeDto[]>([]);
const draft = ref(emptyTaskDraft());
const savedDraft = ref("");
const originalDraft = ref<TaskDraft>(emptyTaskDraft());
const baseRevision = ref<number | null>(null);
const saveUnknown = ref(false);
const editFields = ref<TaskFieldErrors>({});
const latestReadSucceeded = ref(false);
const editing = ref(false);
const comment = ref("");
const reason = ref("");
const reasonRevision = ref<number | null>(null);
const decisionReason = ref("");
const currentDecision = ref<LiveDecisionView | null>(null);
const decisionBase = ref<{ taskRevision: number; roundId: string; roundRevision: number; head: ReviewHeadRef | null; decisionRef: DecisionRef | null } | null>(null);
const decisionUnknown = ref(false);
const decisionRefreshed = ref(false);
const choiceLocked = ref(false);
type FrozenDecisionCommand = { kind: "legacy"; roundId: string; input: DecideReviewInput }
  | { kind: "proposal"; url: string; input: RequestReviewDecisionInput };
const frozenDecision = ref<FrozenDecisionCommand | null>(null);
const decisionReadSerial = ref(0);
const decisionConflictReadSerial = ref<number | null>(null);
const decisionLocked = computed(() => decisionUnknown.value || choiceLocked.value);
const verdict = ref<ReviewVerdict>("changes_requested");
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const conflict = ref(false);
let scopeVersion = 0;
let disposed = false;
const resource = useResourceReconciliation<TaskDetailResource, { projectId: string; key: string; taskId: string }>({
  read: (scope, reader) => readTaskDetail(reader, scope.projectId, scope.taskId), accepts: acceptsTaskDetail,
  relevant: (change, scope) => change.entity !== "task" || change.id === scope.taskId,
  onValue(snapshot, source) {
    detail.value = snapshot.detail; members.value = snapshot.org.members; nodes.value = snapshot.org.nodes;
    if (source === "read") latestReadSucceeded.value = true;
    if (!editing.value) {
      draft.value = taskDraft(snapshot.detail.task); originalDraft.value = taskDraft(snapshot.detail.task);
      savedDraft.value = JSON.stringify(draft.value); baseRevision.value = snapshot.detail.task.revision;
    }
  },
});
const loading = computed(() => resource.loading.value && resource.value.value === null);
const displayError = computed(() => error.value ?? resource.error.value);
const activeRound = computed(() => detail.value?.rounds.find((round) => round.id === task.value?.currentReviewRoundId) ?? null);
const reasonRemoteChanged = computed(() => !!reason.value.trim() && reasonRevision.value !== null && reasonRevision.value !== task.value?.revision);
function sameDecisionRef(left: DecisionRef | null, right: DecisionRef | null): boolean {
  return left === null || right === null ? left === right : left.decisionId === right.decisionId && left.revision === right.revision
    && left.actionDigest === right.actionDigest && left.projectId === right.projectId;
}
function sameDecisionHead(left: ReviewHeadRef | null, right: ReviewHeadRef | null): boolean {
  return left === null || right === null ? left === right : left.projectId === right.projectId && left.taskId === right.taskId
    && left.roundId === right.roundId && left.headRevision === right.headRevision && left.currentDecisionId === right.currentDecisionId;
}
const decisionRemoteChanged = computed(() => !!decisionReason.value.trim() && decisionBase.value !== null && (decisionBase.value.taskRevision !== task.value?.revision
  || decisionBase.value.roundId !== activeRound.value?.id || decisionBase.value.roundRevision !== activeRound.value?.revision
  || !sameDecisionHead(decisionBase.value.head, currentDecision.value?.head ?? null)
  || !sameDecisionRef(decisionBase.value.decisionRef, currentDecision.value?.ref ?? null)));
const needsExplicitProposal = computed(() => !!currentDecision.value && (currentDecision.value.status === "pending"
  ? currentDecision.value.actionRequest.action.payload.choice !== verdict.value : activeRound.value?.state === "reported"));
const proposalAllowed = computed(() => !needsExplicitProposal.value || !!decisionBase.value?.head && !!currentDecision.value?.allowedOperations.includes("propose-successor"));
const decisionRebaseNeeded = computed(() => decisionRemoteChanged.value || decisionConflictReadSerial.value !== null);
const decisionRebaseReady = computed(() => decisionConflictReadSerial.value === null || decisionReadSerial.value > decisionConflictReadSerial.value);
function receiveDecision(value: LiveDecisionView | null): void { currentDecision.value = value; decisionReadSerial.value++; }
function pinDecisionBase(): void {
  if (task.value && activeRound.value) decisionBase.value = { taskRevision: task.value.revision, roundId: activeRound.value.id,
    roundRevision: activeRound.value.revision, head: currentDecision.value ? { ...currentDecision.value.head } : null,
    decisionRef: currentDecision.value ? { ...currentDecision.value.ref } : null };
}
watch(reason, value => {
  if (!value.trim()) reasonRevision.value = null;
  else if (reasonRevision.value === null) reasonRevision.value = task.value?.revision ?? null;
}, { flush: "sync" });
watch(decisionReason, value => {
  if (!value.trim() && !decisionUnknown.value) { decisionBase.value = null; frozenDecision.value = null; decisionRefreshed.value = false; decisionConflictReadSerial.value = null; }
  else if (!decisionBase.value) pinDecisionBase();
}, { flush: "sync" });
const canOverride = computed(() => activeRound.value && ["reported", "decided"].includes(activeRound.value.state) && ["spec", "standards"].every((axis) => detail.value?.reports.some((report) => report.roundId === activeRound.value?.id && report.axis === axis)));
const blockedEscalation = computed(() => [...(detail.value?.history ?? [])].reverse().find((entry) => entry.action === "task.transitioned" && entry.detail["to"] === "blocked")?.detail["escalation"] as { unresolved?: boolean; recipientMemberId?: string | null } | undefined);
const changedInput = computed(() => changedTaskInput(draft.value, originalDraft.value));
const remoteChanged = computed(() => editing.value && task.value !== null && task.value.revision !== baseRevision.value);
const canSave = computed(() => !!task.value && baseRevision.value !== null && !projectReadonly.value && !busy.value && !saveUnknown.value && !remoteChanged.value && task.value.state !== "done" && draft.value.title.trim() !== ""
  && Object.keys(changedInput.value).length > 0
  && (!changedInput.value.assigneeMemberId || members.value.some(member => member.id === changedInput.value.assigneeMemberId && member.status === "active"))
  && (!changedInput.value.reviewerMemberId || members.value.some(member => member.id === changedInput.value.reviewerMemberId && member.kind === "agent" && member.status === "active"))
  && (!draft.value.assigneeMemberId || draft.value.reviewerMemberId === NO_REVIEWER || draft.value.assigneeMemberId !== draft.value.reviewerMemberId));
const hasDraft = () => (editing.value && JSON.stringify(draft.value) !== savedDraft.value) || !!comment.value || !!reason.value || !!decisionReason.value || decisionUnknown.value;
useProjectDraft(hasDraft, () => { editing.value = false; comment.value = ""; reason.value = ""; decisionUnknown.value = false; decisionReason.value = ""; draft.value = emptyTaskDraft(); });
function nameOf(id: string | null): string { return members.value.find((member) => member.id === id)?.displayName ?? (id ? "成员已不可用" : "待分派"); }
function time(iso: string): string { return new Date(iso).toLocaleString("zh-CN"); }
function isCurrent(projectId: string, id: string, generation: number, scope: number): boolean { return !disposed && currentProjectId.value === projectId && taskId.value === id && context.generation.value === generation && scopeVersion === scope; }
function reportsOf(round: ReviewRound) { return detail.value?.reports.filter((report) => report.roundId === round.id) ?? []; }
function roundState(state: ReviewRound["state"]): string { return ({ ready: "等待 reviewer 接手", running: "评审进行中", reported: "两轴报告已提交，等待裁决", decided: "已裁决", failed: "候选准备失败", superseded: "已被后续修改取代" })[state]; }
function actionLabel(action: string): string {
  return ({ "task.created": "创建任务", "task.updated": "修改任务", "task.transitioned": "变更状态", "task.commented": "添加评论", "task.review_started": "提交评审", "task.review_begun": "开始双轴评审", "task.review_decided": "评审裁决", "task.review_reported": "提交评审报告" } as Record<string, string>)[action] ?? action;
}

async function load(): Promise<void> { await resource.refresh(true); }

async function runMutation(kind: string, operation: (projectId: string, id: string) => Promise<unknown>, success: string, saved: () => void = () => {}): Promise<void> {
  const projectId = currentProjectId.value, id = taskId.value;
  if (!projectId || !task.value || !id || busy.value || projectReadonly.value) return;
  const generation = context.generation.value, scope = scopeVersion;
  busy.value = kind; error.value = null; notice.value = null; conflict.value = false; editFields.value = {};
  try {
    const result = await operation(projectId, id);
    if (!isCurrent(projectId, id, generation, scope)) return;
    const returnedTask = result && typeof result === "object" && "task" in result ? result.task as TaskDetail["task"] : null;
    const supersededSave = kind === "save" && returnedTask !== null && returnedTask.revision < (task.value?.revision ?? 0);
    if (!supersededSave) saved();
    else notice.value = "本次修改已保存，但当前任务已有后续更新。原草稿和保存基准已保留，请核对后再决定是否再次保存。";
    toast.success(success);
    await resource.committed(snapshot => snapshot && returnedTask && returnedTask.revision >= snapshot.detail.task.revision
      ? { ...snapshot, detail: { ...snapshot.detail, task: returnedTask } } : snapshot);
  } catch (err) {
    if (!isCurrent(projectId, id, generation, scope)) return;
    conflict.value = err instanceof ApiError && err.status === 409;
    if (kind === "save") editFields.value = taskFieldErrors(err);
    if (kind === "save") { saveUnknown.value = !(err instanceof ApiError) || err.status >= 500 || err.status === 408; latestReadSucceeded.value = false; }
    error.value = saveUnknown.value ? "保存结果尚未确认。请读取当前任务并核对；核对前不会重复提交，草稿和原版本已保留。" : conflict.value ? `任务已变更。${err instanceof Error ? err.message : ""} 你的草稿已保留，请载入最新版本并核对。` : err instanceof Error ? err.message : "操作失败，填写内容已保留。";
    if (kind === "review" && err instanceof ApiError && err.status === 400) await load();
  } finally { if (isCurrent(projectId, id, generation, scope)) busy.value = null; }
}
function edit(): void { if (!task.value || editing.value || projectReadonly.value || busy.value) return; draft.value = taskDraft(task.value); originalDraft.value = taskDraft(task.value); baseRevision.value = task.value.revision; savedDraft.value = JSON.stringify(draft.value); editing.value = true; saveUnknown.value = false; latestReadSucceeded.value = false; editFields.value = {}; }
function cancelEdit(): void {
  if (JSON.stringify(draft.value) !== savedDraft.value && typeof window !== "undefined" && !window.confirm("丢弃尚未保存的任务修改？")) return;
  editing.value = false;
  saveUnknown.value = false;
}
async function saveTask(): Promise<void> {
  if (!canSave.value || !task.value) return;
  const expectedRevision = baseRevision.value!, input = changedInput.value;
  await runMutation("save", (projectId, id) => tasksApi.update(projectId, id, { ...input, expectedRevision }), "任务已保存。", () => { editing.value = false; });
}
async function transition(state: "todo" | "in-progress" | "blocked"): Promise<void> {
  if (!task.value || reasonRemoteChanged.value || ((state === "blocked" || task.value.state === "done") && !reason.value.trim())) return;
  if (state === "in-progress" && task.value.materialStatus.startExecution.reasonCodes.length) return;
  const expectedRevision = reasonRevision.value ?? task.value.revision, enteredReason = reason.value.trim();
  const message = state === "todo" ? "任务已重新打开为待办。请按需重新分派、补齐资料后再开始。" : state === "blocked" ? "任务已标记为受阻。" : "任务已进入进行中。";
  await runMutation("transition", (projectId, id) => tasksApi.transition(projectId, id, { expectedRevision, state, ...(enteredReason ? { reason: enteredReason } : {}) }), message, () => { reason.value = ""; });
}
async function startReview(): Promise<void> {
  if (!task.value || task.value.state !== "in-progress" || task.value.materialStatus.submitReview.reasonCodes.length) return;
  const expectedRevision = task.value.revision;
  await runMutation("review", (projectId, id) => tasksApi.startReview(projectId, id, expectedRevision), "候选已固定，等待指定 reviewer 接手评审。");
}
async function sendComment(): Promise<void> {
  const body = comment.value.trim(); if (!body) return;
  await runMutation("comment", (projectId, id) => tasksApi.comment(projectId, id, body), "评论已保存。", () => { comment.value = ""; });
}
async function decide(retry = false): Promise<void> {
  const projectId = currentProjectId.value, id = taskId.value;
  if (!projectId || !id || busy.value || projectReadonly.value || choiceLocked.value) return;
  if (retry ? !decisionUnknown.value || !frozenDecision.value : !task.value || !activeRound.value || !canOverride.value || !decisionReason.value.trim()
    || !decisionBase.value || decisionRebaseNeeded.value || !proposalAllowed.value || decisionUnknown.value || decisionRefreshed.value || !!resource.error.value) return;
  if (!retry) {
    const base = decisionBase.value!;
    frozenDecision.value = needsExplicitProposal.value ? {
      kind: "proposal", url: `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(id)}/reviews/${encodeURIComponent(base.roundId)}/decision-requests`,
      input: { expectedTaskRevision: base.taskRevision, expectedRoundRevision: base.roundRevision, proposedVerdict: verdict.value,
        reason: decisionReason.value.trim(), requestedPath: "management", expectedHead: { ...base.head! }, idempotencyKey: crypto.randomUUID() },
    } : {
      kind: "legacy", roundId: base.roundId,
      input: { expectedTaskRevision: base.taskRevision, expectedRoundRevision: base.roundRevision, verdict: verdict.value,
        reason: decisionReason.value.trim(), override: true },
    };
  }
  const command = frozenDecision.value!, generation = context.generation.value, scope = scopeVersion;
  busy.value = "decision"; error.value = null; notice.value = null;
  try {
    // The compatibility key is derived by the server from this exact command.
    // A lost reply must not adopt a later Task/Round or manufacture a new choice.
    const result = command.kind === "proposal" ? await postDecision(command.url, command.input)
      : await tasksApi.decide(projectId, id, command.roundId, command.input);
    if (!isCurrent(projectId, id, generation, scope)) return;
    if (command.kind === "proposal" && (result.state === "applied" || result.state === "not_required" || result.receipt.execution !== null))
      throw new Error("提案回执包含未请求的执行结果，无法确认本次操作。");
    decisionUnknown.value = false;
    decisionRefreshed.value = result.state === "refreshed";
    if (decisionRefreshed.value && command.kind === "proposal") decisionConflictReadSerial.value = decisionReadSerial.value;
    notice.value = command.kind === "proposal" && result.state === "pending"
      ? `${decisionResultMessage(result)} 此次只建立替代提案，未应用任务结论；当前状态以上方记录为准。若仍待决，请另行选择是否同意应用。`
      : decisionResultMessage(result);
    if (result.state !== "refreshed") { decisionReason.value = ""; frozenDecision.value = null; }
    if (result.state === "applied") toast.success(notice.value);
    await resource.committed(snapshot => snapshot && result.task.revision >= snapshot.detail.task.revision
      ? { ...snapshot, detail: { ...snapshot.detail, task: result.task } } : snapshot);
  } catch (err) {
    if (!isCurrent(projectId, id, generation, scope)) return;
    // A rejected retry may mean that the current actor can no longer read the
    // receipt. It does not prove that the original command never committed.
    decisionUnknown.value = retry || !(err instanceof ApiError) || err.status >= 500 || err.status === 408;
    if (err instanceof ApiError && err.status === 409) decisionConflictReadSerial.value = decisionReadSerial.value;
    error.value = decisionUnknown.value
      ? "本次裁决结果尚未确认。原评审轮次、结论、理由和请求已锁定，只能原样重试确认。"
      : `${err instanceof Error ? err.message : "裁决操作失败。"} 原输入和版本已保留，请读取并核对当前任务与决定。`;
  } finally { if (isCurrent(projectId, id, generation, scope)) busy.value = null; }
}
function rebaseReason(): void {
  if (task.value && !busy.value && !projectReadonly.value && !resource.error.value) reasonRevision.value = task.value.revision;
}
function rebaseDecision(): void {
  if (!task.value || !activeRound.value || !canOverride.value || busy.value || decisionLocked.value || projectReadonly.value || resource.error.value || !decisionRebaseReady.value) return;
  pinDecisionBase(); decisionConflictReadSerial.value = null;
  if (frozenDecision.value?.kind === "proposal") { frozenDecision.value = null; decisionRefreshed.value = false; }
  error.value = null;
}
async function reloadLatest(): Promise<void> {
  const projectId = currentProjectId.value, id = taskId.value, generation = context.generation.value, scope = scopeVersion;
  if (!projectId || !id) return;
  latestReadSucceeded.value = false;
  error.value = null; await load();
  if (!isCurrent(projectId, id, generation, scope)) return;
  if (latestReadSucceeded.value && !displayError.value) { conflict.value = false; notice.value = editing.value ? `已载入最新版本；草稿仍基于版本 ${baseRevision.value}。请核对后明确采用最新版本。` : "已载入最新版本。"; }
}
function rebaseDraft(): void {
  if (!task.value || !editing.value || !latestReadSucceeded.value || busy.value || projectReadonly.value) return;
  const mine = Object.fromEntries(Object.entries(draft.value).filter(([key, value]) => value !== originalDraft.value[key as keyof TaskDraft]));
  const latest = taskDraft(task.value);
  originalDraft.value = latest; savedDraft.value = JSON.stringify(latest); baseRevision.value = task.value.revision;
  draft.value = { ...latest, ...mine }; saveUnknown.value = false; conflict.value = false; error.value = null; editFields.value = {};
  notice.value = `已采用版本 ${baseRevision.value}，保留你修改过的字段。请检查合并后的草稿再保存。`;
}
watch([currentProjectId, taskId, context.generation], () => {
  scopeVersion++; busy.value = null;
  detail.value = null; error.value = null; notice.value = null; conflict.value = false; editing.value = false;
  baseRevision.value = null; saveUnknown.value = false; latestReadSucceeded.value = false;
  decisionUnknown.value = false; decisionRefreshed.value = false; choiceLocked.value = false; frozenDecision.value = null;
  currentDecision.value = null; decisionReadSerial.value = 0; decisionConflictReadSerial.value = null;
  comment.value = ""; reason.value = ""; decisionReason.value = "";
  const projectId = currentProjectId.value, id = taskId.value;
  void resource.setScope(projectId && id ? { projectId, taskId: id, key: `${projectId}:${id}:${context.generation.value}:${scopeVersion}` } : null);
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; });
</script>

<template>
  <section class="page task-detail-page">
    <RouterLink v-if="currentProjectId" :to="projectPath(currentProjectId, 'tasks')" class="task-back">← 返回任务</RouterLink>
    <header class="page-header"><div><h1>{{ task?.title ?? '任务详情' }}</h1><p class="page-description">{{ task ? `由 ${task.author.displayName} 创建 · 更新于 ${time(task.updatedAt)}` : '任务内容、评审与协作记录' }}</p></div><div v-if="task" class="actions"><span class="badge" :class="`task-state-${task.state}`" data-testid="task-state">{{ taskStateLabel(task.state) }}</span><button type="button" :disabled="projectReadonly || !!busy || editing || task.state === 'done'" data-testid="task-edit-open" @click="edit">编辑任务</button></div></header>
    <p v-if="projectReadonly" class="notice" role="status">项目已归档，可阅读历史记录，无法编辑、评论或裁决。</p>
    <ResourceSyncStatus v-if="currentProjectId" :connection="resource.connection.value" :last-read-at="resource.lastSuccessAt.value" :failed="!!resource.error.value" />
    <div v-if="displayError" class="error" role="alert" data-testid="task-error">{{ displayError }}<button v-if="!conflict" type="button" class="text-button" :disabled="loading || !!busy" @click="reloadLatest">重新加载</button></div>
    <div v-if="conflict" class="notice" role="status" data-testid="task-conflict">你的输入已保留。载入最新任务后，请与草稿核对，再提交更改。 <button type="button" class="text-button" :disabled="loading || !!busy" data-testid="task-reload" @click="reloadLatest">载入最新版本（保留草稿）</button></div>
    <p v-if="notice" class="notice" role="status" data-testid="task-notice">{{ notice }}</p>
    <p v-if="loading" class="muted" role="status">正在读取任务…</p>
    <template v-if="task && detail">
      <section v-if="editing" class="panel"><h2>编辑任务</h2><p class="muted small" data-testid="task-draft-base">草稿基于版本 {{ baseRevision }}；仅提交修改过的字段。</p><p v-if="task.state === 'review'" class="warning-text small">修改候选相关内容会结束当前评审，并将任务恢复为进行中。</p>
        <section v-if="remoteChanged || saveUnknown" class="notice" data-testid="task-remote-changes"><h3>{{ remoteChanged ? '远端已更新，请核对当前任务与草稿' : '核对当前任务与草稿' }}</h3><p>草稿基于版本 {{ baseRevision }}，当前读取的任务为版本 {{ task.revision }}。读取不会自动更换草稿的保存基准。</p><dl class="task-meta"><div><dt>当前标题</dt><dd>{{ task.title }}</dd></div><div><dt>当前目标</dt><dd class="task-body">{{ task.body || '未填写' }}</dd></div><div><dt>当前验收</dt><dd class="task-body">{{ task.acceptanceText || '未填写' }}</dd></div><div><dt>当前交付类型</dt><dd>{{ deliveryKindLabel(task.deliveryKind) }}</dd></div><div><dt>当前负责人 / 评审人</dt><dd>{{ nameOf(task.assigneeMemberId) }} / {{ nameOf(task.reviewerMemberId) }}</dd></div><div><dt>当前仓库 / 基准</dt><dd>{{ task.repoPath || '未填写' }} / {{ task.fixedPoint || '未填写' }}</dd></div><div><dt>当前标签</dt><dd>{{ task.labels.join('，') || '无' }}</dd></div></dl><button type="button" :disabled="!latestReadSucceeded || !!busy || projectReadonly" data-testid="task-rebase" @click="rebaseDraft">已核对，保留我的修改并采用版本 {{ task.revision }}</button><p class="muted small">采用后，你未改过的字段会跟随当前任务；你改过的字段保留为草稿，仍需点击保存。</p></section>
        <form @submit.prevent="saveTask"><TaskFields v-model="draft" :members="members" :nodes="nodes" :disabled="projectReadonly || !!busy || saveUnknown" :errors="editFields" editing /><div class="actions task-actions"><button type="submit" class="primary" :disabled="!canSave" data-testid="task-save">{{ busy === 'save' ? '正在保存…' : '保存修改' }}</button><button type="button" :disabled="!!busy" @click="cancelEdit">取消编辑</button></div></form></section>
      <section v-else class="panel"><h2>目标与范围</h2><p class="task-body">{{ task.body || '尚未补充目标与范围。' }}</p><h3>验收条件</h3><p class="task-body" data-testid="task-acceptance-text">{{ task.acceptanceText || '尚未填写验收条件。' }}</p><p v-if="task.acceptanceSource === 'legacy_task_body'" class="muted small">来源：迁移时的旧任务正文快照。修改目标不会自动改变此验收内容。</p><dl class="task-meta"><div><dt>交付类型</dt><dd>{{ deliveryKindLabel(task.deliveryKind) }}</dd></div><div><dt>负责人</dt><dd>{{ nameOf(task.assigneeMemberId) }}</dd></div><div><dt>评审人</dt><dd>{{ nameOf(task.reviewerMemberId) }}</dd></div><div><dt>仓库</dt><dd>{{ task.repoPath || '待补充' }}</dd></div><div><dt>对比基准</dt><dd>{{ task.fixedPoint || '待补充' }}</dd></div></dl><div v-if="task.labels.length" class="actions"><span v-for="label in task.labels" :key="label" class="badge">{{ label }}</span></div></section>

      <section class="panel"><h2>推进任务</h2><p v-if="task.state === 'blocked'" class="warning-text" data-testid="task-blocked-reason">{{ task.blockedReason }}<span v-if="blockedEscalation?.unresolved"> · 尚无可接收此问题的上级，请联系项目管理者。</span><span v-else-if="blockedEscalation?.recipientMemberId"> · 已记录向 {{ nameOf(blockedEscalation.recipientMemberId) }} 升级。</span></p><p v-if="task.state === 'review'" class="muted small">评审基于已固定的候选。取消评审或修改任务后，需要重新提交评审。</p><p v-if="task.state === 'done'" class="muted small">管理者写明原因后可重新打开为待办，重新分派、补齐资料后再开始。原评审与结论会留在历史中。</p>
        <div class="task-materials" data-testid="task-materials"><h3>{{ task.state === 'in-progress' || task.state === 'review' ? '送审前待补资料' : '开始前待补资料' }}</h3><ul v-if="(task.state === 'in-progress' || task.state === 'review' ? task.materialStatus.submitReview : task.materialStatus.startExecution).issues.length"><li v-for="issue in (task.state === 'in-progress' || task.state === 'review' ? task.materialStatus.submitReview : task.materialStatus.startExecution).issues" :key="`${issue.code}:${issue.field}`" :data-field="issue.field">{{ issue.message }}</li></ul><p v-else class="muted small">此阶段所需资料已填写。</p><p class="muted small">资料检查只用于推进任务记录，不表示已创建执行实例或获得政策批准。</p><p v-if="task.deliveryKind === 'artifact' || task.deliveryKind === 'finding'" class="muted small">分类产物评审尚未接入；目前可以完善资料，不能通过代码评审路径完成。</p></div>
        <div class="actions"><button v-if="['todo', 'blocked', 'review'].includes(task.state)" type="button" :disabled="projectReadonly || !!busy || reasonRemoteChanged || task.materialStatus.startExecution.reasonCodes.length > 0" data-testid="task-start" @click="transition('in-progress')">{{ task.state === 'todo' ? '开始任务' : task.state === 'blocked' ? '恢复进行' : '取消评审，继续修改' }}</button><button v-if="task.state === 'in-progress'" type="button" class="primary" :disabled="projectReadonly || !!busy || task.materialStatus.submitReview.reasonCodes.length > 0" data-testid="task-start-review" @click="startReview">{{ busy === 'review' ? '正在准备候选…' : '提交评审' }}</button></div>
        <form v-if="['todo', 'in-progress', 'review', 'done'].includes(task.state) || !!reason" class="task-reason-form" @submit.prevent="task.state !== 'blocked' && transition(task.state === 'done' ? 'todo' : 'blocked')">
          <p v-if="task.state === 'blocked'" class="muted small">这份理由尚未提交。请核对上方当前受阻原因；采用当前版本后可将理由用于“恢复进行”，也可仅丢弃这份理由草稿。</p>
          <label class="field">{{ task.state === 'done' ? '重新打开原因' : task.state === 'blocked' ? '未提交的理由草稿' : '受阻原因' }}<textarea v-model="reason" rows="2" maxlength="2000" required :disabled="projectReadonly || !!busy" data-testid="task-transition-reason" :placeholder="task.state === 'done' ? '说明为什么需要重新打开为待办' : '说明卡点，以及需要什么支持'" /></label>
          <p v-if="reasonRemoteChanged" class="notice">任务已更新；理由仍基于版本 {{ reasonRevision }}，当前任务为版本 {{ task.revision }}（{{ taskStateLabel(task.state) }}）。请核对当前任务。<button type="button" class="text-button" :disabled="!!busy || projectReadonly || !!resource.error.value" data-testid="task-reason-rebase" @click="rebaseReason">已核对当前任务，保留理由并采用最新版本</button></p>
          <button v-if="task.state === 'blocked'" type="button" :disabled="projectReadonly || !!busy" data-testid="task-reason-discard" @click="reason = ''">丢弃这份理由草稿</button>
          <button v-else type="submit" :disabled="projectReadonly || !!busy || !reason.trim() || reasonRemoteChanged" data-testid="task-block">{{ task.state === 'done' ? '重新打开待办' : '标记为受阻' }}</button>
        </form>
      </section>

      <section class="panel" data-testid="task-reviews"><h2>双轴评审</h2><p v-if="detail.rounds.length === 0" class="muted">尚未发起评审。进行中的任务补齐评审资料后，可提交固定候选。</p>
        <details v-for="round in [...detail.rounds].reverse()" :key="round.id" class="review-round" :open="round.id === task.currentReviewRoundId || round.state === 'failed'"><summary>{{ roundState(round.state) }} <span class="muted small">{{ time(round.createdAt) }}</span></summary>
          <p v-if="round.failure" class="error" role="status">{{ round.failure.message }}。请修正候选资料后重新提交评审。</p>
          <p v-if="round.decision" class="notice">{{ round.decision.override ? '管理者覆盖裁决' : 'Reviewer 裁决' }}：{{ round.decision.verdict === 'pass' ? '通过' : '需要修改' }} · {{ round.decision.actor.displayName }}<br />{{ round.decision.reason }}</p>
          <div class="review-axes"><section v-for="axis in ['spec', 'standards']" :key="axis" class="review-axis" :data-testid="`task-report-${axis}`"><h3>{{ axis === 'spec' ? '需求轴' : '标准轴' }}</h3><template v-for="report in reportsOf(round).filter((report) => report.axis === axis)" :key="report.id"><span class="badge" :class="report.verdict === 'pass' ? 'ok' : 'warning-text'">{{ report.verdict === 'pass' ? '通过' : '需要修改' }}</span><p class="task-body">{{ report.body }}</p><details><summary>来源与执行证据</summary><ul><li v-for="source in report.sources" :key="source" class="small">{{ source }}</li></ul><p class="muted small">以下执行记录由 reviewer 声明，平台未据此验证真实宿主。</p><pre class="task-evidence">{{ JSON.stringify(report.evidence, null, 2) }}</pre></details></template><p v-if="!reportsOf(round).some((report) => report.axis === axis)" class="muted small">尚无此轴报告。</p></section></div>
          <details v-if="round.candidate" class="candidate-evidence"><summary>固定候选与采集记录</summary><dl class="task-meta"><div><dt>基准</dt><dd><code>{{ round.candidate.baseCommit }}</code></dd></div><div><dt>候选</dt><dd><code>{{ round.candidate.candidateCommit }}</code></dd></div><div><dt>Diff 摘要</dt><dd><code>{{ round.candidate.diffSha256 }}</code></dd></div></dl><h3>目标快照</h3><p class="task-body">{{ round.specSnapshot.body }}</p><template v-if="round.specSnapshot.acceptanceText !== undefined"><h3>验收快照</h3><p class="task-body">{{ round.specSnapshot.acceptanceText }}</p><p class="muted small">{{ round.specSnapshot.acceptanceSource === 'legacy_task_body' ? '来源：旧任务正文快照' : '来源：明确填写' }}</p></template><h3>提交记录</h3><ul><li v-for="commit in round.candidate.commits" :key="commit.sha"><code>{{ commit.sha }}</code> {{ commit.subject }}</li></ul><h3>代码差异</h3><pre class="task-evidence" tabindex="0" aria-label="评审代码差异">{{ round.candidate.diff }}</pre><details><summary>Git 采集命令</summary><pre class="task-evidence">{{ JSON.stringify(round.candidate.commands, null, 2) }}</pre></details></details>
        </details>
        <DecisionPanel :task-id="task.id" :round-id="task.currentReviewRoundId" :round-state="activeRound?.state ?? null" :blocked="!!busy || decisionUnknown" @current="receiveDecision" @locked="choiceLocked = $event" @committed="resource.committed()" />
        <form v-if="canOverride || !!decisionReason || decisionUnknown" class="override-form" @submit.prevent="decide()">
          <h3>{{ canOverride ? '管理者覆盖裁决' : '未提交的裁决草稿' }}</h3>
          <p class="muted small">以当前网页的管理者身份提出并确认此任务结论。两轴报告和原裁决会保留；是否已应用以回执为准。拒绝或退回上方提案不会改变任务结论。</p>
          <p v-if="needsExplicitProposal" class="notice" data-testid="task-decision-proposal-notice">当前已有{{ currentDecision?.actionRequest.action.payload.choice === 'pass' ? '通过评审' : '要求修改' }}提案。建立替代提案只保存你提出的结论，任务保持原样；随后须在上方新提案中另行选择是否同意应用。</p>
          <p v-if="!canOverride" class="notice" data-testid="task-decision-unavailable">当前没有可提交裁决的评审轮次。理由保留在这里，可继续编辑或单独丢弃；新的两轴报告齐备后，请核对候选再明确采用。</p>
          <label class="field">结论<select v-model="verdict" :disabled="projectReadonly || !!busy || decisionLocked" data-testid="task-decision-verdict"><option value="changes_requested">需要修改，返回进行中</option><option value="pass">通过，标记完成</option></select></label>
          <label class="field">裁决原因<textarea v-model="decisionReason" rows="3" maxlength="2000" required :disabled="projectReadonly || !!busy || decisionLocked" data-testid="task-decision-reason" /></label>
          <p v-if="decisionBase" class="muted small" data-testid="task-decision-base">草稿基于任务版本 {{ decisionBase.taskRevision }}，评审轮次 {{ decisionBase.roundId }} / 版本 {{ decisionBase.roundRevision }}。<span v-if="decisionBase.head">当前提案 {{ decisionBase.head.currentDecisionId }} / 提案链版本 {{ decisionBase.head.headRevision }}，决定版本 {{ decisionBase.decisionRef?.revision }}。</span></p>
          <p v-if="decisionRebaseNeeded" class="notice" data-testid="task-decision-conflict">任务、评审轮次或提案已变化，裁决理由仍绑定原版本。当前任务为版本 {{ task.revision }}；<template v-if="activeRound">当前评审为 {{ activeRound.id }} / 版本 {{ activeRound.revision }}（{{ roundState(activeRound.state) }}）</template><template v-else>暂无当前评审轮次</template><template v-if="currentDecision">；当前提案 {{ currentDecision.ref.decisionId }} / 提案链版本 {{ currentDecision.head.headRevision }}，决定版本 {{ currentDecision.ref.revision }}</template>。请核对上方当前候选与两轴报告。<span v-if="!decisionRebaseReady">正在等待读取当前决定；读取成功前保留原基准。</span><button type="button" class="text-button" :disabled="!canOverride || !decisionRebaseReady || !!busy || decisionLocked || projectReadonly || !!resource.error.value" data-testid="task-decision-rebase" @click="rebaseDecision">已核对当前候选，保留理由并采用当前版本</button></p>
          <p v-if="decisionRefreshed" class="notice" data-testid="task-decision-refreshed">本次仅更新了策略评估，原裁决未执行。请在上方“评审提案与选择”核对最新提案并明确选择；重试原裁决不会自动应用新策略。</p>
          <button v-if="!!decisionReason" type="button" :disabled="!!busy || decisionLocked" data-testid="task-decision-discard" @click="decisionReason = ''">仅丢弃这份裁决理由</button>
          <button v-if="decisionUnknown" type="button" class="primary" :disabled="projectReadonly || !!busy || choiceLocked" data-testid="task-decision-retry" @click="decide(true)">原样重试，确认这次裁决结果</button>
          <button v-else type="submit" class="primary" :disabled="!canOverride || !proposalAllowed || projectReadonly || !!busy || choiceLocked || decisionRefreshed || !!resource.error.value || !decisionReason.trim() || decisionRebaseNeeded" data-testid="task-decide">{{ needsExplicitProposal ? '建立替代提案（需另行选择）' : '保存覆盖裁决' }}</button>
        </form>
      </section>

      <section class="panel" data-testid="task-comments"><h2>评论</h2><p v-if="detail.comments.length === 0" class="muted">还没有评论。</p><ol class="task-comments"><li v-for="entry in detail.comments" :key="entry.id"><div class="comment-heading"><strong>{{ entry.author.displayName }}</strong><span v-if="entry.kind === 'review_report'" class="badge">评审报告</span><time :datetime="entry.createdAt">{{ time(entry.createdAt) }}</time></div><p class="task-body">{{ entry.body }}</p></li></ol><form class="task-comment-form" @submit.prevent="sendComment"><label class="field">添加评论<textarea v-model="comment" rows="3" :disabled="projectReadonly || !!busy" data-testid="task-comment-body" placeholder="补充进度、问题或需要协作的信息" /></label><button type="submit" :disabled="projectReadonly || !!busy || !comment.trim()" data-testid="task-comment-send">{{ busy === 'comment' ? '正在保存…' : '发表评论' }}</button></form></section>
      <section v-if="detail.messageLinks.length && currentProjectId" class="panel"><h2>关联消息</h2><ul><li v-for="link in detail.messageLinks" :key="link.messageId"><RouterLink :to="{ path: projectPath(currentProjectId, 'chat', link.groupId), query: { messageId: link.messageId } }">查看关联群聊 · {{ time(link.createdAt) }}</RouterLink></li></ul></section>
      <section class="panel" data-testid="task-history"><h2>变更历史</h2><ol class="task-history"><li v-for="entry in detail.history" :key="entry.id"><p><strong>{{ actionLabel(entry.action) }}</strong> · {{ entry.actor.displayName }} <time :datetime="entry.createdAt" class="muted small">{{ time(entry.createdAt) }}</time></p><details><summary class="small">变更详情 · 版本 {{ entry.taskRevision }}</summary><pre class="task-evidence">{{ JSON.stringify(entry.detail, null, 2) }}</pre></details></li></ol><p v-if="detail.history.length === 0" class="muted">暂无变更记录。</p></section>
    </template>
  </section>
</template>

<style scoped>
.task-back { display: inline-block; margin-bottom: 1rem; }.task-detail-page h1 { max-width: 850px; }
.task-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.75; }.task-actions { margin-top: 1rem; }
.task-meta { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 1rem; margin: 1.5rem 0; }.task-meta div { min-width: 0; }.task-meta dt { color: var(--muted); font-size: .85rem; }.task-meta dd { margin: .25rem 0 0; overflow-wrap: anywhere; }
.task-reason-form, .task-comment-form { display: grid; gap: .75rem; margin-top: 1rem; }.task-reason-form button, .task-comment-form button { justify-self: start; }
.review-round { padding: .75rem 0; border-top: 1px solid var(--border); }.review-round > summary { display: list-item; }.review-round > summary span { margin-left: .5rem; }
.review-axes { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 1rem; margin: 1rem 0; }.review-axis { min-width: 0; padding: 1rem; background: var(--surface-subtle); border-radius: 10px; }.review-axis li { overflow-wrap: anywhere; }
.task-evidence { max-height: 380px; overflow: auto; padding: .85rem; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.override-form { display: grid; gap: .9rem; border-top: 1px solid var(--border); padding-top: 1.25rem; margin-top: 1rem; }.override-form button { justify-self: start; }.override-form h3, .override-form p { margin: 0; }
.task-comments, .task-history { list-style: none; padding: 0; margin: 0; }.task-comments li, .task-history li { padding: 1rem 0; border-bottom: 1px solid var(--border); }.comment-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: .6rem; }.comment-heading time { font-size: .8rem; color: var(--muted); }.task-state-blocked { color: var(--warn); }.task-state-done { color: var(--ok); }
@media (max-width: 720px) { .task-meta, .review-axes { grid-template-columns: 1fr; } }
</style>
