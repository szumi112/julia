PRAGMA foreign_keys = ON;

CREATE TABLE specialist_absences (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    id GLOB 'abs_[A-Za-z0-9]*'
    AND length(id) BETWEEN 5 AND 128
    AND length(CAST(id AS BLOB))=length(id)
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  specialist_id TEXT NOT NULL REFERENCES specialists(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  date_from TEXT NOT NULL CHECK (date_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date_from)=date_from),
  date_to TEXT NOT NULL CHECK (date_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date_to)=date_to AND date_to>=date_from),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version)='integer' AND version>=1),
  created_by_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at))),
  cancelled_by_staff_id TEXT REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  cancelled_at TEXT CHECK (cancelled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', julianday(cancelled_at))),
  CHECK ((cancelled_at IS NULL AND cancelled_by_staff_id IS NULL) OR (cancelled_at IS NOT NULL AND cancelled_by_staff_id IS NOT NULL))
);

CREATE INDEX specialist_absences_specialist_dates_idx ON specialist_absences (specialist_id, date_from, date_to, id);

CREATE TRIGGER specialist_absences_no_update BEFORE UPDATE ON specialist_absences
WHEN OLD.id != NEW.id
  OR OLD.specialist_id != NEW.specialist_id
  OR OLD.date_from != NEW.date_from
  OR OLD.date_to != NEW.date_to
  OR OLD.created_by_staff_id != NEW.created_by_staff_id
  OR OLD.created_at != NEW.created_at
  OR OLD.cancelled_at IS NOT NULL
  OR NEW.cancelled_at IS NULL
  OR NEW.cancelled_by_staff_id IS NULL
  OR NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'immutable_specialist_absence'); END;

CREATE TRIGGER specialist_absences_no_delete BEFORE DELETE ON specialist_absences
BEGIN SELECT RAISE(ABORT, 'no_routine_delete'); END;
