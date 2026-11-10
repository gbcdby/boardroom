// 阶段 3 共享 DTO：浏览器和服务端使用同一可序列化合同。
export type TaskState = 'todo' | 'in-progress' | 'review' | 'blocked' | 'done';
export type ReviewAxis = 'spec' | 'standards';
export type ReviewRoundState = 'ready' | 'running' | 'reported' | 'decided' | 'failed' | 'superseded';
export type ReviewVerdict = 'pass' | 'changes_requested';
export interface TaskAuthor { kind: 'human' | 'agent'; actorId: string; displayName: string }
export interface Task {
  id: string; projectId: string; title: string; body: string; labels: string[];
  state: TaskState; assigneeMemberId: string | null; reviewerMemberId: string | null;
  repoPath: string | null; fixedPoint: string | null; revision: number;
  currentReviewRoundId: string | null; blockedReason: string | null;
  author: TaskAuthor; createdAt: string; updatedAt: string;
}
export interface TaskSettings {
  projectId: string; defaultReviewerMemberId: string | null; revision: number;
  // 有配置但成员停用/已删除时不自动猜替代人。
  reviewerValid: boolean; invalidReason: string | null;
}
export interface CreateTaskInput {
  title: string; body: string; labels?: string[]; assigneeMemberId: string;
  reviewerMemberId?: string; repoPath?: string | null; fixedPoint?: string | null;
}
export interface UpdateTaskInput {
  expectedRevision: number; title?: string; body?: string; labels?: string[];
  assigneeMemberId?: string; reviewerMemberId?: string;
  repoPath?: string | null; fixedPoint?: string | null;
}
export interface TransitionTaskInput {
  expectedRevision: number; state: 'todo' | 'in-progress' | 'blocked'; reason?: string;
}
export interface TaskComment {
  id: string; taskId: string; projectId: string; kind: 'comment' | 'review_report';
  author: TaskAuthor; body: string; createdAt: string; reviewReportId: string | null;
}
export interface TaskHistory {
  id: string; taskId: string; projectId: string; action: string; actor: TaskAuthor;
  taskRevision: number; detail: Record<string, unknown>; createdAt: string;
}
export interface TaskMessageLink { taskId: string; messageId: string; groupId: string; createdAt: string }
export interface ReviewCommand { argv: string[]; cwd: string; startedAt: string; completedAt: string; exitCode: number }
export interface ReviewCandidate {
  repositoryRoot: string; fixedPointInput: string; baseCommit: string; candidateCommit: string;
  policy: 'committed-clean'; gitVersion: string; diff: string; diffSha256: string;
  commits: Array<{ sha: string; subject: string }>;
  commands: ReviewCommand[]; capturedAt: string;
}
export interface ReviewRound {
  id: string; taskId: string; projectId: string; revision: number; taskRevision: number;
  state: ReviewRoundState; reviewerMemberId: string; specSnapshot: { title: string; body: string; labels: string[] };
  candidate: ReviewCandidate | null; failure: { code: string; message: string } | null;
  decision: { verdict: ReviewVerdict; actor: TaskAuthor; reason: string; override: boolean; taskRevision: number } | null;
  createdAt: string; updatedAt: string;
}
export interface ReviewEvidence {
  // 外部提交的执行记录是 declared，不能因此宣称平台验证了真实宿主。
  provenance: 'reviewer-declared'; host: string; hostVersion: string;
  parentRunId: string; invocationId: string; contextId: string;
  startedAt: string; completedAt: string; command: ReviewCommand;
  promptSha256: string; transcriptSha256: string;
  evidenceRef: string; baseCommit: string; candidateCommit: string; diffSha256: string;
}
export interface ReviewReport {
  id: string; roundId: string; taskId: string; projectId: string; axis: ReviewAxis;
  verdict: ReviewVerdict; body: string; sources: string[]; evidence: ReviewEvidence;
  contentSha256: string; author: TaskAuthor; createdAt: string;
}
export interface SubmitReviewReportInput {
  expectedTaskRevision: number; expectedRoundRevision: number; axis: ReviewAxis;
  verdict: ReviewVerdict; body: string; sources: string[]; evidence: ReviewEvidence;
}
export interface DecideReviewInput {
  expectedTaskRevision: number; expectedRoundRevision: number;
  verdict: ReviewVerdict; reason: string; override?: boolean;
}
export type WorkEventKind = 'task.assigned' | 'task.review_ready' | 'task.blocked' | 'task.review_decided';
export interface WorkEvent {
  id: string; projectId: string; recipientMemberId: string; taskId: string | null;
  kind: WorkEventKind; eventKey: string; payload: Record<string, unknown>;
  deliveryState: 'pending' | 'delivered' | 'acked'; attempts: number;
  createdAt: string; firstDeliveredAt: string | null; lastDeliveredAt: string | null; ackedAt: string | null;
}
export interface TaskDetail { task: Task; comments: TaskComment[]; history: TaskHistory[]; rounds: ReviewRound[]; reports: ReviewReport[]; messageLinks: TaskMessageLink[] }
export type StartReviewResult = { ready: true; task: Task; round: ReviewRound } | { ready: false; task: Task; round: ReviewRound; error: { code: string; message: string } };
