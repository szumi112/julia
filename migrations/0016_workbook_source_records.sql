PRAGMA foreign_keys = ON;

CREATE TABLE workbook_artifacts (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'wba_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  centre_id TEXT NOT NULL CHECK (centre_id = 'centre_1'),
  environment TEXT NOT NULL CHECK (environment = 'staging'),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  byte_size INTEGER NOT NULL CHECK (
    typeof(byte_size) = 'integer' AND byte_size BETWEEN 1 AND 5242880
  ),
  parser_version INTEGER NOT NULL CHECK (
    typeof(parser_version) = 'integer' AND parser_version >= 2
  ),
  materializer_version INTEGER NOT NULL CHECK (
    typeof(materializer_version) = 'integer' AND materializer_version >= 2
  ),
  object_key TEXT NOT NULL UNIQUE CHECK (
    length(CAST(object_key AS BLOB)) = length(object_key)
    AND length(object_key) BETWEEN 37 AND 160
    AND substr(object_key, 1, 17) = 'workbook-objects/'
    AND substr(object_key, 18, 4) = 'wbo_'
    AND substr(object_key, 22, 1) GLOB '[A-Za-z0-9]'
    AND substr(object_key, 22) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  content_nonce_b64 TEXT NOT NULL CHECK (
    length(content_nonce_b64) = 16
    AND content_nonce_b64 NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  workbook_kek_version INTEGER NOT NULL CHECK (
    typeof(workbook_kek_version) = 'integer' AND workbook_kek_version >= 1
  ),
  metadata_hmac_version INTEGER NOT NULL CHECK (
    typeof(metadata_hmac_version) = 'integer' AND metadata_hmac_version >= 1
  ),
  metadata_signature TEXT NOT NULL CHECK (
    length(metadata_signature) = 43
    AND metadata_signature NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  UNIQUE (centre_id, fingerprint)
);

CREATE TRIGGER workbook_artifacts_no_update
BEFORE UPDATE ON workbook_artifacts
BEGIN
  SELECT RAISE(ABORT, 'immutable_workbook_artifact');
END;

CREATE TRIGGER workbook_artifacts_no_delete
BEFORE DELETE ON workbook_artifacts
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TABLE workbook_templates (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'wbt_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  artifact_id TEXT NOT NULL UNIQUE
    REFERENCES workbook_artifacts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  format TEXT NOT NULL CHECK (format IN ('legacy', 'panel-v2')),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('approved_import', 'panel_round_trip')
  ),
  created_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  )
);

CREATE INDEX workbook_templates_created_id_idx
  ON workbook_templates (created_at DESC, id DESC);

CREATE TRIGGER workbook_templates_no_update
BEFORE UPDATE ON workbook_templates
BEGIN
  SELECT RAISE(ABORT, 'immutable_workbook_template');
END;

CREATE TRIGGER workbook_templates_no_delete
BEFORE DELETE ON workbook_templates
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TABLE workbook_imports (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'wbi_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  artifact_id TEXT NOT NULL UNIQUE
    REFERENCES workbook_artifacts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  preview_token_digest TEXT NOT NULL UNIQUE CHECK (
    length(preview_token_digest) = 43
    AND preview_token_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('uploading', 'ready', 'materializing', 'conflicts', 'complete', 'failed')
  ),
  accepted_records INTEGER NOT NULL CHECK (
    typeof(accepted_records) = 'integer' AND accepted_records BETWEEN 0 AND 10000
  ),
  quarantined_records INTEGER NOT NULL CHECK (
    typeof(quarantined_records) = 'integer' AND quarantined_records BETWEEN 0 AND 10000
  ),
  correlation_id TEXT NOT NULL CHECK (
    length(CAST(correlation_id AS BLOB)) = length(correlation_id)
    AND length(correlation_id) BETWEEN 1 AND 128
    AND substr(correlation_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND correlation_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (
    typeof(version) = 'integer' AND version >= 1
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at))
    AND updated_at >= created_at
  ),
  completed_at TEXT CHECK (
    completed_at IS NULL OR (
      completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(completed_at))
      AND completed_at >= created_at
    )
  ),
  CHECK ((status = 'complete') = (completed_at IS NOT NULL))
);

CREATE INDEX workbook_imports_creator_created_idx
  ON workbook_imports (created_by_staff_id, created_at DESC, id DESC);
CREATE INDEX workbook_imports_status_updated_idx
  ON workbook_imports (status, updated_at, id);

CREATE TRIGGER workbook_imports_immutable_identity
BEFORE UPDATE ON workbook_imports
WHEN OLD.id != NEW.id
  OR OLD.artifact_id != NEW.artifact_id
  OR OLD.preview_token_digest != NEW.preview_token_digest
  OR OLD.accepted_records != NEW.accepted_records
  OR OLD.quarantined_records != NEW.quarantined_records
  OR OLD.correlation_id != NEW.correlation_id
  OR OLD.created_by_staff_id != NEW.created_by_staff_id
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_workbook_import_identity');
END;

CREATE TRIGGER workbook_imports_version_increment
BEFORE UPDATE ON workbook_imports
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TRIGGER workbook_imports_valid_status_transition
BEFORE UPDATE OF status ON workbook_imports
WHEN OLD.status != NEW.status AND NOT (
  (OLD.status = 'uploading' AND NEW.status IN ('ready', 'failed'))
  OR (OLD.status = 'ready' AND NEW.status IN ('materializing', 'conflicts', 'complete', 'failed'))
  OR (OLD.status = 'materializing' AND NEW.status IN ('conflicts', 'complete', 'failed'))
  OR (OLD.status = 'conflicts' AND NEW.status IN ('materializing', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_workbook_import_transition');
END;

CREATE TRIGGER workbook_imports_no_delete
BEFORE DELETE ON workbook_imports
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

ALTER TABLE finance_adjustments ADD COLUMN workbook_import_id TEXT
  REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE INDEX finance_adjustments_workbook_import_idx
  ON finance_adjustments (workbook_import_id, finance_entry_id, created_at, id);

CREATE TABLE workbook_import_plans (
  import_id TEXT PRIMARY KEY NOT NULL
    REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  workbook_kind TEXT NOT NULL CHECK (workbook_kind IN ('legacy', 'panel-v2')),
  plan_version INTEGER NOT NULL CHECK (plan_version = 1),
  plan_envelope TEXT NOT NULL CHECK (
    json_valid(plan_envelope) AND json_type(plan_envelope) = 'object'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  )
);

CREATE TRIGGER workbook_import_plans_no_update
BEFORE UPDATE ON workbook_import_plans
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER workbook_import_plans_no_delete
BEFORE DELETE ON workbook_import_plans
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE workbook_source_records (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'wbs_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  import_id TEXT NOT NULL
    REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_key TEXT NOT NULL CHECK (
    length(source_key) BETWEEN 17 AND 64
    AND source_key GLOB 'workbook:v1:[0-9]*:[0-9]*:[0-9]*'
  ),
  sheet_index INTEGER NOT NULL CHECK (
    typeof(sheet_index) = 'integer' AND sheet_index BETWEEN 0 AND 9999
  ),
  sheet_name TEXT NOT NULL CHECK (
    sheet_name = trim(sheet_name) AND length(CAST(sheet_name AS BLOB)) BETWEEN 1 AND 255
  ),
  row_number INTEGER NOT NULL CHECK (
    typeof(row_number) = 'integer' AND row_number BETWEEN 1 AND 1048576
  ),
  block_index INTEGER NOT NULL CHECK (
    typeof(block_index) = 'integer' AND block_index BETWEEN 0 AND 16384
  ),
  record_type TEXT NOT NULL CHECK (
    record_type IN ('income', 'expense', 'tus', 'english')
  ),
  disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'quarantined')),
  accounting_month TEXT CHECK (
    accounting_month IS NULL OR accounting_month IS strftime('%Y-%m', accounting_month || '-01')
  ),
  occurred_on TEXT CHECK (
    occurred_on IS NULL OR occurred_on IS strftime('%Y-%m-%d', occurred_on)
  ),
  period_precision TEXT NOT NULL CHECK (
    period_precision IN ('day', 'month', 'unknown')
  ),
  period_month TEXT CHECK (
    period_month IS NULL OR period_month IS strftime('%Y-%m', period_month || '-01')
  ),
  amount_grosze INTEGER CHECK (
    amount_grosze IS NULL OR (
      typeof(amount_grosze) = 'integer' AND amount_grosze BETWEEN 0 AND 100000000
    )
  ),
  payment_method TEXT CHECK (
    payment_method IS NULL OR payment_method IN (
      'blik', 'card', 'cash', 'monthly', 'other', 'transfer', 'unknown'
    )
  ),
  settlement_status TEXT CHECK (
    settlement_status IS NULL OR settlement_status IN ('paid', 'partial', 'unknown', 'unpaid')
  ),
  invoice_status TEXT CHECK (
    invoice_status IS NULL OR invoice_status IN (
      'action_required', 'issued', 'not_issued', 'not_required', 'unknown'
    )
  ),
  initial_paid_amount_grosze INTEGER CHECK (
    initial_paid_amount_grosze IS NULL OR (
      typeof(initial_paid_amount_grosze) = 'integer'
      AND initial_paid_amount_grosze BETWEEN 0 AND amount_grosze
    )
  ),
  record_digest TEXT NOT NULL CHECK (
    length(record_digest) = 43 AND record_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  record_digest_hmac_version INTEGER NOT NULL CHECK (
    typeof(record_digest_hmac_version) = 'integer' AND record_digest_hmac_version >= 1
  ),
  specialist_source_digest TEXT NOT NULL CHECK (
    length(specialist_source_digest) = 43
    AND specialist_source_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  specialist_source_hmac_version INTEGER NOT NULL CHECK (
    typeof(specialist_source_hmac_version) = 'integer'
    AND specialist_source_hmac_version >= 1
  ),
  warning_codes_json TEXT NOT NULL CHECK (
    json_valid(warning_codes_json) AND json_type(warning_codes_json) = 'array'
  ),
  source_payload_version INTEGER NOT NULL CHECK (source_payload_version = 1),
  source_payload_envelope TEXT NOT NULL CHECK (
    json_valid(source_payload_envelope)
    AND json_type(source_payload_envelope) = 'object'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  UNIQUE (import_id, source_key)
  ,CHECK (
    disposition = 'quarantined' OR (
      amount_grosze IS NOT NULL
      AND payment_method IS NOT NULL AND settlement_status IS NOT NULL
      AND invoice_status IS NOT NULL AND initial_paid_amount_grosze IS NOT NULL
    )
  )
  ,CHECK (
    (payment_method IS NULL AND settlement_status IS NULL
      AND invoice_status IS NULL AND initial_paid_amount_grosze IS NULL)
    OR (payment_method IS NOT NULL AND settlement_status IS NOT NULL
      AND invoice_status IS NOT NULL AND initial_paid_amount_grosze IS NOT NULL
      AND (
        (settlement_status = 'paid' AND initial_paid_amount_grosze = amount_grosze)
        OR (settlement_status IN ('unpaid', 'unknown') AND initial_paid_amount_grosze = 0)
        OR (settlement_status = 'partial' AND initial_paid_amount_grosze > 0
          AND initial_paid_amount_grosze < amount_grosze)
      )
    )
  )
  ,CHECK (
    (period_precision = 'day' AND occurred_on IS NOT NULL
      AND period_month = substr(occurred_on, 1, 7))
    OR (period_precision = 'month' AND occurred_on IS NULL AND period_month IS NOT NULL)
    OR (period_precision = 'unknown' AND occurred_on IS NULL AND period_month IS NULL)
  )
);

CREATE INDEX workbook_source_records_import_disposition_idx
  ON workbook_source_records (import_id, disposition, source_key);

CREATE TRIGGER workbook_source_records_no_update
BEFORE UPDATE ON workbook_source_records
BEGIN
  SELECT RAISE(ABORT, 'immutable_workbook_source_record');
END;

CREATE TRIGGER workbook_source_records_no_delete
BEFORE DELETE ON workbook_source_records
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TABLE workbook_quarantine_records (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'wbq_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  source_record_id TEXT NOT NULL UNIQUE
    REFERENCES workbook_source_records(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  primary_reason TEXT NOT NULL CHECK (
    primary_reason GLOB '[A-Z]*' AND primary_reason NOT GLOB '*[^A-Z0-9_]*'
    AND length(primary_reason) BETWEEN 3 AND 64
  ),
  reason_codes_json TEXT NOT NULL CHECK (
    json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  )
);

CREATE TRIGGER workbook_quarantine_records_source_guard
BEFORE INSERT ON workbook_quarantine_records
WHEN NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  WHERE source.id = NEW.source_record_id AND source.disposition = 'quarantined'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_quarantine_source');
END;

CREATE TRIGGER workbook_quarantine_records_no_update
BEFORE UPDATE ON workbook_quarantine_records
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER workbook_quarantine_records_no_delete
BEFORE DELETE ON workbook_quarantine_records
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE workbook_resolutions (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'wbr_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  import_id TEXT NOT NULL
    REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_record_id TEXT
    REFERENCES workbook_source_records(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('specialist_mapping', 'quarantine_resolution')),
  resolution_code TEXT NOT NULL CHECK (
    resolution_code IN ('explicit_match', 'blank_assigned_to_julia', 'accepted', 'rejected')
  ),
  specialist_id TEXT
    REFERENCES specialists(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_value_kind TEXT CHECK (source_value_kind IN ('explicit_name', 'blank')),
  source_value_digest TEXT CHECK (
    source_value_digest IS NULL OR (
      length(source_value_digest) = 43
      AND source_value_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  source_value_hmac_version INTEGER CHECK (
    source_value_hmac_version IS NULL OR (
      typeof(source_value_hmac_version) = 'integer' AND source_value_hmac_version >= 1
    )
  ),
  source_value_envelope TEXT CHECK (
    source_value_envelope IS NULL OR (
      json_valid(source_value_envelope)
      AND json_type(source_value_envelope) = 'object'
    )
  ),
  resolved_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  CHECK (
    (kind = 'specialist_mapping'
      AND source_record_id IS NULL
      AND specialist_id IS NOT NULL
      AND source_value_kind IS NOT NULL
      AND source_value_digest IS NOT NULL
      AND source_value_hmac_version IS NOT NULL
      AND source_value_envelope IS NOT NULL
      AND (
        (source_value_kind = 'explicit_name' AND resolution_code = 'explicit_match')
        OR (source_value_kind = 'blank' AND resolution_code = 'blank_assigned_to_julia')
      ))
    OR (kind = 'quarantine_resolution'
      AND source_record_id IS NOT NULL
      AND resolution_code IN ('accepted', 'rejected')
      AND specialist_id IS NULL
      AND source_value_kind IS NULL
      AND source_value_digest IS NULL
      AND source_value_hmac_version IS NULL
      AND source_value_envelope IS NULL)
  )
);

CREATE TRIGGER workbook_resolutions_quarantine_source_guard
BEFORE INSERT ON workbook_resolutions
WHEN NEW.kind = 'quarantine_resolution' AND NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  WHERE source.id = NEW.source_record_id
    AND source.import_id = NEW.import_id
    AND source.disposition = 'quarantined'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_quarantine_resolution_source');
END;

CREATE INDEX workbook_resolutions_import_created_idx
  ON workbook_resolutions (import_id, created_at, id);
CREATE UNIQUE INDEX workbook_resolutions_specialist_source_idx
  ON workbook_resolutions (import_id, source_value_hmac_version, source_value_digest)
  WHERE kind = 'specialist_mapping';

CREATE TRIGGER workbook_resolutions_no_update
BEFORE UPDATE ON workbook_resolutions
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER workbook_resolutions_no_delete
BEFORE DELETE ON workbook_resolutions
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE workbook_finance_candidates (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 5 AND 128 AND substr(id, 1, 4) = 'wfc_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  import_id TEXT NOT NULL
    REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  finance_entry_id TEXT NOT NULL
    REFERENCES finance_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_key TEXT NOT NULL CHECK (
    length(source_key) BETWEEN 17 AND 64
    AND source_key GLOB 'workbook:v1:[0-9]*:[0-9]*:[0-9]*'
  ),
  accounting_month TEXT CHECK (
    accounting_month IS NULL OR accounting_month IS strftime('%Y-%m', accounting_month || '-01')
  ),
  specialist_id TEXT
    REFERENCES specialists(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  finance_version INTEGER NOT NULL CHECK (
    typeof(finance_version) = 'integer' AND finance_version >= 1
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  UNIQUE (import_id, finance_entry_id),
  UNIQUE (import_id, source_key)
);

CREATE INDEX workbook_finance_candidates_import_id_idx
  ON workbook_finance_candidates (import_id, id);

CREATE TRIGGER workbook_finance_candidates_no_update
BEFORE UPDATE ON workbook_finance_candidates
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER workbook_finance_candidates_no_delete
BEFORE DELETE ON workbook_finance_candidates
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE workbook_finance_decisions (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 5 AND 128 AND substr(id, 1, 4) = 'wfd_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  import_id TEXT NOT NULL
    REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_record_id TEXT
    REFERENCES workbook_source_records(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  finance_entry_id TEXT
    REFERENCES finance_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('insert', 'link_update', 'void')),
  reason_code TEXT CHECK (
    reason_code IS NULL OR reason_code IN ('formula_cache', 'quarantined')
  ),
  target_accounting_month TEXT CHECK (
    target_accounting_month IS NULL
    OR target_accounting_month IS strftime('%Y-%m', target_accounting_month || '-01')
  ),
  target_specialist_id TEXT
    REFERENCES specialists(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  expected_finance_version INTEGER CHECK (
    expected_finance_version IS NULL OR (
      typeof(expected_finance_version) = 'integer' AND expected_finance_version >= 1
    )
  ),
  accounting_month_changed INTEGER NOT NULL CHECK (accounting_month_changed IN (0, 1)),
  specialist_changed INTEGER NOT NULL CHECK (specialist_changed IN (0, 1)),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  CHECK (
    (action = 'insert' AND source_record_id IS NOT NULL AND finance_entry_id IS NULL
      AND reason_code IS NULL AND expected_finance_version IS NULL)
    OR (action = 'link_update' AND source_record_id IS NOT NULL
      AND finance_entry_id IS NOT NULL AND reason_code IS NULL
      AND expected_finance_version IS NOT NULL)
    OR (action = 'void' AND finance_entry_id IS NOT NULL
      AND reason_code IS NOT NULL AND expected_finance_version IS NOT NULL)
  )
);

CREATE UNIQUE INDEX workbook_finance_decisions_source_idx
  ON workbook_finance_decisions (import_id, source_record_id)
  WHERE source_record_id IS NOT NULL;
CREATE UNIQUE INDEX workbook_finance_decisions_entry_idx
  ON workbook_finance_decisions (import_id, finance_entry_id)
  WHERE finance_entry_id IS NOT NULL;
CREATE INDEX workbook_finance_decisions_import_id_idx
  ON workbook_finance_decisions (import_id, id);

CREATE TRIGGER workbook_finance_decisions_source_guard
BEFORE INSERT ON workbook_finance_decisions
WHEN NEW.source_record_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  WHERE source.id = NEW.source_record_id AND source.import_id = NEW.import_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_workbook_decision_source');
END;

CREATE TRIGGER workbook_finance_decisions_no_update
BEFORE UPDATE ON workbook_finance_decisions
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER workbook_finance_decisions_no_delete
BEFORE DELETE ON workbook_finance_decisions
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE workbook_materialization_jobs (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'wbj_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  import_id TEXT NOT NULL UNIQUE
    REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK (
    phase IN ('index_finance', 'reconcile_sources', 'reconcile_unmatched',
      'apply_finance', 'complete')
  ),
  status TEXT NOT NULL CHECK (status IN ('ready', 'running', 'complete', 'failed')),
  cursor INTEGER NOT NULL CHECK (
    typeof(cursor) = 'integer' AND cursor BETWEEN 0 AND total_records
  ),
  total_records INTEGER NOT NULL CHECK (
    typeof(total_records) = 'integer' AND total_records BETWEEN 0 AND 10000
  ),
  processed_records INTEGER NOT NULL CHECK (
    typeof(processed_records) = 'integer'
    AND processed_records BETWEEN 0 AND total_records
  ),
  progress_json TEXT NOT NULL CHECK (
    json_valid(progress_json) AND json_type(progress_json) = 'object'
  ),
  summary_json TEXT CHECK (
    summary_json IS NULL OR (
      json_valid(summary_json) AND json_type(summary_json) = 'object'
    )
  ),
  created_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (
    typeof(version) = 'integer' AND version >= 1
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at))
    AND updated_at >= created_at
  ),
  completed_at TEXT CHECK (
    completed_at IS NULL OR completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(completed_at))
  ),
  CHECK (
    (status = 'complete') = (completed_at IS NOT NULL)
    AND (status = 'complete') = (summary_json IS NOT NULL)
  )
);

CREATE TRIGGER workbook_materialization_jobs_immutable_identity
BEFORE UPDATE ON workbook_materialization_jobs
WHEN OLD.id != NEW.id OR OLD.import_id != NEW.import_id
  OR OLD.created_by_staff_id != NEW.created_by_staff_id
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_workbook_job_identity');
END;

CREATE TRIGGER workbook_materialization_jobs_import_creator_guard
BEFORE INSERT ON workbook_materialization_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM workbook_imports AS import
  WHERE import.id = NEW.import_id
    AND import.created_by_staff_id = NEW.created_by_staff_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_workbook_job_creator');
END;

CREATE TRIGGER workbook_materialization_jobs_version_increment
BEFORE UPDATE ON workbook_materialization_jobs
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TRIGGER workbook_materialization_jobs_valid_status_transition
BEFORE UPDATE OF status ON workbook_materialization_jobs
WHEN OLD.status != NEW.status AND NOT (
  (OLD.status = 'ready' AND NEW.status IN ('running', 'complete', 'failed'))
  OR (OLD.status = 'running' AND NEW.status IN ('complete', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_workbook_job_status_transition');
END;

CREATE TRIGGER workbook_materialization_jobs_valid_progress
BEFORE UPDATE ON workbook_materialization_jobs
WHEN NEW.processed_records != NEW.cursor
  OR (
    NEW.phase = OLD.phase AND (
      NEW.cursor < OLD.cursor
      OR (NEW.total_records != OLD.total_records
        AND NOT (OLD.cursor = 0 AND OLD.total_records = 0))
    )
  )
  OR (
    NEW.phase != OLD.phase AND NOT (
      (OLD.phase = 'index_finance' AND NEW.phase = 'reconcile_sources')
      OR (OLD.phase = 'reconcile_sources' AND NEW.phase = 'reconcile_unmatched')
      OR (OLD.phase = 'reconcile_unmatched' AND NEW.phase = 'apply_finance')
      OR (OLD.phase = 'apply_finance' AND NEW.phase = 'complete')
    )
  )
  OR (NEW.phase != OLD.phase AND NEW.phase != 'complete' AND NEW.cursor != 0)
  OR (NEW.phase = 'complete' AND NEW.cursor != NEW.total_records)
BEGIN
  SELECT RAISE(ABORT, 'invalid_workbook_job_progress');
END;

CREATE TRIGGER workbook_materialization_jobs_no_delete
BEFORE DELETE ON workbook_materialization_jobs
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TABLE workbook_request_replays (
  actor_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (
    operation IN ('workbooks.import', 'workbooks.continue')
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 8 AND 128
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._~-]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 43 AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  import_id TEXT NOT NULL
    REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  PRIMARY KEY (actor_staff_id, operation, idempotency_key)
);

CREATE TRIGGER workbook_request_replays_import_creator_guard
BEFORE INSERT ON workbook_request_replays
WHEN NOT EXISTS (
  SELECT 1 FROM workbook_imports AS import
  WHERE import.id = NEW.import_id
    AND import.created_by_staff_id = NEW.actor_staff_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_workbook_replay_creator');
END;

CREATE TRIGGER workbook_request_replays_no_update
BEFORE UPDATE ON workbook_request_replays
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER workbook_request_replays_no_delete
BEFORE DELETE ON workbook_request_replays
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE finance_entry_voids (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'fev_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  finance_entry_id TEXT NOT NULL UNIQUE
    REFERENCES finance_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  workbook_import_id TEXT NOT NULL
    REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  workbook_source_record_id TEXT
    REFERENCES workbook_source_records(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (
    reason_code IN ('formula_cache', 'panel_signed_void', 'quarantined',
      'superseded_source', 'reconciliation')
  ),
  voided_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  )
);

CREATE INDEX finance_entry_voids_source_idx
  ON finance_entry_voids (workbook_source_record_id, id);
CREATE INDEX finance_entry_voids_workbook_import_idx
  ON finance_entry_voids (workbook_import_id, id);

CREATE TRIGGER finance_entry_voids_import_creator_guard
BEFORE INSERT ON finance_entry_voids
WHEN NOT EXISTS (
  SELECT 1 FROM workbook_imports AS import
  WHERE import.id = NEW.workbook_import_id
    AND import.created_by_staff_id = NEW.voided_by_staff_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_finance_void_creator');
END;

CREATE TRIGGER finance_entry_voids_source_guard
BEFORE INSERT ON finance_entry_voids
WHEN NEW.workbook_source_record_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  WHERE source.id = NEW.workbook_source_record_id
    AND source.import_id = NEW.workbook_import_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_finance_void_source');
END;

CREATE TRIGGER finance_entry_voids_no_update
BEFORE UPDATE ON finance_entry_voids
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER finance_entry_voids_no_delete
BEFORE DELETE ON finance_entry_voids
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TABLE finance_source_links (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'fsl_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  source_record_id TEXT NOT NULL UNIQUE
    REFERENCES workbook_source_records(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  finance_entry_id TEXT NOT NULL UNIQUE
    REFERENCES finance_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  relationship TEXT NOT NULL CHECK (relationship IN ('materialized', 'reconciled')),
  created_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  )
);

CREATE TRIGGER finance_source_links_source_guard
BEFORE INSERT ON finance_source_links
WHEN NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  WHERE source.id = NEW.source_record_id AND source.disposition = 'accepted'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_finance_source_link');
END;

CREATE TRIGGER finance_source_links_creator_guard
BEFORE INSERT ON finance_source_links
WHEN NOT EXISTS (
  SELECT 1
  FROM workbook_source_records AS source
  JOIN workbook_imports AS import ON import.id = source.import_id
  WHERE source.id = NEW.source_record_id
    AND import.created_by_staff_id = NEW.created_by_staff_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_finance_source_link_creator');
END;

CREATE TRIGGER finance_source_links_no_update
BEFORE UPDATE ON finance_source_links
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER finance_source_links_no_delete
BEFORE DELETE ON finance_source_links
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;
