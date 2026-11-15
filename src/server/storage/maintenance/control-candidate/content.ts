import path from "node:path";
import { z } from "zod";
import { canonicalJson, parseCanonical, sha256 } from "../canonical.ts";
import { hash, ref } from "../parse-primitives.ts";
import { parseCapability, parseSourceFiles } from "../parse.ts";
import type { ArtifactRef, ControlRootIdentity, ObjectKind, SourceFilesManifest } from "../types.ts";
import { equal, requireCandidate } from "./common.ts";

const rootSchema = z.object({ path: z.string().min(1), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), hostIdentityDigest: hash }).strict();
const inputSchema = z.object({ head: ref,
  objects: z.array(z.object({ reference: ref, bytes: z.instanceof(Uint8Array) }).strict()),
  controlRoot: rootSchema, mutexIdentity: z.unknown(),
}).strict();
export type ReconstructionInput = z.infer<typeof inputSchema>;
export function parseReconstructionInput(value: unknown): ReconstructionInput {
  const parsed = inputSchema.safeParse(value); requireCandidate(parsed.success);
  const input = parsed.data;
  canonicalJson(input.controlRoot); canonicalJson(input.mutexIdentity);
  requireCandidate(input.mutexIdentity !== null && typeof input.mutexIdentity === "object" && !Array.isArray(input.mutexIdentity)
    && path.posix.isAbsolute(input.controlRoot.path) && path.posix.resolve(input.controlRoot.path) === input.controlRoot.path
    && !input.controlRoot.path.includes("\0"));
  return input;
}

const kinds = new Set<ObjectKind>(["plan", "journal", "source-files", "source-file-payload", "database-snapshot", "database-manifests", "capability", "restore-bundle", "publication", "verification", "receipt"]);
/** In-memory supplied bytes only. This class cannot read, publish, restore, select a DB head or acquire authority. */
export class CandidateContents {
  readonly root: ControlRootIdentity;
  private readonly objects = new Map<string, { reference: ArtifactRef; bytes: Buffer }>();
  constructor(input: ReconstructionInput) {
    this.root = input.controlRoot;
    for (const item of input.objects) {
      requireCandidate(!this.objects.has(item.reference.ref));
      this.objects.set(item.reference.ref, { reference: item.reference, bytes: Buffer.from(item.bytes) });
    }
  }
  kind(reference: ArtifactRef): ObjectKind {
    requireCandidate(ref.safeParse(reference).success);
    if (reference.ref === `plans/${reference.sha256}.json`) return "plan";
    if (new RegExp(`^journals/[A-Za-z0-9_-]{1,100}/[1-9][0-9]*-${reference.sha256}\\.json$`).test(reference.ref)) return "journal";
    const match = /^snapshots\/([a-f0-9]{64})\/([a-z-]+)\.(json|bin)$/.exec(reference.ref);
    requireCandidate(match && match[1] === reference.sha256 && kinds.has(match[2] as ObjectKind) && !["plan", "journal"].includes(match[2]!));
    requireCandidate(match[3] === (["database-snapshot", "source-file-payload"].includes(match[2]!) ? "bin" : "json"));
    return match[2] as ObjectKind;
  }
  bytes(reference: ArtifactRef, kind: ObjectKind): Buffer {
    requireCandidate(this.kind(reference) === kind);
    const object = this.objects.get(reference.ref);
    requireCandidate(object && equal(object.reference, reference) && String(object.bytes.length) === reference.bytes && sha256(object.bytes) === reference.sha256);
    return object.bytes;
  }
  json(reference: ArtifactRef, kind: ObjectKind): unknown {
    requireCandidate(kind !== "database-snapshot" && kind !== "source-file-payload");
    const bytes = this.bytes(reference, kind), value = parseCanonical(bytes);
    requireCandidate(Buffer.from(canonicalJson(value)).equals(bytes));
    return value;
  }
  capability(reference: ArtifactRef): void {
    requireCandidate(equal(parseCapability(this.json(reference, "capability")).rootIdentity, this.root));
  }
  sourceFiles(reference: ArtifactRef): SourceFilesManifest {
    const files = parseSourceFiles(this.json(reference, "source-files"));
    for (const root of files.roots) requireCandidate(root.path !== this.root.path && !root.path.startsWith(`${this.root.path}/`) && !this.root.path.startsWith(`${root.path}/`));
    for (const entry of files.entries) if (entry.payload !== null) this.bytes(entry.payload, "source-file-payload");
    return files;
  }
}
