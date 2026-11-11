import type { Actor } from "../authz/authorize.ts";
import type { MutationDiscover } from "../db/mutation-scope.ts";
import type { Member, MemberFactRevision, MemberLifecycleFields, OrgNode } from "../db/types.ts";
import type { ReviewRoundState, TaskState } from "../../shared/tasks.ts";

export interface OrgMutationAccess {
  actor: Actor;
  /** 服务器收到真实断开/取消时，在语句间停止并等待真实事务回滚。 */
  signal?: AbortSignal;
  runMutation?: <T>(body: () => Promise<T>, discover?: MutationDiscover) => Promise<T>;
}
export interface ReversalMetadataV2 {
  version: 2;
  rootAuditId: string;
  rootAction: string;
  undoesAuditId: string | null;
  direction: "forward" | "undo" | "redo";
}
export interface OrgGraphSnapshotV2 {
  schema: "org-graph/v2";
  projectId: string;
  targetId: string;
  node: OrgNode | null;
  childEdges: Array<{ nodeId: string; parentId: string | null }>;
  assignments: Array<{ memberId: string; nodeId: string | null; legacyRole: "manager" | "normal"; membershipRevision: number }>;
  directChildIds: string[];
}
export interface MemberRelationsSnapshotV2 {
  schema: "member-relations/v2";
  projectId: string;
  targetId: string;
  presence: "absent" | "present" | "removed";
  member: (Member & MemberLifecycleFields) | null;
  participants: Array<{ groupId: string; joinedAt: string }>;
  tasks: Array<{ taskId: string; revision: number; assigneeMemberId: string | null; reviewerMemberId: string | null;
    state: TaskState; blockedReason: string | null; currentReviewRoundId: string | null }>;
  settings: { projectId: string; revision: number; defaultReviewerMemberId: string | null } | null;
  invalidatedRounds: Array<{ roundId: string; taskId: string; revision: number; state: ReviewRoundState }>;
  retained: MemberFactRevision[];
  transient: { workEventIds: string[]; mcpSessionIds: string[]; runtimeBindingIds: string[] };
}
export interface MemberCaptureBudget {
  pageRows: 32;
  maxRows: 2048;
  maxReturnedBytes: 2097152;
  maxSqlStatements: 512;
  maxPlannedChangedRows: 2048;
  maxSnapshotFieldBytes: 32768;
  maxWorkMs: 500;
}
export const MEMBER_CAPTURE_BUDGET: Readonly<MemberCaptureBudget> = Object.freeze({
  pageRows: 32, maxRows: 2048, maxReturnedBytes: 2097152, maxSqlStatements: 512,
  maxPlannedChangedRows: 2048, maxSnapshotFieldBytes: 32768, maxWorkMs: 500,
});
export type RestartRequired = "mcp-session" | "review" | "runtime-binding" | "memory-summary";
