PRAGMA foreign_keys = ON;

ALTER TABLE specialists
  ADD COLUMN long_rate_grosze INTEGER NOT NULL DEFAULT 25000
  CHECK (
    typeof(long_rate_grosze) = 'integer'
    AND long_rate_grosze BETWEEN 1 AND 1000000
  );

ALTER TABLE specialists
  ADD COLUMN specialization_envelope TEXT
  CHECK (specialization_envelope IS NULL OR json_valid(specialization_envelope));
