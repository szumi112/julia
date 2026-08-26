PRAGMA foreign_keys = ON;

ALTER TABLE finance_entries ADD COLUMN source_dedup_lookup TEXT CHECK (
  source_dedup_lookup IS NULL OR (
    typeof(source_dedup_lookup) = 'text'
    AND instr(source_dedup_lookup, ':') BETWEEN 3 AND 10
    AND substr(source_dedup_lookup, 1, 1) = 'v'
    AND substr(source_dedup_lookup, 2, instr(source_dedup_lookup, ':') - 2)
      NOT GLOB '*[^0-9]*'
    AND substr(source_dedup_lookup, 2, 1) GLOB '[1-9]'
    AND length(substr(source_dedup_lookup, instr(source_dedup_lookup, ':') + 1)) = 43
    AND substr(source_dedup_lookup, instr(source_dedup_lookup, ':') + 1)
      NOT GLOB '*[^A-Za-z0-9_-]*'
  )
);

CREATE TRIGGER finance_entries_source_duplicate
BEFORE INSERT ON finance_entries
WHEN NEW.source_dedup_lookup IS NOT NULL AND EXISTS (
  SELECT 1 FROM finance_entries
  WHERE source_dedup_lookup = NEW.source_dedup_lookup
)
BEGIN
  SELECT RAISE(ABORT, 'finance_source_duplicate');
END;

CREATE UNIQUE INDEX finance_entries_source_dedup_lookup_unique_idx
  ON finance_entries (source_dedup_lookup)
  WHERE source_dedup_lookup IS NOT NULL;

CREATE TRIGGER finance_import_chunks_identity_collision
BEFORE INSERT ON finance_import_chunks
WHEN EXISTS (
  SELECT 1 FROM finance_import_chunks
  WHERE batch_id = NEW.batch_id
    AND (sequence = NEW.sequence OR idempotency_key = NEW.idempotency_key)
)
BEGIN
  SELECT RAISE(ABORT, 'identity_collision');
END;
