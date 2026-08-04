PRAGMA foreign_keys = ON;

CREATE TABLE appointments (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0)
    CHECK (
      length(CAST(id AS BLOB)) = length(id)
      AND length(id) BETWEEN 5 AND 128
      AND substr(id, 1, 4) = 'apt_'
      AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
      AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  client_id TEXT NOT NULL
    REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  specialist_id TEXT NOT NULL
    REFERENCES specialists(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  service_id TEXT NOT NULL CHECK (
    service_id IN (
      'asrs',
      'conners',
      'konsultacja',
      'obserwacja-dom',
      'obserwacja-placowka',
      'plan',
      'plan-spotkanie',
      'superwizja',
      'terapia-rodzinna',
      'warsztaty',
      'zajecia'
    )
  ),
  starts_at TEXT NOT NULL CHECK (
    typeof(starts_at) = 'text'
    AND starts_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(starts_at))
  ),
  ends_at TEXT NOT NULL CHECK (
    typeof(ends_at) = 'text'
    AND ends_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(ends_at))
    AND ends_at > starts_at
  ),
  time_zone TEXT NOT NULL DEFAULT 'Europe/Warsaw'
    CHECK (time_zone = 'Europe/Warsaw'),
  location TEXT CHECK (
    location IS NULL
    OR (
      typeof(location) = 'text'
      AND location = trim(location)
      AND length(CAST(location AS BLOB)) BETWEEN 1 AND 80
    )
  ),
  status TEXT NOT NULL
    CHECK (status IN ('scheduled', 'completed', 'cancelled', 'noshow')),
  source TEXT NOT NULL DEFAULT 'panel' CHECK (source = 'panel'),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  cancelled_at TEXT CHECK (
    cancelled_at IS NULL
    OR (
      typeof(cancelled_at) = 'text'
      AND cancelled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(cancelled_at))
    )
  ),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text'
    AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    typeof(updated_at) = 'text'
    AND updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at))
  ),
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
    OR (status != 'cancelled' AND cancelled_at IS NULL)
  )
);

CREATE INDEX appointments_specialist_starts_id_idx
  ON appointments (specialist_id, starts_at, id);
CREATE INDEX appointments_client_starts_id_idx
  ON appointments (client_id, starts_at, id);

CREATE TRIGGER appointments_identity_collision
BEFORE INSERT ON appointments
WHEN EXISTS (SELECT 1 FROM appointments WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER appointments_no_delete
BEFORE DELETE ON appointments
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER appointments_immutable_identity
BEFORE UPDATE ON appointments
WHEN OLD.id != NEW.id
  OR OLD.client_id != NEW.client_id
  OR OLD.source != NEW.source
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_appointment_identity');
END;

CREATE TRIGGER appointments_version_increment
BEFORE UPDATE ON appointments
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TABLE session_charges (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0)
    CHECK (
      length(CAST(id AS BLOB)) = length(id)
      AND length(id) BETWEEN 5 AND 128
      AND substr(id, 1, 4) = 'chg_'
      AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
      AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  appointment_id TEXT NOT NULL UNIQUE
    REFERENCES appointments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  service_id TEXT NOT NULL CHECK (
    service_id IN (
      'asrs',
      'conners',
      'konsultacja',
      'obserwacja-dom',
      'obserwacja-placowka',
      'plan',
      'plan-spotkanie',
      'superwizja',
      'terapia-rodzinna',
      'warsztaty',
      'zajecia'
    )
  ),
  expected_amount_grosze INTEGER NOT NULL CHECK (
    typeof(expected_amount_grosze) = 'integer'
    AND expected_amount_grosze BETWEEN 1 AND 1000000
  ),
  currency TEXT NOT NULL DEFAULT 'PLN' CHECK (currency = 'PLN'),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text'
    AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    typeof(updated_at) = 'text'
    AND updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at))
  )
);

CREATE TRIGGER session_charges_identity_collision
BEFORE INSERT ON session_charges
WHEN EXISTS (SELECT 1 FROM session_charges WHERE id = NEW.id)
  OR EXISTS (
    SELECT 1 FROM session_charges WHERE appointment_id = NEW.appointment_id
  )
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER session_charges_service_match_insert
BEFORE INSERT ON session_charges
WHEN NOT EXISTS (
  SELECT 1 FROM appointments
  WHERE id = NEW.appointment_id AND service_id = NEW.service_id
)
BEGIN
  SELECT RAISE(ABORT, 'charge_service_mismatch');
END;

CREATE TRIGGER session_charges_service_match_update
BEFORE UPDATE OF appointment_id, service_id ON session_charges
WHEN NOT EXISTS (
  SELECT 1 FROM appointments
  WHERE id = NEW.appointment_id AND service_id = NEW.service_id
)
BEGIN
  SELECT RAISE(ABORT, 'charge_service_mismatch');
END;

CREATE TRIGGER session_charges_no_delete
BEFORE DELETE ON session_charges
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER session_charges_immutable_identity
BEFORE UPDATE ON session_charges
WHEN OLD.id != NEW.id
  OR OLD.appointment_id != NEW.appointment_id
  OR OLD.currency != NEW.currency
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_charge_identity');
END;

CREATE TRIGGER session_charges_version_increment
BEFORE UPDATE ON session_charges
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TABLE payment_entries (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0)
    CHECK (
      length(CAST(id AS BLOB)) = length(id)
      AND length(id) BETWEEN 5 AND 128
      AND substr(id, 1, 4) = 'pay_'
      AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
      AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  appointment_id TEXT NOT NULL
    REFERENCES appointments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  amount_grosze INTEGER NOT NULL CHECK (
    typeof(amount_grosze) = 'integer'
    AND amount_grosze BETWEEN 1 AND 1000000
  ),
  method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'monthly')),
  received_at TEXT NOT NULL CHECK (
    typeof(received_at) = 'text'
    AND received_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(received_at))
  ),
  recorded_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  external_reference_envelope TEXT,
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text'
    AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  )
);

CREATE TRIGGER payment_entries_identity_collision
BEFORE INSERT ON payment_entries
WHEN EXISTS (SELECT 1 FROM payment_entries WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER payment_entries_no_update
BEFORE UPDATE ON payment_entries
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER payment_entries_no_delete
BEFORE DELETE ON payment_entries
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE payment_corrections (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0)
    CHECK (
      length(CAST(id AS BLOB)) = length(id)
      AND length(id) BETWEEN 5 AND 128
      AND substr(id, 1, 4) = 'cor_'
      AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
      AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  reversed_entry_id TEXT NOT NULL UNIQUE
    REFERENCES payment_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  replacement_entry_id TEXT UNIQUE
    REFERENCES payment_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason_envelope TEXT NOT NULL,
  recorded_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text'
    AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))
  ),
  CHECK (replacement_entry_id IS NULL OR replacement_entry_id != reversed_entry_id)
);

CREATE TRIGGER payment_corrections_identity_collision
BEFORE INSERT ON payment_corrections
WHEN EXISTS (SELECT 1 FROM payment_corrections WHERE id = NEW.id)
  OR EXISTS (
    SELECT 1 FROM payment_corrections
    WHERE reversed_entry_id = NEW.reversed_entry_id
  )
  OR (
    NEW.replacement_entry_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM payment_corrections
      WHERE replacement_entry_id = NEW.replacement_entry_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER payment_corrections_valid_relationship
BEFORE INSERT ON payment_corrections
WHEN NEW.replacement_entry_id IS NOT NULL
  AND (
    NEW.replacement_entry_id = NEW.reversed_entry_id
    OR NOT EXISTS (
      SELECT 1
      FROM payment_entries AS reversed
      JOIN payment_entries AS replacement
        ON replacement.id = NEW.replacement_entry_id
      WHERE reversed.id = NEW.reversed_entry_id
        AND reversed.appointment_id = replacement.appointment_id
    )
    OR EXISTS (
      SELECT 1 FROM payment_corrections
      WHERE reversed_entry_id = NEW.replacement_entry_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_correction');
END;

CREATE TRIGGER payment_corrections_no_update
BEFORE UPDATE ON payment_corrections
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER payment_corrections_no_delete
BEFORE DELETE ON payment_corrections
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
