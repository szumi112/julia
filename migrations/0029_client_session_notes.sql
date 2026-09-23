PRAGMA foreign_keys = ON;

CREATE TABLE client_session_notes (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='cno_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  client_id TEXT NOT NULL REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  author_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  author_specialist_id TEXT NOT NULL REFERENCES specialists(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  body_envelope TEXT NOT NULL CHECK (json_valid(body_envelope))
);

CREATE INDEX client_session_notes_author_page_idx
  ON client_session_notes (client_id,author_staff_id,created_at DESC,id DESC);

CREATE TRIGGER client_session_notes_identity_collision
BEFORE INSERT ON client_session_notes
WHEN EXISTS (SELECT 1 FROM client_session_notes WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'identity_collision'); END;

CREATE TRIGGER client_session_notes_no_update
BEFORE UPDATE ON client_session_notes
BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TRIGGER client_session_notes_no_delete
BEFORE DELETE ON client_session_notes
BEGIN SELECT RAISE(ABORT,'append_only'); END;
