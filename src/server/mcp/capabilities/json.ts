import { createHash } from "node:crypto";
import { types } from "node:util";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export type ReadonlyJsonValue = null | boolean | number | string | readonly ReadonlyJsonValue[] | ReadonlyJsonObject;
export interface ReadonlyJsonObject { readonly [key: string]: ReadonlyJsonValue }
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** 错误只包含固定代码；不回显 URL、命令、凭据或上游正文。 */
export class CapabilityInputError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "CapabilityInputError";
    this.code = code;
  }
}

/**
 * 只接受真实 JSON 数据。禁止 JSON.stringify 静默丢掉 undefined/function，
 * 将 NaN 变为 null，或执行调用方的 getter/toJSON。
 */
export function cloneJson(input: unknown): JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  let characters = 0;
  function visit(value: unknown, depth: number): JsonValue {
    if (++nodes > 100_000 || depth > 64) throw new CapabilityInputError("json_limit_exceeded");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new CapabilityInputError("invalid_json");
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "string") {
      characters += value.length;
      if (characters > 2_000_000) throw new CapabilityInputError("json_limit_exceeded");
      return value;
    }
    if (typeof value !== "object") throw new CapabilityInputError("invalid_json");
    // Proxy 的 ownKeys/getPrototypeOf 也能执行任意调用方代码；先用无陷阱检查拒绝。
    if (types.isProxy(value)) throw new CapabilityInputError("invalid_json");
    if (ancestors.has(value)) throw new CapabilityInputError("invalid_json");
    const prototype = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new CapabilityInputError("invalid_json");
    }
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      throw new CapabilityInputError("invalid_json");
    }
    let result: JsonValue;
    if (array) {
      // JSON 数组不允许洞、附加属性或访问器；length 是唯一非枚举字段。
      if (Object.keys(descriptors).length !== value.length + 1) throw new CapabilityInputError("invalid_json");
      const items: JsonValue[] = [];
      for (let i = 0; i < value.length; i++) {
        const property = descriptors[String(i)];
        if (!property?.enumerable || !("value" in property)) throw new CapabilityInputError("invalid_json");
        items.push(visit(property.value, depth + 1));
      }
      result = items;
    } else {
      const object: JsonObject = {};
      for (const key of Object.keys(descriptors).sort()) {
        const property = descriptors[key]!;
        if (!property.enumerable || !("value" in property)) throw new CapabilityInputError("invalid_json");
        characters += key.length;
        if (characters > 2_000_000) throw new CapabilityInputError("json_limit_exceeded");
        Object.defineProperty(object, key, {
          value: visit(property.value, depth + 1), enumerable: true, writable: true, configurable: true,
        });
      }
      result = object;
    }
    ancestors.delete(value);
    return result;
  }
  return visit(input, 0);
}

/** 确定性 JSON 编码；对象按 UTF-16 key 排序，数组保留语义顺序。 */
export function canonicalJson(input: unknown): string {
  function encode(value: JsonValue): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(encode).join(",") + "]";
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + encode(value[key]!)).join(",") + "}";
  }
  return encode(cloneJson(input));
}

export function digestJson(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

// 公共返回类型自行声明深只读；此辅助函数避免反复映射递归 JSON 类型。
export function freezeData<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
  return value;
}
