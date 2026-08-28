PRAGMA foreign_keys = ON;

ALTER TABLE specialists
  ADD COLUMN professional_title_envelope TEXT
  CHECK (professional_title_envelope IS NULL OR length(professional_title_envelope) > 0);

DROP TRIGGER specialists_current_staff_valid_insert;
DROP TRIGGER specialists_current_staff_valid_update;

CREATE TRIGGER specialists_current_staff_valid_insert
BEFORE INSERT ON specialists
WHEN NEW.staff_user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM staff_users AS staff
  WHERE staff.id=NEW.staff_user_id
    AND staff.role IN ('owner','coordinator','specialist')
    AND staff.status IN ('pending','active')
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
    AND staff.role IN ('owner','coordinator','specialist')
    AND staff.status IN ('pending','active')
    AND staff.specialist_id=NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_specialist_staff_link');
END;
