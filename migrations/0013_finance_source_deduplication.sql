PRAGMA foreign_keys = ON;

ALTER TABLE finance_entries ADD COLUMN source_lookup TEXT CHECK (
  source_lookup IS NULL OR (
    typeof(source_lookup) = 'text'
    AND length(source_lookup) = 46
    AND substr(source_lookup, 1, 2) = 'v1'
    AND substr(source_lookup, 3, 1) = ':'
    AND substr(source_lookup, 4) NOT GLOB '*[^A-Za-z0-9_-]*'
  )
);

CREATE UNIQUE INDEX finance_entries_source_lookup_unique_idx
  ON finance_entries (source_lookup)
  WHERE source_lookup IS NOT NULL;
