import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, probeReadWrite, DatabaseSetupError } from "../src/server/db/database.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-db-"));
  try {
    return await fn(dir);
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

test("数据目录不存在时自动创建，并创建数据库文件", async () => {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, "nested", "data");

    const { db, file } = openDatabase(dataDir);
    try {
      assert.equal(file, path.join(dataDir, "agent-studio.db"));
      assert.equal((await stat(file)).isFile(), true);
      // WAL 模式会在同目录生成 -wal/-shm 边车文件。
      const entries = (await readdir(dataDir)).sort();
      assert.deepEqual(
        entries.filter((name) => !name.startsWith("agent-studio.db-")),
        ["agent-studio.db"],
      );
    } finally {
      db.close();
    }
  });
});

test("数据库启用 WAL，允许读写并发", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      const [{ journal_mode: mode }] = db.pragma("journal_mode") as [{ journal_mode: string }];
      assert.equal(mode, "wal");
      const [{ foreign_keys: fk }] = db.pragma("foreign_keys") as [{ foreign_keys: number }];
      assert.equal(fk, 1);
    } finally {
      db.close();
    }
  });
});

test("可写数据库的读写探测通过", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      assert.doesNotThrow(() => probeReadWrite(db));
      // 探测不应留下事务或临时表。
      assert.equal(db.inTransaction, false);
    } finally {
      db.close();
    }
  });
});

test("数据目录不可写时给出明确错误和恢复路径", async () => {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, "readonly");
    await openDatabase(dataDir).db.close();
    await chmod(dataDir, 0o500);

    try {
      assert.throws(() => openDatabase(dataDir), (error: unknown) => {
        assert.equal(error instanceof DatabaseSetupError, true);
        const message = (error as Error).message;
        assert.match(message, /数据目录/);
        assert.match(message, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(message, /AGENT_STUDIO_DATA_DIR|权限/);
        return true;
      });
    } finally {
      await chmod(dataDir, 0o700);
    }
  });
});

test("数据目录被同名文件占用时给出明确错误", async () => {
  await withTempDir(async (dir) => {
    const { writeFile } = await import("node:fs/promises");
    const dataDir = path.join(dir, "occupied");
    await writeFile(dataDir, "not a directory");

    assert.throws(() => openDatabase(dataDir), (error: unknown) => {
      assert.equal(error instanceof DatabaseSetupError, true);
      assert.match((error as Error).message, /数据目录/);
      return true;
    });
  });
});
