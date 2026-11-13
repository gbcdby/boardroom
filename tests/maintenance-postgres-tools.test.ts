import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresPublicToolVersions, runPostgresTool, waitForPostgresTools } from "../src/server/storage/maintenance/postgres-tools.ts";

async function fixture(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "br-public-tools-"));
  await writeFile(join(directory, "psql"), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return { directory, environment: { ...process.env, PATH: directory },
    close: () => rm(directory, { recursive: true, force: true }) };
}

test("#152 public native tool uses a shared remaining deadline and observes actual close", async () => {
  const f = await fixture("process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 2200);");
  const controller = new AbortController();
  try {
    const start = performance.now();
    await assert.rejects(runPostgresTool("psql", [], f.environment, {
      failure: "restore_verification_unavailable", signal: controller.signal, deadline: start + 150,
    }), /restore_verification_unavailable/);
    await waitForPostgresTools(controller.signal);
    assert.ok(performance.now() - start >= 150, "deadline cannot be reported before it expires");
    assert.ok(performance.now() - start < 2100, "TERM-resistant child must be killed and closed within escalation");
  } finally { controller.abort(); await waitForPostgresTools(controller.signal); await f.close(); }
});

test("#152 public native tool does not spawn after its pipeline deadline", async () => {
  const f = await fixture("import fs from 'node:fs'; fs.writeFileSync(process.env.SPAWN_CANARY, 'spawned');");
  const canary = join(f.directory, "spawn-canary");
  try {
    await assert.rejects(runPostgresTool("psql", [], { ...f.environment, SPAWN_CANARY: canary }, {
      failure: "restore_verification_unavailable", deadline: performance.now() - 1,
    }), /restore_verification_unavailable/);
    await assert.rejects(readFile(canary), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("#152 native controlled descriptors preserve independent offsets and read-only access", async () => {
  const f = await fixture(`import fs from 'node:fs';
const first = fs.readFileSync(3, 'utf8'), second = fs.readFileSync(4, 'utf8');
let readonly = false; try { fs.writeSync(3, 'tamper'); } catch (error) { readonly = error.code === 'EBADF'; }
process.stdout.write(JSON.stringify({ first, second, readonly }));`);
  const file = join(f.directory, "native-input");
  await writeFile(file, "exact native bytes\n", { mode: 0o600 });
  const first = await open(file, "r"), second = await open(file, "r");
  try {
    const result = await runPostgresTool("psql", [], f.environment, {
      failure: "restore_verification_unavailable", readFds: [first.fd, second.fd],
    });
    assert.deepEqual(JSON.parse(result.stdout), { first: "exact native bytes\n", second: "exact native bytes\n", readonly: true });
    assert.equal(await readFile(file, "utf8"), "exact native bytes\n");
  } finally { await first.close(); await second.close(); await f.close(); }
});

test("#152 native tool abort waits for a TERM-resistant child and redacts stderr", async () => {
  const f = await fixture("process.on('SIGTERM', () => {}); process.stderr.write('private-source-sql'); process.stdout.write('ready'); setInterval(() => {}, 100);");
  const controller = new AbortController();
  try {
    const running = runPostgresTool("psql", [], f.environment, {
      failure: "restore_verification_unavailable", signal: controller.signal,
    });
    const rejection = assert.rejects(running, error => /maintenance_lost/.test(String(error)) && !/private-source-sql/.test(String(error)));
    const abortTimer = setTimeout(() => controller.abort(), 120);
    await rejection; clearTimeout(abortTimer);
    await waitForPostgresTools(controller.signal);
  } finally { controller.abort(); await waitForPostgresTools(controller.signal); await f.close(); }
});

test("#152 public tool capability requires present, validated and exact-minor matching native tools", async () => {
  const f = await fixture("process.stdout.write('psql (PostgreSQL) 16.14\\n');");
  const controller = new AbortController();
  try {
    await writeFile(join(f.directory, "pg_restore"), `#!${process.execPath}\nprocess.stdout.write('pg_restore (PostgreSQL) 16.15\\n');\n`, { mode: 0o700 });
    await assert.rejects(postgresPublicToolVersions(f.environment, controller.signal, performance.now() + 5000, "16.15"), /restore_verification_unavailable/);
    await rm(join(f.directory, "psql"));
    await assert.rejects(postgresPublicToolVersions(f.environment, controller.signal, performance.now() + 5000, "16.15"), /restore_verification_unavailable/);
    await writeFile(join(f.directory, "psql"), `#!${process.execPath}\nprocess.stdout.write('psql (PostgreSQL) 16.15\\n');\n`, { mode: 0o700 });
    assert.deepEqual(await postgresPublicToolVersions(f.environment, controller.signal, performance.now() + 5000, "16.15"), { pgRestore: "16.15", psql: "16.15" });
    await assert.rejects(postgresPublicToolVersions(f.environment, controller.signal, performance.now() + 5000, "16.14"), /restore_verification_unavailable/);
  } finally { controller.abort(); await waitForPostgresTools(controller.signal); await f.close(); }
});
