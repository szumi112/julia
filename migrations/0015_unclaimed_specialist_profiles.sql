PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = ON;

DROP INDEX staff_users_specialist_id_idx;

CREATE TABLE specialists_next (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0)
    CHECK (
      length(CAST(id AS BLOB)) = length(id)
      AND length(id) BETWEEN 4 AND 128
      AND substr(id, 1, 3) = 'sp_'
      AND substr(id, 4, 1) GLOB '[A-Za-z0-9]'
      AND substr(id, 4) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  staff_user_id TEXT UNIQUE
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  display_name_envelope TEXT NOT NULL CHECK (length(display_name_envelope) > 0),
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

INSERT INTO specialists_next
  (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
   archived_at,created_at,updated_at)
SELECT specialist.id,specialist.staff_user_id,staff.display_name_envelope,
       specialist.standard_rate_grosze,specialist.status,specialist.version,
       specialist.archived_at,specialist.created_at,specialist.updated_at
FROM specialists AS specialist
JOIN staff_users AS staff ON staff.id=specialist.staff_user_id;

DROP TABLE specialists;
ALTER TABLE specialists_next RENAME TO specialists;

CREATE INDEX specialists_status_id_idx ON specialists (status, id);
CREATE UNIQUE INDEX staff_users_specialist_id_idx
  ON staff_users (specialist_id)
  WHERE specialist_id IS NOT NULL AND status IN ('pending', 'active');

CREATE TRIGGER specialists_identity_collision
BEFORE INSERT ON specialists
WHEN EXISTS (SELECT 1 FROM specialists WHERE id = NEW.id)
  OR (NEW.staff_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM specialists WHERE staff_user_id = NEW.staff_user_id
  ))
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
WHEN OLD.id != NEW.id OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_specialist_identity');
END;

CREATE TRIGGER specialists_version_increment
BEFORE UPDATE ON specialists
WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid_version_increment');
END;

CREATE TRIGGER specialists_current_staff_valid_insert
BEFORE INSERT ON specialists
WHEN NEW.staff_user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM staff_users AS staff
  WHERE staff.id=NEW.staff_user_id
    AND staff.role='specialist'
    AND staff.status IN ('pending', 'active')
    AND staff.specialist_id=NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_specialist_staff_link');
END;

CREATE TRIGGER specialists_current_staff_valid_update
BEFORE UPDATE OF staff_user_id ON specialists
WHEN NEW.staff_user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM staff_users AS staff
  WHERE staff.id=NEW.staff_user_id
    AND staff.role='specialist'
    AND staff.status IN ('pending', 'active')
    AND staff.specialist_id=NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_specialist_staff_link');
END;

CREATE TABLE specialist_account_links (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0)
    CHECK (
      length(CAST(id AS BLOB)) = length(id)
      AND length(id) BETWEEN 5 AND 128
      AND substr(id, 1, 4) = 'spl_'
      AND substr(id, 5, 1) GLOB '[A-Za-z0-9]'
      AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  specialist_id TEXT NOT NULL
    REFERENCES specialists(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  staff_user_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('reserved', 'activated', 'released')),
  changed_by_staff_id TEXT NOT NULL
    REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL
);

CREATE INDEX specialist_account_links_specialist_created_idx
  ON specialist_account_links (specialist_id, created_at, id);
CREATE INDEX specialist_account_links_staff_created_idx
  ON specialist_account_links (staff_user_id, created_at, id);

CREATE TRIGGER specialist_account_links_identity_collision
BEFORE INSERT ON specialist_account_links
WHEN EXISTS (SELECT 1 FROM specialist_account_links WHERE id=NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER specialist_account_links_no_update
BEFORE UPDATE ON specialist_account_links
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER specialist_account_links_no_delete
BEFORE DELETE ON specialist_account_links
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;
