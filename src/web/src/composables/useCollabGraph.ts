/**
 * 协作关系图读模型（#177 S6-T6 的本机真实数据最小切片）。
 *
 * 只消费 main 已有的真实只读 API：projects / org / members / groups /
 * participants / member-statuses / messages。不写业务状态、不伪造关系、
 * 不引入示例节点。空数据就是空图——任何边都来自真实来源。
 * 纯投影逻辑见 collabGraphProjection.ts，便于脱离 Vue 做定向测试。
 */
import { ref, type Ref } from "vue";
import { api } from "../api/client.ts";
import { tasksApi } from "../api/tasks.ts";
import { runtimeApi } from "../api/runtimes.ts";
import {
  buildCollabGraphSnapshot, emptyCollabGraph,
  type CollabGraph, type GraphNode, type GraphGroup, type MessageEdge,
  type ConversationMessage, type GroupConversation, type TaskFlowItem,
  type RoleCapability, type RuntimeCapability, type RecentActivity,
} from "./collabGraphProjection.ts";

export type {
  CollabGraph, GraphNode, GraphGroup, MessageEdge, ConversationMessage,
  GroupConversation, TaskFlowItem, RoleCapability, RuntimeCapability, RecentActivity,
};

export function useCollabGraph(projectId: Ref<string | null>) {
  const graph = ref<CollabGraph>(emptyCollabGraph());
  const loading = ref(false);
  const error = ref<string | null>(null);
  let generation = 0;

  async function load(): Promise<void> {
    const id = projectId.value;
    const version = ++generation;
    if (!id) {
      graph.value = emptyCollabGraph();
      loading.value = false;
      error.value = null;
      return;
    }
    // 立即清空上一项目数据，避免加载失败/切换期间展示陈旧内容并冒充当前项目真实数据。
    graph.value = emptyCollabGraph();
    loading.value = true;
    error.value = null;
    try {
      const [projectResult, orgResult, groupsResult, membersResult, statusesResult, tasksResult, runtimeResult] = await Promise.all([
        api.listProjects({ includeArchived: true }),
        api.getOrg(id),
        api.listGroups(id, { includeArchived: false }),
        api.listMembers(id),
        api.listMemberStatuses(id),
        tasksApi.list(id),
        runtimeApi.list(),
      ]);
      if (version !== generation) return;
      // 并行拉取所有群的成员与消息；取回后校验版本再聚合，不跨群全文读取。
      const groupData = await Promise.all(groupsResult.groups.map(async (group) => ({
        group,
        participants: (await api.listParticipants(group.id)).participants,
        messages: (await api.listMessages(group.id)).messages,
      })));
      if (version !== generation) return;
      graph.value = buildCollabGraphSnapshot({
        project: projectResult.projects.find((item) => item.id === id) ?? null,
        org: orgResult,
        groups: groupsResult.groups,
        members: membersResult.members,
        participantsByGroup: new Map(groupData.map(({ group, participants }) => [group.id, participants])),
        memberStatuses: statusesResult.memberStatuses,
        messagesByGroup: new Map(groupData.map(({ group, messages }) => [group.id, messages])),
        tasks: tasksResult.tasks,
        runtimeViews: runtimeResult.runtimes,
      });
    } catch (err) {
      if (version === generation) error.value = err instanceof Error ? err.message : "关系图读取失败";
    } finally {
      if (version === generation) loading.value = false;
    }
  }

  return { graph, loading, error, load };
}
