import type { Task, TaskMaterialIssue, TaskMaterialStatus } from "../../shared/tasks.ts";

/** HTTP/MCP/UI 共同消费；权限与真实执行准入仍由对应入口另行检查。 */
export function assessTaskMaterials(task: Task, members: { assigneeValid: boolean; reviewerValid: boolean }): TaskMaterialStatus {
  const start: TaskMaterialIssue[] = [];
  if (!task.assigneeMemberId) start.push({ code: "assignee_required", field: "assigneeMemberId", message: "待分派负责人。" });
  else if (!members.assigneeValid) start.push({ code: "assignee_invalid", field: "assigneeMemberId", message: "负责人已不可用，请选择本项目在岗成员。" });
  if (!task.body.trim()) start.push({ code: "task_goal_required", field: "body", message: "请补充任务目标与范围。" });
  if (!task.acceptanceText.trim()) start.push({ code: "task_acceptance_required", field: "acceptanceText", message: "请补充明确的验收条件。" });
  if (task.deliveryKind === null) start.push({ code: "task_delivery_kind_required", field: "deliveryKind", message: "请确定交付类型。" });
  const review = [...start];
  if (!task.reviewerMemberId) review.push({ code: "reviewer_required", field: "reviewerMemberId", message: "提交评审前请选择评审 Agent。" });
  else if (!members.reviewerValid) review.push({ code: "reviewer_invalid", field: "reviewerMemberId", message: "评审人必须是本项目在岗的 Agent。" });
  else if (task.reviewerMemberId === task.assigneeMemberId) review.push({ code: "reviewer_is_assignee", field: "reviewerMemberId", message: "评审人与负责人必须不同。" });
  if (task.deliveryKind !== null && task.deliveryKind !== "code") {
    review.push({ code: "candidate_type_requires_v2", field: "deliveryKind", message: "此类任务可以录入与完善；分类产物评审尚未接入，不能使用代码评审完成。" });
  } else if (task.deliveryKind === "code") {
    if (!task.repoPath) review.push({ code: "review_source_required", field: "repoPath", message: "代码评审前请填写真实仓库路径。" });
    if (!task.fixedPoint) review.push({ code: "review_source_required", field: "fixedPoint", message: "代码评审前请填写对比基准。" });
  }
  const phase = (issues: TaskMaterialIssue[]) => ({ reasonCodes: [...new Set(issues.map(issue => issue.code))], issues });
  return { scope: "task-materials", executionAdmission: "not-issued", startExecution: phase(start), submitReview: phase(review), complete: phase([...review]) };
}
