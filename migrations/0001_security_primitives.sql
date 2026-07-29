PRAGMA foreign_keys = ON;

CREATE TABLE data_keys (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  scope_type TEXT NOT NULL CHECK (length(scope_type) > 0),
  scope_id TEXT NOT NULL CHECK (length(scope_id) > 0),
  purpose TEXT NOT NULL CHECK (length(purpose) > 0),
  dek_version INTEGER NOT NULL CHECK (typeof(dek_version) = 'integer' AND dek_version >= 1),
  wrapped_key_b64 TEXT NOT NULL CHECK (length(wrapped_key_b64) > 0),
  wrap_nonce_b64 TEXT NOT NULL CHECK (length(wrap_nonce_b64) > 0),
  kek_version INTEGER NOT NULL CHECK (typeof(kek_version) = 'integer' AND kek_version >= 1),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE (scope_type, scope_id, purpose, dek_version)
);

CREATE TRIGGER data_keys_identity_collision
BEFORE INSERT ON data_keys
WHEN EXISTS (SELECT 1 FROM data_keys WHERE id = NEW.id)
  OR EXISTS (
    SELECT 1 FROM data_keys
    WHERE scope_type = NEW.scope_type
      AND scope_id = NEW.scope_id
      AND purpose = NEW.purpose
      AND dek_version = NEW.dek_version
  )
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER data_keys_no_delete
BEFORE DELETE ON data_keys
BEGIN
  SELECT RAISE(ABORT, 'no_routine_delete');
END;

CREATE TRIGGER data_keys_immutable_identity
BEFORE UPDATE ON data_keys
WHEN OLD.id != NEW.id
  OR OLD.scope_type != NEW.scope_type
  OR OLD.scope_id != NEW.scope_id
  OR OLD.purpose != NEW.purpose
  OR OLD.dek_version != NEW.dek_version
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_key_identity');
END;

CREATE TRIGGER data_keys_valid_rewrap
BEFORE UPDATE ON data_keys
WHEN (OLD.wrapped_key_b64 != NEW.wrapped_key_b64
      OR OLD.wrap_nonce_b64 != NEW.wrap_nonce_b64
      OR OLD.kek_version != NEW.kek_version)
  AND NOT (
    OLD.wrapped_key_b64 != NEW.wrapped_key_b64
    AND OLD.wrap_nonce_b64 != NEW.wrap_nonce_b64
    AND typeof(NEW.kek_version) = 'integer'
    AND NEW.kek_version > OLD.kek_version
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_key_rewrap');
END;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  occurred_at TEXT NOT NULL,
  actor_staff_id TEXT REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (length(action) > 0),
  entity_type TEXT NOT NULL CHECK (length(entity_type) > 0),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  result TEXT NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
  reason_envelope TEXT,
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) > 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
);

CREATE INDEX audit_events_entity_idx
  ON audit_events (entity_type, entity_id, occurred_at);
CREATE INDEX audit_events_actor_idx
  ON audit_events (actor_staff_id, occurred_at);
CREATE INDEX audit_events_occurred_id_idx
  ON audit_events (occurred_at, id);

CREATE TRIGGER audit_events_identity_collision
BEFORE INSERT ON audit_events
WHEN EXISTS (SELECT 1 FROM audit_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE record_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  entity_type TEXT NOT NULL CHECK (length(entity_type) > 0),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  snapshot_envelope TEXT NOT NULL,
  changed_by_staff_id TEXT REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  changed_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) > 0),
  UNIQUE (entity_type, entity_id, version)
);

CREATE TRIGGER record_versions_identity_collision
BEFORE INSERT ON record_versions
WHEN EXISTS (SELECT 1 FROM record_versions WHERE id = NEW.id)
  OR EXISTS (
    SELECT 1 FROM record_versions
    WHERE entity_type = NEW.entity_type AND entity_id = NEW.entity_id AND version = NEW.version
  )
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;

CREATE TRIGGER record_versions_no_update
BEFORE UPDATE ON record_versions
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER record_versions_no_delete
BEFORE DELETE ON record_versions
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
