import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryObjectValueError, memoryObjectRefEquals, memoryObjectRelativeKey, parseMemoryObjectRef,
  encodeMemoryObjectBody, decodeMemoryObjectBody, memoryObjectBytesEqual,
} from "../src/server/memory/object-ref.ts";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const LIMIT = 1048576;
const ref = () => ({ objectFormat: "utf8-sha256-v1" as const, storageId: "storage.A_b-c:1",
  contentSha256: EMPTY_SHA256, byteLength: 0 });

function rejects(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof MemoryObjectValueError);
    assert.equal(error.code, code);
    assert.equal(error.message, `memory_object_value:${code}`);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
}

test("BC-E01/E03 ref 保留四个数据字段，隔离输入并精确比较 storage/摘要/长度", () => {
  const input = ref();
  const output = parseMemoryObjectRef(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(input), false);
  input.storageId = "changed";
  assert.equal(output.storageId, "storage.A_b-c:1");
  assert.deepEqual(parseMemoryObjectRef(Object.assign(Object.create(null), ref())), ref());
  assert.equal(memoryObjectRefEquals(output, ref()), true);
  assert.equal(memoryObjectRefEquals(output, { ...ref(), storageId: "another" }), false);
  assert.equal(memoryObjectRefEquals(output, { ...ref(), contentSha256: "0".repeat(64) }), false);
  assert.equal(memoryObjectRefEquals(output, { ...ref(), byteLength: 1 }), false);
  assert.equal(parseMemoryObjectRef({ ...ref(), storageId: "a".repeat(128), byteLength: LIMIT }).byteLength, LIMIT);
});

test("BC-E03 ref 拒绝错格式、非法大小/摘要/标识以及非数据属性；getter 不执行", () => {
  const invalid: unknown[] = [null, undefined, [], "private body", new Date(), { ...ref(), verified: true },
    { ...ref(), objectFormat: "utf8-sha256-v2" }, { ...ref(), contentSha256: EMPTY_SHA256.toUpperCase() },
    { ...ref(), contentSha256: "0".repeat(63) }, { ...ref(), contentSha256: "g".repeat(64) },
    ...[-1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, LIMIT + 1, "0"].map(byteLength => ({ ...ref(), byteLength })),
    ...["", "../escape", " starts-space", "a/b", "a\\b", "a\n", "a\r", "a\0", "中文", "a".repeat(129), 1].map(storageId => ({ ...ref(), storageId })),
    Object.assign(Object.create({ inherited: true }), ref()),
    Object.defineProperty(ref(), "private-body", { value: "sensitive", enumerable: false }),
    Object.defineProperty(ref(), Symbol("private-body"), { value: "sensitive" }),
    Object.defineProperty(ref(), "byteLength", { value: 0, enumerable: false }),
  ];
  let reads = 0;
  invalid.push(Object.defineProperty(ref(), "storageId", { enumerable: true, get() { reads++; return "secret"; } }));
  for (const value of invalid) rejects(() => parseMemoryObjectRef(value), "invalid_ref");
  assert.equal(reads, 0);
  rejects(() => memoryObjectRefEquals(ref(), { ...ref(), extra: true }), "invalid_ref");
  rejects(() => memoryObjectRefEquals("not a ref", ref()), "invalid_ref");
});

test("BC-E05 key 只由严格 ref 中的摘要推导，不接收路径或许可字段", () => {
  assert.equal(memoryObjectRelativeKey(ref()), `objects/sha256/e3/${EMPTY_SHA256}.md`);
  assert.equal(memoryObjectRelativeKey({ ...ref(), storageId: "other" }), memoryObjectRelativeKey(ref()));
  for (const value of ["objects/sha256/../../escape", { ...ref(), path: "/tmp/body" }, { ...ref(), active: true }])
    rejects(() => memoryObjectRelativeKey(value), "invalid_ref");
});

// Fixed UTF-8/SHA256 vectors, independently checked with Python hashlib.
const BODY_VECTORS = [
  { markdown: "", hex: "", sha256: EMPTY_SHA256 },
  { markdown: "abc", hex: "616263", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  { markdown: "\ufeffA\r\n", hex: "efbbbf410d0a", sha256: "5e53d52af3601d7307afc26969b31801dd90e431e83643a42dfeba8c39de1a50" },
  { markdown: "e\u0301", hex: "65cc81", sha256: "bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6" },
  { markdown: "é", hex: "c3a9", sha256: "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c" },
  { markdown: "😀", hex: "f09f9880", sha256: "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9" },
  { markdown: "line\r\nend\n", hex: "6c696e650d0a656e640a", sha256: "e9c251fbc6b4c40e5f2171aeb82ea74ce213849a6975d9ba4b12b730afcf75e4" },
  { markdown: "\0", hex: "00", sha256: "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d" },
] as const;

test("BC-E01/E04 encode 保留空、BOM、CRLF、组合字符和 emoji 的原字节及固定 SHA256", () => {
  for (const vector of BODY_VECTORS) {
    const output = encodeMemoryObjectBody(vector.markdown, LIMIT);
    assert.equal(output.markdown, vector.markdown);
    assert.equal(Buffer.from(output.bytes).toString("hex"), vector.hex);
    assert.equal(output.byteLength, vector.hex.length / 2);
    assert.equal(output.contentSha256, vector.sha256);
    assert.deepEqual(Object.keys(output).sort(), ["byteLength", "bytes", "contentSha256", "markdown"]);
  }
  const first = encodeMemoryObjectBody("abc", LIMIT), second = encodeMemoryObjectBody("abc", LIMIT);
  first.bytes[0] = 0;
  assert.equal(Buffer.from(second.bytes).toString("hex"), "616263");
  assert.equal(second.markdown, "abc");
});

test("BC-E02 encode 的配置大小只能缩紧 1MiB 上限，按 UTF-8 bytes 检查且不截断", () => {
  assert.equal(encodeMemoryObjectBody("", 0).byteLength, 0);
  rejects(() => encodeMemoryObjectBody("a", 0), "body_limit_exceeded");
  assert.equal(encodeMemoryObjectBody("é", 2).byteLength, 2);
  rejects(() => encodeMemoryObjectBody("é", 1), "body_limit_exceeded");
  for (const markdown of ["a".repeat(LIMIT), "é".repeat(LIMIT / 2), "😀".repeat(LIMIT / 4)]) {
    const output = encodeMemoryObjectBody(markdown, LIMIT);
    assert.equal(output.byteLength, LIMIT);
    assert.equal(output.bytes.byteLength, LIMIT);
    assert.equal(output.markdown, markdown);
  }
  rejects(() => encodeMemoryObjectBody("a".repeat(LIMIT + 1), LIMIT), "body_limit_exceeded");
  rejects(() => encodeMemoryObjectBody("é".repeat(LIMIT / 2 + 1), LIMIT), "body_limit_exceeded");
  const invalidLimits: unknown[] = [-1, -0, 1.5, NaN, Infinity, LIMIT + 1, Number.MAX_SAFE_INTEGER + 1, undefined, null, "1", true];
  for (const limit of invalidLimits) rejects(() => encodeMemoryObjectBody("", limit as number), "invalid_limit");
});

test("BC-E02 encode 拒绝每个未配对 surrogate 和非字符串，不读取调用者 coercion", () => {
  for (let code = 0xd800; code <= 0xdfff; code++)
    rejects(() => encodeMemoryObjectBody(String.fromCharCode(code), LIMIT), "invalid_body");
  for (const value of ["\ud800A", "A\udfff", "\udfff\ud800", "\ud800\ud800", "\udfff\udfff"])
    rejects(() => encodeMemoryObjectBody(value, LIMIT), "invalid_body");
  let calls = 0;
  for (const value of [undefined, null, 1, {}, [], new String("abc"), { toString() { calls++; return "private body"; } }])
    rejects(() => encodeMemoryObjectBody(value, LIMIT), "invalid_body");
  assert.equal(calls, 0);
});

test("BC-E01/E04 decode 严格保留 BOM 与全部原字节，Buffer/offset view 只复制所选范围", () => {
  for (const vector of BODY_VECTORS) {
    const input = Buffer.from(vector.hex, "hex");
    const output = decodeMemoryObjectBody(input, LIMIT);
    assert.equal(output.markdown, vector.markdown);
    assert.equal(Buffer.from(output.bytes).toString("hex"), vector.hex);
    assert.equal(output.contentSha256, vector.sha256);
    assert.equal(output.byteLength, input.byteLength);
    assert.notEqual(output.bytes, input);
    assert.notEqual(output.bytes.buffer, input.buffer);
  }
  const backing = Uint8Array.from([0, 0x61, 0x62, 0x63, 0xff]);
  const input = backing.subarray(1, 4), output = decodeMemoryObjectBody(input, 3);
  input[0] = 0x7a;
  assert.equal(Buffer.from(output.bytes).toString("hex"), "616263");
  assert.equal(output.bytes.buffer.byteLength, 3);
  output.bytes[1] = 0x7a;
  assert.deepEqual([...backing], [0, 0x7a, 0x62, 0x63, 0xff]);
  assert.equal(output.markdown, "abc");
});

test("BC-E04 decode 拒绝坏 UTF-8 而不替换、截断或规范化；合法 U+FFFD 仍保留", () => {
  for (const hex of ["80", "ff", "feff", "c0af", "e08080", "eda080", "f4908080", "f888808080", "c2", "e282", "efbb", "c3ff"])
    rejects(() => decodeMemoryObjectBody(Buffer.from(hex, "hex"), LIMIT), "invalid_utf8");
  const valid = decodeMemoryObjectBody(Uint8Array.from([0xef, 0xbf, 0xbd]), 3);
  assert.equal(valid.markdown, "\ufffd");
  assert.deepEqual([...valid.bytes], [0xef, 0xbf, 0xbd]);
});

test("BC-E02/E04 decode 和 byte 比较保留硬上限，伪造 view 与 detached buffer 受控拒绝", () => {
  assert.equal(decodeMemoryObjectBody(new Uint8Array(), 0).contentSha256, EMPTY_SHA256);
  assert.equal(decodeMemoryObjectBody(new Uint8Array(LIMIT), LIMIT).byteLength, LIMIT);
  rejects(() => decodeMemoryObjectBody(Uint8Array.of(0x61), 0), "body_limit_exceeded");
  rejects(() => decodeMemoryObjectBody(new Uint8Array(LIMIT + 1), LIMIT), "body_limit_exceeded");
  rejects(() => memoryObjectBytesEqual(new Uint8Array(LIMIT + 1), new Uint8Array()), "body_limit_exceeded");
  rejects(() => memoryObjectBytesEqual(new Uint8Array(), new Uint8Array(LIMIT + 1)), "body_limit_exceeded");
  for (const limit of [-1, -0, 1.5, NaN, Infinity, LIMIT + 1])
    rejects(() => decodeMemoryObjectBody(new Uint8Array(), limit), "invalid_limit");
  const detached = Uint8Array.of(0x61);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const invalid: unknown[] = [undefined, null, "a", [0x61], new ArrayBuffer(1), new Uint16Array([0x61]),
    new Uint8ClampedArray([0x61]), new DataView(new ArrayBuffer(1)), Object.create(Uint8Array.prototype),
    new Proxy(Uint8Array.of(0x61), {}), detached];
  for (const value of invalid) {
    rejects(() => decodeMemoryObjectBody(value as Uint8Array, LIMIT), "invalid_body");
    rejects(() => memoryObjectBytesEqual(value as Uint8Array, new Uint8Array()), "invalid_body");
    rejects(() => memoryObjectBytesEqual(new Uint8Array(), value as Uint8Array), "invalid_body");
  }
});

test("BC-E04 byte 比较读取实际副本，不接受自报摘要，不调用 view 的 getter/iterator/constructor", () => {
  assert.equal(memoryObjectBytesEqual(new Uint8Array(), new Uint8Array()), true);
  assert.equal(memoryObjectBytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2)), true);
  assert.equal(memoryObjectBytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3)), false);
  assert.equal(memoryObjectBytesEqual(Uint8Array.of(1), Uint8Array.of(1, 0)), false);
  const left = Object.assign(Uint8Array.of(0x61), { contentSha256: EMPTY_SHA256 });
  const right = Object.assign(Uint8Array.of(0x62), { contentSha256: EMPTY_SHA256 });
  assert.equal(memoryObjectBytesEqual(left, right), false);
  let reads = 0;
  const input = Uint8Array.from([0x61, 0x62, 0x63]);
  for (const key of ["byteLength", "length", "constructor", Symbol.iterator])
    Object.defineProperty(input, key, { get() { reads++; throw new Error("private caller data"); } });
  const output = decodeMemoryObjectBody(input, 3);
  assert.equal(output.markdown, "abc");
  assert.equal(memoryObjectBytesEqual(input, output.bytes), true);
  assert.equal(reads, 0);
});
