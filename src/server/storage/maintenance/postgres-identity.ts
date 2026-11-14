import { MaintenanceFailure } from "./error.ts";

/** One current server observation. Runtime fields never become the durable source key. */
export interface PostgresDatabaseIdentity {
  readonly systemIdentifier: string;
  readonly databaseOid: string;
  readonly databaseName: string;
  readonly schemaOid: string | null;
  readonly schemaName: string;
  readonly serverAddress: string | null;
  readonly serverPort: number | null;
  readonly postmasterStartedAt: string;
  readonly serverVersion: string;
  readonly fsync: string;
  readonly inRecovery: boolean;
}

/**
 * Persist only the actual cluster/database/schema/endpoint and the trusted descriptor/marker.
 * A new adapter may reacquire the same source after a restart; it must establish fresh sessions
 * and capabilities. Failover, a changed endpoint and a copied/replaced database remain distinct.
 */
export function stablePostgresSourceIdentity(observed: PostgresDatabaseIdentity, descriptorDigest: string,
  databaseInstanceId: string) {
  return { formatVersion: 1 as const, kind: "postgres" as const, systemIdentifier: observed.systemIdentifier,
    databaseOid: observed.databaseOid, databaseName: observed.databaseName, schemaOid: observed.schemaOid,
    schemaName: observed.schemaName, serverAddress: observed.serverAddress, serverPort: observed.serverPort,
    descriptorDigest, databaseInstanceId };
}

/** Readonly diagnostics may describe a non-writable server, but execution cannot use it. */
export function assertPostgresServerCapability(observed: PostgresDatabaseIdentity, purpose: "observe" | "execute"): void {
  if (!/^[0-9]+$/.test(observed.serverVersion) || Math.floor(Number(observed.serverVersion) / 10000) !== 16)
    throw new MaintenanceFailure("backup_capability_unavailable");
  if (purpose === "execute" && (observed.fsync !== "on" || observed.inRecovery))
    throw new MaintenanceFailure("unsupported_durability");
}
