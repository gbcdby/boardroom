import type { Migration } from "../migrate.ts";

/** #66/#67：去重记录、消息和唤醒判定属于同一次持久化提交。 */
export const durableMessageDispatch: Migration = {
  version: 7,
  name: "durable_message_dispatch",
  up: `
    ALTER TABLE messages ADD COLUMN client_message_id TEXT
      CHECK (client_message_id IS NULL OR length(client_message_id) > 0);
    CREATE UNIQUE INDEX ux_messages_sender_client_key
      ON messages (sender_member_id, client_message_id)
      WHERE client_message_id IS NOT NULL;
    ALTER TABLE message_deliveries ADD COLUMN wake_decision TEXT
      CHECK (wake_decision IN ('allowed', 'suppressed'));
    ALTER TABLE message_deliveries ADD COLUMN wake_suppressed_reason TEXT
      CHECK (
        CASE WHEN wake_decision = 'suppressed'
          THEN wake_suppressed_reason IS NOT NULL
            AND wake_suppressed_reason IN ('consecutive_limit', 'rate_limited')
          ELSE wake_suppressed_reason IS NULL
        END
      );
    CREATE INDEX ix_deliveries_wake_pending
      ON message_deliveries (project_id, member_id, wake_decision, status);
  `,
};
