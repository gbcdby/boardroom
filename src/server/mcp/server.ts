import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Logger } from "../logger.ts";
import type { McpCore } from "./core.ts";
import { McpToolError } from "./errors.ts";
import { isRegistered, listAdapterIds } from "./adapters/index.ts";

/**
 * MCP 工具注册层：把 {@link McpCore} 暴露为符合 docs/mcp-tool-contract.md 的工具。
 *
 * 职责边界：
 * - 只做协议装配：参数 schema、会话标识提取、结果序列化、错误码转换。
 * - 业务规则全部在 McpCore，不在此处实现。
 * - 返回同时给出 text（JSON 字符串）与 structuredContent（同一对象），便于各类宿主消费。
 */

export interface CreateMcpServerOptions {
  readonly core: McpCore;
  readonly logger: Logger;
}

type ToolPayload = Record<string, unknown> & { ok: boolean };

interface ToolExtra {
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

/** 工具返回值：ok 时为业务对象，错误时统一为 { ok:false, error }。 */
function toToolResult(payload: ToolPayload, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error: McpToolError) {
  return toToolResult({ ok: false, error: error.toPayload() }, true);
}

/** 统一的工具执行包装：把未知异常收敛为 INTERNAL，业务异常转为错误载荷。 */
async function runTool(
  logger: Logger,
  toolName: string,
  handler: () => Promise<ToolPayload> | ToolPayload,
) {
  try {
    const payload = await handler();
    return toToolResult(payload);
  } catch (error) {
    if (error instanceof McpToolError) {
      logger.debug("tool_business_error", { tool: toolName, code: error.code });
      return errorResult(error);
    }
    logger.error("tool_internal_error", { tool: toolName, error });
    return errorResult(new McpToolError("INTERNAL", "服务端内部错误"));
  }
}

/** 从 RequestHandlerExtra 取会话 ID；缺失时用空串（未入群会返回 NOT_IN_GROUP）。 */
function sessionOf(extra: ToolExtra): string {
  return extra.sessionId ?? "";
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const { core, logger } = options;
  const log = logger.child({ component: "mcp" });
  const server = new McpServer(
    { name: "agent-studio", version: "0.1.0" },
    { capabilities: { logging: {}, tools: {} } },
  );

  server.registerTool(
    "join",
    {
      title: "入群 / 身份声明",
      description: "声明全局身份与宿主类型，并加入阶段 1 的唯一群组。返回 memberId、agentId 与心跳配置。",
      inputSchema: {
        displayName: z.string().describe("显示名，1–64 字符"),
        // HostType 为开放类型；以注册表校验替代写死的枚举（#58 / NFR-HOST-03）：
        // 任何 isRegistered 值（含内建 "other"）均接受，未注册宿主被拒绝。
        hostType: z
          .string()
          .refine((v) => isRegistered(v), {
            message: `未知 hostType：请先注册宿主适配器（${[...listAdapterIds()].sort().join(" / ")}）`,
          })
          .describe("宿主类型（已注册适配器 id 或 other）"),
        projectId: z.string().describe("项目 ID"),
        groupId: z.string().describe("群组 ID"),
        role: z.enum(["manager", "normal"]).optional().describe("提示性角色，默认 normal"),
      },
    },
    (args, extra) =>
      runTool(log, "join", () => core.join(sessionOf(extra), {
        displayName: args.displayName,
        hostType: args.hostType,
        projectId: args.projectId,
        groupId: args.groupId,
        ...(args.role === undefined ? {} : { role: args.role }),
      }) as unknown as ToolPayload),
  );

  server.registerTool(
    "wait_for_messages",
    {
      title: "等待或接收消息",
      description:
        "由工具自身挂起，在有可投递消息、超时或取消时返回。status 取值 message / timeout / cancelled。",
      inputSchema: {
        timeoutMs: z.number().int().min(1).max(300_000).optional().describe("单次等待上限，默认 30000ms"),
        afterCursor: z.string().optional().describe("断线重连后从该游标之后拉取积压"),
      },
    },
    (args, extra) =>
      runTool(log, "wait_for_messages", async () => {
        const result = await core.waitForMessages(sessionOf(extra), {
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
          ...(args.afterCursor === undefined ? {} : { afterCursor: args.afterCursor }),
          ...(extra.signal === undefined ? {} : { signal: extra.signal }),
        });
        return result as unknown as ToolPayload;
      }),
  );

  server.registerTool(
    "send_message",
    {
      title: "发送消息",
      description: "向当前群组发送一条消息；clientMessageId 用作幂等键，重复提交只落一条。",
      inputSchema: {
        groupId: z.string().optional().describe("目标群组，默认当前入群群组"),
        text: z.string().describe("正文，1–8000 字符"),
        mentions: z.array(z.string()).optional().describe("被 @ 的成员 ID"),
        clientMessageId: z.string().optional().describe("客户端幂等键"),
      },
    },
    (args, extra) =>
      runTool(log, "send_message", () => core.sendMessage(sessionOf(extra), {
        text: args.text,
        ...(args.groupId === undefined ? {} : { groupId: args.groupId }),
        ...(args.mentions === undefined ? {} : { mentions: args.mentions }),
        ...(args.clientMessageId === undefined ? {} : { clientMessageId: args.clientMessageId }),
      }) as unknown as ToolPayload),
  );

  server.registerTool(
    "acknowledge_message",
    {
      title: "确认消息",
      description: "确认已处理某条消息，推进投递游标；重复确认幂等。",
      inputSchema: {
        messageId: z.string().describe("待确认消息 ID"),
      },
    },
    (args, extra) =>
      runTool(log, "acknowledge_message", () =>
        core.acknowledgeMessage(sessionOf(extra), args.messageId) as unknown as ToolPayload,
      ),
  );

  server.registerTool(
    "report_status",
    {
      title: "状态上报",
      description: "上报成员在当前项目的运行状态（waiting / working）。与连接心跳分开。",
      inputSchema: {
        status: z.enum(["waiting", "working"]).describe("运行状态"),
        projectId: z.string().optional().describe("项目上下文，默认入群项目"),
        memberId: z.string().optional().describe("成员上下文，显式传入必须与会话一致"),
      },
    },
    (args, extra) =>
      runTool(log, "report_status", () => core.reportStatus(sessionOf(extra), {
        status: args.status,
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        ...(args.memberId === undefined ? {} : { memberId: args.memberId }),
      }) as unknown as ToolPayload),
  );

  server.registerTool(
    "heartbeat",
    {
      title: "连接心跳",
      description:
        "刷新本 MCP 会话的连接心跳与全局身份 last_seen_at（连接状态，D1）；不改变成员运行状态（waiting/working 由 report_status 单独上报）。",
      inputSchema: {},
    },
    (_args, extra) =>
      runTool(log, "heartbeat", () => core.heartbeat(sessionOf(extra)) as unknown as ToolPayload),
  );

  server.registerTool(
    "read_history",
    {
      title: "读取允许范围内的历史",
      description: "读取自己发送 + 被 @ 的历史消息（阶段 1 可见范围）。",
      inputSchema: {
        groupId: z.string().optional().describe("目标群组，默认当前群组"),
        limit: z.number().int().min(1).max(100).optional().describe("条数，默认 20"),
        beforeCursor: z.string().optional().describe("向前翻页游标"),
      },
    },
    (args, extra) =>
      runTool(log, "read_history", () => core.readHistory(sessionOf(extra), {
        ...(args.groupId === undefined ? {} : { groupId: args.groupId }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.beforeCursor === undefined ? {} : { beforeCursor: args.beforeCursor }),
      }) as unknown as ToolPayload),
  );

  return server;
}
