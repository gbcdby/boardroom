import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { mkdtemp, readdir, readlink, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createSqliteMaintenanceAdapter } from "../src/server/storage/maintenance/sqlite.ts";
import { linuxMappingIdentity, linuxMappingIdentityAvailable, linuxSourceMappingIdentities, parseLinuxMappings } from "../src/server/storage/maintenance/linux-mappings.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const fixtureScript = fileURLToPath(new URL("./fixtures/maintenance-linux-mapped-user.py", import.meta.url));
const row = "1000-2000 rw-s 00000000 0a:01 9007199254740993 /a path (deleted)\n";

test("#152 Linux maps uses exact kernel device/inode, preserves readonly users, and ignores display-path identity", () => {
  const identity = linuxMappingIdentity("pos:\t0\nflags:\t02500000\nmnt_id:\t287\nino:\t9007199254740993\n",
    "287 261 10:1 / /fixture rw - overlay overlay rw\n");
  assert.equal(identity, "10:1:9007199254740993");
  assert.equal(parseLinuxMappings(row)[0]!.mappedIdentity, identity);
  assert.equal(parseLinuxMappings(row.replace("/a path (deleted)", "/unrelated display name"))[0]!.mappedIdentity, identity);
  assert.equal(parseLinuxMappings(row.replace("rw-s", "r--p"))[0]!.mappedIdentity, identity);
  assert.notEqual(parseLinuxMappings(row.replace("0a:01", "0a:02"))[0]!.mappedIdentity, identity);
  assert.notEqual(parseLinuxMappings(row.replace("9007199254740993", "9007199254740992"))[0]!.mappedIdentity, identity);
});

test("#152 incomplete, malformed, overlapping maps and ambiguous source metadata stay unknown", () => {
  for (const text of [row.slice(0, -1), "not maps\n", row + row, row.replace("2000", "1000"),
    row.replace("rw-s", "rwxq"), row.replace("9007199254740993", "18446744073709551616"), "x".repeat(8 * 1024 * 1024 + 1)])
    assert.throws(() => parseLinuxMappings(text), /inventory_unavailable/);
  const info = "mnt_id:\t287\nino:\t99\n", mounts = "287 261 0:27 / /fixture rw - overlay overlay rw\n";
  for (const [fdinfo, mountinfo] of [[info + "ino:\t100\n", mounts], [info, mounts + mounts], [info, ""], [info.slice(0, -1), mounts]])
    assert.throws(() => linuxMappingIdentity(fdinfo!, mountinfo!), /inventory_unavailable/);
  assert.equal(linuxMappingIdentityAvailable("6.7.12"), false);
  assert.equal(linuxMappingIdentityAvailable("unknown"), false);
  assert.equal(linuxMappingIdentityAvailable("6.8.0-azure"), true);
  assert.equal(linuxMappingIdentityAvailable("6.18.57"), true);
});

async function fixture() {
  const dir = await mkdtemp(path.join(process.cwd(), "br-linux-mapped-")), file = path.join(dir, "agent-studio.db");
  const db = new Database(file); runMigrations(db, migrations); db.pragma("journal_mode=WAL"); db.close();
  const info = await stat(file, { bigint: true });
  const descriptor = { kind: "sqlite" as const, dataDir: dir, sourcePath: file, sqlitePath: file,
    identity: { device: String(info.dev), inode: String(info.ino) } };
  const adapter = await createSqliteMaintenanceAdapter(descriptor);
  return { dir, file, adapter, descriptor, async close() { await adapter.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function startUser(file: string, mode: string) {
  const child = spawn("/usr/bin/python3", [fixtureScript, file, mode], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal })); child.once("error", reject);
  });
  try {
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let text = "", errors = "";
      const timer = setTimeout(() => reject(new Error("own mapped-user readiness timeout")), 5000);
      child.stderr.on("data", value => { errors += String(value); });
      child.stdout.on("data", value => {
        text += String(value); if (!text.includes("\n")) return;
        clearTimeout(timer); try { resolve(JSON.parse(text.split("\n")[0]!)); } catch (error) { reject(error); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); if (!text.includes("\n")) reject(new Error(errors || "own child exited before readiness")); });
    });
    return { child, ready, async stop() {
      child.stdin.end("finish\n");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { return await exited; } finally { clearTimeout(timer); }
    } };
  } catch (error) { child.kill("SIGKILL"); await exited.catch(() => undefined); throw error; }
}

for (const mode of ["shared-writer", "private-reader", "fd-reader"]) linuxTest(`#152 real Linux ${mode} remains a blocker until the same-UID process releases its source`, async t => {
  const f = await fixture(); let user: Awaited<ReturnType<typeof startUser>> | undefined;
  try {
    assert.deepEqual(await f.adapter.inspectWriters(await f.adapter.observe()), []);
    user = await startUser(f.file, mode);
    assert.equal(user.ready.uid, process.getuid!());
    const sourceFds = [];
    for (const fd of await readdir(`/proc/${user.child.pid}/fd`)) {
      try { if ((await readlink(`/proc/${user.child.pid}/fd/${fd}`)) === f.file) sourceFds.push(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (mode === "fd-reader") assert.equal(sourceFds.length, 1);
    else {
      assert.deepEqual(sourceFds, []); assert.equal(user.ready.sourceFdClosed, true);
      const actual = parseLinuxMappings(`${user.ready.mapping}\n`)[0]!;
      const source = linuxSourceMappingIdentities([f.file])[0]!;
      assert.equal(actual.mappedIdentity, source.mappedIdentity);
      assert.equal(source.identity, `${f.descriptor.identity.device}:${f.descriptor.identity.inode}`);
      if (mode === "shared-writer") assert.equal(user.ready.sameByteWrite, true);
      t.diagnostic(JSON.stringify({ sourceStat: f.descriptor.identity, sourceKernelIdentity: source.mappedIdentity, child: user.ready, sourceFds }));
    }
    const blockers = await f.adapter.inspectWriters(await f.adapter.observe());
    assert.ok(blockers.some(blocker => blocker.code === "source_writer_unknown" && blocker.subjectRef === `os-process:${user!.child.pid}`));
    assert.deepEqual(await user.stop(), { code: 0, signal: null }); user = undefined;
    assert.deepEqual(await f.adapter.inspectWriters(await f.adapter.observe()), []);
  } finally { await user?.stop(); await f.close(); }
});

linuxTest("#152 per-process maps access, partial/empty data and observation limits never produce a clear inventory", async t => {
  const f = await fixture(); const user = await startUser(f.file, "idle");
  try {
    const observation = await f.adapter.observe();
    for (const fault of ["EACCES", "EPERM", "ENOENT", "malformed", "empty", "over-limit", "identity-changed"]) {
      const processFds = new Set<number>(), mapFds = new Set<number>(), changedStatFds = new Set<number>(); let reads = 0, injected = 0;
      const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync };
      t.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: unknown[]) => {
        const name = String(file), match = /^\/proc\/self\/fd\/([0-9]+)\/maps$/.exec(name);
        const target = match && processFds.has(Number(match[1]));
        if (target) { injected++; if (["EACCES", "EPERM", "ENOENT"].includes(fault)) throw Object.assign(new Error(fault), { code: fault }); }
        const fd = Reflect.apply(original.open, fs, [file, ...args]) as number;
        if (name === `/proc/${user.child.pid}`) processFds.add(fd);
        if (target) mapFds.add(fd);
        const identity = /^\/proc\/self\/fd\/([0-9]+)\/stat$/.exec(name);
        if (fault === "identity-changed" && injected && identity && processFds.has(Number(identity[1]))) changedStatFds.add(fd);
        return fd;
      }) as typeof fs.openSync);
      t.mock.method(fs, "readSync", ((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        if (changedStatFds.has(fd)) {
          const size = original.read(fd, buffer, offset, length, position);
          if (!size) return size;
          const text = buffer.toString("latin1", offset, offset + size), end = text.lastIndexOf(") ");
          const fields = text.slice(end + 2).trim().split(/\s+/); fields[19] = String(BigInt(fields[19]!) + 1n);
          const changed = text.slice(0, end + 2) + fields.join(" ") + "\n";
          assert.ok(Buffer.byteLength(changed) <= length);
          return buffer.write(changed, offset, length, "latin1");
        }
        if (!mapFds.has(fd) || fault === "identity-changed") return original.read(fd, buffer, offset, length, position);
        reads++;
        if (fault === "empty" || (fault === "malformed" && reads > 1)) return 0;
        const text = fault === "malformed" ? "incomplete maps row\n" : "x".repeat(length);
        return buffer.write(text, offset, Math.min(length, Buffer.byteLength(text)), "latin1");
      }) as typeof fs.readSync);
      t.mock.method(fs, "closeSync", (fd: number) => { processFds.delete(fd); mapFds.delete(fd); changedStatFds.delete(fd); original.close(fd); });
      syncBuiltinESMExports();
      try {
        const blockers = await f.adapter.inspectWriters(observation);
        assert.ok(injected > 0, `${fault}: reached the original child maps operation`);
        assert.ok(blockers.some(blocker => blocker.code === "source_writer_unknown" && blocker.subjectRef === `unreadable-process:${user.child.pid}`), fault);
        assert.ok(reads <= 130, `${fault}: read budget remains bounded`);
        assert.equal(user.child.exitCode, null);
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    }
    assert.deepEqual(await user.stop(), { code: 0, signal: null });
    assert.deepEqual(await f.adapter.inspectWriters(await f.adapter.observe()), []);
  } finally { if (user.child.exitCode === null) await user.stop(); await f.close(); }
});

linuxTest("#152 an observed exit during the pinned proc walk is distinguished from a missing maps file on a live process", async t => {
  const f = await fixture(), user = await startUser(f.file, "shared-writer"); let released = false;
  try {
    const observation = await f.adapter.observe(), original = promises.readdir;
    t.mock.method(promises, "readdir", (async (file: fs.PathLike, ...args: unknown[]) => {
      const result = await Reflect.apply(original, promises, [file, ...args]);
      const match = /^\/proc\/self\/fd\/([0-9]+)\/fd$/.exec(String(file));
      if (match && !released && fs.readlinkSync(`/proc/self/fd/${match[1]}`) === `/proc/${user.child.pid}`) {
        assert.deepEqual(await user.stop(), { code: 0, signal: null }); released = true;
      }
      return result;
    }) as typeof promises.readdir);
    syncBuiltinESMExports();
    try { assert.deepEqual(await f.adapter.inspectWriters(observation), []); assert.equal(released, true); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  } finally { if (!released) await user.stop(); await f.close(); }
});
