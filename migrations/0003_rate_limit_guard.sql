CREATE VIEW rate_limit_guard_failures (audit_id) AS
SELECT id
FROM audit_events
WHERE 0;

CREATE TRIGGER rate_limit_guard_failure
INSTEAD OF INSERT ON rate_limit_guard_failures
BEGIN
  SELECT RAISE(ABORT, 'rate_limit_guard_failed');
END;
