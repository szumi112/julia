PRAGMA foreign_keys = ON;

ALTER TABLE specialists
  ADD COLUMN avatar_key TEXT NOT NULL DEFAULT 'bloom'
  CHECK (avatar_key IN ('bloom','cross','orbit','wave'));
