import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../../src/server/storage/maintenance/canonical.ts";
import { registeredProcess, type EventFacts } from "../../src/server/storage/maintenance/control-candidate/schema.ts";
import type { SourceRef } from "../../src/server/storage/maintenance/types.ts";

/** A real otherwise idle child, not a registered maintenance controller or a simulated exit. */
export async function historicalControllerProcess(sourceFile?: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { randomUUID } from 'node:crypto';
    import { open, readFile, readlink } from 'node:fs/promises';
    import { hostname } from 'node:os';
    import { darwinCurrentProcessIdentity } from ${JSON.stringify(new URL("../../src/server/storage/maintenance/darwin.ts", import.meta.url).href)};
    let identity;
    const instanceId = randomUUID();
    if (process.platform === 'linux') {
      const text = await readFile('/proc/self/stat', 'utf8');
      identity = { version: 1, platform: 'linux', pid: process.pid, instanceId,
        verification: 'linux_proc_identity_v1',
        kernelBootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
        pidNamespace: await readlink('/proc/self/ns/pid'),
        startTicks: text.slice(text.lastIndexOf(') ') + 2).trim().split(/\\s+/)[19] };
    } else if (process.platform === 'darwin') identity = { ...darwinCurrentProcessIdentity(), instanceId };
    else throw new Error('actual supported native platform required');
    const held = ${JSON.stringify(sourceFile ?? null)};
    const handle = held === null ? undefined : await open(held, 'r');
    process.on('message', async value => { if (value === 'stop') { await handle?.close(); process.disconnect(); } });
    process.send({ host: { version: 1, hostname: hostname(), platform: process.platform }, identity });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 30_000 });
  let stderr = "";
  child.stderr!.on("data", value => { stderr = (stderr + String(value)).slice(-8192); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    const value = await Promise.race([
      new Promise<{ host: EventFacts["actor"]["host"]; identity: unknown }>(resolve => child.once("message", message => resolve(message as never))),
      closed.then(result => { throw new Error(`identity child exited before observation: ${result.code}/${result.signal}: ${stderr}`); }),
    ]);
    const identity = registeredProcess.parse(value.identity);
    assert.equal(identity.pid, child.pid);
    return { host: value.host, identity,
      async exit() {
        assert(child.connected, "the owned child must still be live before the exit request");
        child.send("stop");
        const result = await closed;
        assert.deepEqual(result, { code: 0, signal: null });
      },
      async close() {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      } };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.catch(() => {}); throw error;
  }
}

/** Controlled historical input only; this never claims that a controller registration committed. */
export function historicalControllerRow(source: SourceRef, actor: Pick<Awaited<ReturnType<typeof historicalControllerProcess>>, "host" | "identity">) {
  const migrationId = randomUUID(), previousDigest = "8".repeat(64), planDigest = "7".repeat(64);
  return { client_id: randomUUID(), database_instance_id: source.databaseInstanceId,
    entrypoint: "maintenance-controller", build_id: "boardroom-maintenance-control-v1", protocol_version: 1,
    registered_epoch: 1, observed_epoch: 1, drain_epoch: null, drain_state: "none", drain_receipt_digest: null,
    registered_at: "2026-11-01T00:00:00.000Z", last_observed_at: "2026-11-01T00:00:00.000Z", ended_at: null,
    host_identity_json: canonicalJson(actor.host), process_identity_json: canonicalJson(actor.identity),
    db_sessions_json: canonicalJson({ formatVersion: 1, kind: "maintenance-controller-registration", source,
      sourceIdentityDigest: source.identityDigest,
      creation: { migrationId, plan: { ref: `plans/${planDigest}.json`, sha256: planDigest, bytes: "1" }, fenceEpoch: "1", ownerGeneration: "7",
        previousAnchor: { ref: `journals/${migrationId}/1-${previousDigest}.json`, sha256: previousDigest, bytes: "1" }, targetSequence: "2" },
      sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null }) };
}
