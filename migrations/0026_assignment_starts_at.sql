DROP TRIGGER client_assignments_immutable_identity;

CREATE TRIGGER client_assignments_immutable_identity
BEFORE UPDATE ON client_assignments
WHEN OLD.id != NEW.id
  OR OLD.client_id != NEW.client_id
  OR OLD.specialist_id != NEW.specialist_id
  OR OLD.assigned_by_staff_id != NEW.assigned_by_staff_id
  OR OLD.created_at != NEW.created_at
  OR (
    OLD.starts_at != NEW.starts_at
    AND NOT (
      OLD.ends_at IS NULL
      AND NEW.ends_at IS NULL
      AND typeof(NEW.version) = 'integer'
      AND NEW.version = OLD.version + 1
      AND NEW.updated_at > OLD.updated_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'immutable_assignment_identity');
END;
