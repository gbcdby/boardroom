/** #177 阶段 1：真实只读 API → 协作关系图的可测试纯投影，不写业务状态、不注入示例事实。 */
import type { GroupDto, MemberDto, MemberStatusDto, MessageDto, OrgNodeDto, ProjectDto, RoleCatalogEntry } from "../api/client.ts";
import type { RuntimeViewDto } from "../api/runtimes.ts";
import { taskStateLabel, taskStates, type Task, type TaskState } from "../api/tasks.ts";
import type { TaskMaterialIssue } from "../../../shared/tasks.ts";
import type { GraphCanvasData } from "../components/collabGraphLayout.ts";
import {
  buildMessageDirectionLayer, type MessageDirectionLayer,
} from "./messageDirectionLayer.ts";

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

export interface TaskFlowReadinessIssue extends TaskMaterialIssue {
  /** 服务端写入该缺口的阶段；不表示缺口已解决。 */
  stage: "startExecution" | "submitReview" | "complete";
  /** 仅文字提示；不含链接、按钮或领域动作承诺。 */
  hint: string;
}

export interface TaskFlowItem {
  id: string;
  title: string;
  state: string;
  stateLabel: string;
  assignee: string | null;
  assigneeMemberId: string | null;
  reviewer: string | null;
  reviewerMemberId: string | null;
  blockedReason: string | null;
  /** 资料 readiness 原因码的聚合视图；字段级信息见 readinessIssues。 */
  readinessCodes: string[];
  /** 服务端 issues 原样保留（含同码不同字段），不去重、不补造下一步。 */
  readinessIssues: TaskFlowReadinessIssue[];
  /** 恒为 not-issued：只说明资料观察，不代表执行放行。 */
  executionAdmission: "not-issued";
  deliveryKind: string | null;
  repoPath: string | null;
  fixedPoint: string | null;
  revision: number;
  updatedAt: string;
}

export interface TaskFlowColumn {
  state: string;
  label: string;
  tasks: TaskFlowItem[];
}

const FIELD_HINTS: Record<string, string> = {
  assigneeMemberId: "核对服务端指出的负责人字段（assigneeMemberId）；具体人选需查领域权威",
  body: "补齐服务端指出的任务目标字段（body）",
  acceptanceText: "补齐服务端指出的验收说明字段（acceptanceText）",
  deliveryKind: "确认服务端指出的交付类型字段（deliveryKind）",
  reviewerMemberId: "指定服务端指出的评审人字段（reviewerMemberId）；具体人选需查领域权威",
  repoPath: "补齐服务端指出的评审来源字段（repoPath）",
  fixedPoint: "补齐服务端指出的评审来源字段（fixedPoint）",
};

/** 只对已持久的 code/field 给出保守文字提示，不生成链接、按钮或领域决定。 */
export function nextStepForIssue(issue: TaskMaterialIssue): string {
  if (issue.code === "candidate_type_requires_v2") return "需查领域权威";
  return FIELD_HINTS[issue.field] ?? "需查领域权威";
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
  groupId: string;
  groupName: string;
  senderMemberId: string;
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
  /** 真实消息方向层：全部可追溯消息、最多 6 条标记与同向/时间窗聚合。 */
  messageDirection: MessageDirectionLayer;
  /** 兼容既有画布消费方的可见标记（等于 messageDirection.markers）。 */
  messageEdges: MessageEdge[];
  /** 按群聚合的完整真实会话，供图内检查器显示（不编造 transcript/工具/思考）。 */
  conversations: GroupConversation[];
  tasks: TaskFlowItem[];
  roles: RoleCapability[];
  runtimeCapabilities: RuntimeCapability[];
}

export interface CollabGraphInput {
  project: ProjectDto | null;
  org: { nodes: OrgNodeDto[]; roles: RoleCatalogEntry[] };
  groups: GroupDto[];
  members: MemberDto[];
  participantsByGroup: Map<string, MemberDto[]>;
  memberStatuses: MemberStatusDto[];
  messagesByGroup: Map<string, MessageDto[]>;
  tasks: Task[];
  runtimeViews: RuntimeViewDto[];
}

export function emptyCollabGraph(): CollabGraph {
  return {
    root: null, lead: null, groups: [], memberCount: 0, messageCount: 0,
    recent: [], messageDirection: buildMessageDirectionLayer([]), messageEdges: [],
    conversations: [], tasks: [], roles: [], runtimeCapabilities: [],
  };
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

function groupIcon(name: string): string {
  if (/mcp|能力|接入/i.test(name)) return "layers";
  if (/质量|验证|测试|qa/i.test(name)) return "check";
  if (/群|聊|讨论/i.test(name)) return "message";
  return "grid";
}

/** 从一次一致读取的输入构造快照；任一输入为空时不补造节点或关系。 */
export function buildCollabGraphSnapshot(input: CollabGraphInput): CollabGraph {
  const statusMap = new Map(input.memberStatuses.map((item) => [item.memberId, item]));
  const memberMap = new Map(input.members.map((item) => [item.id, item]));

  // 身份按真实 DTO 语义标注：project.manager 与 org.top_manager 占据者是不同来源。
  const root = input.project?.manager ? memberNode(input.project.manager, statusMap, "manager", "项目负责人") : null;
  const leadNode = input.org.nodes.find((node: OrgNodeDto) => node.role === "top_manager" && node.memberId);
  const leadMember = leadNode?.memberId ? memberMap.get(leadNode.memberId) : null;
  const lead = leadMember ? memberNode(leadMember, statusMap, "lead", "顶级主管岗位") : null;

  const groups: GraphGroup[] = [];
  const recent: RecentActivity[] = [];
  const messageEdges: MessageEdge[] = [];
  const conversations: GroupConversation[] = [];
  const seenMembers = new Set<string>();

  for (const group of input.groups) {
    // 同一逻辑消息 ID 的重复/补发只保留首次到达：后到内容或时间不同也不覆盖原文。
    const seenGroupMessageIds = new Set<string>();
    const messages: MessageDto[] = [];
    for (const item of input.messagesByGroup.get(group.id) ?? []) {
      if (seenGroupMessageIds.has(item.id)) continue;
      seenGroupMessageIds.add(item.id);
      messages.push(item);
    }
    for (const item of messages) {
      const activity: RecentActivity = {
        id: item.id,
        groupId: group.id,
        groupName: group.name,
        senderMemberId: item.senderMemberId,
        sender: item.senderDisplayName ?? "已移除成员",
        text: item.text,
        createdAt: item.createdAt,
        avatarSeed: avatarSeed(item.senderMemberId),
      };
      recent.push(activity);
      messageEdges.push({ ...activity, groupName: group.name });
    }
    const senders = new Set(messages.map((item) => item.senderMemberId));
    conversations.push({
      groupId: group.id,
      groupName: group.name,
      messages: messages.map((item): ConversationMessage => ({
        id: item.id,
        senderMemberId: item.senderMemberId,
        sender: item.senderDisplayName ?? "已移除成员",
        text: item.text,
        createdAt: item.createdAt,
        avatarSeed: avatarSeed(item.senderMemberId),
        mentions: item.mentions,
      })),
    });
    // 群成员来自真实 participants；同名/同 agentId 的不同成员 ID 保持独立节点。
    const participants = input.participantsByGroup.get(group.id) ?? [];
    const members = participants.map((item) => {
      seenMembers.add(item.id);
      return memberNode(item, statusMap, "member", senders.has(item.id) ? "有消息" : "群成员");
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
  messageEdges.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

  const tasks: TaskFlowItem[] = input.tasks.map((task: Task) => {
    const readinessIssues: TaskFlowReadinessIssue[] = ([
      ["startExecution", task.materialStatus.startExecution],
      ["submitReview", task.materialStatus.submitReview],
      ["complete", task.materialStatus.complete],
    ] as const).flatMap(([stage, phase]) => phase.issues.map((issue) => ({
      ...issue, stage, hint: nextStepForIssue(issue),
    })));
    return {
      id: task.id,
      title: task.title,
      state: task.state,
      stateLabel: taskStateLabel(task.state),
      assignee: task.assigneeMemberId ? memberMap.get(task.assigneeMemberId)?.displayName ?? "已移除成员" : null,
      assigneeMemberId: task.assigneeMemberId,
      reviewer: task.reviewerMemberId ? memberMap.get(task.reviewerMemberId)?.displayName ?? "已移除成员" : null,
      reviewerMemberId: task.reviewerMemberId,
      blockedReason: task.blockedReason,
      readinessCodes: [...new Set([
        ...task.materialStatus.startExecution.reasonCodes,
        ...task.materialStatus.submitReview.reasonCodes,
        ...task.materialStatus.complete.reasonCodes,
      ])],
      readinessIssues,
      executionAdmission: task.materialStatus.executionAdmission,
      deliveryKind: task.deliveryKind,
      repoPath: task.repoPath,
      fixedPoint: task.fixedPoint,
      revision: task.revision,
      updatedAt: task.updatedAt,
    };
  });
  const roles: RoleCapability[] = input.org.roles.map((role) => ({
    role: role.role,
    capabilities: [...role.capabilities],
    nodeRole: role.nodeRole,
  }));
  const groupNameMap = new Map(input.groups.map((item) => [item.id, item.name]));
  const runtimeCapabilities: RuntimeCapability[] = [];
  for (const view of input.runtimeViews) {
    for (const viewBinding of view.bindings) {
      const binding = viewBinding.binding;
      if (binding.projectId !== input.project?.id || !viewBinding.status.capability) continue;
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

  const messageDirection = buildMessageDirectionLayer(messageEdges);
  return {
    root, lead, groups, memberCount: seenMembers.size, messageCount: messageDirection.totalCount,
    recent: recent.slice(0, 5), messageDirection, messageEdges: messageDirection.markers,
    conversations, tasks, roles, runtimeCapabilities,
  };
}

/** 真实 state → 固定五列；未知 state 按服务端原值另列，不丢弃任务也不硬造统一关卡。 */
export function buildTaskFlowBoard(tasks: readonly TaskFlowItem[]): TaskFlowColumn[] {
  const columns: TaskFlowColumn[] = taskStates.map((state) => ({
    state: state.value as TaskState, label: state.label, tasks: [],
  }));
  const extras = new Map<string, TaskFlowColumn>();
  for (const item of tasks) {
    let column = columns.find((candidate) => candidate.state === item.state);
    if (!column) {
      column = extras.get(item.state) ?? { state: item.state, label: item.state, tasks: [] };
      extras.set(item.state, column);
    }
    column.tasks.push(item);
  }
  return [...columns, ...extras.values()];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function clock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/**
 * 快照 → 画布视图模型。成员节点 ID 为「真实群 ID:真实成员 ID」，同名 Agent 跨群不合并；
 * 阶段 1 没有可追溯的跨群协作事实，因此 collaborations 恒为空，不画虚构关系线。
 */
export function toGraphCanvasData(graph: CollabGraph): GraphCanvasData {
  const latestByGroup = new Map<string, MessageEdge>();
  for (const edge of graph.messageEdges) {
    if (!latestByGroup.has(edge.groupId)) latestByGroup.set(edge.groupId, edge);
  }
  const newestMessageId = graph.messageEdges[0]?.id;
  // 当前真实 API 中项目负责人与顶级主管岗位可能由同一成员占据；不画两张同人卡片。
  const sameHeaderMember = Boolean(graph.root && graph.lead && graph.root.id === graph.lead.id);
  return {
    root: graph.root
      ? {
        name: graph.root.name,
        role: sameHeaderMember ? `${graph.root.role} · ${graph.lead!.role}` : graph.root.role,
        avatar: graph.root.avatarSeed,
        initials: graph.root.initials,
      }
      : null,
    lead: graph.lead && !sameHeaderMember
      ? {
        id: graph.lead.id, name: graph.lead.name, initials: graph.lead.initials, role: graph.lead.role,
        status: graph.lead.status, tone: graph.lead.tone, avatar: graph.lead.avatarSeed,
      }
      : null,
    groups: graph.groups.map((group) => {
      const latest = latestByGroup.get(group.id);
      return {
        id: group.id,
        name: group.name,
        icon: group.icon,
        flowLabel: group.messageCount > 0 ? `群消息 ${group.messageCount}` : "群成员",
        flowMessage: latest ? `${latest.sender}：${clip(latest.text, 8)} · ${clock(latest.createdAt)}` : undefined,
        flowEmphasis: Boolean(latest && latest.id === newestMessageId),
        members: group.members.map((member) => ({
          id: `${group.id}:${member.id}`,
          memberId: member.id,
          groupId: group.id,
          name: member.name,
          initials: member.initials,
          role: member.role,
          status: member.status,
          tone: member.tone,
          avatar: member.avatarSeed,
        })),
      };
    }),
    collaborations: [],
  };
}
