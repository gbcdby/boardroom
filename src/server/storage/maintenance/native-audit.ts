import { randomUUID } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { darwinCurrentProcessIdentity } from "./darwin.ts";
import { inspectRegisteredSourceProcess } from "./source-facts.ts";
import { registeredProcess, type EventFacts } from "./control-candidate/schema.ts";
import { MaintenanceFailure } from "./error.ts";
import type { SourceClientFactsWindow, SourceClientsObservation } from "./types.ts";

/** Historical data only. It cannot be supplied to an adapter to claim ownership. */
export interface SourceClientAudit {
  readonly kind: "untrusted-source-client-audit";
  readonly observation: SourceClientsObservation;
  readonly origin: SourceClientFactsWindow["origin"];
  readonly facts: EventFacts;
}
/** Adapter-only destination for values from the original native inspection calls. */
export interface SessionAuditCollection {
  readonly actor: EventFacts["actor"];
  readonly observation: SourceClientsObservation;
  value?: EventFacts["sessions"];
}

async function currentIdentity(instanceId: string) {
  if (process.platform === "darwin") return registeredProcess.parse({ ...darwinCurrentProcessIdentity(), instanceId });
  if (process.platform !== "linux") throw new MaintenanceFailure("source_writer_unknown", "audit-actor");
  const kernelBootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const pidNamespace = await readlink("/proc/self/ns/pid");
  const text = await readFile("/proc/self/stat", "utf8"), end = text.lastIndexOf(") ");
  if (Number(/^([1-9][0-9]*) \(/.exec(text)?.[1]) !== process.pid || end < 0 || text.length > 8192)
    throw new MaintenanceFailure("source_writer_unknown", "audit-actor");
  return registeredProcess.parse({ version: 1, platform: "linux", pid: process.pid, instanceId,
    verification: "linux_proc_identity_v1", kernelBootId, pidNamespace, startTicks: text.slice(end + 2).trim().split(/\s+/)[19] });
}

/** Never exported by an adapter. One factory belongs to one actual mutex invocation. */
export class BootstrapAuditFactory {
  readonly #adapter: object;
  readonly #mutex: object;
  readonly #actorId = randomUUID();
  #identity?: ReturnType<typeof currentIdentity>;
  #host?: EventFacts["actor"]["host"];
  #closed = false;
  constructor(adapter: object, mutex: object) { this.#adapter = adapter; this.#mutex = mutex; }
  close(): void { this.#closed = true; }
  bind(adapter: object, mutex: object, lock: object, assertHeld: () => Promise<void>): BootstrapAuditLease {
    if (adapter !== this.#adapter || mutex !== this.#mutex || this.#closed) throw new MaintenanceFailure("maintenance_lost");
    let active = true;
    const owner = this;
    return Object.freeze({
      async observe(actualLock: object) {
        if (!active || owner.#closed || actualLock !== lock) throw new MaintenanceFailure("maintenance_lost");
        try { await assertHeld(); } catch (error) { owner.close(); throw error; }
        try {
          const identity = await (owner.#identity ??= currentIdentity(owner.#actorId));
          const host = owner.#host ??= { version: 1 as const, hostname: hostname(), platform: identity.platform };
          const inspection = await inspectRegisteredSourceProcess(host, identity);
          if (inspection.fact.status !== "present") throw new MaintenanceFailure("source_writer_unknown", "audit-actor");
          try { await assertHeld(); } catch (error) { owner.close(); throw error; }
          return { actorId: owner.#actorId, clientId: null, host, process: identity, processCheck: inspection.check };
        } catch (error) {
          if (error instanceof MaintenanceFailure) throw error;
          throw new MaintenanceFailure("source_writer_unknown", "audit-actor");
        }
      },
      close() { active = false; },
      invalidate() { owner.close(); },
    });
  }
}
export interface BootstrapAuditLease {
  observe(actualLock: object): Promise<EventFacts["actor"]>;
  close(): void;
  invalidate(): void;
}
