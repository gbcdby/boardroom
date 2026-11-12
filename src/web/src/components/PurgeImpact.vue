<script setup lang="ts">
import type { GroupPurgeConfirmation, ProjectPurgeConfirmation } from "../api/client.ts";
defineProps<{ confirmation: ProjectPurgeConfirmation | GroupPurgeConfirmation }>();
</script>

<template>
  <div v-if="confirmation.kind === 'project'" data-testid="project-purge-confirm">
    <p class="muted small">将同时删除以下内容：</p>
    <ul class="small">
      <li>群组：{{ confirmation.cascade.groups }} 个</li>
      <li>工作区配置及历史版本：{{ confirmation.cascade.workspaceVersions }} 个</li>
      <li>项目策略配置：{{ confirmation.cascade.policyDocuments }} 份</li>
      <li>项目策略历史版本：{{ confirmation.cascade.policyVersions }} 个</li>
      <li>任务：{{ confirmation.cascade.tasks }} 项（评论 {{ confirmation.cascade.taskComments }} 条，历史 {{ confirmation.cascade.taskHistory }} 条）</li>
      <li>评审：{{ confirmation.cascade.reviewRounds }} 轮，报告 {{ confirmation.cascade.reviewReports }} 份</li>
      <li>任务关联消息：{{ confirmation.cascade.taskMessageLinks }} 条，工作事件 {{ confirmation.cascade.workEvents }} 条，任务设置 {{ confirmation.cascade.taskSettings }} 条</li>
      <li>记忆文档：{{ confirmation.cascade.memoryDocuments }} 份（历史版本 {{ confirmation.cascade.memoryVersions }} 个）</li>
      <li>自总结请求：{{ confirmation.cascade.memorySummaryRequests }} 条</li>
      <li>记忆投递收据：{{ confirmation.cascade.memoryMessageReceipts }} 条，触发计数 {{ confirmation.cascade.memoryTriggerCounters }} 条，扫描检查点 {{ confirmation.cascade.memoryScanCheckpoints }} 条</li>
      <li>成员：{{ confirmation.cascade.members }} 个</li>
      <li>组织岗位：{{ confirmation.cascade.orgNodes }} 个</li>
      <li>群聊消息：{{ confirmation.cascade.messages }} 条（投递记录 {{ confirmation.cascade.deliveries }} 条）</li>
      <li>成员状态：{{ confirmation.cascade.memberStatuses }} 条</li>
      <li>成员关系版本：{{ confirmation.cascade.memberFactRevisions }} 条</li>
      <li>MCP 会话记录：{{ confirmation.cascade.mcpSessions }} 条</li>
      <li>托管群绑定：{{ confirmation.cascade.agentRuntimeBindings }} 条</li>
      <li>托管运行状态：{{ confirmation.cascade.agentRunnerStates }} 条</li>
      <li>托管成员预留关系：{{ confirmation.cascade.agentRuntimeMembers }} 条</li>
    </ul>
    <p class="muted small">项目共享与成员记忆会随项目删除。Agent 的全局私有记忆保留。</p>
    <p class="muted small">工作区配置删除后，用户原工作目录、代码与目录内的 Skills 文件仍然保留。</p>
    <p class="muted small">全局托管配置和 Agent 身份保留；其他项目的成员、托管群绑定与运行状态保留。</p>
    <p class="muted small">确认凭据在 {{ confirmation.expiresAt }} 后失效。</p>
  </div>
  <div v-else data-testid="group-purge-confirm">
    <p class="muted small">将同时删除以下内容：</p>
    <ul class="small">
      <li>群聊消息：{{ confirmation.cascade.messages }} 条（投递记录 {{ confirmation.cascade.deliveries }} 条）</li>
      <li>参与者关系：{{ confirmation.cascade.participants }} 条</li>
      <li>任务关联消息：{{ confirmation.cascade.taskMessageLinks }} 条（任务与评审保留）</li>
      <li>该群工作事件：{{ confirmation.cascade.workEvents }} 条（其它工作事件保留）</li>
      <li>自总结请求：{{ confirmation.cascade.memorySummaryRequests }} 条</li>
      <li>记忆投递收据：{{ confirmation.cascade.memoryMessageReceipts }} 条，触发计数 {{ confirmation.cascade.memoryTriggerCounters }} 条，扫描检查点 {{ confirmation.cascade.memoryScanCheckpoints }} 条</li>
      <li>MCP 会话记录：{{ confirmation.cascade.mcpSessions }} 条</li>
      <li>托管群绑定：{{ confirmation.cascade.agentRuntimeBindings }} 条</li>
      <li>托管运行状态：{{ confirmation.cascade.agentRunnerStates }} 条</li>
      <li>托管成员预留关系：{{ confirmation.cascade.agentRuntimeMembers }} 条</li>
    </ul>
    <p class="muted small">记忆正文与版本历史全部保留；该群的总结请求与触发记录会一并清除。</p>
    <p class="muted small">项目工作区配置与用户原工作目录保留。</p>
    <p class="muted small">全局托管配置和项目成员保留；其他群的托管绑定与运行状态保留。仅清除删除后不再有其他群绑定的未占用预留关系。</p>
    <p class="muted small">确认凭据在 {{ confirmation.expiresAt }} 后失效。</p>
  </div>
</template>

<style scoped>
ul { padding-left: 1.15rem; }
</style>
