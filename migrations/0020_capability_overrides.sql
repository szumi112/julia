PRAGMA foreign_keys = ON;

CREATE TABLE staff_authorities (
  staff_id TEXT PRIMARY KEY NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (
    typeof(revision)='integer' AND revision>=1
  ),
  updated_at TEXT NOT NULL CHECK (length(updated_at)>0)
);

CREATE TRIGGER staff_authorities_initial_revision
BEFORE INSERT ON staff_authorities
WHEN typeof(NEW.revision)!='integer' OR NEW.revision!=1
BEGIN SELECT RAISE(ABORT,'invalid_authority_initial_revision'); END;

CREATE TRIGGER staff_authorities_immutable_identity
BEFORE UPDATE ON staff_authorities
WHEN OLD.staff_id!=NEW.staff_id
BEGIN SELECT RAISE(ABORT,'immutable_staff_authority_identity'); END;

CREATE TRIGGER staff_authorities_revision_increment
BEFORE UPDATE ON staff_authorities
WHEN typeof(NEW.revision)!='integer' OR NEW.revision!=OLD.revision+1
BEGIN SELECT RAISE(ABORT,'invalid_authority_revision_increment'); END;

CREATE TRIGGER staff_authorities_no_delete
BEFORE DELETE ON staff_authorities
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

INSERT INTO staff_authorities (staff_id,revision,updated_at)
SELECT id,1,updated_at FROM staff_users;

CREATE TRIGGER staff_users_create_authority
AFTER INSERT ON staff_users
BEGIN
  INSERT INTO staff_authorities (staff_id,revision,updated_at)
  VALUES (NEW.id,1,NEW.updated_at);
END;

CREATE TABLE staff_capability_overrides (
  staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  capability TEXT NOT NULL CHECK (capability IN (
    'appointment.charge.read',
    'appointment.manage',
    'backup.manage',
    'centre.manage',
    'chat.direct',
    'chat.general',
    'client.manage',
    'client.operational.read',
    'clinical.read',
    'finance.centre.manage',
    'finance.centre.read',
    'finance.import',
    'operations.health.read',
    'payment.manage',
    'permissions.manage',
    'restore.manage',
    'security.audit.read',
    'security.keys.manage',
    'specialist.directory.read',
    'staff.manage',
    'tus.manage',
    'workbook.centre.export',
    'workbook.own.export'
  )),
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny','cleared')),
  version INTEGER NOT NULL CHECK (
    typeof(version)='integer' AND version>=1
  ),
  changed_by_staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(created_at)>0),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at)>0 AND updated_at>=created_at
  ),
  PRIMARY KEY (staff_id,capability)
);

CREATE INDEX staff_capability_overrides_staff_decision_idx
  ON staff_capability_overrides (staff_id,decision,capability);
CREATE INDEX staff_capability_overrides_changed_by_staff_idx
  ON staff_capability_overrides (changed_by_staff_id,staff_id,capability);

CREATE TRIGGER staff_capability_overrides_initial_version
BEFORE INSERT ON staff_capability_overrides
WHEN typeof(NEW.version)!='integer' OR NEW.version!=1
BEGIN SELECT RAISE(ABORT,'invalid_override_initial_version'); END;

CREATE TRIGGER staff_capability_overrides_immutable_identity
BEFORE UPDATE ON staff_capability_overrides
WHEN OLD.staff_id!=NEW.staff_id
  OR OLD.capability!=NEW.capability
  OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_capability_override_identity'); END;

CREATE TRIGGER staff_capability_overrides_version_increment
BEFORE UPDATE ON staff_capability_overrides
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_override_version_increment'); END;

CREATE TRIGGER staff_capability_overrides_no_delete
BEFORE DELETE ON staff_capability_overrides
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE staff_capability_override_history (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='cph_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  capability TEXT NOT NULL CHECK (capability IN (
    'appointment.charge.read',
    'appointment.manage',
    'backup.manage',
    'centre.manage',
    'chat.direct',
    'chat.general',
    'client.manage',
    'client.operational.read',
    'clinical.read',
    'finance.centre.manage',
    'finance.centre.read',
    'finance.import',
    'operations.health.read',
    'payment.manage',
    'permissions.manage',
    'restore.manage',
    'security.audit.read',
    'security.keys.manage',
    'specialist.directory.read',
    'staff.manage',
    'tus.manage',
    'workbook.centre.export',
    'workbook.own.export'
  )),
  role_at_change TEXT NOT NULL CHECK (
    role_at_change IN ('owner','coordinator','specialist')
  ),
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny','cleared')),
  override_version INTEGER NOT NULL CHECK (
    typeof(override_version)='integer' AND override_version>=1
  ),
  authority_revision INTEGER NOT NULL CHECK (
    typeof(authority_revision)='integer' AND authority_revision>=1
  ),
  changed_by_staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (
    reason IN ('owner_update','role_change','status_change')
  ),
  changed_at TEXT NOT NULL CHECK (length(changed_at)>0)
);

CREATE UNIQUE INDEX staff_capability_override_history_staff_capability_version_unique_idx
  ON staff_capability_override_history (staff_id,capability,override_version);
CREATE INDEX staff_capability_override_history_staff_revision_idx
  ON staff_capability_override_history
    (staff_id,authority_revision,capability,override_version);
CREATE INDEX staff_capability_override_history_changed_by_staff_idx
  ON staff_capability_override_history
    (changed_by_staff_id,staff_id,capability,override_version);

CREATE TRIGGER staff_capability_override_history_version_contiguous
BEFORE INSERT ON staff_capability_override_history
WHEN NEW.override_version!=coalesce((
  SELECT max(history.override_version)+1
  FROM staff_capability_override_history AS history
  WHERE history.staff_id=NEW.staff_id
    AND history.capability=NEW.capability
),1)
BEGIN SELECT RAISE(ABORT,'invalid_override_history_version'); END;

CREATE TRIGGER staff_capability_override_history_authority_contiguous
BEFORE INSERT ON staff_capability_override_history
WHEN NOT EXISTS (
  SELECT 1 FROM staff_authorities AS authority
  WHERE authority.staff_id=NEW.staff_id
    AND NEW.authority_revision=authority.revision+1
)
BEGIN SELECT RAISE(ABORT,'invalid_history_authority_revision'); END;

CREATE TRIGGER staff_capability_override_history_no_update
BEFORE UPDATE ON staff_capability_override_history
BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TRIGGER staff_capability_override_history_no_delete
BEFORE DELETE ON staff_capability_override_history
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;
