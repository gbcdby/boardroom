import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { parseProfileContent, parseBindingOrdinaryContent, parseLegacyConfigSnapshotRef, parseLegacySourceValue } from "../src/server/identity/m2-config-values.ts";
import { snapshotRuntimeConfig } from "../src/server/runtime/config.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const profile = () => ({ preferredHost: null, model: null, instructions: "原说明\n", defaultRoleRef: { roleTemplateId: "role-v1", revision: 1 },
  skillSelection: [], toolSelection: [], memorySelection: [], maxConcurrentInstances: 2,
  legacyCompatibility: { tools: ["Write", "Read", "Write"], permissionMode: "auto" } });
function legacySource(kind: "requestedSnapshot" | "applied" | "effective" = "requestedSnapshot") {
  const snapshot = snapshotRuntimeConfig("codex-cli", { model: "old-model", workdir: "/old/../fixed-root", tools: ["Write", "Read"], systemPrompt: "旧来源", permissionMode: "workspace-write" },
    { runtimeRevision: 2, bindingRevision: 3 }, null);
  const rawJson = kind === "effective" ? null : JSON.stringify(snapshot, null, 2) + "\n";
  // 原 current 高级选择独立于 requested/applied；不借数值匹配重新确认。
  const rawAdvancedJson = '{ "strategy": "bypassPermissions", "runtimeRevision": 1, "bindingRevision": 1 }';
  return { ref: { authority: "legacy", kind, sourceId: "binding-old", bindingId: "binding-old", runtimeId: "runtime-old", agentId: "agent-old", digest: snapshot.digest,
    versions: { ...snapshot.versions }, configVersion: 1 }, snapshot, rawJson, rawDigest: rawJson === null ? null : digest(rawJson),
    rawAdvancedJson, rawAdvancedDigest: digest(rawAdvancedJson) };
}

test("E1 Profile 普通值保留空选择、旧 null/空/有序 tools；校验不生成引用或能力且输出与入参隔离", () => {
  const input = profile(); const output = parseProfileContent(input);
  assert.deepEqual(output, input);
  assert.equal(output.preferredHost, null); assert.equal(output.maxConcurrentInstances, 2);
  input.legacyCompatibility.tools.push("Later"); input.defaultRoleRef.revision = 3;
  assert.deepEqual(output.legacyCompatibility?.tools, ["Write", "Read", "Write"]);
  assert.equal(output.defaultRoleRef?.revision, 1);
  assert.ok(Object.isFrozen(output)); assert.ok(Object.isFrozen(output.defaultRoleRef)); assert.ok(Object.isFrozen(output.skillSelection));
  assert.throws(() => { (output.legacyCompatibility!.tools as string[]).push("New"); }, TypeError);
  for (const tools of [null, []]) assert.deepEqual(parseProfileContent({ ...profile(), legacyCompatibility: { tools, permissionMode: "manual" } }).legacyCompatibility?.tools, tools);
  assert.equal(parseProfileContent({ ...profile(), legacyCompatibility: null, defaultRoleRef: null }).legacyCompatibility, null);
  for (const patch of [{ workdir: "/not-a-profile-root" }, { authorizationEpoch: 1 }, { enabled: true }, { requested: {} },
    { toolSelection: ["preview-id"] }, { memorySelection: ["memory-id"] }, { skillSelection: ["skill-id"] },
    { defaultRoleRef: { roleTemplateId: "role", revision: Number.MAX_SAFE_INTEGER + 1 } }, { maxConcurrentInstances: 0 }]) {
    assert.throws(() => parseProfileContent({ ...profile(), ...patch }), ZodError);
  }
  assert.throws(() => parseProfileContent({ preferredHost: null }), ZodError, "不以缺省值把不完整内容升级为完整 Profile");
});

test("E1 Binding 仅普通覆盖；保留未设置与显式 null，不接收 currentAdvanced、根、宿主或新授权", () => {
  const input = { roleRef: null, profileOverrides: { model: null, instructions: "", legacyTools: [], legacyPermissionMode: "manual", toolSelection: [] } };
  const output = parseBindingOrdinaryContent(input);
  assert.deepEqual(output, input); assert.ok(!Object.hasOwn(output.profileOverrides, "skillSelection"));
  assert.deepEqual(parseBindingOrdinaryContent({ roleRef: null, profileOverrides: {} }).profileOverrides, {});
  for (const profileOverrides of [{ workdir: "/root" }, { preferredHost: "claude-code" }, { authorizationEpoch: 3 },
    { memorySelection: ["preview"] }, { legacyTools: ["Read", 1] }, { model: undefined }]) {
    assert.throws(() => parseBindingOrdinaryContent({ roleRef: null, profileOverrides }), ZodError);
  }
  for (const field of ["currentAdvanced", "mode", "enabled", "authorizationEpoch", "workdir", "preferredHost"]) {
    assert.throws(() => parseBindingOrdinaryContent({ ...input, [field]: {} }), ZodError);
  }
});

test("E1 仅解析已有 legacy 引用；拒绝错 sourceId、未知版本、非安全修订与伪造许可字段", () => {
  const input = legacySource().ref;
  const output = parseLegacyConfigSnapshotRef(input);
  assert.deepEqual(output, input); assert.notEqual(output, input); assert.ok(Object.isFrozen(output.versions));
  for (const patch of [{ authority: "profile" }, { kind: "latest" }, { sourceId: "another-binding" }, { configVersion: 2 },
    { digest: "A".repeat(64) }, { versions: { runtimeRevision: 1.5, bindingRevision: 3 } },
    { versions: { runtimeRevision: 2, bindingRevision: Number.MAX_SAFE_INTEGER + 1 } }, { activationAllowed: true }, { captureId: "new-id" }]) {
    assert.throws(() => parseLegacyConfigSnapshotRef({ ...input, ...patch }), ZodError);
  }
});

test("E1 旧三类来源只按本次完整值校验，backend/root/原修订/raw advanced 均不向 current 靠齐", () => {
  for (const kind of ["requestedSnapshot", "applied", "effective"] as const) {
    const input = legacySource(kind); const output = parseLegacySourceValue(input);
    assert.deepEqual(output, input);
    assert.equal(output.snapshot.backend, "codex-cli"); assert.equal(output.snapshot.config.workdir, "/old/../fixed-root");
    assert.deepEqual(output.ref.versions, { runtimeRevision: 2, bindingRevision: 3 });
    assert.equal(output.rawAdvancedJson, input.rawAdvancedJson);
    assert.equal(output.snapshot.advancedStrategy, null);
    assert.equal(output.rawJson, kind === "effective" ? null : input.rawJson);
    assert.ok(Object.isFrozen(output.snapshot.config)); assert.ok(Object.isFrozen(output.snapshot.config.tools));
    Object.assign(input.snapshot, { versions: { runtimeRevision: 9, bindingRevision: 9 } });
    assert.deepEqual(output.snapshot.versions, { runtimeRevision: 2, bindingRevision: 3 });
    assert.ok(!Object.hasOwn(output, "captureRef")); assert.ok(!Object.hasOwn(output, "activationAllowed"));
  }
});

test("E1 raw/semantic/修订各自核验；不靠重算摘要掩盖原字节、不接受坏高优先来源", () => {
  const input = legacySource();
  const alteredRaw = JSON.stringify({ ...input.snapshot, versions: { runtimeRevision: 99, bindingRevision: 3 } });
  const invalids = [
    { ...input, rawDigest: "0".repeat(64) },
    { ...input, rawJson: JSON.stringify(input.snapshot) },
    { ...input, rawJson: alteredRaw, rawDigest: digest(alteredRaw) },
    { ...input, rawJson: "{ broken", rawDigest: digest("{ broken") },
    { ...input, rawJson: null, rawDigest: null },
    { ...input, rawAdvancedDigest: "0".repeat(64) },
    { ...input, rawAdvancedJson: null },
    { ...input, rawAdvancedJson: "{}", rawAdvancedDigest: digest("{}") },
    { ...input, ref: { ...input.ref, versions: { runtimeRevision: 1, bindingRevision: 3 } } },
    { ...input, snapshot: { ...input.snapshot, config: { ...input.snapshot.config, workdir: "/new-current-root" } } },
    { ...input, snapshot: { ...input.snapshot, backend: "claude-code" } },
    { ...input, snapshot: { ...input.snapshot, sources: { model: "default", workdir: "default", tools: "default", systemPrompt: "default", permissionMode: "default" } } },
    { ...input, ref: { ...input.ref, digest: "0".repeat(64) } },
    { ...input, currentProfile: profile() },
    { ...input, captureRef: { captureId: "invented", sourceDigest: input.ref.digest, artifactDigest: input.ref.digest } },
    { ...input, activationAllowed: true },
    { ...input, ref: { ...input.ref, kind: "effective" } },
  ];
  for (const value of invalids) assert.throws(() => parseLegacySourceValue(value), ZodError);
  assert.equal(parseLegacySourceValue({ ...input, rawAdvancedJson: null, rawAdvancedDigest: null }).rawAdvancedJson, null);
});
