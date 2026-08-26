CREATE UNIQUE INDEX delivery_attempts_outbox_job_id_idx
  ON delivery_attempts (outbox_job_id);
