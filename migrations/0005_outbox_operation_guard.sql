CREATE VIEW outbox_operation_guard_failures (operation_id) AS
SELECT id
FROM outbox_jobs
WHERE 0;

CREATE TRIGGER outbox_operation_guard_failure
INSTEAD OF INSERT ON outbox_operation_guard_failures
BEGIN
  SELECT RAISE(ABORT, 'outbox_operation_guard_failed');
END;
