-- Immutable lineage for owner-requested replacement of terminal identity outbox jobs.

CREATE TABLE outbox_job_recoveries (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4) = 'rcv_'
    AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  source_job_id TEXT NOT NULL UNIQUE
    REFERENCES outbox_jobs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  replacement_job_id TEXT NOT NULL UNIQUE
    REFERENCES outbox_jobs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  operational_action_id TEXT NOT NULL UNIQUE
    REFERENCES operational_actions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  requested_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL CHECK (
    length(CAST(correlation_id AS BLOB)) = length(correlation_id)
    AND length(correlation_id) BETWEEN 1 AND 128
    AND correlation_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  CHECK (source_job_id != replacement_job_id)
);

CREATE TRIGGER outbox_job_recoveries_valid_edge
BEFORE INSERT ON outbox_job_recoveries
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM outbox_jobs AS source
    WHERE source.id=NEW.source_job_id
      AND source.status='dead'
      AND source.max_attempts=8
      AND source.attempt_count BETWEEN 1 AND source.max_attempts
      AND source.lease_owner IS NULL
      AND source.lease_expires_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM outbox_attempts AS attempt
        WHERE attempt.job_id=source.id
          AND attempt.attempt_number=source.attempt_count
          AND attempt.completed_at IS NOT NULL
          AND attempt.completed_at=source.updated_at
          AND attempt.result='dead'
          AND attempt.error_code=source.last_error_code
          AND attempt.provider_reference IS NULL
      )
      AND (
        (source.type='staff.access.reconcile'
          AND source.aggregate_type='access_group'
          AND source.aggregate_id='centre_1'
          AND (
            source.last_error_code='OUTBOX_HANDLER_FAILURE'
            OR (source.last_error_code IN (
              'OUTBOX_HANDLER_RETRY',
              'OUTBOX_LEASE_EXPIRED'
            ) AND source.attempt_count=source.max_attempts)
          ))
        OR
        (source.type='staff.invitation.email'
          AND source.aggregate_type='staff_invitation'
          AND (
            source.last_error_code='OUTBOX_HANDLER_FAILURE'
            OR (source.last_error_code='OUTBOX_HANDLER_RETRY'
              AND source.attempt_count=source.max_attempts)
          ))
      )
  )
  AND EXISTS (
    SELECT 1
    FROM outbox_jobs AS replacement
    JOIN outbox_jobs AS source ON source.id=NEW.source_job_id
    WHERE replacement.id=NEW.replacement_job_id
      AND replacement.id!=source.id
      AND replacement.type=source.type
      AND replacement.aggregate_type=source.aggregate_type
      AND replacement.aggregate_id=source.aggregate_id
      AND replacement.status='queued'
      AND replacement.attempt_count=0
      AND replacement.max_attempts=8
      AND replacement.lease_owner IS NULL
      AND replacement.lease_expires_at IS NULL
      AND replacement.last_error_code IS NULL
      AND replacement.created_at=replacement.updated_at
  )
  AND EXISTS (
    SELECT 1
    FROM operational_actions AS action
    WHERE action.id=NEW.operational_action_id
      AND action.fingerprint='outbox.dead:' || NEW.source_job_id
      AND action.kind='outbox_job_failed'
      AND action.severity='critical'
      AND action.status='open'
      AND action.entity_type='outbox_job'
      AND action.entity_id=NEW.source_job_id
      AND action.version=1
      AND action.created_at=action.updated_at
      AND action.resolved_at IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM staff_users AS requester
    WHERE requester.id=NEW.requested_by_staff_id
      AND requester.role='owner'
      AND requester.status='active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recovery_edge');
END;

CREATE TRIGGER outbox_job_recoveries_identity_collision
BEFORE INSERT ON outbox_job_recoveries
WHEN EXISTS (SELECT 1 FROM outbox_job_recoveries WHERE id=NEW.id)
  OR EXISTS (
    SELECT 1 FROM outbox_job_recoveries WHERE source_job_id=NEW.source_job_id
  )
  OR EXISTS (
    SELECT 1 FROM outbox_job_recoveries
    WHERE replacement_job_id=NEW.replacement_job_id
  )
  OR EXISTS (
    SELECT 1 FROM outbox_job_recoveries
    WHERE operational_action_id=NEW.operational_action_id
  )
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER outbox_job_recoveries_no_update
BEFORE UPDATE ON outbox_job_recoveries
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER outbox_job_recoveries_no_delete
BEFORE DELETE ON outbox_job_recoveries
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;
