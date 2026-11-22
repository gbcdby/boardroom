/**
 * 协作关系图读模型（#177 S6-T6 的本机真实数据最小切片）。
 *
 * 只消费 main 已有的真实只读 API：projects / org / members / groups /
 * participants / member-statuses / messages。不写业务状态、不伪造关系、
 * 不引入示例节点。空数据就是空图——任何边都来自真实来源：
 *   - 总管 = project.manager（真实负责人成员）
 *   - 项目负责人 = org 中 top_manager 岗位的占据者
 *   - 群 = 项目未归档群；群内成员 = 真实 participants
 *   - 成员状态 = member-statuses 的 state/connection
 *   - 消息方向 = 群内真实 messages 的 sender（只统计真实发送者）
 */
import { ref, type Ref } from "vue";
import {
  api,
  type MemberDto,
  type MemberStatusDto,
  type OrgNodeDto,
  type ProjectDto,
} from "../api/client.ts";
import { tasksApi, taskStateLabel, type Task } from "../api/tasks.ts";
import { runtimeApi } from "../api/runtimes.ts";

export interface GraphNode {
  id: string;
  name: string;
  initials: string;
  role: string;
  status: string;
  tone: "ok" | "active" | "wait" | "idle";
  kind: "manager" | "lead" | "group" | "member";
  avatarSeed: number;
}

export interface GraphGroup {
  id: string;
  name: string;
  icon: string;
  members: GraphNode[];
  /** 真实消息发送者数量（消息方向边的来源统计，不伪造两两私信）。 */
  senderCount: number;
  messageCount: number;
}

export interface MessageEdge {
  /** 真实消息的逻辑 ID（MessageDto.id），可逐条追溯到来源。 */
  id: string;
  groupId: string;
  groupName: string;
  senderMemberId: string;
  sender: string;
  text: string;
  createdAt: string;
  avatarSeed: number;
}

export interface ConversationMessage {
  id: string;
  senderMemberId: string;
  sender: string;
  text: string;
  createdAt: string;
  avatarSeed: number;
  mentions: string[];
}

export interface GroupConversation {
  groupId: string;
  groupName: string;
  messages: ConversationMessage[];
}

export interface TaskFlowItem {
  id: string;
  title: string;
  state: string;
  stateLabel: string;
  assignee: string | null;
  blockedReason: string | null;
  /** 资料 readiness 原因码（executionAdmission 始终 not-issued，不冒充执行放行）。 */
  readinessCodes: string[];
  revision: number;
  updatedAt: string;
}

export interface RoleCapability {
  role: string;
  capabilities: string[];
  nodeRole: boolean;
}

export interface RuntimeCapability {
  runtimeName: string;
  bindingId: string;
  projectId: string;
  groupName: string;
  supported: boolean;
  reason: string;
  isolation: "verified" | "unavailable" | "unverified";
  runnerState: string;
}

export interface RecentActivity {
  id: string;
  groupName: string;
  sender: string;
  text: string;
  createdAt: string;
  avatarSeed: number;
}

export interface CollabGraph {
  root: GraphNode | null;
  lead: GraphNode | null;
  groups: GraphGroup[];
  memberCount: number;
  messageCount: number;
  recent: RecentActivity[];
  /** 真实消息方向边：sender → 所属群，按时间倒序，最多 6 条用于画布标记。 */
  messageEdges: MessageEdge[];
  /** 按群聚合的完整真实会话，供图内检查器显示（不编造 transcript/工具/思考）。 */
  conversations: GroupConversation[];
  /** 真实任务流转项（阶段/负责人/readiness），来自 tasks API。 */
  tasks: TaskFlowItem[];
  /** 真实角色能力目录（org.roles），来自组织树只读 API。 */
  roles: RoleCapability[];
  /** 真实运行时能力状态（supported/reason/isolation），来自 runtimes API。 */
  runtimeCapabilities: RuntimeCapability[];
}

function initials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1) : "?";
}

function avatarSeed(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 7;
  return hash;
}

function toneFor(status: MemberStatusDto | undefined, lifecycle: MemberDto["status"] | undefined): GraphNode["tone"] {
  if (lifecycle === "disabled" || lifecycle === "pending") return "idle";
  if (!status) return "idle";
  if (status.state === "working") return "active";
  if (status.state === "waiting") return "wait";
  if (status.connection === "connected" || status.state === "online") return "ok";
  return "idle";
}

function statusLabel(status: MemberStatusDto | undefined, lifecycle: MemberDto["status"] | undefined): string {
  if (lifecycle === "disabled") return "已停用";
  if (lifecycle === "pending") return "待激活";
  if (!status) return "未连接";
  if (status.state === "working") return "执行中";
  if (status.state === "waiting") return "等待中";
  if (status.state === "online") return "在线(未工作)";
  if (status.connection === "connected") return "连接正常(未工作)";
  return "离线";
}

function memberNode(
  member: MemberDto,
  statusMap: Map<string, MemberStatusDto>,
  kind: GraphNode["kind"],
  role: string,
): GraphNode {
  const status = statusMap.get(member.id);
  return {
    id: member.id,
    name: member.displayName,
    initials: initials(member.displayName),
    role,
    status: statusLabel(status, member.status),
    tone: toneFor(status, member.status),
    kind,
    avatarSeed: avatarSeed(member.id),
  };
}

export function useCollabGraph(projectId: Ref<string | null>) {
  const EMPTY: CollabGraph = { root: null, lead: null, groups: [], memberCount: 0, messageCount: 0, recent: [], messageEdges: [], conversations: [], tasks: [], roles: [], runtimeCapabilities: [] };
  const graph = ref<CollabGraph>({ ...EMPTY });
  const loading = ref(false);
  const error = ref<string | null>(null);
  let generation = 0;

  async function load(): Promise<void> {
    const id = projectId.value;
    const version = ++generation;
    if (!id) {
      graph.value = { ...EMPTY };
      loading.value = false;
      error.value = null;
      return;
    }
    // 立即清空上一项目数据，避免加载失败/切换期间展示陈旧内容并冒充当前项目真实数据。
    graph.value = { ...EMPTY };
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
      const project = projectResult.projects.find((p) => p.id === id) ?? null;
      const statusMap = new Map(statusesResult.memberStatuses.map((s) => [s.memberId, s]));
      const memberMap = new Map(membersResult.members.map((m) => [m.id, m]));

      // 身份按真实 DTO 语义标注，不把项目负责人冒充"总管"：
      // project.manager = 项目负责人；org 的 top_manager = 顶级主管岗位（真实组织树占据者）。
      const root = project?.manager ? memberNode(project.manager, statusMap, "manager", "项目负责人") : null;
      const leadNode = orgResult.nodes.find((node: OrgNodeDto) => node.role === "top_manager" && node.memberId);
      const leadMember = leadNode?.memberId ? memberMap.get(leadNode.memberId) : null;
      const lead = leadMember ? memberNode(leadMember, statusMap, "lead", "顶级主管岗位") : null;

      const groups: GraphGroup[] = [];
      const recent: RecentActivity[] = [];
      const messageEdges: MessageEdge[] = [];
      const conversations: GroupConversation[] = [];
      let totalMessages = 0;
      const seenMembers = new Set<string>();
      // 并行拉取所有群的成员与消息，群数多时避免串行线性等待；取回后校验版本再聚合。
      const groupData = await Promise.all(groupsResult.groups.map(async (group) => ({
        group,
        participants: (await api.listParticipants(group.id)).participants,
        messages: (await api.listMessages(group.id)).messages,
      })));
      if (version !== generation) return;
      for (const { group, participants, messages } of groupData) {
        totalMessages += messages.length;
        for (const message of messages) {
          recent.push({
            id: message.id,
            groupName: group.name,
            sender: message.senderDisplayName ?? "已移除成员",
            text: message.text,
            createdAt: message.createdAt,
            avatarSeed: avatarSeed(message.senderMemberId),
          });
          messageEdges.push({
            id: message.id,
            groupId: group.id,
            groupName: group.name,
            senderMemberId: message.senderMemberId,
            sender: message.senderDisplayName ?? "已移除成员",
            text: message.text,
            createdAt: message.createdAt,
            avatarSeed: avatarSeed(message.senderMemberId),
          });
        }
        const senders = new Set(messages.map((m) => m.senderMemberId));
        conversations.push({
          groupId: group.id,
          groupName: group.name,
          messages: messages.map((message): ConversationMessage => ({
            id: message.id,
            senderMemberId: message.senderMemberId,
            sender: message.senderDisplayName ?? "已移除成员",
            text: message.text,
            createdAt: message.createdAt,
            avatarSeed: avatarSeed(message.senderMemberId),
            mentions: message.mentions,
          })),
        });
        const members = participants.map((member) => {
          seenMembers.add(member.id);
          return memberNode(member, statusMap, "member", senders.has(member.id) ? "有消息" : "群成员");
        });
        groups.push({
          id: group.id,
          name: group.name,
          icon: groupIcon(group.name),
          members,
          senderCount: senders.size,
          messageCount: messages.length,
        });
      }
      messageEdges.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const tasks: TaskFlowItem[] = tasksResult.tasks.map((task: Task) => ({
        id: task.id,
        title: task.title,
        state: task.state,
        stateLabel: taskStateLabel(task.state),
        assignee: task.assigneeMemberId ? memberMap.get(task.assigneeMemberId)?.displayName ?? "已移除成员" : null,
        blockedReason: task.blockedReason,
        readinessCodes: [...new Set([
          ...task.materialStatus.startExecution.reasonCodes,
          ...task.materialStatus.submitReview.reasonCodes,
          ...task.materialStatus.complete.reasonCodes,
        ])],
        revision: task.revision,
        updatedAt: task.updatedAt,
      }));
      const roles: RoleCapability[] = orgResult.roles.map((role) => ({
        role: role.role,
        capabilities: [...role.capabilities],
        nodeRole: role.nodeRole,
      }));
      const groupNameMap = new Map(groupsResult.groups.map((g) => [g.id, g.name]));
      const runtimeCapabilities: RuntimeCapability[] = [];
      for (const view of runtimeResult.runtimes) {
        for (const viewBinding of view.bindings) {
          const binding = viewBinding.binding;
          if (binding.projectId !== id || !viewBinding.status.capability) continue;
          runtimeCapabilities.push({
            runtimeName: view.runtime.name,
            bindingId: binding.id,
            projectId: binding.projectId,
            groupName: groupNameMap.get(binding.groupId) ?? "未知群组",
            supported: viewBinding.status.capability.supported,
            reason: viewBinding.status.capability.reason,
            isolation: viewBinding.status.capability.isolation,
            runnerState: viewBinding.runner.state,
          });
        }
      }
      graph.value = {
        root,
        lead,
        groups,
        memberCount: seenMembers.size,
        messageCount: totalMessages,
        recent: recent.slice(0, 5),
        messageEdges: messageEdges.slice(0, 6),
        conversations,
        tasks,
        roles,
        runtimeCapabilities,
      };
    } catch (err) {
      if (version === generation) error.value = err instanceof Error ? err.message : "关系图读取失败";
    } finally {
      if (version === generation) loading.value = false;
    }
  }

  return { graph, loading, error, load };
}

function groupIcon(name: string): string {
  if (/mcp|能力|接入/i.test(name)) return "layers";
  if (/质量|验证|测试|qa/i.test(name)) return "check";
  if (/群|聊|讨论/i.test(name)) return "message";
  return "grid";
}
