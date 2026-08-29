-- Additive authority for bounded finance reporting and workbook registry operations.

CREATE TABLE finance_reporting_state (
  authority_key TEXT PRIMARY KEY NOT NULL CHECK (authority_key = 'finance'),
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer' AND revision >= 1
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at))
  )
);

INSERT INTO finance_reporting_state (authority_key,revision,updated_at)
VALUES ('finance',1,'1970-01-01T00:00:00.000Z');

CREATE TRIGGER finance_reporting_state_revision_guard
BEFORE UPDATE ON finance_reporting_state
WHEN NEW.authority_key != OLD.authority_key OR NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_finance_reporting_revision');
END;

CREATE TRIGGER finance_reporting_state_no_delete
BEFORE DELETE ON finance_reporting_state
BEGIN
  SELECT RAISE(ABORT, 'finance_reporting_state_no_delete');
END;

CREATE TRIGGER finance_reporting_specialist_labels_update
AFTER UPDATE OF display_name_envelope,status ON specialists
WHEN OLD.display_name_envelope != NEW.display_name_envelope OR OLD.status != NEW.status
BEGIN
  UPDATE finance_reporting_state
  SET revision=revision+1,updated_at=NEW.updated_at WHERE authority_key='finance';
END;

CREATE TABLE workbook_import_plan_summaries (
  import_id TEXT PRIMARY KEY NOT NULL
    REFERENCES workbook_import_plans(import_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  mapping_conflict_count INTEGER NOT NULL CHECK (
    typeof(mapping_conflict_count) = 'integer'
    AND mapping_conflict_count BETWEEN 0 AND 100
  )
);

-- Before 0021 createWorkbookImport rejected every preview containing a conflict;
-- its immutable resolution rows are therefore automatic/proposed mappings only.
INSERT INTO workbook_import_plan_summaries (import_id,mapping_conflict_count)
SELECT import_id,0 FROM workbook_import_plans;

CREATE TRIGGER workbook_import_plan_summaries_no_update
BEFORE UPDATE ON workbook_import_plan_summaries BEGIN
  SELECT RAISE(ABORT,'append_only');
END;
CREATE TRIGGER workbook_import_plan_summaries_no_delete
BEFORE DELETE ON workbook_import_plan_summaries BEGIN
  SELECT RAISE(ABORT,'no_routine_delete');
END;

CREATE TABLE finance_reporting_classifications (
  finance_entry_id TEXT PRIMARY KEY NOT NULL
    REFERENCES finance_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  service_id TEXT CHECK (service_id IS NULL OR service_id IN (
    'konsultacja','zajecia','terapia-rodzinna','plan','plan-spotkanie',
    'obserwacja-placowka','obserwacja-dom','asrs','conners','warsztaty','superwizja'
  )),
  classification_source TEXT NOT NULL CHECK (
    classification_source IN ('appointment','historical','unresolved')
  ),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
  )
);

INSERT INTO finance_reporting_classifications
  (finance_entry_id,service_id,classification_source,version,updated_at)
SELECT entry.id,
       CASE
         WHEN entry.appointment_id IS NOT NULL THEN appointment.service_id
         ELSE occurrence.service_id
       END,
       CASE
         WHEN entry.appointment_id IS NOT NULL THEN 'appointment'
         WHEN occurrence.id IS NOT NULL THEN 'historical'
         ELSE 'unresolved'
       END,
       1,entry.updated_at
FROM finance_entries AS entry
LEFT JOIN appointments AS appointment ON appointment.id=entry.appointment_id
LEFT JOIN finance_source_links AS source_link ON source_link.finance_entry_id=entry.id
LEFT JOIN historical_service_occurrences AS occurrence
  ON occurrence.source_record_id=source_link.source_record_id;

CREATE TRIGGER finance_reporting_classifications_authority
BEFORE UPDATE ON finance_reporting_classifications
WHEN NEW.finance_entry_id!=OLD.finance_entry_id OR NEW.version!=OLD.version+1
  OR NOT EXISTS (
    SELECT 1 FROM finance_entries AS entry
    LEFT JOIN appointments AS appointment ON appointment.id=entry.appointment_id
    WHERE entry.id=NEW.finance_entry_id AND (
      (NEW.classification_source='appointment' AND entry.appointment_id IS NOT NULL
        AND NEW.service_id IS appointment.service_id)
      OR (NEW.classification_source='historical' AND entry.appointment_id IS NULL
        AND EXISTS (
        SELECT 1 FROM finance_source_links AS source_link
        JOIN historical_service_occurrences AS occurrence
          ON occurrence.source_record_id=source_link.source_record_id
        WHERE source_link.finance_entry_id=entry.id
          AND occurrence.service_id IS NEW.service_id
      ))
      OR (NEW.classification_source='unresolved' AND NEW.service_id IS NULL
        AND entry.appointment_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM finance_source_links AS source_link
          JOIN historical_service_occurrences AS occurrence
            ON occurrence.source_record_id=source_link.source_record_id
          WHERE source_link.finance_entry_id=entry.id
        ))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_finance_reporting_classification');
END;

CREATE TRIGGER finance_reporting_classifications_no_delete
BEFORE DELETE ON finance_reporting_classifications
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER finance_entries_reporting_classification
AFTER INSERT ON finance_entries
BEGIN
  INSERT INTO finance_reporting_classifications
    (finance_entry_id,service_id,classification_source,version,updated_at)
  SELECT NEW.id,appointment.service_id,'appointment',1,NEW.created_at
  FROM appointments AS appointment WHERE appointment.id=NEW.appointment_id;
  INSERT INTO finance_reporting_classifications
    (finance_entry_id,service_id,classification_source,version,updated_at)
  SELECT NEW.id,NULL,'unresolved',1,NEW.created_at WHERE NEW.appointment_id IS NULL;
END;

CREATE TRIGGER historical_occurrences_reporting_classification
AFTER INSERT ON historical_service_occurrences
BEGIN
  UPDATE finance_reporting_classifications
  SET service_id=NEW.service_id,classification_source='historical',
      version=version+1,updated_at=NEW.created_at
  WHERE classification_source='unresolved' AND finance_entry_id=(
    SELECT source_link.finance_entry_id FROM finance_source_links AS source_link
    JOIN finance_entries AS entry ON entry.id=source_link.finance_entry_id
    WHERE source_link.source_record_id=NEW.source_record_id
      AND entry.appointment_id IS NULL
  );
END;

CREATE TRIGGER appointments_reporting_classification
AFTER UPDATE OF service_id ON appointments
WHEN NEW.service_id IS NOT OLD.service_id
BEGIN
  UPDATE finance_reporting_classifications
  SET service_id=NEW.service_id,classification_source='appointment',
      version=version+1,updated_at=NEW.updated_at
  WHERE finance_entry_id IN (
    SELECT id FROM finance_entries WHERE appointment_id=NEW.id
  );
END;

CREATE TABLE finance_appointment_authority_claims (
  finance_entry_id TEXT PRIMARY KEY NOT NULL
    REFERENCES finance_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  appointment_id TEXT NOT NULL
    REFERENCES appointments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  claimed_at TEXT NOT NULL CHECK (
    claimed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(claimed_at))
  ),
  released_at TEXT CHECK (
    released_at IS NULL OR (
      released_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(released_at))
      AND released_at >= claimed_at
    )
  ),
  version INTEGER NOT NULL CHECK (
    typeof(version) = 'integer' AND version IN (1, 2)
    AND (version = 1) = (released_at IS NULL)
  )
);

CREATE TRIGGER finance_appointment_authority_active_preflight
BEFORE INSERT ON finance_appointment_authority_claims
WHEN NEW.released_at IS NULL AND EXISTS (
  SELECT 1 FROM finance_appointment_authority_claims AS active
  WHERE active.appointment_id=NEW.appointment_id AND active.released_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'duplicate_active_finance_appointment_authority');
END;

INSERT INTO finance_appointment_authority_claims
  (finance_entry_id,appointment_id,claimed_at,released_at,version)
SELECT entry.id,entry.appointment_id,entry.created_at,void.created_at,
       CASE WHEN void.id IS NULL THEN 1 ELSE 2 END
FROM finance_entries AS entry
LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
WHERE entry.appointment_id IS NOT NULL;

CREATE UNIQUE INDEX finance_appointment_authority_active_uidx
  ON finance_appointment_authority_claims (appointment_id)
  WHERE released_at IS NULL;

CREATE TRIGGER finance_entries_appointment_authority_claim
AFTER INSERT ON finance_entries
WHEN NEW.appointment_id IS NOT NULL
BEGIN
  INSERT INTO finance_appointment_authority_claims
    (finance_entry_id,appointment_id,claimed_at,released_at,version)
  VALUES (NEW.id,NEW.appointment_id,NEW.created_at,NULL,1);
END;

CREATE TRIGGER finance_appointment_authority_insert_guard
BEFORE INSERT ON finance_appointment_authority_claims
WHEN NOT EXISTS (
  SELECT 1 FROM finance_entries AS entry
  WHERE entry.id=NEW.finance_entry_id
    AND entry.appointment_id=NEW.appointment_id
    AND NEW.released_at IS NULL AND NEW.version=1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_finance_appointment_authority');
END;

CREATE TRIGGER finance_entries_appointment_authority_immutable
BEFORE UPDATE OF appointment_id ON finance_entries
WHEN NEW.appointment_id IS NOT OLD.appointment_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_finance_appointment_authority');
END;

CREATE TRIGGER finance_appointment_authority_release_only
BEFORE UPDATE ON finance_appointment_authority_claims
WHEN OLD.finance_entry_id != NEW.finance_entry_id
  OR OLD.appointment_id != NEW.appointment_id
  OR OLD.claimed_at != NEW.claimed_at
  OR OLD.released_at IS NOT NULL
  OR NEW.released_at IS NULL
  OR NEW.version != OLD.version + 1
  OR NOT EXISTS (
    SELECT 1 FROM finance_entry_voids AS workbook_void
    WHERE workbook_void.finance_entry_id=OLD.finance_entry_id
    UNION ALL
    SELECT 1 FROM finance_manual_voids AS manual_void
    WHERE manual_void.finance_entry_id=OLD.finance_entry_id
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_finance_authority_release');
END;

CREATE TRIGGER finance_appointment_authority_no_delete
BEFORE DELETE ON finance_appointment_authority_claims
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER finance_entry_voids_release_appointment_authority
AFTER INSERT ON finance_entry_voids
BEGIN
  UPDATE finance_appointment_authority_claims
  SET released_at=NEW.created_at,version=version+1
  WHERE finance_entry_id=NEW.finance_entry_id AND released_at IS NULL;
END;

CREATE TRIGGER finance_entry_voids_existing_manual_void_guard
BEFORE INSERT ON finance_entry_voids
WHEN EXISTS (
  SELECT 1 FROM finance_manual_voids AS manual_void
  WHERE manual_void.finance_entry_id=NEW.finance_entry_id
)
BEGIN
  SELECT RAISE(ABORT, 'finance_entry_already_void');
END;

CREATE TABLE finance_collection_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'fce_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  finance_entry_id TEXT NOT NULL
    REFERENCES finance_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  entry_version INTEGER NOT NULL CHECK (
    typeof(entry_version) = 'integer' AND entry_version >= 1
  ),
  amount_grosze INTEGER NOT NULL CHECK (
    typeof(amount_grosze) = 'integer' AND amount_grosze BETWEEN 0 AND 100000000
  ),
  method TEXT NOT NULL CHECK (
    method IN ('blik','card','cash','monthly','other','transfer','unknown')
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  UNIQUE (finance_entry_id,entry_version)
);

INSERT INTO finance_collection_events
  (id,finance_entry_id,entry_version,amount_grosze,method,created_at)
SELECT 'fce_' || lower(hex(randomblob(16))),entry.id,entry.version,entry.paid_amount_grosze,
       entry.payment_method,entry.updated_at
FROM finance_entries AS entry
WHERE entry.appointment_id IS NULL AND entry.kind='income';

CREATE TRIGGER finance_collection_events_authority_guard
BEFORE INSERT ON finance_collection_events
WHEN NOT EXISTS (
  SELECT 1 FROM finance_entries AS entry
  WHERE entry.id=NEW.finance_entry_id AND entry.appointment_id IS NULL
    AND entry.kind='income' AND entry.version=NEW.entry_version
    AND entry.paid_amount_grosze=NEW.amount_grosze
    AND entry.payment_method=NEW.method AND entry.updated_at=NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_finance_collection_authority');
END;

CREATE TRIGGER finance_entries_collection_event
AFTER INSERT ON finance_entries
WHEN NEW.appointment_id IS NULL AND NEW.kind='income'
BEGIN
  INSERT INTO finance_collection_events
    (id,finance_entry_id,entry_version,amount_grosze,method,created_at)
  VALUES ('fce_' || lower(hex(randomblob(16))),NEW.id,NEW.version,NEW.paid_amount_grosze,
          NEW.payment_method,NEW.created_at);
END;

CREATE TRIGGER finance_entries_collection_event_revision
AFTER UPDATE ON finance_entries
WHEN NEW.appointment_id IS NULL AND NEW.kind='income'
BEGIN
  INSERT INTO finance_collection_events
    (id,finance_entry_id,entry_version,amount_grosze,method,created_at)
  VALUES ('fce_' || lower(hex(randomblob(16))),NEW.id,NEW.version,NEW.paid_amount_grosze,
          NEW.payment_method,NEW.updated_at);
END;

CREATE TRIGGER finance_collection_events_no_update
BEFORE UPDATE ON finance_collection_events
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER finance_collection_events_no_delete
BEFORE DELETE ON finance_collection_events
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE finance_manual_voids (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'fmv_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  finance_entry_id TEXT NOT NULL UNIQUE
    REFERENCES finance_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  expected_entry_version INTEGER NOT NULL CHECK (
    typeof(expected_entry_version) = 'integer' AND expected_entry_version >= 1
  ),
  reason_envelope TEXT NOT NULL CHECK (
    json_valid(reason_envelope) AND json_type(reason_envelope) = 'object'
  ),
  voided_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  )
);

CREATE INDEX finance_manual_voids_created_idx
  ON finance_manual_voids (created_at DESC, id DESC);

CREATE TRIGGER finance_manual_voids_entry_version_guard
BEFORE INSERT ON finance_manual_voids
WHEN NOT EXISTS (
  SELECT 1 FROM finance_entries AS entry
  WHERE entry.id = NEW.finance_entry_id
    AND entry.version = NEW.expected_entry_version
)
BEGIN
  SELECT RAISE(ABORT, 'stale_finance_entry');
END;

CREATE TRIGGER finance_manual_voids_existing_void_guard
BEFORE INSERT ON finance_manual_voids
WHEN EXISTS (
  SELECT 1 FROM finance_entry_voids AS void
  WHERE void.finance_entry_id = NEW.finance_entry_id
)
BEGIN
  SELECT RAISE(ABORT, 'finance_entry_already_void');
END;

CREATE TRIGGER finance_manual_voids_historical_occurrence_guard
BEFORE INSERT ON finance_manual_voids
WHEN EXISTS (
  SELECT 1 FROM finance_source_links AS link
  JOIN historical_service_occurrences AS occurrence
    ON occurrence.source_record_id=link.source_record_id
   AND occurrence.status='recorded'
  WHERE link.finance_entry_id=NEW.finance_entry_id
)
BEGIN
  SELECT RAISE(ABORT, 'recorded_historical_occurrence');
END;

CREATE TRIGGER finance_manual_voids_activity_guard
BEFORE INSERT ON finance_manual_voids
WHEN EXISTS (
  SELECT 1 FROM activity_charges AS charge
  WHERE charge.finance_entry_id=NEW.finance_entry_id AND charge.status='active'
)
BEGIN
  SELECT RAISE(ABORT, 'active_activity_charge_finance_void');
END;

CREATE TRIGGER historical_client_source_links_manual_void_guard
BEFORE INSERT ON historical_client_source_links
WHEN EXISTS (
  SELECT 1 FROM finance_source_links AS link
  JOIN finance_manual_voids AS manual_void ON manual_void.finance_entry_id=link.finance_entry_id
  WHERE link.source_record_id=NEW.source_record_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_historical_source');
END;

CREATE TRIGGER historical_counterparty_source_links_manual_void_guard
BEFORE INSERT ON historical_counterparty_source_links
WHEN EXISTS (
  SELECT 1 FROM finance_source_links AS link
  JOIN finance_manual_voids AS manual_void ON manual_void.finance_entry_id=link.finance_entry_id
  WHERE link.source_record_id=NEW.source_record_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_historical_source');
END;

CREATE TRIGGER historical_occurrences_manual_void_guard
BEFORE INSERT ON historical_service_occurrences
WHEN EXISTS (
  SELECT 1 FROM finance_source_links AS link
  JOIN finance_manual_voids AS manual_void ON manual_void.finance_entry_id=link.finance_entry_id
  WHERE link.source_record_id=NEW.source_record_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_historical_occurrence_source');
END;

CREATE TRIGGER activity_charges_manual_void_insert_guard
BEFORE INSERT ON activity_charges
WHEN EXISTS (
  SELECT 1 FROM finance_manual_voids
  WHERE finance_entry_id=NEW.finance_entry_id
)
BEGIN
  SELECT RAISE(ABORT, 'activity_charge_finance_mismatch');
END;

CREATE TRIGGER activity_charges_manual_void_update_guard
BEFORE UPDATE ON activity_charges
WHEN NEW.status='active' AND EXISTS (
  SELECT 1 FROM finance_manual_voids
  WHERE finance_entry_id=NEW.finance_entry_id
)
BEGIN
  SELECT RAISE(ABORT, 'activity_charge_finance_mismatch');
END;

CREATE TRIGGER activity_source_links_manual_void_guard
BEFORE INSERT ON activity_source_links
WHEN NEW.relation='charge' AND EXISTS (
  SELECT 1 FROM activity_charges AS charge
  JOIN finance_manual_voids AS manual_void
    ON manual_void.finance_entry_id=charge.finance_entry_id
  WHERE charge.id=NEW.entity_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_activity_charge_source');
END;

CREATE TRIGGER finance_manual_voids_release_appointment_authority
AFTER INSERT ON finance_manual_voids
BEGIN
  UPDATE finance_appointment_authority_claims
  SET released_at=NEW.created_at,version=version+1
  WHERE finance_entry_id=NEW.finance_entry_id AND released_at IS NULL;
END;

CREATE TRIGGER finance_manual_voids_no_update
BEFORE UPDATE ON finance_manual_voids
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER finance_manual_voids_no_delete
BEFORE DELETE ON finance_manual_voids
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TABLE workbook_import_resolution_sets (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'wrs_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  import_id TEXT NOT NULL
    REFERENCES workbook_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  artifact_id TEXT NOT NULL
    REFERENCES workbook_artifacts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  preview_token_digest TEXT NOT NULL CHECK (
    length(preview_token_digest) = 43
    AND preview_token_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  plan_digest TEXT NOT NULL CHECK (
    length(plan_digest) BETWEEN 45 AND 128
    AND plan_digest NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  resolution_count INTEGER NOT NULL CHECK (
    typeof(resolution_count) = 'integer' AND resolution_count BETWEEN 1 AND 100
  ),
  resolutions_envelope TEXT NOT NULL CHECK (
    json_valid(resolutions_envelope) AND json_type(resolutions_envelope) = 'object'
  ),
  created_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (
    typeof(version) = 'integer' AND version >= 1
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  UNIQUE (import_id, version)
);

CREATE TRIGGER workbook_import_resolution_sets_authority_guard
BEFORE INSERT ON workbook_import_resolution_sets
WHEN NOT EXISTS (
  SELECT 1 FROM workbook_imports AS import
  WHERE import.id = NEW.import_id
    AND import.artifact_id = NEW.artifact_id
    AND import.preview_token_digest = NEW.preview_token_digest
    AND import.created_by_staff_id = NEW.created_by_staff_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_workbook_resolution_authority');
END;

CREATE TRIGGER workbook_import_resolution_sets_version_guard
BEFORE INSERT ON workbook_import_resolution_sets
WHEN NEW.version != coalesce((
  SELECT max(existing.version) + 1
  FROM workbook_import_resolution_sets AS existing
  WHERE existing.import_id=NEW.import_id
), 1)
BEGIN
  SELECT RAISE(ABORT, 'stale_workbook_resolution_version');
END;

CREATE TRIGGER workbook_import_resolution_sets_no_update
BEFORE UPDATE ON workbook_import_resolution_sets
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER workbook_import_resolution_sets_no_delete
BEFORE DELETE ON workbook_import_resolution_sets
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TABLE workbook_export_history (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'wbe_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  format TEXT NOT NULL CHECK (format IN ('legacy', 'panel-v2')),
  scope TEXT NOT NULL CHECK (scope IN ('centre', 'own')),
  scope_specialist_id TEXT
    REFERENCES specialists(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  byte_size INTEGER NOT NULL CHECK (
    typeof(byte_size) = 'integer' AND byte_size BETWEEN 1 AND 10485760
  ),
  filename TEXT NOT NULL CHECK (
    filename = trim(filename)
    AND length(CAST(filename AS BLOB)) BETWEEN 6 AND 133
    AND filename GLOB '*.xlsx'
    AND filename NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  artifact_fingerprint TEXT NOT NULL CHECK (
    length(artifact_fingerprint) = 64
    AND artifact_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  created_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  CHECK (
    (scope = 'centre' AND scope_specialist_id IS NULL)
    OR (scope = 'own' AND scope_specialist_id IS NOT NULL)
  )
);

CREATE INDEX workbook_export_history_creator_created_idx
  ON workbook_export_history (created_by_staff_id, created_at DESC, id DESC);

CREATE TRIGGER workbook_export_history_own_scope_guard
BEFORE INSERT ON workbook_export_history
WHEN NEW.scope = 'own' AND NOT EXISTS (
  SELECT 1 FROM staff_users AS staff
  WHERE staff.id = NEW.created_by_staff_id
    AND staff.status = 'active'
    AND staff.specialist_id = NEW.scope_specialist_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_workbook_export_scope');
END;

CREATE TRIGGER workbook_export_history_no_update
BEFORE UPDATE ON workbook_export_history
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER workbook_export_history_no_delete
BEFORE DELETE ON workbook_export_history
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE finance_reporting_request_replays (
  actor_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (
    operation IN ('finance.entry.void','workbook.resolutions.record','workbook.export.create')
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 8 AND 128
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._~-]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 43 AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  entity_id TEXT NOT NULL CHECK (
    length(CAST(entity_id AS BLOB)) = length(entity_id)
    AND length(entity_id) BETWEEN 5 AND 128
    AND substr(entity_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND entity_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  response_version INTEGER NOT NULL CHECK (
    typeof(response_version) = 'integer' AND response_version >= 1
  ),
  response_aux_version INTEGER CHECK (
    response_aux_version IS NULL OR (
      typeof(response_aux_version) = 'integer' AND response_aux_version >= 1
    )
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  PRIMARY KEY (actor_staff_id, operation, idempotency_key)
);

CREATE TRIGGER finance_reporting_request_replays_no_update
BEFORE UPDATE ON finance_reporting_request_replays
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER finance_reporting_request_replays_no_delete
BEFORE DELETE ON finance_reporting_request_replays
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

-- A read brackets all FinanceWindow queries with this monotonic revision. Any
-- interleaved authority mutation changes it, so the server refuses a mixed view.
CREATE TRIGGER finance_reporting_state_finance_insert
AFTER INSERT ON finance_entries
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_finance_update
AFTER UPDATE ON finance_entries
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.updated_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_source_link_insert
AFTER INSERT ON finance_source_links
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_classification_update
AFTER UPDATE ON finance_reporting_classifications
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.updated_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_import_batch_insert
AFTER INSERT ON finance_import_batches
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_import_batch_update
AFTER UPDATE ON finance_import_batches
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.updated_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_workbook_void
AFTER INSERT ON finance_entry_voids
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_manual_void
AFTER INSERT ON finance_manual_voids
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_appointment_insert
AFTER INSERT ON appointments
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_appointment_update
AFTER UPDATE ON appointments
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.updated_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_charge_insert
AFTER INSERT ON session_charges
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_charge_update
AFTER UPDATE ON session_charges
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.updated_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_payment_insert
AFTER INSERT ON payment_entries
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_payment_correction
AFTER INSERT ON payment_corrections
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_historical_insert
AFTER INSERT ON historical_service_occurrences
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_historical_update
AFTER UPDATE ON historical_service_occurrences
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.updated_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_activity_insert
AFTER INSERT ON activity_charges
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;

CREATE TRIGGER finance_reporting_state_activity_update
AFTER UPDATE ON activity_charges
BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.updated_at
  WHERE authority_key='finance';
END;

-- Registry reads span several bounded collections. Every mutation that can alter
-- their visible rows or summaries participates in the same monotonic snapshot
-- bracket used by FinanceWindow.
CREATE TRIGGER finance_reporting_state_workbook_import_insert
AFTER INSERT ON workbook_imports BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_workbook_import_update
AFTER UPDATE ON workbook_imports BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.updated_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_workbook_plan_insert
AFTER INSERT ON workbook_import_plans BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_workbook_plan_summary_insert
AFTER INSERT ON workbook_import_plan_summaries BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=(
    SELECT created_at FROM workbook_import_plans WHERE import_id=NEW.import_id
  )
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_workbook_job_insert
AFTER INSERT ON workbook_materialization_jobs BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_workbook_job_update
AFTER UPDATE ON workbook_materialization_jobs BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.updated_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_workbook_source_insert
AFTER INSERT ON workbook_source_records BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_workbook_quarantine_insert
AFTER INSERT ON workbook_quarantine_records BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_workbook_resolution_insert
AFTER INSERT ON workbook_resolutions BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_workbook_resolution_set_insert
AFTER INSERT ON workbook_import_resolution_sets BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_workbook_export_insert
AFTER INSERT ON workbook_export_history BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_projection_job_insert
AFTER INSERT ON historical_projection_jobs BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_projection_job_update
AFTER UPDATE ON historical_projection_jobs BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.updated_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_projection_conflict_insert
AFTER INSERT ON historical_projection_conflicts BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
CREATE TRIGGER finance_reporting_state_projection_resolution_insert
AFTER INSERT ON historical_conflict_resolutions BEGIN
  UPDATE finance_reporting_state SET revision=revision+1,updated_at=NEW.created_at
  WHERE authority_key='finance';
END;
