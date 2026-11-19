import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../policy/canonical.ts";
import { composePolicyRules } from "../../policy/rules.ts";
import { policyDocumentsSchema, policyInputErrorCode } from "../../policy/schemas.ts";
import type { GlobalPolicyDocument, ProjectPolicyDocument, PolicyRule } from "../../../shared/policy.ts";
import type { P0Row } from "./m2-p0.ts";
import { EContext, digestValue, objectValue, safeUnits } from "./m2-p0-e-context.ts";

const POL = "PC1B-POL01", WS = "PC1B-WS01";
type Document = GlobalPolicyDocument | ProjectPolicyDocument;

function compose(ctx: EContext, global: GlobalPolicyDocument, project: ProjectPolicyDocument | undefined, row: P0Row): void {
  const site = ctx.site(row, POL);
  // Two new input wrappers below borrow the document trees; reserve their
  // object/key nodes before either object literal is constructed.
  ctx.charge(2, 0, site, 2 * (project ? 3 : 2), 2);
  // schema cloning and all normalized object copies; original consumer sorts
  // rules, selector arrays, and JSON-encoded subjects, with bounded inputs.
  const inputCost = ctx.reserve(project ? { global, project } : { global }, site, 3, 0, 8);
  const arrays = [global.rules, project?.rules ?? [], project?.overrides ?? []];
  const count = global.rules.length + (project?.rules.length ?? 0);
  // Besides its schema clones, compose creates normalized rule/when/selector
  // trees (bounded by one complete input tree), an effective wrapper (3 nodes),
  // source metadata (at most 11), and up to three spread helper objects (6)
  // per emitted rule. Its final return wrapper plus rules array adds 9 nodes.
  // Keep the old clone/byte reservations; this separately covers new shapes.
  const derivedNodes = inputCost.nodes + count * 20 + 9;
  ctx.charge(derivedNodes, 0, site, derivedNodes, derivedNodes);
  ctx.charge(count * count + 1, count * count * 202, site, 0, count);
  for (const rules of arrays) for (const rule of rules as readonly PolicyRule[]) {
    const when = rule.when;
    for (const values of [when.actionKinds, when.projectIds]) if (values) {
      ctx.charge(values.length * values.length, values.length * values.length * 1200, site, 0, values.length * 2);
    }
    if (when.subjects) {
      const n = when.subjects.length;
      // subjectKey is called both while mapping and inside the sort comparator.
      ctx.charge(n * n * 4 + n, (2 * n * n + n) * 4096, site, 0, n * 2);
    }
  }
  try { composePolicyRules(project ? { global, project } : { global }); }
  catch (error) {
    if (policyInputErrorCode(error) === "policy_input_invalid") ctx.fail(row, POL, "negative-invariant");
    throw error;
  }
}

export function checkP0Policy(ctx: EContext): void {
  const heads = ctx.index("policy_documents", ["scope_key"], POL);
  const versions = ctx.index("policy_document_versions", ["document_id", ["revision", "integer"]], POL);
  const projects = ctx.index("projects", ["id"], POL);
  ctx.charge(1, 0, undefined, 0, 1); const documents = new Map<P0Row, Document>();
  for (const head of ctx.rows("policy_documents")) {
    const scope = ctx.oneOf(head, "scope", POL, ["user", "project"]), key = ctx.text(head, "scope_key", POL);
    const project = ctx.nullableText(head, "project_id", POL);
    if (scope === "user") { ctx.equal(project, null, head, POL, "project_id"); ctx.equal(key, "user", head, POL, "scope_key"); }
    else {
      if (project === null) ctx.fail(head, POL, "scope-mismatch", "project_id");
      ctx.charge(1, project.length * 3 + 8, ctx.site(head, POL));
      ctx.equal(key, `project:${project}`, head, POL, "scope_key"); ctx.target(projects, [project], head, POL, "project_id");
    }
    ctx.integer(head, "revision", POL, 1); ctx.text(head, "created_at", POL); ctx.text(head, "updated_at", POL);
  }
  for (const row of ctx.rows("policy_document_versions")) {
    const key = ctx.text(row, "document_id", POL), revision = ctx.integer(row, "revision", POL, 1);
    const head = ctx.target(heads, [key], row, POL, "document_id"), scope = ctx.text(head, "scope", POL);
    const input = ctx.json(row, "document_json", POL), raw = ctx.text(row, "document_json", POL), site = ctx.site(row, POL, "document_json");
    const document: Document = scope === "user" ? ctx.schema(policyDocumentsSchema.shape.global, input, row, POL, "document_json")
      : ctx.schema(policyDocumentsSchema.shape.project.unwrap(), input, row, POL, "document_json");
    ctx.equal(document.scope, scope, row, POL, "document_json", "scope-mismatch", head);
    ctx.equal(document.revision, revision, row, POL, "revision");
    ctx.equal(document.schemaVersion, ctx.integer(row, "schema_version", POL, 1), row, POL, "schema_version");
    ctx.equal(document.scope === "project" ? document.projectId : null, ctx.nullableText(head, "project_id", POL), row, POL, "document_json", "scope-mismatch", head);
    const cost = ctx.reserve(document, site, 0, 1);
    const encoded = canonicalJson(document); ctx.equal(encoded, raw, row, POL, "document_json", "bytes-mismatch");
    ctx.charge(2, cost.encoded * 2 + 64, site);
    const digest = createHash("sha256").update("boardroom.policy-document.v1\n").update(encoded).digest("hex");
    ctx.equal(digest, ctx.text(row, "content_digest", POL), row, POL, "content_digest", "bytes-mismatch");
    const basedOn = ctx.nullableInteger(row, "based_on_global_revision", POL, 1);
    if (basedOn !== null) ctx.target(versions, ["user", basedOn], row, POL, "based_on_global_revision");
    ctx.integer(row, "default_revision", POL, 1); ctx.oneOf(row, "created_by_kind", POL, ["human", "system"]);
    ctx.text(row, "created_by_id", POL); ctx.text(row, "created_at", POL);
    ctx.charge(1, 0, site, 0, 1); documents.set(row, document);
  }
  const globalHead = heads.get(["user"]);
  const currentGlobal = globalHead ? documents.get(ctx.target(versions, ["user", ctx.integer(globalHead, "revision", POL, 1)], globalHead, POL, "revision")) : undefined;
  if (currentGlobal) {
    if (currentGlobal.scope !== "user") ctx.fail(globalHead!, POL, "scope-mismatch");
    compose(ctx, currentGlobal, undefined, globalHead!);
  }
  for (const head of ctx.rows("policy_documents")) {
    const key = ctx.text(head, "scope_key", POL), revision = ctx.integer(head, "revision", POL, 1);
    const row = ctx.target(versions, [key, revision], head, POL, "revision");
    const document = documents.get(row)!;
    if (document.scope === "project") {
      if (!currentGlobal || currentGlobal.scope !== "user") ctx.fail(head, POL, "missing-target");
      compose(ctx, currentGlobal, document, head);
    }
  }
}

const decimal = z.string().regex(/^[0-9]+$/);
const rootIdentity = z.object({ device: decimal, inode: decimal, birthtimeNs: decimal }).strict();
const repositoryInfo = z.object({ kind: z.enum(["git", "not_git", "unavailable"]), topLevel: z.string().nullable(), head: z.string().nullable(),
  dirty: z.boolean().nullable(), trackedChangedCount: safeUnits.nullable(), untrackedCount: safeUnits.nullable(), indexChanged: z.boolean().nullable(),
  complete: z.boolean(), comparison: z.literal("raw_bytes_no_filters"), reason: z.string().nullable() }).strict();

export function checkP0Workspace(ctx: EContext): void {
  const projects = ctx.index("projects", ["id"], WS), versions = ctx.index("project_workspace_versions", ["project_id", ["workspace_revision", "integer"]], WS);
  for (const row of ctx.rows("project_workspace_versions")) {
    const project = ctx.target(projects, [ctx.text(row, "project_id", WS)], row, WS, "project_id");
    ctx.integer(row, "workspace_revision", WS, 1);
    if (ctx.integer(row, "project_revision", WS, 1) > ctx.integer(project, "project_revision", WS, 1)) ctx.fail(row, WS, "state-mismatch", "project_revision");
    ctx.oneOf(row, "mode", WS, ["isolated", "serialized"]);
    const raw = ctx.nullableText(row, "root_path", WS), canonical = ctx.nullableText(row, "canonical_root", WS), key = ctx.nullableText(row, "physical_resource_key", WS);
    const identity = ctx.json(row, "root_identity_json", WS), repository = ctx.json(row, "repository_info_json", WS);
    if (identity !== null) ctx.schema(rootIdentity, identity, row, WS, "root_identity_json");
    if (repository !== null) ctx.schema(repositoryInfo, repository, row, WS, "repository_info_json");
    if (raw === null) {
      if (canonical !== null || key !== null || identity !== null || repository !== null) ctx.fail(row, WS, "state-mismatch", "root_path");
    } else if (canonical === null || key === null || !objectValue(identity)) ctx.fail(row, WS, "state-mismatch", "root_identity_json");
    // The raw and canonical paths need not equal. No filesystem/provider work or runReady assertion.
    ctx.text(row, "observed_at", WS); ctx.text(row, "updated_at", WS); ctx.text(row, "mutation_id", WS);
    ctx.schema(digestValue, ctx.text(row, "input_digest", WS), row, WS, "input_digest");
  }
  for (const row of ctx.rows("projects")) {
    ctx.integer(row, "project_revision", WS, 1); const revision = ctx.integer(row, "workspace_revision", WS);
    if (revision > 0) ctx.target(versions, [ctx.text(row, "id", WS), revision], row, WS, "workspace_revision");
  }
}
