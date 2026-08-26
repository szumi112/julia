PRAGMA foreign_keys = ON;

CREATE TABLE finance_import_batches (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'fib_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  fingerprint TEXT NOT NULL UNIQUE CHECK (
    length(fingerprint) = 64
    AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  filename_envelope TEXT NOT NULL CHECK (
    typeof(filename_envelope) = 'text' AND length(filename_envelope) > 0
  ),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  total_rows INTEGER NOT NULL CHECK (
    typeof(total_rows) = 'integer' AND total_rows BETWEEN 1 AND 10000
  ),
  accepted_rows INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(accepted_rows) = 'integer'
    AND accepted_rows BETWEEN 0 AND total_rows
  ),
  status TEXT NOT NULL CHECK (status IN ('importing', 'committed', 'failed')),
  created_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(version) = 'integer' AND version >= 1
  ),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text'
    AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    typeof(updated_at) = 'text'
    AND updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at))
    AND updated_at >= created_at
  ),
  committed_at TEXT CHECK (
    committed_at IS NULL OR (
      typeof(committed_at) = 'text'
      AND committed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(committed_at))
      AND committed_at >= created_at
    )
  ),
  CHECK (
    (status = 'committed' AND committed_at IS NOT NULL AND accepted_rows = total_rows)
    OR (status != 'committed' AND committed_at IS NULL)
  )
);

CREATE INDEX finance_import_batches_status_updated_id_idx
  ON finance_import_batches (status, updated_at DESC, id DESC);

CREATE TRIGGER finance_import_batches_no_delete
BEFORE DELETE ON finance_import_batches
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER finance_import_batches_immutable_identity
BEFORE UPDATE ON finance_import_batches
WHEN OLD.id != NEW.id
  OR OLD.fingerprint != NEW.fingerprint
  OR OLD.filename_envelope != NEW.filename_envelope
  OR OLD.format_version != NEW.format_version
  OR OLD.total_rows != NEW.total_rows
  OR OLD.created_by_staff_id != NEW.created_by_staff_id
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_finance_import_identity');
END;

CREATE TRIGGER finance_import_batches_version_increment
BEFORE UPDATE ON finance_import_batches
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TABLE finance_import_chunks (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'fic_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  batch_id TEXT NOT NULL
    REFERENCES finance_import_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (
    typeof(sequence) = 'integer' AND sequence BETWEEN 0 AND 9999
  ),
  row_count INTEGER NOT NULL CHECK (
    typeof(row_count) = 'integer' AND row_count BETWEEN 1 AND 250
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(CAST(idempotency_key AS BLOB)) = length(idempotency_key)
    AND length(idempotency_key) BETWEEN 1 AND 128
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text'
    AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  UNIQUE (batch_id, sequence),
  UNIQUE (batch_id, idempotency_key)
);

CREATE TRIGGER finance_import_chunks_no_update
BEFORE UPDATE ON finance_import_chunks
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER finance_import_chunks_no_delete
BEFORE DELETE ON finance_import_chunks
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE finance_entries (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 5 AND 128
    AND substr(id, 1, 4) = 'fin_'
    AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  batch_id TEXT
    REFERENCES finance_import_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_key TEXT CHECK (
    source_key IS NULL OR (
      typeof(source_key) = 'text'
      AND source_key = trim(source_key)
      AND length(CAST(source_key AS BLOB)) BETWEEN 1 AND 512
    )
  ),
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
  record_type TEXT NOT NULL CHECK (
    record_type IN ('income', 'expense', 'tus', 'english')
  ),
  accounting_month TEXT CHECK (
    accounting_month IS NULL OR (
      typeof(accounting_month) = 'text'
      AND length(accounting_month) = 7
      AND accounting_month IS strftime('%Y-%m', accounting_month || '-01')
    )
  ),
  occurred_on TEXT CHECK (
    occurred_on IS NULL OR (
      typeof(occurred_on) = 'text'
      AND occurred_on IS strftime('%Y-%m-%d', occurred_on)
    )
  ),
  amount_grosze INTEGER NOT NULL CHECK (
    typeof(amount_grosze) = 'integer'
    AND amount_grosze BETWEEN 0 AND 100000000
    AND (record_type = 'english' OR amount_grosze >= 1)
  ),
  paid_amount_grosze INTEGER NOT NULL CHECK (
    typeof(paid_amount_grosze) = 'integer'
    AND paid_amount_grosze BETWEEN 0 AND amount_grosze
  ),
  currency TEXT NOT NULL DEFAULT 'PLN' CHECK (currency = 'PLN'),
  payment_method TEXT NOT NULL CHECK (
    payment_method IN ('blik', 'card', 'cash', 'monthly', 'other', 'transfer', 'unknown')
  ),
  settlement_status TEXT NOT NULL CHECK (
    settlement_status IN ('paid', 'partial', 'unknown', 'unpaid')
  ),
  invoice_status TEXT NOT NULL CHECK (
    invoice_status IN ('action_required', 'issued', 'not_issued', 'not_required', 'unknown')
  ),
  specialist_id TEXT
    REFERENCES specialists(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  appointment_id TEXT
    REFERENCES appointments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  counterparty_lookup TEXT CHECK (
    counterparty_lookup IS NULL OR (
      length(counterparty_lookup) = 43
      AND counterparty_lookup NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  details_envelope TEXT NOT NULL CHECK (
    typeof(details_envelope) = 'text' AND length(details_envelope) > 0
  ),
  source_row_envelope TEXT CHECK (
    source_row_envelope IS NULL OR (
      typeof(source_row_envelope) = 'text' AND length(source_row_envelope) > 0
    )
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(version) = 'integer' AND version >= 1
  ),
  created_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text'
    AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    typeof(updated_at) = 'text'
    AND updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at))
    AND updated_at >= created_at
  ),
  CHECK ((record_type = 'expense') = (kind = 'expense')),
  CHECK (
    (settlement_status = 'paid' AND paid_amount_grosze = amount_grosze)
    OR (settlement_status IN ('unpaid', 'unknown') AND paid_amount_grosze = 0)
    OR (
      settlement_status = 'partial'
      AND paid_amount_grosze > 0
      AND paid_amount_grosze < amount_grosze
    )
  ),
  CHECK (
    (batch_id IS NULL AND source_key IS NULL AND source_row_envelope IS NULL)
    OR (batch_id IS NOT NULL AND source_key IS NOT NULL AND source_row_envelope IS NOT NULL)
  ),
  UNIQUE (batch_id, source_key)
);

CREATE INDEX finance_entries_month_kind_id_idx
  ON finance_entries (accounting_month, kind, id);
CREATE INDEX finance_entries_invoice_month_id_idx
  ON finance_entries (invoice_status, accounting_month, id);
CREATE INDEX finance_entries_counterparty_month_id_idx
  ON finance_entries (counterparty_lookup, accounting_month, id);
CREATE INDEX finance_entries_specialist_month_id_idx
  ON finance_entries (specialist_id, accounting_month, id);

CREATE TRIGGER finance_entries_no_delete
BEFORE DELETE ON finance_entries
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER finance_entries_immutable_identity
BEFORE UPDATE ON finance_entries
WHEN OLD.id != NEW.id
  OR OLD.batch_id IS NOT NEW.batch_id
  OR OLD.source_key IS NOT NEW.source_key
  OR OLD.kind != NEW.kind
  OR OLD.record_type != NEW.record_type
  OR OLD.created_by_staff_id != NEW.created_by_staff_id
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_finance_entry_identity');
END;

CREATE TRIGGER finance_entries_version_increment
BEFORE UPDATE ON finance_entries
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TABLE finance_adjustments (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB)) = length(id)
    AND length(id) BETWEEN 6 AND 128
    AND substr(id, 1, 5) = 'fadj_'
    AND substr(id, 6, 1) GLOB '[A-Za-z0-9]'
    AND substr(id, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  finance_entry_id TEXT NOT NULL
    REFERENCES finance_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason_envelope TEXT NOT NULL CHECK (
    typeof(reason_envelope) = 'text' AND length(reason_envelope) > 0
  ),
  before_envelope TEXT NOT NULL CHECK (
    typeof(before_envelope) = 'text' AND length(before_envelope) > 0
  ),
  after_envelope TEXT NOT NULL CHECK (
    typeof(after_envelope) = 'text' AND length(after_envelope) > 0
  ),
  recorded_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text'
    AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  )
);

CREATE INDEX finance_adjustments_entry_created_id_idx
  ON finance_adjustments (finance_entry_id, created_at, id);

CREATE TRIGGER finance_adjustments_no_update
BEFORE UPDATE ON finance_adjustments
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER finance_adjustments_no_delete
BEFORE DELETE ON finance_adjustments
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
