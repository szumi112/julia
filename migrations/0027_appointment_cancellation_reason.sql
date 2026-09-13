ALTER TABLE appointments ADD COLUMN cancellation_reason TEXT
  CHECK (
    cancellation_reason IS NULL
    OR cancellation_reason IN ('client', 'centre', 'late_paid')
  );
