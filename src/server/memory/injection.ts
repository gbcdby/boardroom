import type { MemoryConfig, MemoryDocument, MemoryInjection, MemoryInjectionEntry } from "../../shared/memory.ts";
import { MemoryError } from "./errors.ts";

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

export function assertMemoryMarkdown(value: unknown, maxBytes: number): number {
  if (typeof value !== "string") throw new MemoryError("memory_invalid_input", "记忆正文必须是 Markdown 文本。");
  if (/[\uD800-\uDFFF]/u.test(value)) throw new MemoryError("memory_invalid_unicode", "记忆正文包含无效 Unicode 字符。");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) throw new MemoryError("memory_too_large", `记忆正文不能超过 ${maxBytes} 个 UTF-8 字节。`);
  return bytes;
}

/** 返回原字符串的 grapheme 前缀；绝不规范化或替换存储正文。 */
export function truncateGraphemes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = 0; let bytes = 0;
  for (const part of segmenter.segment(value)) {
    const size = Buffer.byteLength(part.segment, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size; end = part.index + part.segment.length;
  }
  return value.slice(0, end);
}

export function unavailableMemory(config: Pick<MemoryConfig, "maxInjectedBytes">, code: string): MemoryInjection {
  return { state: "unavailable", entries: [], maxBytes: config.maxInjectedBytes,
    errors: [{ scope: "global", code }, { scope: "project-agent", code }] };
}

export function buildMemoryInjection(documents: readonly Pick<MemoryDocument, "id" | "key" | "version" | "markdown">[], config: MemoryConfig): MemoryInjection {
  const selected = ["global", "project-agent"].flatMap(scope => documents.filter(doc => doc.key.scope === scope).slice(0, 1));
  const allocations = selected.map(() => selected.length < 2 ? config.maxInjectedBytes : Math.floor(config.maxInjectedBytes / 2));
  const texts = selected.map((doc, i) => {
    assertMemoryMarkdown(doc.markdown, config.maxDocumentBytes);
    return truncateGraphemes(doc.markdown, allocations[i]!);
  });
  let free = config.maxInjectedBytes - texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  for (let i = 0; i < selected.length && free > 0; i++) {
    const oldSize = Buffer.byteLength(texts[i]!);
    texts[i] = truncateGraphemes(selected[i]!.markdown, oldSize + free);
    free -= Buffer.byteLength(texts[i]!) - oldSize;
  }
  const entries: MemoryInjectionEntry[] = selected.map((doc, i) => ({
    scope: doc.key.scope as MemoryInjectionEntry["scope"], documentId: doc.id, version: doc.version,
    markdown: texts[i]!, sourceBytes: Buffer.byteLength(doc.markdown), injectedBytes: Buffer.byteLength(texts[i]!), truncated: texts[i] !== doc.markdown,
  }));
  return { state: entries.some(entry => entry.truncated) ? "partial" : "available", entries, maxBytes: config.maxInjectedBytes, errors: [] };
}
