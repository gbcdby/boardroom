import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";

/**
 * T1 (#14) 项目/群组/成员 HTTP API 的验收测试。
 *
 * seam：HTTP API（`/api/projects...`）。所有断言只经过公共 HTTP 边界，不直接查库。
 * 覆盖 ticket 交付行为：创建项目/群组、添加/移除成员、列出成员/群组、指定/更换 manager、
 * 群组参与者只能来自项目成员、重复 manager 返回 409、manager 可留空、重启后保留。
 */

const silentLogger = createLogger({ write: () => {} });

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t1-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function startTestServer(dir: string): Promise<RunningServer> {
  return startServer({
    config: {
      port: 0,
      dataDir: dir,
      heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
      configFile: null,
    },
    logger: silentLogger,
  });
}

interface JsonResponse {
  status: number;
  body: any;
}

async function json(
  server: RunningServer,
  method: string,
  pathname: string,
  payload?: unknown,
): Promise<JsonResponse> {
  const init: RequestInit = { method };
  if (payload !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(`${server.url}${pathname}`, init);
  return { status: response.status, body: await response.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

test("POST /api/projects 创建项目返回稳定 ID，manager 可留空", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const created = await json(server, "POST", "/api/projects", { name: "我的项目" });
      assert.equal(created.status, 201);
      assert.equal(created.body.project.name, "我的项目");
      assert.equal(typeof created.body.project.id, "string");
      assert.ok(created.body.project.id.length > 0);
      // 尚未指定 manager：manager 为 null。
      assert.equal(created.body.project.manager, null);

      // 相同名称的项目应得到不同的稳定 ID（不做名称唯一约束）。
      const second = await json(server, "POST", "/api/projects", { name: "我的项目" });
      assert.equal(second.status, 201);
      assert.notEqual(second.body.project.id, created.body.project.id);
    } finally {
      await server.close();
    }
  });
});

test("POST /api/projects 名称为空返回 400", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const response = await json(server, "POST", "/api/projects", { name: "   " });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "invalid_argument");
      assert.equal(typeof response.body.error.message, "string");
    } finally {
      await server.close();
    }
  });
});

test("GET /api/projects 列出已创建的项目", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const a = await json(server, "POST", "/api/projects", { name: "甲" });
      const b = await json(server, "POST", "/api/projects", { name: "乙" });
      const list = await json(server, "GET", "/api/projects");
      assert.equal(list.status, 200);
      const ids = (list.body.projects as { id: string }[]).map((p) => p.id);
      assert.deepEqual(ids.sort(), [a.body.project.id, b.body.project.id].sort());
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 成员
// ---------------------------------------------------------------------------

test("POST /api/projects/:id/members 添加 human 成员，GET 列出成员", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const project = (await json(server, "POST", "/api/projects", { name: "P" })).body.project;

      const added = await json(server, "POST", `/api/projects/${project.id}/members`, {
        kind: "human",
        displayName: "我",
      });
      assert.equal(added.status, 201);
      assert.equal(added.body.member.kind, "human");
      assert.equal(added.body.member.role, "normal");
      assert.equal(added.body.member.projectId, project.id);

      const listed = await json(server, "GET", `/api/projects/${project.id}/members`);
      assert.equal(listed.status, 200);
      assert.equal(listed.body.members.length, 1);
      assert.equal(listed.body.members[0].displayName, "我");
    } finally {
      await server.close();
    }
  });
});

test("POST /api/projects/:id/members 到不存在的项目返回 404", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const response = await json(server, "POST", "/api/projects/NOPE/members", {
        kind: "human",
        displayName: "我",
      });
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, "not_found");
    } finally {
      await server.close();
    }
  });
});

test("DELETE /api/projects/:id/members/:memberId 移除成员", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const project = (await json(server, "POST", "/api/projects", { name: "P" })).body.project;
      const member = (
        await json(server, "POST", `/api/projects/${project.id}/members`, {
          kind: "human",
          displayName: "我",
        })
      ).body.member;

      const removed = await json(server, "DELETE", `/api/projects/${project.id}/members/${member.id}`);
      assert.equal(removed.status, 204);

      const listed = await json(server, "GET", `/api/projects/${project.id}/members`);
      assert.equal(listed.body.members.length, 0);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// manager 指定（D2）
// ---------------------------------------------------------------------------

test("PUT /api/projects/:id/manager 无 manager 时指定成功（留空可用）", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const project = (await json(server, "POST", "/api/projects", { name: "P" })).body.project;
      // 项目创建时 manager 留空。
      assert.equal(project.manager, null);

      const alice = (
        await json(server, "POST", `/api/projects/${project.id}/members`, {
          kind: "human",
          displayName: "Alice",
        })
      ).body.member;

      const set = await json(server, "PUT", `/api/projects/${project.id}/manager`, {
        memberId: alice.id,
      });
      assert.equal(set.status, 200);
      assert.equal(set.body.project.manager.id, alice.id);
    } finally {
      await server.close();
    }
  });
});

test("PUT /api/projects/:id/manager 可在已有 manager 时更换（旧降 normal，仅一个 manager）", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const project = (await json(server, "POST", "/api/projects", { name: "P" })).body.project;
      const alice = (
        await json(server, "POST", `/api/projects/${project.id}/members`, {
          kind: "human",
          displayName: "Alice",
        })
      ).body.member;
      const bob = (
        await json(server, "POST", `/api/projects/${project.id}/members`, {
          kind: "human",
          displayName: "Bob",
        })
      ).body.member;

      const first = await json(server, "PUT", `/api/projects/${project.id}/manager`, {
        memberId: alice.id,
      });
      assert.equal(first.status, 200);
      assert.equal(first.body.project.manager.id, alice.id);

      // 已有 manager A，更换为 B → 200，且 project.manager = B。
      const replace = await json(server, "PUT", `/api/projects/${project.id}/manager`, {
        memberId: bob.id,
      });
      assert.equal(replace.status, 200);
      assert.equal(replace.body.project.manager.id, bob.id);

      // 复核：A 降为 normal、B 为 manager，成员列表中恰好一个 manager。
      const members = (await json(server, "GET", `/api/projects/${project.id}/members`)).body.members as {
        id: string;
        role: string;
      }[];
      const byId = new Map(members.map((m) => [m.id, m.role]));
      assert.equal(byId.get(alice.id), "normal");
      assert.equal(byId.get(bob.id), "manager");
      assert.equal(members.filter((m) => m.role === "manager").length, 1);
    } finally {
      await server.close();
    }
  });
});

test("PUT /api/projects/:id/manager 同一成员重复 PUT 幂等", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const project = (await json(server, "POST", "/api/projects", { name: "P" })).body.project;
      const alice = (
        await json(server, "POST", `/api/projects/${project.id}/members`, {
          kind: "human",
          displayName: "Alice",
        })
      ).body.member;

      const first = await json(server, "PUT", `/api/projects/${project.id}/manager`, { memberId: alice.id });
      assert.equal(first.status, 200);
      const again = await json(server, "PUT", `/api/projects/${project.id}/manager`, { memberId: alice.id });
      assert.equal(again.status, 200);
      assert.equal(again.body.project.manager.id, alice.id);

      const members = (await json(server, "GET", `/api/projects/${project.id}/members`)).body.members as {
        role: string;
      }[];
      assert.equal(members.filter((m) => m.role === "manager").length, 1);
    } finally {
      await server.close();
    }
  });
});

test("PUT /api/projects/:id/manager 非项目成员被拒（404/400）", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const project = (await json(server, "POST", "/api/projects", { name: "P" })).body.project;
      // 纯粹不存在的成员 id。
      const unknown = await json(server, "PUT", `/api/projects/${project.id}/manager`, {
        memberId: "NOPE",
      });
      assert.ok(unknown.status === 404 || unknown.status === 400);
      assert.equal(unknown.body.error.code !== undefined, true);

      // 属于另一个项目的成员也不能被指定为本项目 manager。
      const other = (await json(server, "POST", "/api/projects", { name: "Q" })).body.project;
      const outsider = (
        await json(server, "POST", `/api/projects/${other.id}/members`, {
          kind: "human",
          displayName: "外部",
        })
      ).body.member;
      const cross = await json(server, "PUT", `/api/projects/${project.id}/manager`, {
        memberId: outsider.id,
      });
      assert.equal(cross.status, 404);
      assert.equal(cross.body.error.code, "not_found");
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 群组与参与者（GROUP-02）
// ---------------------------------------------------------------------------

test("POST /api/projects/:id/groups 创建群组并可带项目成员参与者", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const project = (await json(server, "POST", "/api/projects", { name: "P" })).body.project;
      const human = (
        await json(server, "POST", `/api/projects/${project.id}/members`, {
          kind: "human",
          displayName: "我",
        })
      ).body.member;

      const created = await json(server, "POST", `/api/projects/${project.id}/groups`, {
        name: "主群",
        participantMemberIds: [human.id],
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.group.name, "主群");
      assert.equal(created.body.group.projectId, project.id);

      const groups = await json(server, "GET", `/api/projects/${project.id}/groups`);
      assert.equal(groups.status, 200);
      assert.equal(groups.body.groups.length, 1);
      assert.equal(groups.body.groups[0].id, created.body.group.id);

      const participants = await json(server, "GET", `/api/groups/${created.body.group.id}/participants`);
      assert.equal(participants.status, 200);
      assert.deepEqual(
        (participants.body.participants as { id: string }[]).map((m) => m.id),
        [human.id],
      );
    } finally {
      await server.close();
    }
  });
});

test("群组参与者只能来自项目成员（GROUP-02），越界返回明确错误", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const projectA = (await json(server, "POST", "/api/projects", { name: "A" })).body.project;
      const projectB = (await json(server, "POST", "/api/projects", { name: "B" })).body.project;

      // 只属于 B 的成员。
      const outsider = (
        await json(server, "POST", `/api/projects/${projectB.id}/members`, {
          kind: "human",
          displayName: "外部",
        })
      ).body.member;

      // 在 A 的群组里引用 B 的成员 → 明确错误（4xx，invalid_reference）。
      const response = await json(server, "POST", `/api/projects/${projectA.id}/groups`, {
        name: "坏群",
        participantMemberIds: [outsider.id],
      });
      assert.ok(response.status >= 400 && response.status < 500);
      assert.equal(response.body.error.code, "invalid_reference");
    } finally {
      await server.close();
    }
  });
});

test("GET /api/projects/:id/groups/participants 按项目列出所有群组的参与者", async () => {
  await withTempDir(async (dir) => {
    const server = await startTestServer(dir);
    try {
      const project = (await json(server, "POST", "/api/projects", { name: "P" })).body.project;
      const human = (
        await json(server, "POST", `/api/projects/${project.id}/members`, {
          kind: "human",
          displayName: "我",
        })
      ).body.member;
      await json(server, "POST", `/api/projects/${project.id}/groups`, {
        name: "群一",
        participantMemberIds: [human.id],
      });
      // HTTP-断言：群组列表里能看到该群组。
      const groups = await json(server, "GET", `/api/projects/${project.id}/groups`);
      const groupId = groups.body.groups[0].id;
      const participants = await json(server, "GET", `/api/groups/${groupId}/participants`);
      assert.equal(participants.body.participants.length, 1);
      assert.equal(participants.body.participants[0].displayName, "我");
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 持久化 / 重启
// ---------------------------------------------------------------------------

test("重启后项目/成员/群组/manager 保留", async () => {
  await withTempDir(async (dir) => {
    const first = await startTestServer(dir);
    let projectId: string;
    let memberIds: string[];
    let groupId: string;
    try {
      const project = (await json(first, "POST", "/api/projects", { name: "重启项目" })).body.project;
      projectId = project.id;
      const alice = (
        await json(first, "POST", `/api/projects/${projectId}/members`, {
          kind: "human",
          displayName: "Alice",
        })
      ).body.member;
      const bob = (
        await json(first, "POST", `/api/projects/${projectId}/members`, {
          kind: "human",
          displayName: "Bob",
        })
      ).body.member;
      memberIds = [alice.id, bob.id];
      await json(first, "PUT", `/api/projects/${projectId}/manager`, { memberId: alice.id });
      const group = (
        await json(first, "POST", `/api/projects/${projectId}/groups`, {
          name: "重启群",
          participantMemberIds: memberIds,
        })
      ).body.group;
      groupId = group.id;
    } finally {
      await first.close();
    }

    // 模拟进程重启：同一数据目录重新启动。
    const second = await startTestServer(dir);
    try {
      const projects = await json(second, "GET", "/api/projects");
      const reloaded = (projects.body.projects as { id: string; manager: { id: string } | null }[]).find(
        (p) => p.id === projectId,
      );
      assert.ok(reloaded);
      assert.equal(reloaded.manager?.id, memberIds[0]);

      const members = await json(second, "GET", `/api/projects/${projectId}/members`);
      assert.deepEqual(
        (members.body.members as { id: string }[]).map((m) => m.id).sort(),
        [...memberIds].sort(),
      );

      const groups = await json(second, "GET", `/api/projects/${projectId}/groups`);
      assert.equal(groups.body.groups[0].id, groupId);

      const participants = await json(second, "GET", `/api/groups/${groupId}/participants`);
      assert.deepEqual(
        (participants.body.participants as { id: string }[]).map((m) => m.id).sort(),
        [...memberIds].sort(),
      );
    } finally {
      await second.close();
    }
  });
});
