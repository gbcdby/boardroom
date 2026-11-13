import { getCurrentInstance, getCurrentScope, inject, onScopeDispose, ref, shallowRef, type InjectionKey } from "vue";
import { ApiError } from "../api/client.ts";
import type { ResourceChange } from "../../../shared/resource-changes.ts";

export interface ResourceScope { projectId: string; key: string }
export interface ResourceReader { get<T>(path: string): Promise<T> }
export interface ResourceSocketHandlers { open(): void; message(data: string): void; close(): void; error(): void }
interface ResourceSocket { send(data: string): void; close(): void }
/** 小型浏览器边界，便于用独立时钟/断线测试，不模拟领域事实。 */
export interface ResourceBrowser {
  isVisible(): boolean;
  onVisibility(listener: () => void): () => void;
  interval(callback: () => void, ms: number): () => void;
  timeout(callback: () => void, ms: number): () => void;
  connect(handlers: ResourceSocketHandlers): ResourceSocket;
}
export const resourceBrowserKey: InjectionKey<ResourceBrowser | null> = Symbol("resource-browser");
interface Options<T, Scope extends ResourceScope> {
  read(scope: Scope, reader: ResourceReader): Promise<T>;
  accepts?(incoming: T, current: T | null): boolean;
  onValue?(value: T, source: "read" | "mutation"): void;
  relevant?(change: ResourceChange, scope: Scope): boolean;
  fetch?: typeof fetch;
  browser?: ResourceBrowser | null;
}
interface CachedResponse { value: unknown; etag: string | null }
interface Flight { epoch: number; again: boolean; cancel(): void; done: Promise<void> }

function browserEnvironment(): ResourceBrowser | null {
  const host = globalThis as unknown as { document?: { visibilityState: string; addEventListener(name: string, listener: () => void): void; removeEventListener(name: string, listener: () => void): void }; location?: { protocol: string; host: string } };
  const { document, location } = host;
  if (!document || !location || typeof WebSocket === "undefined") return null;
  return {
    isVisible: () => document.visibilityState !== "hidden",
    onVisibility(listener) { document.addEventListener("visibilitychange", listener); return () => document.removeEventListener("visibilitychange", listener); },
    interval(callback, ms) { const timer = setInterval(callback, ms); return () => clearInterval(timer); },
    timeout(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    connect(handlers) {
      const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
      socket.addEventListener("open", handlers.open);
      socket.addEventListener("message", event => handlers.message(String(event.data)));
      socket.addEventListener("close", handlers.close); socket.addEventListener("error", handlers.error);
      return { send: data => socket.send(data), close: () => socket.close() };
    },
  };
}

/** 提示只触发读；每个活动页面合并当前快照请求、条件缓存和可见性兜底。
 * key 必须包含项目、实体与上下文代际。缓存只属于当前 key，旧请求不能写回。
 */
export function createResourceReconciliation<T, Scope extends ResourceScope = ResourceScope>(options: Options<T, Scope>) {
  const value = shallowRef<T | null>(null), loading = ref(false), error = ref<string | null>(null);
  const lastSuccessAt = ref<number | null>(null);
  const connection = ref<"connecting" | "connected" | "disconnected">("disconnected");
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const browser = options.browser === undefined ? browserEnvironment() : options.browser;
  let scope: Scope | null = null, epoch = 0, disposed = false;
  let cache = new Map<string, CachedResponse>(), pending: Flight | null = null;
  let visible = browser?.isVisible() ?? true;
  let socket: ResourceSocket | null = null, socketToken: object | null = null, socketOpen = false, subscribedBefore = false;
  let stopPoll: (() => void) | undefined, stopReconnect: (() => void) | undefined;

  function isCurrent(flight: Flight): boolean { return !disposed && flight.epoch === epoch && pending === flight; }
  function readerFor(staged: Map<string, CachedResponse>, signal: AbortSignal): ResourceReader {
    return { async get<R>(path: string): Promise<R> {
      const previous = staged.get(path);
      const response = await request(path, { method: "GET", signal, headers: { accept: "application/json", ...(previous?.etag ? { "if-none-match": previous.etag } : {}) } });
      if (response.status === 304) {
        if (!previous) throw new Error("服务器返回未修改，但当前页面没有对应快照。请重新读取。");
        return previous.value as R;
      }
      let data: unknown;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        const failure = (data as { error?: { code?: string; message?: string; reason?: string; details?: unknown } } | null)?.error;
        throw new ApiError(response.status, failure?.code ?? "unknown_error", failure?.message ?? `读取失败（HTTP ${response.status}）`, failure?.reason, failure?.details);
      }
      staged.set(path, { value: data, etag: response.headers.get("etag") });
      return data as R;
    } };
  }

  async function read(flight: Flight, selected: Scope): Promise<void> {
    try {
      do {
        flight.again = false;
        const staged = new Map(cache);
        const controller = new AbortController();
        let rejectRead!: (error: Error) => void;
        const cancelled = new Promise<never>((_, reject) => { rejectRead = reject; });
        flight.cancel = () => { rejectRead(new Error("读取已取消。")); controller.abort(); };
        const timeout = () => { rejectRead(new Error("读取超时，已保留最后成功的数据；会继续对账。")); controller.abort(); };
        const timer = browser ? null : setTimeout(timeout, 10_000);
        const stopTimeout = browser ? browser.timeout(timeout, 10_000) : () => clearTimeout(timer!);
        try {
          const incoming = await Promise.race([options.read(selected, readerFor(staged, controller.signal)), cancelled]);
          if (!isCurrent(flight)) return;
          // 在途收到变化后先补一次权威读取，不把提示前的旧响应发布为当前快照。
          if (flight.again && visible) continue;
          if (options.accepts && !options.accepts(incoming, value.value)) {
            cache.clear(); error.value = "读取到旧版本，已保留较新的内容；会继续对账。";
          } else {
            cache = staged; value.value = incoming; error.value = null; lastSuccessAt.value = Date.now();
            options.onValue?.(incoming, "read");
          }
        } catch (failure) {
          if (!isCurrent(flight)) return;
          error.value = failure instanceof Error ? failure.message : "读取失败，已保留最后成功的数据。";
        } finally { stopTimeout(); flight.cancel = () => {}; }
      } while (flight.again && visible && isCurrent(flight));
    } finally {
      if (isCurrent(flight)) { pending = null; loading.value = false; }
    }
  }

  function refresh(afterChange = false): Promise<void> {
    if (disposed || !scope || !visible) return Promise.resolve();
    if (pending) { if (afterChange) pending.again = true; return pending.done; }
    const flight: Flight = { epoch, again: false, cancel() {}, done: Promise.resolve() };
    pending = flight; loading.value = true;
    flight.done = read(flight, scope);
    return flight.done;
  }
  function cancelRead(): void { epoch++; pending?.cancel(); pending = null; loading.value = false; }
  function polling(): void {
    stopPoll?.(); stopPoll = undefined;
    if (browser && scope && visible && !disposed) stopPoll = browser.interval(() => { void refresh(); }, 15_000);
  }
  function subscribe(): void {
    if (socket && socketOpen) socket.send(JSON.stringify({ type: "resource.subscribe", projectId: scope?.projectId ?? null }));
  }
  function connect(): void {
    if (!browser || disposed) return;
    stopReconnect = undefined; connection.value = "connecting";
    const token = {}; socketToken = token;
    const active = () => !disposed && socketToken === token;
    socket = browser.connect({
      open() { if (!active()) return; socketOpen = true; subscribe(); },
      message(raw) {
        if (!active() || !scope) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(raw) as Record<string, unknown>; } catch { void refresh(true); return; }
        if (!event || typeof event !== "object") { void refresh(true); return; }
        if (event.type === "resource.subscribed") {
          if (event.projectId !== scope.projectId) return;
          connection.value = "connected";
          if (subscribedBefore) cancelRead();
          void refresh(); subscribedBefore = true; return;
        }
        if (event.type === "resource.changed") {
          if (typeof event.projectId === "string" && event.projectId !== scope.projectId) return;
          if (event.projectId === scope.projectId && (event.entity === "task" || event.entity === "task-settings")
            && typeof event.id === "string" && Number.isSafeInteger(event.revision) && Number(event.revision) >= 0) {
            const change = event as unknown as ResourceChange;
            if (!options.relevant || options.relevant(change, scope)) void refresh(true);
          } else void refresh(true);
          return;
        }
        if (event.type === "error") { connection.value = "disconnected"; void refresh(true); return; }
        if (!["welcome", "pong", "notice", "message", "status_update"].includes(String(event.type))) void refresh(true);
      },
      close() {
        if (!active()) return; socketOpen = false; connection.value = "disconnected";
        stopReconnect?.(); stopReconnect = browser.timeout(connect, 2000);
      },
      error() { if (active()) connection.value = "disconnected"; },
    });
  }
  const stopVisibility = browser?.onVisibility(() => {
    const next = browser.isVisible(); if (visible === next) return;
    visible = next; polling(); if (visible) { cancelRead(); void refresh(); }
  });

  function setScope(next: Scope | null): Promise<void> {
    if (disposed) return Promise.resolve();
    if (scope?.key === next?.key) return refresh();
    cancelRead(); scope = next; cache.clear(); value.value = null; error.value = null; lastSuccessAt.value = null;
    if (browser && !socket) connect();
    else if (socketOpen) { connection.value = "connecting"; subscribe(); }
    polling(); return refresh();
  }
  async function committed(update: (current: T | null) => T | null = current => current): Promise<void> {
    if (!scope || disposed) return;
    // 写入已提交，但回执可能旧于当前观察值；发布前沿用 GET 的版本下界。
    cancelRead(); cache.clear(); const current = value.value, next = update(current);
    if (next !== null && (!options.accepts || options.accepts(next, current))) {
      value.value = next; options.onValue?.(next, "mutation");
    }
    await refresh(true);
  }
  function dispose(): void {
    if (disposed) return; disposed = true; cancelRead(); stopPoll?.(); stopReconnect?.(); stopVisibility?.(); socket?.close(); socket = null;
  }
  return { value, loading, error, lastSuccessAt, connection, setScope, refresh, committed, dispose };
}

export function useResourceReconciliation<T, Scope extends ResourceScope = ResourceScope>(options: Options<T, Scope>) {
  const browser = options.browser === undefined && getCurrentInstance() ? inject(resourceBrowserKey, undefined) : options.browser;
  const resource = createResourceReconciliation({ ...options, ...(browser !== undefined ? { browser } : {}) });
  if (getCurrentScope()) onScopeDispose(resource.dispose);
  return resource;
}
