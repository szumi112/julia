PRAGMA foreign_keys = ON;

CREATE TABLE staff_users (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  email_lookup TEXT NOT NULL UNIQUE CHECK (length(email_lookup) > 0),
  email_envelope TEXT NOT NULL,
  display_name_envelope TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'coordinator', 'specialist')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  access_subject TEXT UNIQUE CHECK (access_subject IS NULL OR length(access_subject) > 0),
  specialist_id TEXT CHECK (specialist_id IS NULL OR length(specialist_id) > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  activated_at TEXT,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (role != 'specialist' OR specialist_id IS NOT NULL),
  CHECK (
    (status = 'pending' AND access_subject IS NULL AND activated_at IS NULL AND disabled_at IS NULL)
    OR (status = 'active' AND access_subject IS NOT NULL AND activated_at IS NOT NULL AND disabled_at IS NULL)
    OR (status = 'disabled' AND disabled_at IS NOT NULL)
  )
);

CREATE INDEX staff_users_status_idx ON staff_users (status, role);

CREATE TRIGGER staff_users_identity_collision
BEFORE INSERT ON staff_users
WHEN EXISTS (SELECT 1 FROM staff_users WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM staff_users WHERE email_lookup = NEW.email_lookup)
  OR (NEW.access_subject IS NOT NULL AND EXISTS (
    SELECT 1 FROM staff_users WHERE access_subject = NEW.access_subject
  ))
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER staff_users_no_delete
BEFORE DELETE ON staff_users
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER staff_users_update_identity_collision
BEFORE UPDATE ON staff_users
WHEN EXISTS (SELECT 1 FROM staff_users WHERE id != OLD.id AND email_lookup = NEW.email_lookup)
  OR (NEW.access_subject IS NOT NULL AND EXISTS (
    SELECT 1 FROM staff_users WHERE id != OLD.id AND access_subject = NEW.access_subject
  ))
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER staff_users_immutable_identity
BEFORE UPDATE ON staff_users
WHEN OLD.id != NEW.id OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_staff_identity');
END;

CREATE TRIGGER staff_users_version_increment
BEFORE UPDATE ON staff_users
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TRIGGER staff_users_keep_last_owner
BEFORE UPDATE OF role, status ON staff_users
WHEN OLD.role = 'owner'
  AND OLD.status = 'active'
  AND (NEW.role != 'owner' OR NEW.status != 'active')
  AND NOT EXISTS (
    SELECT 1 FROM staff_users
    WHERE id != OLD.id AND role = 'owner' AND status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'last_active_owner');
END;

CREATE TABLE staff_invitations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  staff_id TEXT NOT NULL REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  email_lookup TEXT NOT NULL CHECK (length(email_lookup) > 0),
  email_envelope TEXT NOT NULL,
  display_name_envelope TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'coordinator', 'specialist')),
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'pending', 'activated', 'revoked', 'expired')),
  inviter_id TEXT NOT NULL REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  expires_at TEXT NOT NULL,
  access_allowed_at TEXT CHECK (access_allowed_at IS NULL OR length(access_allowed_at) > 0),
  email_sent_at TEXT,
  activated_at TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'activated' AND activated_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND activated_at IS NULL)
    OR (status NOT IN ('activated', 'revoked') AND activated_at IS NULL AND revoked_at IS NULL)
  ),
  CHECK (
    (status = 'provisioning' AND access_allowed_at IS NULL)
    OR (status IN ('pending', 'activated') AND access_allowed_at IS NOT NULL AND length(access_allowed_at) > 0)
    OR status IN ('revoked', 'expired')
  )
);

CREATE UNIQUE INDEX staff_invitations_open_email_idx
  ON staff_invitations (email_lookup)
  WHERE status IN ('provisioning', 'pending');
CREATE UNIQUE INDEX staff_invitations_open_staff_idx
  ON staff_invitations (staff_id)
  WHERE status IN ('provisioning', 'pending');
CREATE INDEX staff_invitations_expiry_idx
  ON staff_invitations (status, expires_at);

CREATE TRIGGER staff_invitations_identity_collision
BEFORE INSERT ON staff_invitations
WHEN EXISTS (SELECT 1 FROM staff_invitations WHERE id = NEW.id)
  OR (NEW.status IN ('provisioning', 'pending') AND EXISTS (
    SELECT 1 FROM staff_invitations
    WHERE email_lookup = NEW.email_lookup AND status IN ('provisioning', 'pending')
  ))
  OR (NEW.status IN ('provisioning', 'pending') AND EXISTS (
    SELECT 1 FROM staff_invitations
    WHERE staff_id = NEW.staff_id AND status IN ('provisioning', 'pending')
  ))
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER staff_invitations_no_delete
BEFORE DELETE ON staff_invitations
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER staff_invitations_update_identity_collision
BEFORE UPDATE ON staff_invitations
WHEN (NEW.status IN ('provisioning', 'pending') AND EXISTS (
  SELECT 1 FROM staff_invitations
  WHERE id != OLD.id AND email_lookup = NEW.email_lookup AND status IN ('provisioning', 'pending')
))
  OR (NEW.status IN ('provisioning', 'pending') AND EXISTS (
    SELECT 1 FROM staff_invitations
    WHERE id != OLD.id AND staff_id = NEW.staff_id AND status IN ('provisioning', 'pending')
  ))
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER staff_invitations_immutable_identity
BEFORE UPDATE ON staff_invitations
WHEN OLD.id != NEW.id OR OLD.staff_id != NEW.staff_id OR OLD.inviter_id != NEW.inviter_id
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_invitation_identity');
END;

CREATE TRIGGER staff_invitations_version_increment
BEFORE UPDATE ON staff_invitations
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TRIGGER staff_invitations_valid_transition
BEFORE UPDATE OF status ON staff_invitations
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'provisioning' AND NEW.status IN ('pending', 'revoked', 'expired'))
  OR (OLD.status = 'pending' AND NEW.status IN ('activated', 'revoked', 'expired'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_invitation_transition');
END;

CREATE TABLE idempotency_records (
  actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
  operation TEXT NOT NULL CHECK (length(operation) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash TEXT NOT NULL CHECK (length(request_hash) > 0),
  resource_type TEXT NOT NULL CHECK (length(resource_type) > 0),
  resource_id TEXT NOT NULL CHECK (length(resource_id) > 0),
  response_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, operation, idempotency_key)
);

CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at);

CREATE TRIGGER idempotency_records_identity_collision
BEFORE INSERT ON idempotency_records
WHEN EXISTS (
  SELECT 1 FROM idempotency_records
  WHERE actor_id = NEW.actor_id AND operation = NEW.operation AND idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER idempotency_records_no_update
BEFORE UPDATE ON idempotency_records
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER idempotency_records_no_delete
BEFORE DELETE ON idempotency_records
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TABLE outbox_jobs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  type TEXT NOT NULL CHECK (length(type) > 0),
  aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) > 0),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) > 0),
  payload_envelope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (typeof(max_attempts) = 'integer' AND max_attempts BETWEEN 1 AND 20),
  scheduled_at TEXT NOT NULL,
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) > 0),
  lease_expires_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (attempt_count <= max_attempts),
  CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status != 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  UNIQUE (type, idempotency_key)
);

CREATE INDEX outbox_jobs_due_idx ON outbox_jobs (status, scheduled_at, lease_expires_at);
CREATE INDEX outbox_jobs_type_status_scheduled_idx ON outbox_jobs (type, status, scheduled_at);
CREATE INDEX outbox_jobs_expired_lease_idx ON outbox_jobs (lease_expires_at) WHERE status = 'processing';

CREATE TRIGGER outbox_jobs_identity_collision
BEFORE INSERT ON outbox_jobs
WHEN EXISTS (SELECT 1 FROM outbox_jobs WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM outbox_jobs WHERE type = NEW.type AND idempotency_key = NEW.idempotency_key)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER outbox_jobs_no_delete
BEFORE DELETE ON outbox_jobs
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER outbox_jobs_immutable_identity
BEFORE UPDATE ON outbox_jobs
WHEN OLD.id != NEW.id
  OR OLD.type != NEW.type
  OR OLD.aggregate_type != NEW.aggregate_type
  OR OLD.aggregate_id != NEW.aggregate_id
  OR OLD.payload_envelope != NEW.payload_envelope
  OR OLD.idempotency_key != NEW.idempotency_key
  OR OLD.max_attempts != NEW.max_attempts
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_outbox_identity');
END;

CREATE TRIGGER outbox_jobs_update_identity_collision
BEFORE UPDATE ON outbox_jobs
WHEN EXISTS (
  SELECT 1 FROM outbox_jobs
  WHERE id != OLD.id AND type = NEW.type AND idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER outbox_jobs_valid_transition
BEFORE UPDATE OF status ON outbox_jobs
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'queued' AND NEW.status IN ('processing', 'dead'))
  OR (OLD.status = 'processing' AND NEW.status IN ('queued', 'succeeded', 'dead'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_outbox_transition');
END;

CREATE TABLE outbox_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  job_id TEXT NOT NULL REFERENCES outbox_jobs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (typeof(attempt_number) = 'integer' AND attempt_number >= 1),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result TEXT CHECK (result IN ('succeeded', 'retry', 'dead')),
  error_code TEXT,
  provider_reference TEXT CHECK (provider_reference IS NULL OR length(provider_reference) > 0),
  UNIQUE (job_id, attempt_number),
  CHECK (
    (completed_at IS NULL AND result IS NULL)
    OR (completed_at IS NOT NULL AND result IS NOT NULL)
  )
);

CREATE TRIGGER outbox_attempts_identity_collision
BEFORE INSERT ON outbox_attempts
WHEN EXISTS (SELECT 1 FROM outbox_attempts WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM outbox_attempts WHERE job_id = NEW.job_id AND attempt_number = NEW.attempt_number)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER outbox_attempts_no_delete
BEFORE DELETE ON outbox_attempts
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER outbox_attempts_immutable_identity
BEFORE UPDATE ON outbox_attempts
WHEN OLD.id != NEW.id OR OLD.job_id != NEW.job_id OR OLD.attempt_number != NEW.attempt_number
  OR OLD.started_at != NEW.started_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_attempt_identity');
END;

CREATE TRIGGER outbox_attempts_valid_completion
BEFORE UPDATE ON outbox_attempts
WHEN NOT (
  OLD.completed_at IS NULL
  AND OLD.result IS NULL
  AND NEW.completed_at IS NOT NULL
  AND NEW.result IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_terminal');
END;

CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  outbox_job_id TEXT NOT NULL REFERENCES outbox_jobs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  provider_reference TEXT CHECK (provider_reference IS NULL OR length(provider_reference) > 0),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'failed')),
  error_code TEXT,
  attempted_at TEXT NOT NULL
);

CREATE TRIGGER delivery_attempts_identity_collision
BEFORE INSERT ON delivery_attempts
WHEN EXISTS (SELECT 1 FROM delivery_attempts WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER delivery_attempts_no_update
BEFORE UPDATE ON delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER delivery_attempts_no_delete
BEFORE DELETE ON delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TABLE operational_actions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  entity_type TEXT NOT NULL CHECK (length(entity_type) > 0),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  details_envelope TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK ((status = 'open' AND resolved_at IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL))
);

CREATE UNIQUE INDEX operational_actions_open_fingerprint_idx
  ON operational_actions (fingerprint)
  WHERE status = 'open';
CREATE INDEX operational_actions_open_created_id_idx
  ON operational_actions (created_at, id)
  WHERE status = 'open';

CREATE TRIGGER operational_actions_identity_collision
BEFORE INSERT ON operational_actions
WHEN EXISTS (SELECT 1 FROM operational_actions WHERE id = NEW.id)
  OR (NEW.status = 'open' AND EXISTS (
    SELECT 1 FROM operational_actions WHERE fingerprint = NEW.fingerprint AND status = 'open'
  ))
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER operational_actions_no_delete
BEFORE DELETE ON operational_actions
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER operational_actions_update_identity_collision
BEFORE UPDATE ON operational_actions
WHEN NEW.status = 'open' AND EXISTS (
  SELECT 1 FROM operational_actions
  WHERE id != OLD.id AND fingerprint = NEW.fingerprint AND status = 'open'
)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER operational_actions_immutable_identity
BEFORE UPDATE ON operational_actions
WHEN OLD.id != NEW.id OR OLD.fingerprint != NEW.fingerprint OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_action_identity');
END;

CREATE TRIGGER operational_actions_version_increment
BEFORE UPDATE ON operational_actions
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TABLE scheduler_runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  scheduled_for TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 1),
  lease_owner TEXT NOT NULL CHECK (length(lease_owner) > 0),
  lease_expires_at TEXT NOT NULL,
  claimed_jobs INTEGER NOT NULL DEFAULT 0 CHECK (typeof(claimed_jobs) = 'integer' AND claimed_jobs >= 0),
  succeeded_jobs INTEGER NOT NULL DEFAULT 0 CHECK (typeof(succeeded_jobs) = 'integer' AND succeeded_jobs >= 0),
  failed_jobs INTEGER NOT NULL DEFAULT 0 CHECK (typeof(failed_jobs) = 'integer' AND failed_jobs >= 0),
  error_code TEXT,
  CHECK ((status = 'running' AND completed_at IS NULL) OR (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL))
);

CREATE INDEX scheduler_runs_started_idx ON scheduler_runs (started_at);

CREATE TRIGGER scheduler_runs_identity_collision
BEFORE INSERT ON scheduler_runs
WHEN EXISTS (SELECT 1 FROM scheduler_runs WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM scheduler_runs WHERE scheduled_for = NEW.scheduled_for)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER scheduler_runs_no_delete
BEFORE DELETE ON scheduler_runs
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER scheduler_runs_immutable_identity
BEFORE UPDATE ON scheduler_runs
WHEN OLD.id != NEW.id OR OLD.scheduled_for != NEW.scheduled_for
BEGIN
  SELECT RAISE(ABORT, 'immutable_scheduler_identity');
END;

CREATE TRIGGER scheduler_runs_update_identity_collision
BEFORE UPDATE ON scheduler_runs
WHEN EXISTS (
  SELECT 1 FROM scheduler_runs WHERE id != OLD.id AND scheduled_for = NEW.scheduled_for
)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER scheduler_runs_valid_transition
BEFORE UPDATE OF status ON scheduler_runs
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed'))
  OR (OLD.status = 'failed' AND NEW.status = 'running')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_scheduler_transition');
END;

CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  local_day TEXT NOT NULL CHECK (length(local_day) = 10),
  local_month TEXT NOT NULL CHECK (length(local_month) = 7),
  retention_class TEXT NOT NULL CHECK (retention_class IN ('daily', 'monthly')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'exporting', 'stored', 'failed', 'restore_verified', 'pruned')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  export_bookmark TEXT CHECK (export_bookmark IS NULL OR length(export_bookmark) > 0),
  object_key TEXT CHECK (object_key IS NULL OR length(object_key) > 0),
  manifest_key TEXT CHECK (manifest_key IS NULL OR length(manifest_key) > 0),
  ssec_key_version INTEGER CHECK (ssec_key_version IS NULL OR (typeof(ssec_key_version) = 'integer' AND ssec_key_version >= 1)),
  wrapped_ssec_key_b64 TEXT CHECK (wrapped_ssec_key_b64 IS NULL OR length(wrapped_ssec_key_b64) > 0),
  wrap_nonce_b64 TEXT CHECK (wrap_nonce_b64 IS NULL OR length(wrap_nonce_b64) > 0),
  object_etag TEXT CHECK (object_etag IS NULL OR length(object_etag) > 0),
  object_size INTEGER CHECK (object_size IS NULL OR (typeof(object_size) = 'integer' AND object_size >= 0)),
  started_at TEXT,
  completed_at TEXT,
  expires_at TEXT,
  restore_verified_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (substr(local_day, 1, 7) = local_month),
  CHECK (
    status NOT IN ('stored', 'restore_verified')
    OR (
      export_bookmark IS NOT NULL AND length(export_bookmark) > 0
      AND object_key IS NOT NULL AND length(object_key) > 0
      AND manifest_key IS NOT NULL AND length(manifest_key) > 0
      AND ssec_key_version IS NOT NULL
      AND wrapped_ssec_key_b64 IS NOT NULL AND length(wrapped_ssec_key_b64) > 0
      AND wrap_nonce_b64 IS NOT NULL AND length(wrap_nonce_b64) > 0
      AND object_etag IS NOT NULL AND length(object_etag) > 0
      AND object_size IS NOT NULL
      AND completed_at IS NOT NULL
      AND expires_at IS NOT NULL
    )
  ),
  CHECK (status != 'restore_verified' OR restore_verified_at IS NOT NULL)
);

CREATE INDEX backup_runs_status_idx ON backup_runs (status, created_at);
CREATE INDEX backup_runs_expiry_idx ON backup_runs (expires_at);
CREATE UNIQUE INDEX backup_runs_live_day_idx
  ON backup_runs (local_day)
  WHERE status IN ('queued', 'exporting', 'stored', 'restore_verified');
CREATE UNIQUE INDEX backup_runs_monthly_idx
  ON backup_runs (local_month)
  WHERE retention_class = 'monthly'
    AND status IN ('queued', 'exporting', 'stored', 'restore_verified');

CREATE TRIGGER backup_runs_identity_collision
BEFORE INSERT ON backup_runs
WHEN EXISTS (SELECT 1 FROM backup_runs WHERE id = NEW.id)
  OR (NEW.status IN ('queued', 'exporting', 'stored', 'restore_verified') AND EXISTS (
    SELECT 1 FROM backup_runs
    WHERE local_day = NEW.local_day AND status IN ('queued', 'exporting', 'stored', 'restore_verified')
  ))
  OR (NEW.retention_class = 'monthly'
      AND NEW.status IN ('queued', 'exporting', 'stored', 'restore_verified')
      AND EXISTS (
        SELECT 1 FROM backup_runs
        WHERE local_month = NEW.local_month
          AND retention_class = 'monthly'
          AND status IN ('queued', 'exporting', 'stored', 'restore_verified')
      ))
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER backup_runs_no_delete
BEFORE DELETE ON backup_runs
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER backup_runs_update_identity_collision
BEFORE UPDATE ON backup_runs
WHEN (NEW.status IN ('queued', 'exporting', 'stored', 'restore_verified') AND EXISTS (
  SELECT 1 FROM backup_runs
  WHERE id != OLD.id AND local_day = NEW.local_day
    AND status IN ('queued', 'exporting', 'stored', 'restore_verified')
))
  OR (NEW.retention_class = 'monthly'
      AND NEW.status IN ('queued', 'exporting', 'stored', 'restore_verified')
      AND EXISTS (
        SELECT 1 FROM backup_runs
        WHERE id != OLD.id AND local_month = NEW.local_month
          AND retention_class = 'monthly'
          AND status IN ('queued', 'exporting', 'stored', 'restore_verified')
      ))
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER backup_runs_immutable_identity
BEFORE UPDATE ON backup_runs
WHEN OLD.id != NEW.id OR OLD.local_day != NEW.local_day OR OLD.local_month != NEW.local_month
  OR OLD.retention_class != NEW.retention_class OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_backup_identity');
END;

CREATE TRIGGER backup_runs_version_increment
BEFORE UPDATE ON backup_runs
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TRIGGER backup_runs_valid_transition
BEFORE UPDATE OF status ON backup_runs
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'queued' AND NEW.status IN ('exporting', 'failed'))
  OR (OLD.status = 'exporting' AND NEW.status IN ('stored', 'failed'))
  OR (OLD.status = 'stored' AND NEW.status IN ('restore_verified', 'pruned'))
  OR (OLD.status = 'restore_verified' AND NEW.status = 'pruned')
  OR (OLD.status = 'failed' AND NEW.status = 'pruned')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_backup_transition');
END;

CREATE TABLE system_state (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(key) > 0),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  updated_at TEXT NOT NULL
);

CREATE TRIGGER system_state_identity_collision
BEFORE INSERT ON system_state
WHEN EXISTS (SELECT 1 FROM system_state WHERE key = NEW.key)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER system_state_no_delete
BEFORE DELETE ON system_state
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER system_state_immutable_identity
BEFORE UPDATE ON system_state
WHEN OLD.key != NEW.key
BEGIN
  SELECT RAISE(ABORT, 'immutable_state_identity');
END;

CREATE TRIGGER system_state_version_increment
BEFORE UPDATE ON system_state
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;
