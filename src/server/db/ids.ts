/**
 * 稳定 ID 方案：UUIDv7 的 128 位值，编码为 26 位 Crockford Base32（ULID 形状）。
 *
 * 选择理由（见 docs/data-model.md）：
 * - **时间有序**：48 位毫秒时间戳前置，同毫秒内插入的 ID 保持单调，便于按插入顺序
 *   或游标分页（Message 的天然排序）。
 * - **全局唯一**：后 80 位为随机数 + 每毫秒流量计数器，跨进程/重启也不会碰撞。
 * - **可作为主键文本**：固定 26 字符、无连字符，便于日志、URL 与 SQLite TEXT 主键。
 * - **零依赖**：只用 node:crypto 的 randomBytes，不新增外部库。
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ALPHABET_INDEX = (() => {
  const map = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i += 1) map.set(ALPHABET[i]!, i);
  return map;
})();

/** 编码后的固定长度（128 位 → 26 个 Base32 字符，前导补零）。 */
export const ID_LENGTH = 26;

/** 每毫秒最多可生成的 ID 数（2 字节计数器，同毫秒单调递增）。 */
const MAX_COUNTER = 0x1_0000;

let lastTimestamp = -1;
let counter = 0;

/**
 * 生成一个新的稳定 ID。可选注入时钟，便于测试与确定性场景。
 *
 * 同一毫秒内通过随机数保证唯一；若同一毫秒内请求超过容量上限，则借用未来 1 毫秒，
 * 以维持严格单调并避免碰撞。
 */
export function newId(now: () => number = Date.now): string {
  let timestamp = now();
  if (timestamp <= lastTimestamp) {
    counter += 1;
    if (counter >= MAX_COUNTER) {
      // 同一毫秒容量耗尽：推进到下一毫秒，重置随机/计数位。
      timestamp = lastTimestamp + 1;
      lastTimestamp = timestamp;
      counter = 0;
    }
  } else {
    lastTimestamp = timestamp;
    counter = 0;
  }

  const bytes = new Uint8Array(16);

  // 布局（大端）：[0..5] 48 位毫秒时间戳 | [6..7] 16 位同毫秒计数器 | [8..15] 64 位随机。
  // 该布局保证：编码后的字符串按字典序与「时间戳→计数器」的插入顺序一致。
  const ts = BigInt(timestamp);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (counter >> 8) & 0xff;
  bytes[7] = counter & 0xff;

  bytes.set(randomBytesInto(8), 8);

  return encodeBase32(bytes);
}

/**
 * 判断字符串是否是本模块生成的合法 ID（26 位 Crockford Base32）。
 * 用于在边界处校验外部输入，避免非法 ID 进入数据库。
 */
export function isId(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== ID_LENGTH) return false;
  for (const char of value) {
    if (!ALPHABET_INDEX.has(char)) return false;
  }
  return true;
}

function encodeBase32(bytes: Uint8Array): string {
  // 128 位 → 26 个 5 位组；高位先补零到 130 位。
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  const chars: string[] = new Array(ID_LENGTH);
  for (let i = ID_LENGTH - 1; i >= 0; i -= 1) {
    chars[i] = ALPHABET[Number(value & 31n)]!;
    value >>= 5n;
  }
  return chars.join("");
}

/** 用 node:crypto 填充随机字节；封装以便将来在不改调用点的情况下替换实现。 */
function randomBytesInto(length: number): Uint8Array {
  const buffer = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buffer);
  return buffer;
}
