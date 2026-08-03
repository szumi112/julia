INSERT INTO system_state (key, value_json, version, updated_at)
VALUES (
  'outbox.drain.last_success',
  '{"completedAt":null}',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
