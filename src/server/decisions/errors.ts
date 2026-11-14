import { RepositoryError } from '../db/errors.ts';
import type { DecisionErrorCode, DecisionRef, ReviewHeadRef } from '../../shared/decisions.ts';

export class DecisionCommandError extends RepositoryError {
  readonly reason: DecisionErrorCode;
  readonly status: number;
  readonly details: { currentRef?: DecisionRef; head?: ReviewHeadRef; missingFacts?: readonly string[] };
  constructor(reason: DecisionErrorCode, message: string, status = 409,
    details: DecisionCommandError['details'] = {}) {
    super(status === 403 ? 'invalid_argument' : status >= 500 ? 'write_failed' : 'conflict', message);
    this.reason = reason; this.status = status; this.details = details;
  }
}
