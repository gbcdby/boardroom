import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHostArguments, parseHostVersion } from "../src/server/runtime/hosts/adapters.ts";
import { createHostOutputParser, MAX_HOST_LINE_BYTES } from "../src/server/runtime/hosts/parser.ts";
import { createHostLauncher } from "../src/server/runtime/hosts/launcher.ts";
import { VERIFIED_HOST_PROFILES, type HostEvent, type HostLaunchSnapshot } from "../src/server/runtime/hosts/types.ts";

function snapshot(): HostLaunchSnapshot {
  return { bindingId: "binding-1", ownerId: "owner-1", generation: 1, revision: 1, backend: "claude-code",
    config: { workdir: "/tmp/fixture-work", permissionMode: "auto", bypass: false }, mcpSocketPath: "/tmp/fixture.sock" };
}

test("R3 launcher argv 将名字/模型/提示中的 shell 字符保留为独立数据；Auto 与无人审批显式设置", () => {
  const data = `space ' ; $(touch /tmp/NEVER)\n--dangerously-skip-permissions`;
  const args = buildHostArguments({ ...snapshot(), config: { ...snapshot().config, model: data, systemPrompt: data } });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
  assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
  assert(args.includes(`--model=${data}`));
  assert(args.includes(`--append-system-prompt=${data}`));
  assert(args.includes("--restricted"));
  assert(!args.includes("--dangerously-skip-permissions"));
  assert.throws(() => buildHostArguments({ ...snapshot(), config: { ...snapshot().config, tools: ["arbitrary-plugin"] } }), /config_invalid/);
  assert.throws(() => buildHostArguments({ ...snapshot(), config: { ...snapshot().config, bypass: true } }), /profile_unsupported/);
  assert.throws(() => buildHostArguments({ ...snapshot(), backend: "codex-cli" }), /profile_unsupported/);
});

test("R3 输出白名单不从正文读取状态/秘密；未知或回落模式不 ready", () => {
  const events: HostEvent[] = [];
  const parser = createHostOutputParser({ backend: "claude-code", version: "2.1.322", expectedPermissionMode: "auto", onEvent: e => events.push(e) });
  parser.push(`${JSON.stringify({ type: "assistant", text: "Bearer PRIVATE_CANARY", permissionMode: "auto" })}\n`);
  assert.equal(events.length, 0);
  parser.push(`${JSON.stringify({ type: "system", subtype: "init", session_id: "sid-1", permissionMode: "manual", apiKey: "PRIVATE_CANARY" })}\n`);
  assert.deepEqual(events, [{ type: "session", sessionId: "sid-1" }, { type: "permission", mode: "manual", status: "fallback" }]);
  parser.push('{"type":"system","subtype":"init"}\n');
  assert.deepEqual(events.at(-1), { type: "permission", mode: "unknown", status: "unknown" });
  parser.push('{"type":"system","subtype":"init","permissionMode":"auto"}\n');
  assert.deepEqual(events.at(-1), { type: "ready", permissionMode: "auto" });
  assert(!JSON.stringify(events).includes("PRIVATE_CANARY"));
});

test("R3 JSONL 按 bytes 有界；超长行尾不能伪装成新 ready 事件", () => {
  const events: HostEvent[] = [];
  const parser = createHostOutputParser({ backend: "claude-code", version: "fixture", expectedPermissionMode: "auto", onEvent: e => events.push(e) });
  parser.push(Buffer.alloc(MAX_HOST_LINE_BYTES + 1, 120));
  parser.push('{"type":"system","subtype":"init","permissionMode":"auto"}\n');
  parser.push('{bad json secret=PRIVATE_CANARY}\n');
  parser.push('{"type":"system","subtype":"init","permissionMode":"auto"}\n');
  parser.end(); parser.push("more");
  assert.deepEqual(events, [
    { type: "protocol_invalid", reason: "line_too_large" }, { type: "protocol_invalid", reason: "invalid_json" },
    { type: "permission", mode: "auto", status: "observed" }, { type: "ready", permissionMode: "auto" },
  ]);
});

test("R3 真实认证失败帧只取顶层枚举，success + is_error 不能抹去登录失败", () => {
  const events: HostEvent[] = [];
  const parser = createHostOutputParser({ backend: "claude-code", version: "2.1.322", expectedPermissionMode: "auto", onEvent: e => events.push(e) });
  for (const value of [
    { type: "assistant", text: "authentication_failed PRIVATE_CANARY", message: { error: "authentication_failed" } },
    { type: "user", error: "authentication_failed" },
    { type: "assistant", error: "PRIVATE_CANARY" },
    { type: "assistant", error: { code: "authentication_failed" } },
  ]) parser.push(`${JSON.stringify(value)}\n`);
  assert.deepEqual(events, [], "正文、嵌套键和未知错误不能猜成认证失败");
  // 来自无凭据、无网络出口的实际 Claude 2.1.322 探针，仅保留结构字段。
  parser.push('{"type":"system","subtype":"init","permissionMode":"auto"}\n');
  parser.push('{"type":"assistant","error":"authentication_failed"}\n');
  parser.push('{"type":"result","subtype":"success","is_error":true}\n');
  parser.end();
  assert.deepEqual(events, [
    { type: "permission", mode: "auto", status: "observed" }, { type: "ready", permissionMode: "auto" },
    { type: "failure", reason: "login_required" }, { type: "usage_unavailable" },
  ]);
  assert(!JSON.stringify(events).includes("PRIVATE_CANARY"));
});

test("R3 权限拒绝只记录操作拒绝；未知 usage 不填零，不把 session 金额当 invocation", () => {
  const events: HostEvent[] = [];
  const result = { type: "result", subtype: "success", is_error: false, num_turns: 2,
    permission_denials: [{ tool_input: "PRIVATE_CANARY" }], total_cost_usd: 12, usage: { input_tokens: 8, output_tokens: 3 } };
  const parser = createHostOutputParser({ backend: "claude-code", version: "fixture", expectedPermissionMode: "auto", onEvent: e => events.push(e) });
  parser.push(`${JSON.stringify(result)}\n`);
  assert.deepEqual(events, [{ type: "permission_denied", reason: "permission_required" }, { type: "usage_unavailable" }]);
  const verified = createHostOutputParser({ backend: "claude-code", version: "fixture", expectedPermissionMode: "auto", onEvent: e => events.push(e),
    usageSchema: { format: "claude-result-v1", evidence: "fixture-schema-only-not-host-acceptance", metrics: { inputTokens: { scope: "invocation", cumulative: true, zeroMeaningful: true } } } });
  verified.push(`${JSON.stringify(result)}\n`);
  const usage = events.filter(e => e.type === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.metric, "inputTokens");
  assert.equal(usage[0]?.value, 8);
  assert(!events.some(e => e.type === "exit"));
  assert(!JSON.stringify(events).includes("PRIVATE_CANARY"));
});

test("R3 help/版本与模拟输出不能打开生产支持；普通失败不降级 bypass", async () => {
  const profilesBefore = structuredClone(VERIFIED_HOST_PROFILES);
  assert.equal(parseHostVersion("claude-code", "2.1.322 (Claude Code)\n"), "2.1.322");
  assert.equal(parseHostVersion("codex-cli", "codex-cli 0.167.0-alpha.4"), "0.167.0-alpha.4");
  const root = await mkdtemp(path.join(tmpdir(), "br-host-"));
  try {
    const workdir = path.join(root, "work"); await mkdir(workdir);
    const launcher = createHostLauncher({ stateRoot: path.join(root, "state"), protectedPaths: [path.join(root, "control")], installations: [{ backend: "claude-code", executable: "/does-not-exist" }] });
    const input = { ...snapshot(), config: { ...snapshot().config, workdir } };
    const result = await launcher.preflight(input);
    assert.equal(result.supported, false);
    assert.equal(result.reason, "host_version_unknown");
    await assert.rejects(launcher.launch(input, { onEvent() { assert.fail("unsupported host spawned"); } }), /host_version_unknown/);
    const overlap = await launcher.preflight({ ...input, config: { ...input.config, workdir: root } });
    assert.equal(overlap.reason, "protected_path_overlap");
    const unverifiedVersion = "0.0.0-boardroom-unverified";
    assert(!VERIFIED_HOST_PROFILES.some(p => p.backend === "claude-code" && p.version === unverifiedVersion),
      "合成版本不得登记为生产支持");
    const executable = path.join(root, "version-only-cli");
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf '%s\\n' '${unverifiedVersion} (Claude Code)'\n  exit 0\nfi\nexit 99\n`, { mode: 0o700 });
    const unverified = createHostLauncher({ stateRoot: path.join(root, "state"), protectedPaths: [path.join(root, "control")],
      installations: [{ backend: "claude-code", executable }] });
    const denied = await unverified.preflight(input);
    assert.equal(denied.reason, "host_version_unsupported");
    assert.equal(denied.supported, false);
    await assert.rejects(unverified.launch(input, { onEvent() { assert.fail("unverified host spawned"); } }), /host_version_unsupported/);
    assert.deepEqual(VERIFIED_HOST_PROFILES, profilesBefore, "帮助/版本检查不能改变已验证支持表");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R3 preflight 拒绝工作目录中的预置硬链接，不等到 CLI 启动", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "br-host-hardlink-"));
  try {
    const workdir = path.join(root, "work"); await mkdir(workdir);
    const control = path.join(root, "control"); await writeFile(control, "synthetic-control");
    await link(control, path.join(workdir, "alias"));
    const launcher = createHostLauncher({ stateRoot: path.join(root, "state"), protectedPaths: [control],
      installations: [{ backend: "claude-code", executable: "/does-not-exist" }] });
    const result = await launcher.preflight({ ...snapshot(), config: { ...snapshot().config, workdir } });
    assert.equal(result.supported, false);
    assert.equal(result.reason, "workdir_unsafe");
  } finally { await rm(root, { recursive: true, force: true }); }
});
