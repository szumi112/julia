PRAGMA foreign_keys = ON;

CREATE TABLE historical_clients (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='hcl_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  identity_envelope TEXT NOT NULL CHECK (
    json_valid(identity_envelope) AND json_type(identity_envelope)='object'
  ),
  status TEXT NOT NULL CHECK (status IN ('historical','activated')),
  active_client_id TEXT REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  ),
  CHECK ((status='historical' AND active_client_id IS NULL)
    OR (status='activated' AND active_client_id IS NOT NULL))
);

CREATE TRIGGER historical_clients_no_delete BEFORE DELETE ON historical_clients BEGIN
  SELECT RAISE(ABORT,'no_routine_delete');
END;
CREATE TRIGGER historical_clients_immutable_identity BEFORE UPDATE ON historical_clients
WHEN OLD.id!=NEW.id OR OLD.identity_envelope!=NEW.identity_envelope
  OR OLD.created_at!=NEW.created_at BEGIN
  SELECT RAISE(ABORT,'immutable_historical_client_identity');
END;
CREATE TRIGGER historical_clients_version_increment BEFORE UPDATE ON historical_clients
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1 BEGIN
  SELECT RAISE(ABORT,'invalid_version_increment');
END;
CREATE TRIGGER historical_clients_valid_transition BEFORE UPDATE ON historical_clients
WHEN NOT (OLD.status='historical' AND NEW.status='activated'
  AND OLD.active_client_id IS NULL AND NEW.active_client_id IS NOT NULL) BEGIN
  SELECT RAISE(ABORT,'invalid_historical_client_transition');
END;

CREATE TABLE historical_client_lookup_aliases (
  historical_client_id TEXT NOT NULL REFERENCES historical_clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  domain TEXT NOT NULL CHECK (domain='bwm:historical-person:v1'),
  hmac_version INTEGER NOT NULL CHECK (typeof(hmac_version)='integer' AND hmac_version>=1),
  lookup_digest TEXT NOT NULL CHECK (
    length(lookup_digest)=43 AND lookup_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  PRIMARY KEY (historical_client_id,hmac_version),
  UNIQUE (domain,hmac_version,lookup_digest)
);
CREATE TRIGGER historical_client_lookup_aliases_no_update
BEFORE UPDATE ON historical_client_lookup_aliases BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER historical_client_lookup_aliases_no_delete
BEFORE DELETE ON historical_client_lookup_aliases BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TABLE historical_counterparties (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='hcp_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  identity_envelope TEXT NOT NULL CHECK (
    json_valid(identity_envelope) AND json_type(identity_envelope)='object'
  ),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  )
);
CREATE TRIGGER historical_counterparties_no_update BEFORE UPDATE ON historical_counterparties
BEGIN SELECT RAISE(ABORT,'immutable_historical_counterparty'); END;
CREATE TRIGGER historical_counterparties_no_delete BEFORE DELETE ON historical_counterparties
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE historical_counterparty_lookup_aliases (
  counterparty_id TEXT NOT NULL REFERENCES historical_counterparties(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  domain TEXT NOT NULL CHECK (domain='bwm:historical-counterparty:v1'),
  hmac_version INTEGER NOT NULL CHECK (typeof(hmac_version)='integer' AND hmac_version>=1),
  lookup_digest TEXT NOT NULL CHECK (
    length(lookup_digest)=43 AND lookup_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  PRIMARY KEY (counterparty_id,hmac_version),
  UNIQUE (domain,hmac_version,lookup_digest)
);
CREATE TRIGGER historical_counterparty_lookup_aliases_no_update
BEFORE UPDATE ON historical_counterparty_lookup_aliases BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER historical_counterparty_lookup_aliases_no_delete
BEFORE DELETE ON historical_counterparty_lookup_aliases BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TABLE historical_client_source_links (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 5 AND 128 AND substr(id,1,4)='hcs_'
    AND substr(id,5,1) GLOB '[A-Za-z0-9]' AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  historical_client_id TEXT NOT NULL REFERENCES historical_clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_record_id TEXT NOT NULL UNIQUE REFERENCES workbook_source_records(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  UNIQUE (historical_client_id,source_record_id)
);
CREATE TRIGGER historical_client_source_links_source_guard
BEFORE INSERT ON historical_client_source_links WHEN NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  JOIN finance_source_links AS link ON link.source_record_id=source.id
  JOIN finance_entries AS finance ON finance.id=link.finance_entry_id
    AND finance.kind='income' AND finance.record_type='income'
  LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=finance.id
  WHERE source.id=NEW.source_record_id AND source.disposition='accepted'
    AND source.record_type='income' AND void.id IS NULL
) BEGIN SELECT RAISE(ABORT,'invalid_historical_source'); END;
CREATE TRIGGER historical_client_source_links_no_update
BEFORE UPDATE ON historical_client_source_links BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER historical_client_source_links_no_delete
BEFORE DELETE ON historical_client_source_links BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TABLE historical_counterparty_source_links (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 5 AND 128 AND substr(id,1,4)='hps_'
    AND substr(id,5,1) GLOB '[A-Za-z0-9]' AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  counterparty_id TEXT NOT NULL REFERENCES historical_counterparties(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_record_id TEXT NOT NULL UNIQUE REFERENCES workbook_source_records(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  UNIQUE (counterparty_id,source_record_id)
);
CREATE TRIGGER historical_counterparty_source_links_source_guard
BEFORE INSERT ON historical_counterparty_source_links WHEN NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  JOIN finance_source_links AS link ON link.source_record_id=source.id
  JOIN finance_entries AS finance ON finance.id=link.finance_entry_id
    AND finance.kind='income' AND finance.record_type='income'
  LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=finance.id
  WHERE source.id=NEW.source_record_id AND source.disposition='accepted'
    AND source.record_type='income' AND void.id IS NULL
) BEGIN SELECT RAISE(ABORT,'invalid_historical_source'); END;
CREATE TRIGGER historical_counterparty_source_links_no_update
BEFORE UPDATE ON historical_counterparty_source_links BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER historical_counterparty_source_links_no_delete
BEFORE DELETE ON historical_counterparty_source_links BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TRIGGER historical_client_source_links_subject_xor
BEFORE INSERT ON historical_client_source_links WHEN EXISTS (
  SELECT 1 FROM historical_counterparty_source_links
  WHERE source_record_id=NEW.source_record_id
) BEGIN SELECT RAISE(ABORT,'historical_source_subject_conflict'); END;
CREATE TRIGGER historical_counterparty_source_links_subject_xor
BEFORE INSERT ON historical_counterparty_source_links WHEN EXISTS (
  SELECT 1 FROM historical_client_source_links
  WHERE source_record_id=NEW.source_record_id
) BEGIN SELECT RAISE(ABORT,'historical_source_subject_conflict'); END;

CREATE TABLE historical_service_occurrences (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='hoc_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  source_record_id TEXT NOT NULL UNIQUE REFERENCES workbook_source_records(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  historical_client_id TEXT REFERENCES historical_clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  counterparty_id TEXT REFERENCES historical_counterparties(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  specialist_id TEXT NOT NULL REFERENCES specialists(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  service_id TEXT CHECK (service_id IS NULL OR service_id IN (
    'konsultacja','zajecia','terapia-rodzinna','plan','plan-spotkanie',
    'obserwacja-placowka','obserwacja-dom','asrs','conners','warsztaty','superwizja'
  )),
  service_label_envelope TEXT NOT NULL CHECK (
    json_valid(service_label_envelope) AND json_type(service_label_envelope)='object'
  ),
  period_precision TEXT NOT NULL CHECK (period_precision IN ('day','month','unknown')),
  occurred_on TEXT CHECK (
    occurred_on IS NULL OR occurred_on IS strftime('%Y-%m-%d',occurred_on)
  ),
  occurred_month TEXT CHECK (
    occurred_month IS NULL OR occurred_month IS strftime('%Y-%m',occurred_month||'-01')
  ),
  status TEXT NOT NULL CHECK (status IN ('recorded','voided')),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  ),
  CHECK ((historical_client_id IS NOT NULL)!=(counterparty_id IS NOT NULL)),
  CHECK (
    (period_precision='day' AND occurred_on IS NOT NULL
      AND occurred_month=substr(occurred_on,1,7))
    OR (period_precision='month' AND occurred_on IS NULL AND occurred_month IS NOT NULL)
    OR (period_precision='unknown' AND occurred_on IS NULL AND occurred_month IS NULL)
  )
);
CREATE INDEX historical_occurrences_specialist_day_idx
  ON historical_service_occurrences (specialist_id,occurred_on,id);
CREATE INDEX historical_occurrences_specialist_month_idx
  ON historical_service_occurrences (specialist_id,occurred_month,id);
CREATE INDEX historical_occurrences_day_idx
  ON historical_service_occurrences (occurred_on,id);
CREATE INDEX historical_occurrences_month_idx
  ON historical_service_occurrences (occurred_month,id);
CREATE INDEX historical_occurrences_unknown_idx
  ON historical_service_occurrences (specialist_id,id) WHERE period_precision='unknown';
CREATE TRIGGER historical_occurrences_source_guard
BEFORE INSERT ON historical_service_occurrences WHEN NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  JOIN finance_source_links AS link ON link.source_record_id=source.id
  LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=link.finance_entry_id
  WHERE source.id=NEW.source_record_id AND source.disposition='accepted'
    AND source.record_type='income' AND void.id IS NULL
    AND ((NEW.historical_client_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM historical_client_source_links AS subject
      WHERE subject.source_record_id=source.id
        AND subject.historical_client_id=NEW.historical_client_id
    )) OR (NEW.counterparty_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM historical_counterparty_source_links AS subject
      WHERE subject.source_record_id=source.id
        AND subject.counterparty_id=NEW.counterparty_id
    )))
) BEGIN SELECT RAISE(ABORT,'invalid_historical_occurrence_source'); END;
CREATE TRIGGER historical_occurrences_immutable_provenance
BEFORE UPDATE ON historical_service_occurrences WHEN OLD.id!=NEW.id
  OR OLD.source_record_id!=NEW.source_record_id
  OR OLD.historical_client_id IS NOT NEW.historical_client_id
  OR OLD.counterparty_id IS NOT NEW.counterparty_id
  OR OLD.specialist_id!=NEW.specialist_id OR OLD.service_id IS NOT NEW.service_id
  OR OLD.service_label_envelope!=NEW.service_label_envelope
  OR OLD.period_precision!=NEW.period_precision OR OLD.occurred_on IS NOT NEW.occurred_on
  OR OLD.occurred_month IS NOT NEW.occurred_month OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_historical_occurrence_provenance'); END;
CREATE TRIGGER historical_occurrences_version_increment
BEFORE UPDATE ON historical_service_occurrences
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER historical_occurrences_valid_transition
BEFORE UPDATE OF status ON historical_service_occurrences
WHEN NOT (OLD.status='recorded' AND NEW.status='voided')
BEGIN SELECT RAISE(ABORT,'invalid_historical_occurrence_transition'); END;
CREATE TRIGGER historical_occurrences_no_delete
BEFORE DELETE ON historical_service_occurrences BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TRIGGER finance_entry_voids_historical_occurrence_guard
BEFORE INSERT ON finance_entry_voids WHEN EXISTS (
  SELECT 1 FROM finance_source_links AS link
  JOIN historical_service_occurrences AS occurrence
    ON occurrence.source_record_id=link.source_record_id
      AND occurrence.status='recorded'
  WHERE link.finance_entry_id=NEW.finance_entry_id
) BEGIN SELECT RAISE(ABORT,'recorded_historical_occurrence'); END;

CREATE TABLE historical_projection_jobs (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 5 AND 128 AND substr(id,1,4)='hpj_'
    AND substr(id,5,1) GLOB '[A-Za-z0-9]' AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  import_id TEXT NOT NULL UNIQUE REFERENCES workbook_imports(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('ready','running','conflicts','complete','failed')),
  after_source_record_id TEXT REFERENCES workbook_source_records(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  total_records INTEGER NOT NULL CHECK (typeof(total_records)='integer' AND total_records>=0),
  processed_records INTEGER NOT NULL CHECK (
    typeof(processed_records)='integer' AND processed_records BETWEEN 0 AND total_records
  ),
  projected_records INTEGER NOT NULL CHECK (
    typeof(projected_records)='integer' AND projected_records BETWEEN 0 AND processed_records
  ),
  conflict_count INTEGER NOT NULL CHECK (
    typeof(conflict_count)='integer' AND conflict_count BETWEEN 0 AND processed_records
  ),
  created_by_staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL CHECK (
    length(correlation_id) BETWEEN 1 AND 128
    AND correlation_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  ),
  completed_at TEXT CHECK (
    completed_at IS NULL OR completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(completed_at))
  ),
  CHECK ((status='complete')=(completed_at IS NOT NULL))
);
CREATE TRIGGER historical_projection_jobs_readiness_guard
BEFORE INSERT ON historical_projection_jobs WHEN NOT EXISTS (
  SELECT 1 FROM workbook_imports AS import
  JOIN workbook_import_plans AS plan ON plan.import_id=import.id AND plan.workbook_kind='legacy'
  JOIN workbook_materialization_jobs AS finance ON finance.import_id=import.id
    AND finance.status='complete' AND finance.phase='complete'
  WHERE import.id=NEW.import_id AND import.status='complete'
    AND import.created_by_staff_id=NEW.created_by_staff_id
    AND import.correlation_id=NEW.correlation_id
) BEGIN SELECT RAISE(ABORT,'historical_projection_not_ready'); END;
CREATE TRIGGER historical_projection_jobs_immutable_identity
BEFORE UPDATE ON historical_projection_jobs WHEN OLD.id!=NEW.id OR OLD.import_id!=NEW.import_id
  OR OLD.total_records!=NEW.total_records OR OLD.created_by_staff_id!=NEW.created_by_staff_id
  OR OLD.correlation_id!=NEW.correlation_id OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_historical_projection_job'); END;
CREATE TRIGGER historical_projection_jobs_version_increment
BEFORE UPDATE ON historical_projection_jobs
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER historical_projection_jobs_progress_guard
BEFORE UPDATE ON historical_projection_jobs WHEN NEW.processed_records<OLD.processed_records
  OR NEW.projected_records<OLD.projected_records OR NEW.conflict_count<OLD.conflict_count
  OR NEW.processed_records>NEW.total_records
  OR (NEW.after_source_record_id IS NOT OLD.after_source_record_id
    AND NEW.after_source_record_id IS NOT NULL AND OLD.after_source_record_id IS NOT NULL
    AND NEW.after_source_record_id<=OLD.after_source_record_id)
  OR (OLD.status='complete' OR OLD.status='failed')
  OR NOT ((OLD.status='ready' AND NEW.status IN ('running','conflicts','complete','failed'))
    OR (OLD.status='running' AND NEW.status IN ('running','conflicts','complete','failed'))
    OR (OLD.status='conflicts' AND NEW.status IN ('running','conflicts','complete','failed')))
BEGIN SELECT RAISE(ABORT,'invalid_historical_projection_progress'); END;
CREATE TRIGGER historical_projection_jobs_no_delete
BEFORE DELETE ON historical_projection_jobs BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE historical_projection_conflicts (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 5 AND 128 AND substr(id,1,4)='hcf_'
    AND substr(id,5,1) GLOB '[A-Za-z0-9]' AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  job_id TEXT NOT NULL REFERENCES historical_projection_jobs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_record_id TEXT NOT NULL REFERENCES workbook_source_records(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('classification','service','near_match')),
  context_envelope TEXT NOT NULL CHECK (
    json_valid(context_envelope) AND json_type(context_envelope)='object'
  ),
  created_by_staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  UNIQUE (job_id,source_record_id,kind)
);
CREATE TRIGGER historical_projection_conflicts_guard
BEFORE INSERT ON historical_projection_conflicts WHEN NOT EXISTS (
  SELECT 1 FROM historical_projection_jobs AS job
  JOIN workbook_source_records AS source ON source.import_id=job.import_id
  WHERE job.id=NEW.job_id AND source.id=NEW.source_record_id
    AND job.created_by_staff_id=NEW.created_by_staff_id
    AND job.correlation_id=NEW.correlation_id
) BEGIN SELECT RAISE(ABORT,'invalid_historical_conflict'); END;
CREATE TRIGGER historical_projection_conflicts_no_update
BEFORE UPDATE ON historical_projection_conflicts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER historical_projection_conflicts_no_delete
BEFORE DELETE ON historical_projection_conflicts BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TABLE historical_conflict_resolutions (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 5 AND 128 AND substr(id,1,4)='hcr_'
    AND substr(id,5,1) GLOB '[A-Za-z0-9]' AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  conflict_id TEXT NOT NULL UNIQUE REFERENCES historical_projection_conflicts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('person','counterparty','exclude')),
  existing_historical_client_id TEXT REFERENCES historical_clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  existing_counterparty_id TEXT REFERENCES historical_counterparties(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  service_id TEXT CHECK (service_id IS NULL OR service_id IN (
    'konsultacja','zajecia','terapia-rodzinna','plan','plan-spotkanie',
    'obserwacja-placowka','obserwacja-dom','asrs','conners','warsztaty','superwizja'
  )),
  resolved_by_staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  CHECK ((existing_historical_client_id IS NOT NULL)
    +(existing_counterparty_id IS NOT NULL)<=1),
  CHECK ((classification='person' AND existing_counterparty_id IS NULL)
    OR (classification='counterparty' AND existing_historical_client_id IS NULL)
    OR (classification='exclude' AND existing_historical_client_id IS NULL
      AND existing_counterparty_id IS NULL AND service_id IS NULL))
);
CREATE TRIGGER historical_conflict_resolutions_creator_guard
BEFORE INSERT ON historical_conflict_resolutions WHEN NOT EXISTS (
  SELECT 1 FROM historical_projection_conflicts AS conflict
  JOIN historical_projection_jobs AS job ON job.id=conflict.job_id
  WHERE conflict.id=NEW.conflict_id AND job.created_by_staff_id=NEW.resolved_by_staff_id
) BEGIN SELECT RAISE(ABORT,'invalid_historical_resolution_creator'); END;
CREATE TRIGGER historical_conflict_resolutions_no_update
BEFORE UPDATE ON historical_conflict_resolutions BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER historical_conflict_resolutions_no_delete
BEFORE DELETE ON historical_conflict_resolutions BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TABLE historical_request_replays (
  actor_staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN (
    'historical.continue','historical.resolve','historical.activate'
  )),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 8 AND 128
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._~-]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash)=43 AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  import_id TEXT REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  historical_client_id TEXT REFERENCES historical_clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  response_envelope TEXT CHECK (
    response_envelope IS NULL OR (json_valid(response_envelope)
      AND json_type(response_envelope)='object')
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  PRIMARY KEY (actor_staff_id,operation,idempotency_key),
  CHECK ((operation='historical.activate' AND historical_client_id IS NOT NULL
      AND import_id IS NULL AND response_envelope IS NOT NULL)
    OR (operation IN ('historical.continue','historical.resolve')
      AND import_id IS NOT NULL AND historical_client_id IS NULL
      AND response_envelope IS NULL))
);
CREATE TRIGGER historical_request_replays_no_update
BEFORE UPDATE ON historical_request_replays BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER historical_request_replays_no_delete
BEFORE DELETE ON historical_request_replays BEGIN SELECT RAISE(ABORT,'append_only'); END;
