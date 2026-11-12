import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ClientConfig } from "pg";
import type { DatabaseDescriptor } from "../../environment.ts";
import { digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import type { BlockerCode } from "./types.ts";

export type PostgresDescriptor = Extract<DatabaseDescriptor, { kind: "postgres" }>;
export interface PostgresConnection {
  readonly schema: string;
  readonly database: string;
  readonly descriptorDigest: string;
  readonly clientConfig: ClientConfig;
  /** Private process environment. Never serialize this object or include it in evidence. */
  readonly childEnvironment: NodeJS.ProcessEnv;
}

/** Both node-postgres and libpq use only this explicit source, never PG* defaults. */
export function parsePostgresConnection(descriptor: PostgresDescriptor): PostgresConnection {
  let url: URL;
  try { url = new URL(descriptor.connectionString); }
  catch { throw new MaintenanceFailure("source_missing"); }
  const schema = descriptor.schema ?? "public";
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username
    || !url.pathname || url.pathname === "/" || url.hash || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))
    throw new MaintenanceFailure("source_missing");
  const allowed = new Set(["sslmode", "sslrootcert", "sslcert", "sslkey"]);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key))
    || [...allowed].some(key => url.searchParams.getAll(key).length > 1))
    throw new MaintenanceFailure("backup_capability_unavailable");
  let user: string, database: string, password: string;
  try {
    user = decodeURIComponent(url.username); database = decodeURIComponent(url.pathname.slice(1));
    password = decodeURIComponent(url.password);
  } catch { throw new MaintenanceFailure("source_missing"); }
  if ([user, database, password].some(value => value.includes("\0")) || !user || !database)
    throw new MaintenanceFailure("source_missing");
  const host = url.hostname.replace(/^\[|\]$/g, ""), port = Number(url.port || "5432");
  const sslmode = url.searchParams.get("sslmode") ?? "disable";
  if (!["disable", "require", "verify-ca", "verify-full"].includes(sslmode))
    throw new MaintenanceFailure("backup_capability_unavailable");
  const certPaths: Record<string, string> = {};
  const sslFiles: { ca?: string; cert?: string; key?: string } = {};
  for (const [parameter, option] of [["sslrootcert", "ca"], ["sslcert", "cert"], ["sslkey", "key"]] as const) {
    const path = url.searchParams.get(parameter);
    if (path !== null) {
      if (!path || /[\r\n\0]/.test(path) || sslmode === "disable") throw new MaintenanceFailure("backup_capability_unavailable");
      try { sslFiles[option] = readFileSync(path, "utf8"); }
      catch { throw new MaintenanceFailure("backup_capability_unavailable"); }
      certPaths[parameter] = path;
    }
  }
  const childEnvironment: NodeJS.ProcessEnv = {};
  // Preserve PATH/platform process needs, but discard every ambient libpq selector/credential.
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("PG")) childEnvironment[key] = value;
  Object.assign(childEnvironment, {
    PGHOST: host, PGPORT: String(port), PGUSER: user, PGDATABASE: database, PGPASSWORD: password,
    PGSSLMODE: sslmode, PGCONNECT_TIMEOUT: "5", PGCLIENTENCODING: "UTF8", PGAPPNAME: "boardroom-maintenance-tool",
    PGOPTIONS: "-c statement_timeout=300000 -c lock_timeout=5000",
  });
  for (const [parameter, path] of Object.entries(certPaths)) childEnvironment[`PG${parameter.toUpperCase()}`] = path;
  // A callback returning an explicit password also prevents node-postgres consulting pgpass.
  const clientConfig: ClientConfig & { replication: string; sslnegotiation: string } = {
    host, port, user, database, password: () => password, connectionTimeoutMillis: 5_000,
    options: "-c search_path=pg_catalog -c statement_timeout=15000 -c lock_timeout=5000",
    application_name: "boardroom-maintenance-native", client_encoding: "UTF8", replication: "false", sslnegotiation: "postgres",
    query_timeout: 15_000,
    ssl: sslmode === "disable" ? false : {
      ...sslFiles, rejectUnauthorized: sslmode !== "require",
      ...(sslmode === "verify-ca" ? { checkServerIdentity: () => undefined } : {}),
    },
  };
  return { schema, database, clientConfig, childEnvironment,
    descriptorDigest: digestJson({ kind: "postgres", host, port, user, database, schema, sslmode,
      certificateConfigurationDigest: digestJson(certPaths) }) };
}

/** A connection option containing only an escaped database name, never a DSN or password. */
export function postgresDatabaseArgument(database: string): string {
  return `--dbname=dbname='${database.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** Safe resolver-facing projection; the full parsed connection stays inside native adapters. */
export function postgresDescriptorDigest(descriptor: PostgresDescriptor): string {
  return parsePostgresConnection(descriptor).descriptorDigest;
}
const activeTools = new WeakMap<AbortSignal, Set<Promise<unknown>>>();
export async function waitForPostgresTools(signal: AbortSignal): Promise<void> {
  await Promise.allSettled([...(activeTools.get(signal) ?? [])]);
}

export async function runPostgresTool(program: "pg_dump" | "pg_restore", args: readonly string[],
  environment: NodeJS.ProcessEnv, options: {
    readonly failure: BlockerCode;
    readonly signal?: AbortSignal;
    readonly inputFd?: number;
    readonly outputFd?: number;
  }): Promise<{ readonly stdout: string; readonly stderrPresent: boolean }> {
  if (options.signal?.aborted) throw new MaintenanceFailure("maintenance_lost");
  const operation = new Promise<{ readonly stdout: string; readonly stderrPresent: boolean }>((resolve, reject) => {
    let settled = false, stdout = "", stderrPresent = false, failure: BlockerCode | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(program, [...args], { shell: false, env: environment,
      stdio: [options.inputFd ?? "ignore", options.outputFd ?? "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}), killSignal: "SIGTERM" });
    const stop = (code = options.failure) => {
      failure = code;
      if (child.pid && !settled) {
        child.kill("SIGTERM");
        escalation ??= setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 1_000);
        escalation.unref();
      }
    };
    const timer = setTimeout(() => stop(), 300_000);
    timer.unref();
    // stderr can contain source SQL, identifiers and authentication details. Do not retain it.
    child.stderr?.on("data", () => { stderrPresent = true; });
    child.stdout?.on("data", (data: Buffer) => {
      if (stdout.length + data.length > 4096) stop();
      else stdout += data.toString("utf8");
    });
    child.once("error", () => stop(options.signal?.aborted ? "maintenance_lost" : options.failure));
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(escalation);
      if (failure || code !== 0 || signal || options.signal?.aborted)
        reject(new MaintenanceFailure(options.signal?.aborted ? "maintenance_lost" : failure ?? options.failure));
      else resolve({ stdout, stderrPresent });
    });
  });
  if (options.signal) {
    let pending = activeTools.get(options.signal);
    if (!pending) { pending = new Set(); activeTools.set(options.signal, pending); }
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
  }
  return operation;
}

export async function postgresToolVersions(environment: NodeJS.ProcessEnv, signal: AbortSignal,
  failure: BlockerCode): Promise<{ readonly pgDump: string; readonly pgRestore: string; readonly major: number }> {
  const versions: string[] = [];
  for (const program of ["pg_dump", "pg_restore"] as const) {
    const result = await runPostgresTool(program, ["--version"], environment, { signal, failure });
    const match = new RegExp(`^${program} \\(PostgreSQL\\) (\\d+\\.\\d+)(?:[^\\r\\n]*)[\\r\\n]*$`).exec(result.stdout);
    if (!match || result.stderrPresent) throw new MaintenanceFailure(failure);
    versions.push(match[1]!);
  }
  const major = Number(versions[0]!.split(".")[0]);
  if (major !== 16 || Number(versions[1]!.split(".")[0]) !== major) throw new MaintenanceFailure(failure);
  return { pgDump: versions[0]!, pgRestore: versions[1]!, major };
}
