/** Generated raw storage Row shapes. No decoded JSON strings or authority are implied. */
export interface DecisionLegacyRecordsRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly round_id: string | null;
  readonly source_table: string;
  readonly source_id: string;
  readonly raw_text: string;
  readonly raw_digest: string;
  readonly chain_status: string;
  readonly diagnostics_json: string;
  readonly imported_at: string;
}
export interface DecisionActionRequestsRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly round_id: string;
  readonly action_json: string;
  readonly candidate_envelope_json: string;
  readonly action_digest: string;
  readonly candidate_digest: string;
  readonly expected_task_revision: number | string;
  readonly expected_round_revision: number | string;
  readonly proposed_verdict: string;
  readonly proposal_reason_json: string;
  readonly requested_path: string;
  readonly origin: string;
  readonly created_by_kind: string;
  readonly created_by_id: string;
  readonly created_at: string;
}
export interface DecisionRecordsRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly round_id: string;
  readonly action_request_id: string;
  readonly action_digest: string;
  readonly generation: number | string;
  readonly revision: number | string;
  readonly status: string;
  readonly required_authority: string | null;
  readonly assignee_member_id: string | null;
  readonly blocked_reason_code: string | null;
  readonly policy_evaluation_json: string;
  readonly predecessor_decision_id: string | null;
  readonly predecessor_legacy_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
export interface DecisionReviewHeadsRow {
  readonly project_id: string;
  readonly task_id: string;
  readonly round_id: string;
  readonly head_revision: number | string;
  readonly current_decision_id: string;
}
export interface DecisionUserEventsRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly round_id: string;
  readonly decision_id: string;
  readonly input_decision_revision: number | string;
  readonly action_digest: string;
  readonly choice_id: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly request_digest: string;
  readonly command_kind: string;
  readonly client_mutation_id: string;
  readonly command_json: string;
  readonly issued_at: string;
}
export interface DecisionLocalInitiationsRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly round_id: string;
  readonly decision_id: string;
  readonly input_decision_revision: number | string;
  readonly action_digest: string;
  readonly choice_id: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly request_digest: string;
  readonly user_event_id: string;
  readonly nonce_hash: string;
  readonly source_contract: string;
  readonly authority_basis: string;
  readonly transfer_mode: string;
  readonly consumed_receipt_id: string;
  readonly issued_at: string;
  readonly consumed_at: string;
}
export interface DecisionResolutionsRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly round_id: string;
  readonly decision_id: string;
  readonly input_decision_revision: number | string;
  readonly action_digest: string;
  readonly choice_id: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly request_digest: string;
  readonly authority: string;
  readonly reason_json: string;
  readonly actual_execution_path: string;
  readonly initiation_id: string | null;
  readonly command_receipt_id: string;
  readonly policy_evaluation_json: string;
  readonly permission_snapshot_json: string;
  readonly permission_snapshot_digest: string;
  readonly resolved_at: string;
}
export interface DecisionExecutionsRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly round_id: string;
  readonly decision_id: string;
  readonly resolution_id: string;
  readonly choice_id: string;
  readonly effect_key: string;
  readonly status: string;
  readonly verdict: string | null;
  readonly before_task_revision: number | string | null;
  readonly before_round_revision: number | string | null;
  readonly after_task_revision: number | string | null;
  readonly after_round_revision: number | string | null;
  readonly task_history_id: string | null;
  readonly work_event_ids_json: string;
  readonly committed_at: string;
}
export interface DecisionCommandReceiptsRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly round_id: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly operation: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly input_decision_id: string | null;
  readonly input_decision_revision: number | string | null;
  readonly result_decision_id: string;
  readonly result_decision_revision: number | string;
  readonly result_action_digest: string;
  readonly head_revision: number | string;
  readonly result_state: string;
  readonly http_status: number | string;
  readonly resolution_id: string | null;
  readonly initiation_id: string | null;
  readonly response_json: string;
  readonly committed_at: string;
}
export interface DecisionReviewProjectionsRow {
  readonly project_id: string;
  readonly task_id: string;
  readonly round_id: string;
  readonly source_kind: string;
  readonly execution_id: string | null;
  readonly legacy_id: string | null;
  readonly applied_at: string;
}
export interface DecisionChangeHeadsRow {
  readonly project_id: string;
  readonly revision: number | string;
}
export interface DecisionChangesRow {
  readonly project_id: string;
  readonly revision: number | string;
  readonly task_id: string;
  readonly decision_id: string;
  readonly decision_revision: number | string;
  readonly kind: string;
  readonly created_at: string;
}
