CREATE TABLE draft_photo_cleanup_runs (
  trigger TEXT PRIMARY KEY NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER NOT NULL CHECK (finished_at >= started_at),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
  scanned INTEGER CHECK (scanned >= 0),
  retired_keys INTEGER CHECK (retired_keys >= 0),
  orphaned_keys INTEGER CHECK (orphaned_keys >= 0),
  more_work INTEGER CHECK (more_work IN (0, 1)),
  CHECK (
    (outcome='completed' AND scanned IS NOT NULL AND retired_keys IS NOT NULL
      AND orphaned_keys IS NOT NULL AND more_work IS NOT NULL)
    OR (outcome='failed' AND scanned IS NULL AND retired_keys IS NULL
      AND orphaned_keys IS NULL AND more_work IS NULL)
  )
) STRICT;
