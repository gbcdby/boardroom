import { spawn } from "node:child_process";
import type { DatabaseDescriptor } from "../../src/server/environment.ts";

/** Real ordinary registration, normal close, then actual process exit before maintenance. */
export async function registerExitedAuditClient(database: DatabaseDescriptor, dataDir?: string): Promise<string> {
  const source = new URL("../../src/server/storage/source-client.ts", import.meta.url).href;
  const driver = new URL(database.kind === "sqlite" ? "../../src/server/db/drivers/sqlite.ts" : "../../src/server/db/drivers/postgres.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { randomUUID } from "node:crypto";
    import { registerStorageSourceClient } from ${JSON.stringify(source)};
    import { ${database.kind === "sqlite" ? "SqliteDriver" : "PostgresDriver"} as Driver } from ${JSON.stringify(driver)};
    const database = JSON.parse(process.env.BOARDROOM_AUDIT_CHILD_SOURCE);
    const clientId = randomUUID();
    let options;
    if (database.kind === "sqlite") options = { dataDir: process.env.BOARDROOM_AUDIT_CHILD_DATA };
    else { const url = new URL(database.connectionString); url.searchParams.set("application_name", "boardroom-source:" + clientId); options = { connectionString: String(url) }; }
    const db = new Driver(options); await db.connect();
    const registration = await registerStorageSourceClient({ db, database, entrypoint: "owned-background", clientId });
    const id = registration.clientId; await registration.close(); process.send({ id }); process.disconnect();
  `], { env: { ...process.env, BOARDROOM_AUDIT_CHILD_SOURCE: JSON.stringify(database),
    ...(dataDir ? { BOARDROOM_AUDIT_CHILD_DATA: dataDir } : {}) }, stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 15_000 });
  let clientId: string | undefined, failed = false;
  child.stderr!.on("data", () => { failed = true; }); // Do not expose source connection text.
  child.on("message", message => { if (typeof (message as { id?: unknown }).id === "string") clientId = (message as { id: string }).id; });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 && signal === null && !failed && clientId
      ? resolve() : reject(new Error("actual historical registration child failed")));
  });
  return clientId!;
}
