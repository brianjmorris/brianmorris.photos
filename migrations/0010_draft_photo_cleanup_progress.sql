CREATE TABLE draft_photo_cleanup_progress (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;
-- statement
INSERT INTO draft_photo_cleanup_progress (id, cursor, revision) VALUES (1, NULL, 0);
