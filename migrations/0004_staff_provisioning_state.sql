-- Task 7 state is permanent. SQL version is a CAS revision, not the logical generation.
INSERT INTO system_state (key, value_json, version, updated_at)
VALUES ('access.desired_generation', '{"generation":0}', 1, '2026-07-30T00:00:00.000Z');
INSERT INTO system_state (key, value_json, version, updated_at)
VALUES ('access.applied_generation', '{"fingerprint":"BYDlKyUUBNO-3cX7_bRPY-TkArudTPGjIdbwtAdLSCw","generation":0}', 1, '2026-07-30T00:00:00.000Z');
INSERT INTO system_state (key, value_json, version, updated_at)
VALUES ('access.reconcile.lease', '{"expiresAt":null,"nonce":null,"owner":null}', 1, '2026-07-30T00:00:00.000Z');
