export class McpConnectionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.name = "McpConnectionError"; this.code = code; this.status = status; }
}
export type DiscoveryCleanup = "not_opened" | "closed" | "remote_unsupported" | "remote_unknown";
export type DiscoveryFailureState = "blocked" | "connection_failed" | "discovery_failed" | "cancelled" | "timed_out";
/** 不带原错误/cause、请求正文、端点、argv、凭据或上游建议。 */
export class McpDiscoveryFailure extends Error {
  readonly code: string;
  readonly state: DiscoveryFailureState;
  readonly cleanup: DiscoveryCleanup;
  constructor(code: string, state: DiscoveryFailureState, cleanup: DiscoveryCleanup = "not_opened") {
    super(code); this.name = "McpDiscoveryFailure"; this.code = code; this.state = state; this.cleanup = cleanup;
  }
}
