/* 私有静态表注册表来自冻结B3；包含每列，非可扩展输入。 */
export interface DecisionColumn { name:string; integer:boolean; nullable:boolean; positive?:boolean; values?:readonly string[] }
export interface DecisionTable { name:string; columns:readonly DecisionColumn[]; keyColumns:readonly string[]; uniqueKeys:readonly (readonly string[])[]; foreignKeys:readonly {columns:readonly string[];table:string;targetColumns:readonly string[]}[] }
export const DECISION_TABLES: readonly DecisionTable[] = [
  {
    "name": "decision_legacy_records",
    "columns": [
      {
        "name": "id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "round_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "source_table",
        "integer": false,
        "nullable": false,
        "values": [
          "task_history",
          "task_review_rounds"
        ]
      },
      {
        "name": "source_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "raw_text",
        "integer": false,
        "nullable": false
      },
      {
        "name": "raw_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "chain_status",
        "integer": false,
        "nullable": false,
        "values": [
          "verified",
          "projection-only",
          "ambiguous",
          "malformed"
        ]
      },
      {
        "name": "diagnostics_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "imported_at",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "id"
    ],
    "uniqueKeys": [
      [
        "id"
      ],
      [
        "project_id",
        "source_table",
        "source_id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id"
      ],
      [
        "project_id",
        "task_id",
        "id"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id"
        ],
        "table": "projects",
        "targetColumns": [
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id"
        ],
        "table": "tasks",
        "targetColumns": [
          "project_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id"
        ],
        "table": "task_review_rounds",
        "targetColumns": [
          "project_id",
          "task_id",
          "id"
        ]
      }
    ]
  },
  {
    "name": "decision_action_requests",
    "columns": [
      {
        "name": "id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "round_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "action_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "candidate_envelope_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "action_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "candidate_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "expected_task_revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "expected_round_revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "proposed_verdict",
        "integer": false,
        "nullable": false,
        "values": [
          "pass",
          "changes_requested"
        ]
      },
      {
        "name": "proposal_reason_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "requested_path",
        "integer": false,
        "nullable": false,
        "values": [
          "reviewer",
          "management",
          "materializer"
        ]
      },
      {
        "name": "origin",
        "integer": false,
        "nullable": false,
        "values": [
          "review-reports",
          "legacy-bootstrap",
          "user-request",
          "agent-request"
        ]
      },
      {
        "name": "created_by_kind",
        "integer": false,
        "nullable": false,
        "values": [
          "human",
          "agent",
          "system"
        ]
      },
      {
        "name": "created_by_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "created_at",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "id"
    ],
    "uniqueKeys": [
      [
        "id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id",
        "action_digest"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id"
        ],
        "table": "task_review_rounds",
        "targetColumns": [
          "project_id",
          "task_id",
          "id"
        ]
      }
    ]
  },
  {
    "name": "decision_records",
    "columns": [
      {
        "name": "id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "round_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "action_request_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "action_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "generation",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "status",
        "integer": false,
        "nullable": false,
        "values": [
          "pending",
          "resolved",
          "superseded",
          "cancelled",
          "expired"
        ]
      },
      {
        "name": "required_authority",
        "integer": false,
        "nullable": true,
        "values": [
          "auto",
          "owner",
          "human"
        ]
      },
      {
        "name": "assignee_member_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "blocked_reason_code",
        "integer": false,
        "nullable": true
      },
      {
        "name": "policy_evaluation_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "predecessor_decision_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "predecessor_legacy_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "created_at",
        "integer": false,
        "nullable": false
      },
      {
        "name": "updated_at",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "id"
    ],
    "uniqueKeys": [
      [
        "id"
      ],
      [
        "action_request_id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id"
      ],
      [
        "project_id",
        "id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "generation"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id",
        "generation"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id",
        "action_digest"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id"
        ],
        "table": "task_review_rounds",
        "targetColumns": [
          "project_id",
          "task_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "action_request_id",
          "action_digest"
        ],
        "table": "decision_action_requests",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id",
          "action_digest"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "predecessor_decision_id"
        ],
        "table": "decision_records",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "predecessor_legacy_id"
        ],
        "table": "decision_legacy_records",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id"
        ]
      }
    ]
  },
  {
    "name": "decision_review_heads",
    "columns": [
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "round_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "head_revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "current_decision_id",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "project_id",
      "task_id",
      "round_id"
    ],
    "uniqueKeys": [
      [
        "project_id",
        "task_id",
        "round_id"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id"
        ],
        "table": "task_review_rounds",
        "targetColumns": [
          "project_id",
          "task_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "current_decision_id",
          "head_revision"
        ],
        "table": "decision_records",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id",
          "generation"
        ]
      }
    ]
  },
  {
    "name": "decision_user_events",
    "columns": [
      {
        "name": "id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "round_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "decision_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "input_decision_revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "action_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "choice_id",
        "integer": false,
        "nullable": false,
        "values": [
          "approve",
          "reject",
          "request_changes"
        ]
      },
      {
        "name": "actor_kind",
        "integer": false,
        "nullable": false,
        "values": [
          "human",
          "agent"
        ]
      },
      {
        "name": "actor_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "request_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "command_kind",
        "integer": false,
        "nullable": false,
        "values": [
          "ui-decision-choice",
          "legacy-decide"
        ]
      },
      {
        "name": "client_mutation_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "command_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "issued_at",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "id"
    ],
    "uniqueKeys": [
      [
        "id"
      ],
      [
        "id",
        "project_id",
        "task_id",
        "round_id",
        "decision_id",
        "input_decision_revision",
        "action_digest",
        "choice_id",
        "actor_kind",
        "actor_id",
        "request_digest"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id"
      ],
      [
        "project_id",
        "actor_kind",
        "actor_id",
        "client_mutation_id"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id"
        ],
        "table": "task_review_rounds",
        "targetColumns": [
          "project_id",
          "task_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "decision_id",
          "action_digest"
        ],
        "table": "decision_records",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id",
          "action_digest"
        ]
      }
    ]
  },
  {
    "name": "decision_local_initiations",
    "columns": [
      {
        "name": "id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "round_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "decision_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "input_decision_revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "action_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "choice_id",
        "integer": false,
        "nullable": false,
        "values": [
          "approve",
          "reject",
          "request_changes"
        ]
      },
      {
        "name": "actor_kind",
        "integer": false,
        "nullable": false,
        "values": [
          "human",
          "agent"
        ]
      },
      {
        "name": "actor_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "request_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "user_event_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "nonce_hash",
        "integer": false,
        "nullable": false
      },
      {
        "name": "source_contract",
        "integer": false,
        "nullable": false,
        "values": [
          "s1.local-db-decision-choice/v1"
        ]
      },
      {
        "name": "authority_basis",
        "integer": false,
        "nullable": false,
        "values": [
          "same-transaction-current-permissions"
        ]
      },
      {
        "name": "transfer_mode",
        "integer": false,
        "nullable": false,
        "values": [
          "same-transaction-only"
        ]
      },
      {
        "name": "consumed_receipt_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "issued_at",
        "integer": false,
        "nullable": false
      },
      {
        "name": "consumed_at",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "id"
    ],
    "uniqueKeys": [
      [
        "id"
      ],
      [
        "user_event_id"
      ],
      [
        "nonce_hash"
      ],
      [
        "consumed_receipt_id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id"
      ],
      [
        "id",
        "project_id",
        "task_id",
        "round_id",
        "decision_id",
        "input_decision_revision",
        "action_digest",
        "choice_id",
        "actor_kind",
        "actor_id",
        "request_digest"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id"
        ],
        "table": "task_review_rounds",
        "targetColumns": [
          "project_id",
          "task_id",
          "id"
        ]
      },
      {
        "columns": [
          "user_event_id",
          "project_id",
          "task_id",
          "round_id",
          "decision_id",
          "input_decision_revision",
          "action_digest",
          "choice_id",
          "actor_kind",
          "actor_id",
          "request_digest"
        ],
        "table": "decision_user_events",
        "targetColumns": [
          "id",
          "project_id",
          "task_id",
          "round_id",
          "decision_id",
          "input_decision_revision",
          "action_digest",
          "choice_id",
          "actor_kind",
          "actor_id",
          "request_digest"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "consumed_receipt_id",
          "id"
        ],
        "table": "decision_command_receipts",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id",
          "initiation_id"
        ]
      }
    ]
  },
  {
    "name": "decision_resolutions",
    "columns": [
      {
        "name": "id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "round_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "decision_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "input_decision_revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "action_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "choice_id",
        "integer": false,
        "nullable": false,
        "values": [
          "approve",
          "reject",
          "request_changes"
        ]
      },
      {
        "name": "actor_kind",
        "integer": false,
        "nullable": false,
        "values": [
          "human",
          "agent"
        ]
      },
      {
        "name": "actor_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "request_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "authority",
        "integer": false,
        "nullable": false,
        "values": [
          "auto",
          "owner",
          "human"
        ]
      },
      {
        "name": "reason_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "actual_execution_path",
        "integer": false,
        "nullable": false,
        "values": [
          "reviewer",
          "management",
          "no-effect"
        ]
      },
      {
        "name": "initiation_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "command_receipt_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "policy_evaluation_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "permission_snapshot_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "permission_snapshot_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "resolved_at",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "id"
    ],
    "uniqueKeys": [
      [
        "id"
      ],
      [
        "initiation_id"
      ],
      [
        "command_receipt_id"
      ],
      [
        "decision_id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id",
        "decision_id",
        "choice_id"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id"
        ],
        "table": "task_review_rounds",
        "targetColumns": [
          "project_id",
          "task_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "decision_id",
          "action_digest"
        ],
        "table": "decision_records",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id",
          "action_digest"
        ]
      },
      {
        "columns": [
          "initiation_id",
          "project_id",
          "task_id",
          "round_id",
          "decision_id",
          "input_decision_revision",
          "action_digest",
          "choice_id",
          "actor_kind",
          "actor_id",
          "request_digest"
        ],
        "table": "decision_local_initiations",
        "targetColumns": [
          "id",
          "project_id",
          "task_id",
          "round_id",
          "decision_id",
          "input_decision_revision",
          "action_digest",
          "choice_id",
          "actor_kind",
          "actor_id",
          "request_digest"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "command_receipt_id",
          "id"
        ],
        "table": "decision_command_receipts",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id",
          "resolution_id"
        ]
      }
    ]
  },
  {
    "name": "decision_executions",
    "columns": [
      {
        "name": "id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "round_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "decision_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "resolution_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "choice_id",
        "integer": false,
        "nullable": false,
        "values": [
          "approve",
          "reject",
          "request_changes"
        ]
      },
      {
        "name": "effect_key",
        "integer": false,
        "nullable": false
      },
      {
        "name": "status",
        "integer": false,
        "nullable": false,
        "values": [
          "succeeded",
          "not_required"
        ]
      },
      {
        "name": "verdict",
        "integer": false,
        "nullable": true,
        "values": [
          "pass",
          "changes_requested"
        ]
      },
      {
        "name": "before_task_revision",
        "integer": true,
        "nullable": true,
        "positive": true
      },
      {
        "name": "before_round_revision",
        "integer": true,
        "nullable": true,
        "positive": true
      },
      {
        "name": "after_task_revision",
        "integer": true,
        "nullable": true,
        "positive": true
      },
      {
        "name": "after_round_revision",
        "integer": true,
        "nullable": true,
        "positive": true
      },
      {
        "name": "task_history_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "work_event_ids_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "committed_at",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "id"
    ],
    "uniqueKeys": [
      [
        "id"
      ],
      [
        "decision_id"
      ],
      [
        "resolution_id"
      ],
      [
        "effect_key"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id"
        ],
        "table": "task_review_rounds",
        "targetColumns": [
          "project_id",
          "task_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "resolution_id",
          "decision_id",
          "choice_id"
        ],
        "table": "decision_resolutions",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id",
          "decision_id",
          "choice_id"
        ]
      },
      {
        "columns": [
          "task_history_id"
        ],
        "table": "task_history",
        "targetColumns": [
          "id"
        ]
      }
    ]
  },
  {
    "name": "decision_command_receipts",
    "columns": [
      {
        "name": "id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "round_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "actor_kind",
        "integer": false,
        "nullable": false,
        "values": [
          "human",
          "agent"
        ]
      },
      {
        "name": "actor_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "operation",
        "integer": false,
        "nullable": false,
        "values": [
          "request-review",
          "resolve",
          "refresh",
          "legacy-decide"
        ]
      },
      {
        "name": "idempotency_key",
        "integer": false,
        "nullable": false
      },
      {
        "name": "request_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "input_decision_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "input_decision_revision",
        "integer": true,
        "nullable": true,
        "positive": true
      },
      {
        "name": "result_decision_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "result_decision_revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "result_action_digest",
        "integer": false,
        "nullable": false
      },
      {
        "name": "head_revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "result_state",
        "integer": false,
        "nullable": false,
        "values": [
          "applied",
          "pending",
          "not_required",
          "refreshed"
        ]
      },
      {
        "name": "http_status",
        "integer": true,
        "nullable": false,
        "values": []
      },
      {
        "name": "resolution_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "initiation_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "response_json",
        "integer": false,
        "nullable": false
      },
      {
        "name": "committed_at",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "id"
    ],
    "uniqueKeys": [
      [
        "id"
      ],
      [
        "initiation_id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id",
        "initiation_id"
      ],
      [
        "project_id",
        "task_id",
        "round_id",
        "id",
        "resolution_id"
      ],
      [
        "project_id",
        "actor_kind",
        "actor_id",
        "operation",
        "idempotency_key"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id"
        ],
        "table": "task_review_rounds",
        "targetColumns": [
          "project_id",
          "task_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "input_decision_id"
        ],
        "table": "decision_records",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "result_decision_id",
          "result_action_digest"
        ],
        "table": "decision_records",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id",
          "action_digest"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "resolution_id"
        ],
        "table": "decision_resolutions",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "initiation_id"
        ],
        "table": "decision_local_initiations",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id"
        ]
      }
    ]
  },
  {
    "name": "decision_review_projections",
    "columns": [
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "round_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "source_kind",
        "integer": false,
        "nullable": false,
        "values": [
          "live",
          "legacy"
        ]
      },
      {
        "name": "execution_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "legacy_id",
        "integer": false,
        "nullable": true
      },
      {
        "name": "applied_at",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "project_id",
      "task_id",
      "round_id"
    ],
    "uniqueKeys": [
      [
        "project_id",
        "task_id",
        "round_id"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id"
        ],
        "table": "task_review_rounds",
        "targetColumns": [
          "project_id",
          "task_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "execution_id"
        ],
        "table": "decision_executions",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id",
          "round_id",
          "legacy_id"
        ],
        "table": "decision_legacy_records",
        "targetColumns": [
          "project_id",
          "task_id",
          "round_id",
          "id"
        ]
      }
    ]
  },
  {
    "name": "decision_change_heads",
    "columns": [
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "revision",
        "integer": true,
        "nullable": false,
        "positive": true
      }
    ],
    "keyColumns": [
      "project_id"
    ],
    "uniqueKeys": [
      [
        "project_id"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id"
        ],
        "table": "projects",
        "targetColumns": [
          "id"
        ]
      }
    ]
  },
  {
    "name": "decision_changes",
    "columns": [
      {
        "name": "project_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "task_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "decision_id",
        "integer": false,
        "nullable": false
      },
      {
        "name": "decision_revision",
        "integer": true,
        "nullable": false,
        "positive": true
      },
      {
        "name": "kind",
        "integer": false,
        "nullable": false,
        "values": [
          "created",
          "refreshed",
          "resolved",
          "superseded",
          "cancelled",
          "expired"
        ]
      },
      {
        "name": "created_at",
        "integer": false,
        "nullable": false
      }
    ],
    "keyColumns": [
      "project_id",
      "revision"
    ],
    "uniqueKeys": [
      [
        "project_id",
        "revision"
      ]
    ],
    "foreignKeys": [
      {
        "columns": [
          "project_id"
        ],
        "table": "projects",
        "targetColumns": [
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "task_id"
        ],
        "table": "tasks",
        "targetColumns": [
          "project_id",
          "id"
        ]
      },
      {
        "columns": [
          "project_id",
          "decision_id"
        ],
        "table": "decision_records",
        "targetColumns": [
          "project_id",
          "id"
        ]
      }
    ]
  }
];
export const DECISION_TABLE_NAMES = Object.freeze(DECISION_TABLES.map(t=>t.name));
export const DECISION_TABLE_BY_NAME = new Map(DECISION_TABLES.map(t=>[t.name,t]));
