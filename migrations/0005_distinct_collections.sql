-- A combination has one stable identity. Notes/name/cover are revisioned;
-- membership is always the intersection of its defining canonical tags.
CREATE TABLE collections (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  tag_set_key TEXT NOT NULL UNIQUE CHECK (json_valid(tag_set_key) AND json_type(tag_set_key) = 'array' AND json_array_length(tag_set_key) BETWEEN 2 AND 64),
  draft_revision INTEGER,
  FOREIGN KEY (id, draft_revision) REFERENCES collection_revisions(collection_id, revision)
) STRICT;
-- statement
CREATE TABLE collection_tags (
  collection_id TEXT NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (collection_id, tag_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
CREATE INDEX collection_tags_by_tag ON collection_tags(tag_id, collection_id);
-- statement
CREATE TABLE collection_revisions (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  name TEXT CHECK (name IS NULL OR length(trim(name)) BETWEEN 1 AND 120),
  notes TEXT NOT NULL CHECK (length(notes) <= 20000),
  featured_order INTEGER CHECK (featured_order BETWEEN 0 AND 1000000),
  cover_photo_id TEXT REFERENCES photos(id),
  PRIMARY KEY (collection_id, revision),
  CHECK (featured_order IS NULL OR name IS NOT NULL)
) STRICT;
-- statement
CREATE TABLE published_collections (
  collection_id TEXT PRIMARY KEY NOT NULL,
  collection_revision INTEGER NOT NULL,
  FOREIGN KEY (collection_id, collection_revision) REFERENCES collection_revisions(collection_id, revision)
) STRICT;
-- statement
CREATE TRIGGER collection_definition BEFORE INSERT ON collections
WHEN NEW.tag_set_key IS NOT (
  SELECT json_group_array(tag_id) FROM (
    SELECT tag_id FROM collection_tags WHERE collection_id = NEW.id ORDER BY tag_id COLLATE BINARY
  )
) BEGIN
  SELECT RAISE(ABORT, 'invalid_collection_definition');
END;
-- statement
CREATE TRIGGER collection_tags_sealed_insert BEFORE INSERT ON collection_tags
WHEN EXISTS (SELECT 1 FROM collections WHERE id = NEW.collection_id) BEGIN
  SELECT RAISE(ABORT, 'immutable_collection_definition');
END;
-- statement
CREATE TRIGGER collection_tags_immutable_update BEFORE UPDATE ON collection_tags BEGIN
  SELECT RAISE(ABORT, 'immutable_collection_definition');
END;
-- statement
CREATE TRIGGER collection_tags_immutable_delete BEFORE DELETE ON collection_tags BEGIN
  SELECT RAISE(ABORT, 'immutable_collection_definition');
END;
-- statement
CREATE TRIGGER collection_identity_update BEFORE UPDATE ON collections
WHEN NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at OR NEW.tag_set_key <> OLD.tag_set_key
  OR NEW.draft_revision IS NOT COALESCE(OLD.draft_revision, 0) + 1 BEGIN
  SELECT RAISE(ABORT, 'invalid_collection_head');
END;
-- statement
CREATE TRIGGER collection_identity_delete BEFORE DELETE ON collections BEGIN
  SELECT RAISE(ABORT, 'immutable_collection_definition');
END;
-- statement
CREATE TRIGGER collection_revision_sequence BEFORE INSERT ON collection_revisions
WHEN NEW.revision <> COALESCE((SELECT draft_revision + 1 FROM collections WHERE id = NEW.collection_id), 1) BEGIN
  SELECT RAISE(ABORT, 'catalogue_revision_conflict');
END;
-- statement
CREATE TRIGGER collection_revision_immutable_update BEFORE UPDATE ON collection_revisions BEGIN
  SELECT RAISE(ABORT, 'immutable_collection_revision');
END;
-- statement
CREATE TRIGGER collection_revision_immutable_delete BEFORE DELETE ON collection_revisions BEGIN
  SELECT RAISE(ABORT, 'immutable_collection_revision');
END;
-- statement
CREATE TRIGGER collection_cover_published_member BEFORE INSERT ON collection_revisions
WHEN NEW.cover_photo_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM collection_tags t WHERE t.collection_id = NEW.collection_id AND NOT EXISTS (
    SELECT 1 FROM published_photo_tags p WHERE p.tag_id = t.tag_id AND p.photo_id = NEW.cover_photo_id
  )
) BEGIN
  SELECT RAISE(ABORT, 'invalid_collection_cover');
END;
-- statement
CREATE TRIGGER published_collection_valid_insert BEFORE INSERT ON published_collections
WHEN NOT EXISTS (
  SELECT 1 FROM collection_revisions WHERE collection_id = NEW.collection_id
    AND revision = NEW.collection_revision AND (name IS NOT NULL OR length(trim(notes, char(9) || char(10) || char(13) || ' ')) > 0)
) OR EXISTS (
  SELECT 1 FROM collection_tags t WHERE t.collection_id = NEW.collection_id
    AND NOT EXISTS (SELECT 1 FROM published_tags p WHERE p.tag_id = t.tag_id)
) OR EXISTS (
  SELECT 1 FROM collection_revisions r JOIN collection_tags t ON t.collection_id = r.collection_id
  WHERE r.collection_id = NEW.collection_id AND r.revision = NEW.collection_revision AND r.cover_photo_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM published_photo_tags p WHERE p.tag_id = t.tag_id AND p.photo_id = r.cover_photo_id)
) BEGIN
  SELECT RAISE(ABORT, 'invalid_published_collection');
END;
-- statement
CREATE TRIGGER published_collection_valid_update BEFORE UPDATE ON published_collections
WHEN NEW.collection_id <> OLD.collection_id OR NOT EXISTS (
  SELECT 1 FROM collection_revisions WHERE collection_id = NEW.collection_id
    AND revision = NEW.collection_revision AND (name IS NOT NULL OR length(trim(notes, char(9) || char(10) || char(13) || ' ')) > 0)
) OR EXISTS (
  SELECT 1 FROM collection_tags t WHERE t.collection_id = NEW.collection_id
    AND NOT EXISTS (SELECT 1 FROM published_tags p WHERE p.tag_id = t.tag_id)
) OR EXISTS (
  SELECT 1 FROM collection_revisions r JOIN collection_tags t ON t.collection_id = r.collection_id
  WHERE r.collection_id = NEW.collection_id AND r.revision = NEW.collection_revision AND r.cover_photo_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM published_photo_tags p WHERE p.tag_id = t.tag_id AND p.photo_id = r.cover_photo_id)
) BEGIN
  SELECT RAISE(ABORT, 'invalid_published_collection');
END;
