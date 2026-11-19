import { canonicalP0, chargeP0, failP0, withP0Guard } from './m2-p0.ts';
import type { P0Request, P0Result, P0View } from './m2-p0.ts';
import type { P0CompletionIndex } from './m2-p0-completion.ts';
import { P0DContext } from './m2-p0-d-context.ts';
import { checkP0Audits } from './m2-p0-audit.ts';
import type { P0DAvailability } from './m2-p0-audit.ts';
import { checkP0Memory } from './m2-p0-memory.ts';

export const P0_D_RULES = Object.freeze(['PC1B-AUD01', 'PC1B-AUD02', 'PC1B-AUD03',
  'PC1B-MEM01', 'PC1B-MEM02', 'PC1B-MEM03', 'PC1B-MEM04', 'PC1B-MEM05'] as const);
export interface P0AuditMemoryObservation {
  readonly classification: 'audit-memory-observation';
  readonly phase: 'original-graph' | 'retained-graph';
  readonly rules: typeof P0_D_RULES;
  readonly fullSemanticClosure: 'not-performed';
  readonly availability: readonly P0DAvailability[];
}

export function checkP0AuditMemory(request: P0Request, completion: P0CompletionIndex, selectedView?: P0View): P0Result<P0AuditMemoryObservation> {
  return withP0Guard(request, () => {
    const context = new P0DContext(request, selectedView ?? request.original);
    const availability: P0DAvailability[] = [];
    checkP0Audits(context, availability);
    checkP0Memory(context, completion, availability);
    const result: P0AuditMemoryObservation = Object.freeze({ classification: 'audit-memory-observation', phase: context.view.phase,
      rules: P0_D_RULES, fullSemanticClosure: 'not-performed', availability: Object.freeze(availability) });
    const encoded = canonicalP0(request, result);
    chargeP0(request, { bytes: encoded.length * 2 });
    if (Buffer.byteLength(encoded, 'utf8') > 1_048_576) failP0(request, { code: 'resource_limit', rule: null });
    return result;
  });
}
