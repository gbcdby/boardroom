import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { DbDriver } from "../db/driver.ts";
import type { Logger } from "../logger.ts";
import { createMcpCore, type ManagedCoreAuthority, type McpCore, type SessionBinding } from "../mcp/core.ts";
import { createMcpServer } from "../mcp/server.ts";
import { newId } from "../db/ids.ts";
import { createRepositories } from "../db/repositories.ts";
import { createOrgActorResolver } from "../authz/org-actors.ts";
import type { Actor } from "../authz/authorize.ts";

/** 父进程持有的匿名管道只转发绑定专用 MCP，不暴露 HTTP 管理面、DB 或文件路径。 */
export interface RuntimeGateway {
  readonly joined: boolean;
  readonly pendingWaitCount: number;
  /** 每 generation 只允许一个受控通道；模型不能选择/提交 owner 或 fence。 */
  attach(transport: Transport): Promise<void>;
  wake(): Promise<void>;
  close(): Promise<void>;
}

export async function createRuntimeGateway(options: {
  db: DbDriver;
  logger: Logger;
  authority: ManagedCoreAuthority;
  onJoined: () => Promise<void>;
  actorFor?: (binding: SessionBinding) => Promise<Actor>;
  onDisconnected?: () => Promise<void>;
}): Promise<RuntimeGateway> {
  const inflight = new Set<Promise<unknown>>();
  let core: McpCore | null = null;
  let mcp: ReturnType<typeof createMcpServer> | null = null;
  let transport: Transport | null = null;
  let joined = false;
  let disconnected = false;
  let normalClosing = false;
  let businessClosing: Promise<void> | null = null;
  let loss: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  const log = options.logger.child({ component: "managed-mcp" });
  const orgResolver = createOrgActorResolver(createRepositories(options.db));
  function closeBusiness(): Promise<void> {
    if (businessClosing) return businessClosing;
    joined = false;
    disconnected = true;
    businessClosing = (async () => {
      await core?.close();
      await Promise.allSettled([...inflight]);
      await core?.disconnect();
    })();
    return businessClosing;
  }
  function transportLost(): void {
    if (normalClosing || loss) return;
    joined = false;
    disconnected = true;
    // 业务通道失效不关闭共用的停止控制管道；忙碌进程继续由真实退出证明约束。
    loss = (async () => { await options.onDisconnected?.(); await closeBusiness(); })()
      .catch(() => { log.warn("managed_disconnect_observation_failed"); });
  }
  return {
    get joined() { return joined; },
    get pendingWaitCount() { return core?.pendingWaitCount ?? 0; },
    async attach(channel) {
      if (transport || closing) throw new Error("managed_transport_conflict");
      transport = channel;
      const authority: ManagedCoreAuthority = {
        ...options.authority,
        run(operation, fn) {
          const promise = options.authority.run(operation, fn).then(async (result) => {
            if (operation === "join" && !disconnected && !normalClosing) { joined = true; await options.onJoined(); }
            return result;
          });
          inflight.add(promise);
          void promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
          return promise;
        },
      };
      core = createMcpCore({ db: options.db, logger: options.logger, managed: authority,
        memberKey: `managed:${newId()}`,
        authz: { actorFor: options.actorFor ?? (binding => orgResolver.actorForMcpBinding(binding)) } });
      mcp = createMcpServer({ core, logger: options.logger });
      // SDK connect 会保留并链式调用已有 transport 回调，不覆盖其关闭清理。
      const onclose = channel.onclose;
      const onerror = channel.onerror;
      channel.onclose = () => { onclose?.(); transportLost(); };
      channel.onerror = error => { onerror?.(error); transportLost(); };
      await mcp.connect(channel);
    },
    async wake() {
      if (closing || disconnected || !core) return;
      try { await core.resolveGroup(options.authority.identity.groupId, new Set([options.authority.identity.memberId])); }
      catch { log.warn("managed_wake_failed"); }
    },
    close() {
      if (closing) return closing;
      normalClosing = true;
      closing = (async () => {
        await loss;
        await closeBusiness();
        await transport?.close();
        await mcp?.close();
      })();
      return closing;
    },
  };
}
