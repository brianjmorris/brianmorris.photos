-- Test-only derived projection. Not an application migration or release runner.
CREATE TABLE discovery_test_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL) STRICT;
-- statement
INSERT INTO discovery_test_version (id, version) VALUES (1, 1);
-- statement
CREATE TABLE discovery_test_collections (
  kind TEXT NOT NULL CHECK (kind IN ('tag', 'group', 'place')),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  photo_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, id)
) STRICT;
-- statement
CREATE TABLE discovery_test_members (
  kind TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  photo_id TEXT NOT NULL REFERENCES published_photos(photo_id) ON DELETE CASCADE,
  first_published_at INTEGER NOT NULL,
  PRIMARY KEY (kind, collection_id, photo_id),
  FOREIGN KEY (kind, collection_id) REFERENCES discovery_test_collections(kind, id)
) STRICT;
-- statement
CREATE INDEX discovery_test_members_order ON discovery_test_members
  (kind, collection_id, first_published_at DESC, photo_id DESC);
