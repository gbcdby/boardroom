import { assertP0View, withP0Guard } from "./m2-p0.ts";
import type { P0Request, P0Result, P0View } from "./m2-p0.ts";
import { EContext, E_RULES } from "./m2-p0-e-context.ts";
import { checkP0Policy, checkP0Workspace } from "./m2-p0-policy-workspace.ts";
import { checkP0Mcp } from "./m2-p0-mcp.ts";
import { checkP0Runtime } from "./m2-p0-runtime.ts";
import type { RuntimeUsability } from "./m2-p0-runtime.ts";
import { checkP0RuntimeObservations } from "./m2-p0-runtime-observations.ts";

export function checkP0ConfigurationFamily(request: P0Request, inputView?: P0View): P0Result<Readonly<{
  classification: "configuration-observation"; checkedRules: typeof E_RULES; phase: P0View["phase"];
  runtimeUsability: readonly RuntimeUsability[]; fullSemanticClosure: "not-performed";
}>> {
  return withP0Guard(request, () => {
    const view = inputView === undefined ? request.original : inputView;
    assertP0View(request, view);
    const ctx = new EContext(request, view);
    checkP0Policy(ctx); checkP0Mcp(ctx); checkP0Workspace(ctx);
    const runtimeUsability = checkP0Runtime(ctx);
    checkP0RuntimeObservations(ctx);
    ctx.charge(12, 512, undefined, 1, 1);
    return Object.freeze({ classification: "configuration-observation", checkedRules: E_RULES, phase: view.phase,
      runtimeUsability, fullSemanticClosure: "not-performed" });
  });
}
