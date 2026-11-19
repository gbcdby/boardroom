// Private legacy P0 B family; never a full closure, provider or native success.
import { assertP0View, withP0Guard } from "./m2-p0.ts";
import type { P0Request, P0Result, P0View } from "./m2-p0.ts";
import { P0BContext } from "./m2-p0-b-context.ts";
import { checkP0Aliases, checkP0Roles } from "./m2-p0-alias-role.ts";
import { checkP0Organization } from "./m2-p0-organization.ts";
import { checkP0Chat } from "./m2-p0-chat.ts";
const B_RULES = Object.freeze(["PC1B-ID01", "PC1B-ROLE01", "PC1B-ROLE02", "PC1B-ORG01", "PC1B-CHAT01"] as const);
export function checkP0IdentityFamily(request: P0Request, inputView?: P0View): P0Result<Readonly<{
  classification: "identity-organization-chat-observation"; checkedRules: typeof B_RULES; phase: P0View["phase"]; fullSemanticClosure: "not-performed";
}>> {
  return withP0Guard(request, () => {
    const view = inputView === undefined ? request.original : inputView;
    assertP0View(request, view);
    const ctx = new P0BContext(request, view);
    checkP0Aliases(ctx);
    checkP0Roles(ctx);
    checkP0Organization(ctx);
    checkP0Chat(ctx);
    ctx.cost(8, 512);
    return Object.freeze({ classification: "identity-organization-chat-observation", checkedRules: B_RULES, phase: view.phase, fullSemanticClosure: "not-performed" });
  });
}
