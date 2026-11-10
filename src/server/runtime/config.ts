import { createHash } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { InvalidArgumentError } from "../db/errors.ts";
import type {
  AgentRuntime, AgentRuntimeBinding, RuntimeAdvancedStrategy, RuntimeAppliedConfig,
  RuntimeBackend, RuntimeConfig, RuntimeEffectiveConfig, RuntimeOverrides, RuntimePermissionMode,
} from "./types.ts";

export const RUNTIME_CONFIG_VERSION = 1;
export const RUNTIME_BACKENDS: readonly RuntimeBackend[] = ["claude-code", "codex-cli", "dsh"];
const CONFIG_FIELDS = ["model", "workdir", "tools", "systemPrompt", "permissionMode"] as const;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function validateRuntimeBackend(value: unknown): RuntimeBackend {
  if (typeof value !== "string" || !RUNTIME_BACKENDS.includes(value as RuntimeBackend)) {
    throw new InvalidArgumentError("runtime_backend_invalid");
  }
  return value as RuntimeBackend;
}

export function validateRuntimeName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 64) {
    throw new InvalidArgumentError("runtime_name_invalid");
  }
  return value.trim();
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidArgumentError("runtime_config_invalid");
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !CONFIG_FIELDS.includes(key as typeof CONFIG_FIELDS[number]))) {
    throw new InvalidArgumentError("runtime_config_field_unsupported");
  }
  return result;
}

export function defaultPermissionMode(backend: RuntimeBackend): RuntimePermissionMode {
  return backend === "claude-code" ? "auto" : backend === "codex-cli" ? "workspace-write" : "manual";
}

export async function validateRuntimeOverrides(backend: RuntimeBackend, input: unknown): Promise<RuntimeOverrides> {
  const value = record(input);
  const result: Partial<{ -readonly [K in keyof RuntimeConfig]: RuntimeConfig[K] }> = {};
  if (own(value, "model")) {
    if (value.model === null || value.model === "") result.model = null;
    else if (typeof value.model === "string" && value.model.trim().length <= 256 && !/[\r\n\0]/.test(value.model)) {
      result.model = value.model.trim() || null;
    } else throw new InvalidArgumentError("runtime_model_invalid");
  }
  if (own(value, "workdir")) {
    if (typeof value.workdir !== "string" || !path.isAbsolute(value.workdir) || value.workdir.includes("\0")) {
      throw new InvalidArgumentError("runtime_workdir_invalid");
    }
    try {
      const directory = await realpath(value.workdir);
      if (!(await stat(directory)).isDirectory()) throw new Error("not-directory");
      await access(directory, constants.R_OK | constants.X_OK);
      result.workdir = directory;
    } catch {
      throw new InvalidArgumentError("runtime_workdir_unavailable");
    }
  }
  if (own(value, "tools")) {
    if (value.tools === null) result.tools = null;
    else if (Array.isArray(value.tools) && value.tools.length <= 64 && value.tools.every(
      (tool) => typeof tool === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tool),
    )) result.tools = [...new Set(value.tools as string[])].sort();
    else throw new InvalidArgumentError("runtime_tools_invalid");
  }
  if (own(value, "systemPrompt")) {
    if (typeof value.systemPrompt !== "string" || value.systemPrompt.length > 16_000 || value.systemPrompt.includes("\0")) {
      throw new InvalidArgumentError("runtime_prompt_invalid");
    }
    result.systemPrompt = value.systemPrompt;
  }
  if (own(value, "permissionMode")) {
    const allowed = backend === "claude-code" ? ["auto", "manual"] : backend === "codex-cli" ? ["workspace-write"] : ["manual"];
    if (typeof value.permissionMode !== "string" || !allowed.includes(value.permissionMode)) {
      throw new InvalidArgumentError("runtime_permission_mode_invalid");
    }
    result.permissionMode = value.permissionMode as RuntimePermissionMode;
  }
  return result;
}

export async function validateRuntimeConfig(backend: RuntimeBackend, input: unknown): Promise<RuntimeConfig> {
  const overrides = await validateRuntimeOverrides(backend, input);
  if (overrides.workdir === undefined) throw new InvalidArgumentError("runtime_workdir_required");
  return {
    model: overrides.model ?? null,
    workdir: overrides.workdir,
    tools: overrides.tools ?? null,
    systemPrompt: overrides.systemPrompt ?? "",
    permissionMode: overrides.permissionMode ?? defaultPermissionMode(backend),
  };
}

export function validateAdvancedStrategy(backend: RuntimeBackend, value: unknown): RuntimeAdvancedStrategy | null {
  if (value === undefined || value === null) return null;
  if (backend === "claude-code" && value === "bypassPermissions") return value;
  throw new InvalidArgumentError("runtime_advanced_strategy_unsupported");
}

export function resolveRuntimeConfig(runtime: AgentRuntime, binding: AgentRuntimeBinding): RuntimeEffectiveConfig {
  const config: RuntimeConfig = { ...runtime.defaults, ...binding.overrides };
  const versions = { runtimeRevision: runtime.revision, bindingRevision: binding.revision };
  const advancedStrategy = binding.advanced?.runtimeRevision === versions.runtimeRevision
    && binding.advanced.bindingRevision === versions.bindingRevision ? binding.advanced.strategy : null;
  const sources = Object.fromEntries(CONFIG_FIELDS.map((key) => [key, own(binding.overrides, key) ? "override" : "default"])) as
    Record<keyof RuntimeConfig, "default" | "override">;
  return { ...snapshotRuntimeConfig(runtime.backend, config, versions, advancedStrategy), sources };
}

export function snapshotRuntimeConfig(
  backend: RuntimeBackend,
  config: RuntimeConfig,
  versions: { runtimeRevision: number; bindingRevision: number },
  advancedStrategy: RuntimeAdvancedStrategy | null,
): RuntimeAppliedConfig {
  const normalized: RuntimeConfig = {
    model: config.model, workdir: config.workdir, tools: config.tools === null ? null : [...config.tools],
    systemPrompt: config.systemPrompt, permissionMode: config.permissionMode,
  };
  const digest = createHash("sha256").update(JSON.stringify({ backend, config: normalized, advancedStrategy })).digest("hex");
  return { backend, config: normalized, versions: { ...versions }, advancedStrategy, digest };
}
