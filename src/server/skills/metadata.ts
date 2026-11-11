import { isAlias, isNode, parseAllDocuments, visit } from "yaml";
import { z } from "zod";
import type { SkillDependency, SkillInvocationMode, SkillResource } from "../../shared/skills.ts";
import { relativePath, uniqueSorted } from "./common.ts";

const name = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const exactPinSchema = z.union([z.object({ contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ versionId: z.string().min(1).max(256) }).strict()]);
const dependencyList = z.array(z.object({ skillName: name, pin: exactPinSchema }).strict()).max(256);
const resourceList = z.array(z.object({ path: z.string().refine(relativePath), required: z.boolean().default(true) }).strict()).max(2048);
const extension = z.object({ invocationMode: z.enum(["user-only", "implicit-or-explicit"]).optional(),
  dependencies: dependencyList.default([]), resources: resourceList.default([]) }).strict();
const skillMetadata = z.object({ name, description: z.string().min(1), version: z.string().optional(),
  "disable-model-invocation": z.boolean().optional(), dependencies: dependencyList.optional(), resources: resourceList.optional(), boardroom: extension.optional() }).passthrough();

/** 仅 YAML 1.2 core 数据；拒绝别名、标签、重复键与多文档，绝不求值或调用包代码。 */
export function parseMetadataYaml(raw: string): unknown {
  const docs = parseAllDocuments(raw, { version: "1.2", schema: "core", uniqueKeys: true });
  if (docs.length !== 1 || docs[0]!.errors.length || docs[0]!.warnings.length) throw new Error("YAML 必须是单文档且无语法错误/未知标签");
  const doc = docs[0]!;
  if (doc.directives?.yaml.version !== "1.2") throw new Error("仅支持 YAML 1.2");
  visit(doc, (_key, node) => {
    if (isAlias(node) || (isNode(node) && (node.tag || ("anchor" in node && node.anchor)))) throw new Error("YAML 不支持标签、锚点或别名");
  });
  return doc.toJS({ maxAliasCount: 0 });
}
export function readSkillMetadata(skill: Buffer, openai: Buffer | undefined, manifestInvocation?: string): {
  skillName: string; description: string; declaredVersion: string | null; invocationMode: SkillInvocationMode;
  invocationEvidence: string[]; dependencies: SkillDependency[]; resources: SkillResource[];
} {
  const decoder = new TextDecoder("utf-8", { fatal: true }), text = decoder.decode(skill);
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") throw new Error("缺少 SKILL.md YAML frontmatter");
  const closing = lines.indexOf("---", 1);
  if (closing < 1) throw new Error("SKILL.md frontmatter 未闭合");
  const header = lines.slice(1, closing).join("\n");
  if (Buffer.byteLength(header) > 64 * 1024) throw new Error("SKILL frontmatter 超过 64 KiB");
  const meta = skillMetadata.parse(parseMetadataYaml(header));
  const modes: { mode: SkillInvocationMode; evidence: string }[] = [];
  if (meta["disable-model-invocation"] !== undefined) modes.push({ mode: meta["disable-model-invocation"] ? "user-only" : "implicit-or-explicit", evidence: "SKILL.md:disable-model-invocation" });
  if (meta.boardroom?.invocationMode) modes.push({ mode: meta.boardroom.invocationMode, evidence: "SKILL.md:boardroom.invocationMode" });
  if (openai) {
    const value = z.object({ policy: z.object({ allow_implicit_invocation: z.boolean().optional() }).passthrough().optional() }).passthrough()
      .parse(parseMetadataYaml(decoder.decode(openai)));
    if (value.policy?.allow_implicit_invocation !== undefined) modes.push({ mode: value.policy.allow_implicit_invocation ? "implicit-or-explicit" : "user-only", evidence: "agents/openai.yaml:policy.allow_implicit_invocation" });
  }
  if (manifestInvocation) modes.push({ mode: manifestInvocation === "explicit-user" ? "user-only" : "implicit-or-explicit", evidence: "work-suite/v1:invocation" });
  return { skillName: meta.name, description: meta.description, declaredVersion: meta.version ?? null,
    invocationMode: modes.some(item => item.mode === "user-only") ? "user-only" : modes.length ? "implicit-or-explicit" : "unknown",
    invocationEvidence: modes.map(item => item.evidence).sort(),
    dependencies: uniqueSorted([...(meta.dependencies ?? []), ...(meta.boardroom?.dependencies ?? [])]),
    resources: uniqueSorted([...(meta.resources ?? []), ...(meta.boardroom?.resources ?? [])]) };
}
