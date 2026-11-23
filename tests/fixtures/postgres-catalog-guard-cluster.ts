import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, appendFile, copyFile, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";

const execute = promisify(execFile);
export const h04Roles = Object.freeze({ administrator: "br_fixture_admin", control: "br_fixture_control",
  business: "br_fixture_business", verification: "br_fixture_verify" });
type FixtureDatabase = "postgres" | "h04_source" | "h04_verification";

/** Test-only adaptation of the existing restart fixture. This owns a fresh child/datadir, never a supplied database URL.
 * Trust authentication is deliberate fixture behavior, not evidence of the H04 production server epoch or HBA profile. */
export async function openCatalogGuardTestCluster(binaryDirectory: string, diagnostic: "h04" | "wr1" | "r05" | "cap01-source" | "cap01-target" = "h04") {
  assert.ok(isAbsolute(binaryDirectory), "private PostgreSQL tools require an explicit absolute directory");
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid?.(), 0);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG")));
  const binary = (name: string) => join(binaryDirectory, name);
  const command = async (program: string, args: readonly string[]) => {
    try { return (await execute(binary(program), [...args], { env: environment, timeout: 30_000, maxBuffer: 512_000 })).stdout; }
    catch { throw new Error(`owned H04 fixture ${program} failed`); }
  };
  for (const name of ["postgres", "initdb", "pg_ctl"]) {
    await access(binary(name), constants.X_OK);
    assert.match(await command(name, ["--version"]), /PostgreSQL\) 16\.15(?:\s|$)/,
      "an explicit wrong or missing capability must fail, never fall back to the main CI database");
  }
  const directory = await mkdtemp(join(tmpdir(), "br-h04-owned-"));
  const data = join(directory, "cluster"), log = join(directory, "postgres.log");
  const diagnostics = async () => {
    const evidence = resolve(".agent-output/maintenance-pg-restart");
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    await copyFile(log, join(evidence, `${diagnostic}-postgres.log`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  };
  const probe = createServer();
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address(); assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  assert.notEqual(port, 5432);
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let systemIdentifier: string | undefined;
  const connect = async (database: FixtureDatabase = "postgres", user: string = h04Roles.administrator) => {
    assert.ok(Object.values(h04Roles).some(role => role === user));
    const client = new Client({ host: "127.0.0.1", port, user, database, password: () => "", ssl: false,
      connectionTimeoutMillis: 1_000, application_name: "boardroom-owned-h04-component-fixture" });
    client.on("error", () => {});
    try { await client.connect(); return client; }
    catch (error) { await client.end().catch(() => {}); throw error; }
  };
  const verifyOwner = async () => {
    const client = await connect();
    try {
      const row = (await client.query(`SELECT current_setting('data_directory') AS directory,
        current_setting('port') AS port,pg_catalog.host(inet_server_addr()) AS address,
        current_setting('server_version_num') AS version,
        (pg_control_system()).system_identifier::text AS system_identifier`)).rows[0];
      assert.equal(await realpath(row.directory), await realpath(data));
      assert.equal(row.port, String(port)); assert.equal(row.address, "127.0.0.1"); assert.equal(row.version, "160015");
      if (systemIdentifier !== undefined) assert.equal(row.system_identifier, systemIdentifier);
      systemIdentifier ??= row.system_identifier;
    } finally { await client.end(); }
  };
  const stop = async () => {
    if (!child) return;
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
      await command("pg_ctl", ["-D", data, "-w", "-t", "30", "-m", "fast", "stop"]);
    const outcome = await closed!;
    assert.equal(outcome.code, 0); assert.equal(outcome.signal, null);
    await assert.rejects(access(join(data, "postmaster.pid")), { code: "ENOENT" });
    child = undefined;
  };
  try {
    const share = resolve(binaryDirectory, "../../../../share/postgresql/16"), library = resolve(binaryDirectory, "../lib");
    await access(join(share, "postgres.bki"));
    await command("initdb", ["-D", data, "-U", h04Roles.administrator, "--auth=trust", "--no-locale", "--encoding=UTF8", "-L", share]);
    await appendFile(join(data, "postgresql.conf"), `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nfsync=on\nsynchronous_commit=on\njit=off\ndynamic_library_path='${library.replaceAll("'", "''")}'\n`);
    const output = await open(log, "a", 0o600);
    try {
      child = spawn(binary("postgres"), ["-D", data], { shell: false, env: environment, stdio: ["ignore", output.fd, output.fd] });
      closed = new Promise(resolve => child!.once("close", (code, signal) => resolve({ code, signal })));
      await once(child, "spawn");
    } finally { await output.close(); }
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("owned H04 PostgreSQL child exited before readiness");
      try { await verifyOwner(); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED" && !/starting up/.test(String(error))) throw error;
        if (Date.now() >= deadline) throw new Error("owned H04 PostgreSQL readiness deadline");
        await new Promise<void>(resolve => setTimeout(resolve, 50));
      }
    }
    return { connect, systemIdentifier: systemIdentifier!,
      connectionString(database: FixtureDatabase = "postgres") {
        return `postgresql://${h04Roles.administrator}@127.0.0.1:${port}/${database}`;
      },
      async close() { await verifyOwner(); await stop(); await diagnostics(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await diagnostics(); await stop(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
