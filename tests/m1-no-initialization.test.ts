import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import fs, { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createDbDriver } from "../src/server/db/driver.ts";
import { DATABASE_FILE_NAME } from "../src/server/db/database.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { migrateData, validateData, M1_READ_PLAN } from "../src/server/db/migrate-data.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { m1Capture, m1Sqlite } from "./helpers/m1-fixture.ts";
import { withM1Cleanup, m1CleanupFailures } from "../src/server/db/m1-resources.ts";
import { openM1SourceExisting, type M1SourcePermit } from "../src/server/db/m1-source.ts";
import { withM1TargetLease } from "../src/server/db/m1-target.ts";

async function withDirectory(use: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "boardroom-m1-none-"));
  try { await use(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("M1 none 从构造起禁止创建 SQLite 文件和目录；重连仍保持 NO_CREATE", async () => {
  await withDirectory(async root => {
    const dataDir = path.join(root, "missing", "source");
    const driver = createDbDriver({ dataDir, initializationOnConnect: "none" });
    try {
      await assert.rejects(driver.connect());
      assert.equal(existsSync(path.join(root, "missing")), false);
      await assert.rejects(driver.connect());
      assert.equal(existsSync(path.join(root, "missing")), false);
    } finally { await driver.close(); }
  });
});

test("默认 normal 仍可创建与完整升级；none 不切换现有 DELETE journal", async () => {
  await withDirectory(async root => {
    const dataDir = path.join(root, "normal");
    const normal = createDbDriver({ dataDir });
    await normal.connect();
    await normal.migrate(migrations);
    await normal.close();
    const file = path.join(dataDir, DATABASE_FILE_NAME);
    const control = new Database(file, { fileMustExist: true });
    control.pragma("journal_mode = DELETE");
    control.close();
    const before = await readFile(file);
    const none = createDbDriver({ dataDir, initializationOnConnect: "none" });
    try {
      await none.connect();
      assert.deepEqual(await none.query("PRAGMA journal_mode"), [{ journal_mode: "delete" }]);
    } finally { await none.close(); }
    assert.ok((await readFile(file)).equals(before), "main database bytes remain unchanged");
  });
});

test("M1 缺源先拒绝，不能创建目标目录或替代源库", async () => {
  await withDirectory(async root => {
    const source = { dataDir: path.join(root, "source", "nested") };
    const target = { dataDir: path.join(root, "target", "nested") };
    await assert.rejects(migrateData(source, target));
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(validateData(source, target));
    assert.deepEqual(await readdir(root), []);
  });
});

for (const badSource of ["empty", "bad-header", "missing-metadata"] as const) {
  test(`M1 ${badSource} 源拒绝且原文件、journal、目标保持`, async () => {
    await withDirectory(async root => {
      const dataDir = path.join(root, "source");
      await mkdir(dataDir);
      const file = path.join(dataDir, DATABASE_FILE_NAME);
      if (badSource === "missing-metadata") {
        const db = new Database(file);
        db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('original')");
        db.close();
      } else await writeFile(file, badSource === "empty" ? "" : "invalid SQLite header");
      const before = await readFile(file);
      const target = path.join(root, "target", "nested");
      await assert.rejects(migrateData({ dataDir }, { dataDir: target }));
      assert.ok((await readFile(file)).equals(before), "rejected source bytes remain unchanged");
      assert.equal(existsSync(path.join(root, "target")), false);
      assert.deepEqual((await readdir(dataDir)).sort(), [DATABASE_FILE_NAME]);
    });
  });
}

test("M1 版本读取缺schema_migrations拒绝且不补建；完整checksum集合漂移也不修复", async () => {
  for (const damage of ["missing", "checksum"] as const) {
    const source = await m1Sqlite();
    await withM1Cleanup(async () => {
      if (damage === "missing") await source.db.exec("DROP TABLE schema_migrations");
      else await source.db.exec("UPDATE schema_migrations SET checksum='unknown' WHERE version=1");
      await source.db.close();
      const file = path.join(source.directory!, DATABASE_FILE_NAME), before = await readFile(file);
      const target = path.join(source.directory!, "uncreated-target");
      await assert.rejects(migrateData(source.options, { dataDir: target }), /m1_source_relation_missing|m1_source_version_or_checksum_mismatch/);
      assert.equal(existsSync(target), false);
      assert.ok((await readFile(file)).equals(before));
    }, [source.close]);
  }
});

test("M1 SQLite readonly预检后原文件移走，第二次NO_CREATE打开失败且不补替代空库", async () => {
  const source = await m1Sqlite();
  await source.db.close();
  const file = path.join(source.directory!, DATABASE_FILE_NAME), moved = `${file}.moved`;
  const original = SqliteDriver.prototype.connect;
  let renamed = false;
  const hook = mock.method(SqliteDriver.prototype, "connect", async function (this: SqliteDriver) {
    if (this.initializationOnConnect === "none" && !renamed) { renamed = true; fs.renameSync(file, moved); }
    return original.call(this);
  });
  try {
    await assert.rejects(migrateData(source.options, { dataDir: path.join(source.directory!, "target") }), /移动|替换|ENOENT/);
    assert.equal(renamed, true);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(moved), true);
    assert.equal(existsSync(path.join(source.directory!, "target")), false);
  } finally { hook.mock.restore(); await source.close(); }
});

test("M1 SQLite inspect后出现同名新文件，独占创建失败且竞争者原文件不接管", async () => {
  const source = await m1Sqlite();
  const targetDir = path.join(source.directory!, "target"), targetFile = path.join(targetDir, DATABASE_FILE_NAME);
  const original = fs.openSync;
  let competed = false;
  const hook = mock.method(fs, "openSync", function (...args: Parameters<typeof fs.openSync>) {
    if (String(args[0]) === targetFile && args[1] === "wx" && !competed) {
      competed = true;
      const fd = original(targetFile, "wx");
      try { fs.writeSync(fd, "competitor-owned"); } finally { fs.closeSync(fd); }
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(migrateData(source.options, { dataDir: targetDir }), { code: "EEXIST" });
    assert.equal(competed, true);
    assert.equal(await readFile(targetFile, "utf8"), "competitor-owned");
  } finally { hook.mock.restore(); syncBuiltinESMExports(); await source.close(); }
});

test("M1 SQLite实际同源别名在初始化/clear前拒绝，原57表保持", async () => {
  const source = await m1Sqlite(true);
  await withM1Cleanup(async () => {
    const before = await m1Capture(source.db);
    const alias = path.join(source.directory!, "alias");
    fs.symlinkSync(source.directory!, alias);
    await assert.rejects(migrateData(source.options, { dataDir: alias }), /m1_source_target_same_database/);
    assert.deepEqual(await m1Capture(source.db), before);
  }, [source.close]);
});

test("M1 CLI migrate与validate实际入口：缺源不创建两端；合法源/目标可验证", async () => {
  const source = await m1Sqlite(), target = await m1Sqlite();
  await withM1Cleanup(async () => {
    for (const command of ["migrate", "validate"]) {
      const missing = path.join(source.directory!, `missing-${command}`), destination = path.join(source.directory!, `target-${command}`);
      const result = spawnSync(process.execPath, ["scripts/migrate-data.ts", "--command", command,
        "--src-data-dir", missing, "--dst-data-dir", destination], { encoding: "utf8" });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(existsSync(missing), false);
      assert.equal(existsSync(destination), false);
    }
    for (const command of ["migrate", "validate"]) {
      const result = spawnSync(process.execPath, ["scripts/migrate-data.ts", "--command", command,
        "--src-data-dir", source.directory!, "--dst-data-dir", target.directory!], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /校验：通过/);
    }
    const absentTarget = path.join(source.directory!, "validate-absent-target");
    const absent = spawnSync(process.execPath, ["scripts/migrate-data.ts", "--command", "validate",
      "--src-data-dir", source.directory!, "--dst-data-dir", absentTarget], { encoding: "utf8" });
    assert.equal(absent.status, 1, absent.stderr);
    assert.equal(existsSync(absentTarget), false);
  }, [source.close, target.close]);
});

test("M1 sourcePermit不能由配置布尔值伪造，owner结束后也不能重新初始化目标", async () => {
  const fixture = await m1Sqlite();
  const target = { dataDir: path.join(fixture.directory!, "permit-target") };
  const source = await openM1SourceExisting(fixture.options, M1_READ_PLAN);
  await withM1Cleanup(async () => {
    await assert.rejects(withM1TargetLease(target, { allowed: true } as unknown as M1SourcePermit, M1_READ_PLAN, async () => {}), /m1_source_permit_inactive/);
    let stale: M1SourcePermit | undefined;
    await source.withBatch(async permit => { stale = permit; });
    await assert.rejects(withM1TargetLease(target, stale!, M1_READ_PLAN, async () => {}), /m1_source_permit_inactive/);
    assert.equal(existsSync(target.dataDir), false);
  }, [() => source.close(), fixture.close]);
});

test("M1 copy原错保留，target/source close故障分别收集且其余连接仍关闭", async () => {
  const source = await m1Sqlite(true), target = await m1Sqlite();
  await target.db.exec("CREATE TRIGGER m1_copy_fail BEFORE INSERT ON decision_changes BEGIN SELECT RAISE(ABORT,'original-copy-failure'); END");
  const sourceFile = path.join(source.directory!, DATABASE_FILE_NAME), targetFile = path.join(target.directory!, DATABASE_FILE_NAME);
  const sourceClose = new Error("source-close-failed"), targetClose = new Error("target-close-failed");
  const closed: string[] = [];
  const originalClose = SqliteDriver.prototype.close;
  const hook = mock.method(SqliteDriver.prototype, "close", async function (this: SqliteDriver) {
    if (this.initializationOnConnect !== "none") return originalClose.call(this);
    const file = this.file;
    await originalClose.call(this);
    closed.push(file);
    throw file === sourceFile ? sourceClose : targetClose;
  });
  try {
    await assert.rejects(migrateData(source.options, target.options), error => {
      assert.match(String(error), /original-copy-failure/);
      assert.deepEqual(m1CleanupFailures(error), [targetClose, sourceClose]);
      return true;
    });
    assert.deepEqual(closed, [targetFile, sourceFile]);
  } finally { hook.mock.restore(); await source.close(); await target.close(); }
});

test("M1 目标已真实提交后source最终完成失败：保留失败，目标数据如实保持已提交", async () => {
  const source = await m1Sqlite(true), target = await m1Sqlite();
  const sourceFile = path.join(source.directory!, DATABASE_FILE_NAME);
  const original = SqliteDriver.prototype.transaction;
  const failure = new Error("source-final-completion-failed");
  const hook = mock.method(SqliteDriver.prototype, "transaction", async function <T>(this: SqliteDriver,
    fn: Parameters<SqliteDriver["transaction"]>[0]): Promise<T> {
    return original.call(this, async tx => {
      const result = await fn(tx);
      if (this.initializationOnConnect === "none" && this.file === sourceFile) throw failure;
      return result;
    }) as Promise<T>;
  });
  try {
    const before = await m1Capture(source.db);
    await assert.rejects(migrateData(source.options, target.options), error => error === failure);
    assert.deepEqual(await m1Capture(target.db), before);
    assert.deepEqual(await m1Capture(source.db), before);
  } finally { hook.mock.restore(); await source.close(); await target.close(); }
});
