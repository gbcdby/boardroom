import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { darwinHostUuid } from "./darwin.ts";

/** Persistent host binding, private digest only; a hostname or reboot-scoped boot ID alone is insufficient. */
export async function maintenanceHostIdentityDigest(): Promise<string> {
  if (process.platform === "darwin") return digestJson({ version: 1, platform: "darwin", hostname: hostname(), hostUuid: darwinHostUuid() });
  if (process.platform !== "linux") throw new MaintenanceFailure("unsupported_durability");
  try {
    const machineId = (await readFile("/etc/machine-id", "utf8")).trim();
    if (!/^[a-f0-9]{32}$/.test(machineId)) throw new Error("unavailable");
    return digestJson({ version: 1, platform: process.platform, hostname: hostname(), machineId });
  } catch { throw new MaintenanceFailure("unsupported_durability"); }
}
