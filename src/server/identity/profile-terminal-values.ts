import { boundary } from "./internal/m2-audit-boundary.ts";
import type { AuditResult } from "./internal/m2-audit-boundary.ts";
import { profileCompletionBindingParsed, profileJournalValueParsed } from "./internal/profile-terminal-values.ts";
import type { M2ProfileJournalValue, ProfileCompletionBinding } from "./profile-terminal-contracts.ts";

/** Parse one canonical terminal value; success is neither durable closure nor live admission. */
export function parseProfileCompletionBinding(input: unknown): AuditResult<ProfileCompletionBinding> {
  return boundary(input, (value, r) => profileCompletionBindingParsed(value, input as string, r));
}

/** One original selected-bytes value, limited to the three M2 profile events. */
export function inspectM2ProfileJournalValue(input: unknown): AuditResult<M2ProfileJournalValue> {
  return boundary(input, (value, r) => profileJournalValueParsed(value, input as string, r));
}
