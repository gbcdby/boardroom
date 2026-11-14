/** 公开工具契约；不从服务注册表生成，以便发现漏注册或意外扩展。 */
export const EXPECTED_MCP_TOOL_NAMES = [
  "acknowledge_message", "heartbeat", "join", "read_history", "report_status", "send_message", "wait_for_messages",
  "get_task_settings", "set_task_settings", "list_tasks", "read_task", "create_task", "update_task", "transition_task",
  "comment_task", "link_task_message", "start_task_review", "begin_task_review", "submit_task_review_report", "decide_task_review",
  "list_work_events", "acknowledge_work_event",
  "list_decisions", "read_decision", "request_review_decision", "resolve_decision", "refresh_decision",
  "read_memory", "write_memory", "list_memory_versions", "list_memory_summary_requests", "read_memory_summary",
  "report_memory_session_end", "begin_memory_summary", "submit_memory_summary", "fail_memory_summary", "retry_memory_summary",
].sort();
