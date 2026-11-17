import { randomUUID } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { darwinCurrentProcessIdentity } from "../../src/server/storage/maintenance/darwin.ts";
import { registeredProcess } from "../../src/server/storage/maintenance/control-candidate/schema.ts";

// Owned identity witness only. This child opens no source DB or application file;
// the parent fixture assembles the protocol and V independently inspects this PID.
const instanceId = randomUUID();
let identity: unknown;
if (process.platform === "darwin") identity = { ...darwinCurrentProcessIdentity(), instanceId };
else if (process.platform === "linux") {
  const [boot, namespace, stat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readlink("/proc/self/ns/pid"), readFile("/proc/self/stat", "utf8")]);
  identity = { version: 1, platform: "linux", pid: process.pid, instanceId, verification: "linux_proc_identity_v1",
    kernelBootId: boot.trim(), pidNamespace: namespace, startTicks: stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19] };
} else throw new Error("native identity witness requires Linux or macOS");
process.stdout.write(`${JSON.stringify({ host: { version: 1, hostname: hostname(), platform: process.platform }, process: registeredProcess.parse(identity) })}\n`);
process.stdin.resume();
