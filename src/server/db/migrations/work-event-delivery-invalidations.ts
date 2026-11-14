import type { Migration } from '../migrate.ts';

// #122 sole allocation: comment 6818993401; #157 WorkEvent lifecycle D1.
// Original event facts and the v1–20 migration/checksum catalog stay unchanged.
const table = `
CREATE TABLE work_event_delivery_invalidations (
  work_event_id TEXT PRIMARY KEY NOT NULL REFERENCES work_events(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  cause_member_id TEXT NOT NULL REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  cause_from_revision BIGINT NOT NULL CHECK (cause_from_revision BETWEEN 1 AND 9007199254740990),
  cause_to_revision BIGINT NOT NULL CHECK (cause_to_revision = cause_from_revision + 1 AND cause_to_revision <= 9007199254740991),
  cause_action TEXT NOT NULL CHECK (cause_action IN ('removed','restored')),
  cause_audit_id TEXT NOT NULL REFERENCES audit_log(id) DEFERRABLE INITIALLY DEFERRED,
  invalidated_at TEXT NOT NULL
);
CREATE INDEX ix_work_event_invalidation_project ON work_event_delivery_invalidations(project_id);
CREATE INDEX ix_work_event_invalidation_cause ON work_event_delivery_invalidations(cause_audit_id);
`;
export const workEventDeliveryInvalidationsMigration: Migration = {
  version: 21, name: 'work_event_delivery_invalidations',
  up: table + `
CREATE TRIGGER work_event_invalidation_integer_guard BEFORE INSERT ON work_event_delivery_invalidations
WHEN typeof(NEW.cause_from_revision) <> 'integer' OR typeof(NEW.cause_to_revision) <> 'integer'
BEGIN SELECT RAISE(ABORT, 'work_event_invalidation_integer'); END;
CREATE TRIGGER work_event_invalidation_update_guard BEFORE UPDATE ON work_event_delivery_invalidations
BEGIN SELECT RAISE(ABORT, 'work_event_invalidation_immutable'); END;
`,
  upPostgres: table + `
CREATE FUNCTION work_event_invalidation_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $work_event_guard$
BEGIN RAISE EXCEPTION 'work_event_invalidation_immutable' USING ERRCODE = '23514'; END;
$work_event_guard$;
CREATE TRIGGER work_event_invalidation_update_guard BEFORE UPDATE ON work_event_delivery_invalidations
FOR EACH ROW EXECUTE FUNCTION work_event_invalidation_update_guard_fn();
`,
};
