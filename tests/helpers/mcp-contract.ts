/** 公开工具契约；不从服务注册表生成，以便发现漏注册或意外扩展。 */
export const EXPECTED_MCP_TOOL_NAMES = [
  "acknowledge_message", "heartbeat", "join", "read_history", "report_status", "send_message", "wait_for_messages",
  "get_task_settings", "set_task_settings", "list_tasks", "read_task", "create_task", "update_task", "transition_task",
  "comment_task", "link_task_message", "start_task_review", "begin_task_review", "submit_task_review_report", "decide_task_review",
  "list_work_events", "acknowledge_work_event",
].sort();
