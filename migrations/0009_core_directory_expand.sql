PRAGMA foreign_keys = ON;

CREATE TABLE specialists (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0)
    CHECK (
      length(CAST(id AS BLOB)) = length(id)
      AND
      length(id) BETWEEN 4 AND 128
      AND substr(id, 1, 3) = 'sp_'
      AND substr(id, 4, 1) GLOB '[A-Za-z0-9]'
      AND substr(id, 4) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  staff_user_id TEXT NOT NULL UNIQUE
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  standard_rate_grosze INTEGER NOT NULL DEFAULT 18000
    CHECK (
      typeof(standard_rate_grosze) = 'integer'
      AND standard_rate_grosze BETWEEN 1 AND 1000000
    ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status IN ('pending', 'active') AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL)
  )
);

CREATE INDEX specialists_status_id_idx ON specialists (status, id);
CREATE UNIQUE INDEX staff_users_specialist_id_idx
  ON staff_users (specialist_id)
  WHERE specialist_id IS NOT NULL;

CREATE TRIGGER specialists_identity_collision
BEFORE INSERT ON specialists
WHEN EXISTS (SELECT 1 FROM specialists WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM specialists WHERE staff_user_id = NEW.staff_user_id)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER specialists_no_delete
BEFORE DELETE ON specialists
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER specialists_immutable_identity
BEFORE UPDATE ON specialists
WHEN OLD.id != NEW.id
  OR OLD.staff_user_id != NEW.staff_user_id
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_specialist_identity');
END;

CREATE TRIGGER specialists_version_increment
BEFORE UPDATE ON specialists
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TABLE clients (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0)
    CHECK (
      length(CAST(id AS BLOB)) = length(id)
      AND
      length(id) BETWEEN 4 AND 128
      AND substr(id, 1, 3) = 'cl_'
      AND substr(id, 4, 1) GLOB '[A-Za-z0-9]'
      AND substr(id, 4) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  identity_envelope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status IN ('active', 'paused') AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL)
  )
);

CREATE TRIGGER clients_identity_collision
BEFORE INSERT ON clients
WHEN EXISTS (SELECT 1 FROM clients WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER clients_no_delete
BEFORE DELETE ON clients
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER clients_immutable_identity
BEFORE UPDATE ON clients
WHEN OLD.id != NEW.id OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_client_identity');
END;

CREATE TRIGGER clients_version_increment
BEFORE UPDATE ON clients
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TRIGGER clients_valid_transition
BEFORE UPDATE OF status ON clients
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'active' AND NEW.status IN ('paused', 'archived'))
  OR (OLD.status = 'paused' AND NEW.status IN ('active', 'archived'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_client_transition');
END;

CREATE TABLE client_assignments (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0)
    CHECK (
      length(CAST(id AS BLOB)) = length(id)
      AND
      length(id) BETWEEN 5 AND 128
      AND substr(id, 1, 4) = 'asg_'
      AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
      AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  client_id TEXT NOT NULL
    REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  specialist_id TEXT NOT NULL
    REFERENCES specialists(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  assigned_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE UNIQUE INDEX client_assignments_open_client_idx
  ON client_assignments (client_id)
  WHERE ends_at IS NULL;
CREATE INDEX client_assignments_specialist_ends_client_idx
  ON client_assignments (specialist_id, ends_at, client_id);

CREATE TRIGGER client_assignments_identity_collision
BEFORE INSERT ON client_assignments
WHEN EXISTS (SELECT 1 FROM client_assignments WHERE id = NEW.id)
  OR (NEW.ends_at IS NULL AND EXISTS (
    SELECT 1 FROM client_assignments
    WHERE client_id = NEW.client_id AND ends_at IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER client_assignments_no_delete
BEFORE DELETE ON client_assignments
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER client_assignments_immutable_identity
BEFORE UPDATE ON client_assignments
WHEN OLD.id != NEW.id
  OR OLD.client_id != NEW.client_id
  OR OLD.specialist_id != NEW.specialist_id
  OR OLD.assigned_by_staff_id != NEW.assigned_by_staff_id
  OR OLD.starts_at != NEW.starts_at
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_assignment_identity');
END;

CREATE TRIGGER client_assignments_version_increment
BEFORE UPDATE ON client_assignments
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TRIGGER client_assignments_valid_close
BEFORE UPDATE OF ends_at ON client_assignments
WHEN OLD.ends_at IS NOT NEW.ends_at
  AND NOT (
    OLD.ends_at IS NULL
    AND NEW.ends_at IS NOT NULL
    AND NEW.ends_at > OLD.starts_at
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_assignment_close');
END;

CREATE VIEW core_directory_invariant_failures (failure_kind) AS
SELECT CAST(NULL AS TEXT)
WHERE 0;

CREATE TRIGGER core_directory_invariant_failure
INSTEAD OF INSERT ON core_directory_invariant_failures
BEGIN
  SELECT CASE NEW.failure_kind
    WHEN 'rate_limit_guard_failed' THEN RAISE(ABORT, 'rate_limit_guard_failed')
    ELSE RAISE(ABORT, 'core_directory_invariant_failed')
  END;
END;

INSERT INTO system_state (key, value_json, version, updated_at)
VALUES (
  'core_directory_specialist_backfill_v1',
  '{"afterStaffId":null,"createdCount":0,"processedCount":0,"status":"pending"}',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
