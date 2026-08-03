CREATE INDEX backup_runs_created_id_idx
  ON backup_runs (created_at DESC, id DESC);

CREATE INDEX backup_runs_success_completed_id_idx
  ON backup_runs (completed_at DESC, id DESC)
  WHERE status IN ('stored','restore_verified');

CREATE INDEX operational_actions_resolved_fingerprint_at_id_idx
  ON operational_actions (fingerprint, resolved_at DESC, id DESC)
  WHERE status='resolved';

CREATE INDEX outbox_jobs_ordinary_status_updated_id_idx
  ON outbox_jobs (status, updated_at DESC, id DESC)
  WHERE type IN ('staff.access.reconcile','staff.invitation.email','staff.invitation.expire');

CREATE INDEX scheduler_runs_status_completed_id_idx
  ON scheduler_runs (status, completed_at DESC, id DESC);
