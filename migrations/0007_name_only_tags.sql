-- Legacy addresses remain mapped in tag_slugs. Current tag snapshots use IDs.
DROP TRIGGER tag_draft_slug_insert;
-- statement
DROP TRIGGER tag_draft_slug_update;
-- statement
DROP TRIGGER tag_draft_namespace_insert;
-- statement
DROP TRIGGER tag_draft_namespace_update;
-- statement
DROP TRIGGER tag_publication_insert;
-- statement
DROP TRIGGER tag_publication_update;
-- statement
DROP VIEW tag_states;
-- statement
ALTER TABLE tag_drafts DROP COLUMN slug;
-- statement
ALTER TABLE tag_public DROP COLUMN slug;
-- statement
CREATE VIEW tag_states AS
  SELECT tag_id, revision, created_at, name, normalized_name, notes, featured_order, cover_photo_id FROM tag_drafts
  UNION ALL
  SELECT p.tag_id, p.revision, p.created_at, p.name, p.normalized_name, p.notes, p.featured_order, p.cover_photo_id FROM tag_public p
  WHERE NOT EXISTS (SELECT 1 FROM tag_drafts d WHERE d.tag_id=p.tag_id AND d.revision=p.revision);
-- statement
CREATE TRIGGER tag_draft_namespace_insert AFTER INSERT ON tag_drafts BEGIN
  INSERT INTO tag_name_claims (normalized_name, tag_id) VALUES (NEW.normalized_name, NEW.tag_id);
  INSERT INTO tag_name_claims (normalized_name, tag_id)
    SELECT normalized_alias, NEW.tag_id FROM tag_draft_aliases WHERE tag_id=NEW.tag_id AND tag_revision=NEW.revision;
END;
-- statement
CREATE TRIGGER tag_draft_namespace_update AFTER UPDATE ON tag_drafts BEGIN
  DELETE FROM tag_name_claims WHERE tag_id=NEW.tag_id;
  INSERT INTO tag_name_claims (normalized_name, tag_id) VALUES (NEW.normalized_name, NEW.tag_id);
  INSERT INTO tag_name_claims (normalized_name, tag_id)
    SELECT normalized_alias, NEW.tag_id FROM tag_draft_aliases WHERE tag_id=NEW.tag_id AND tag_revision=NEW.revision;
END;
-- statement
CREATE TRIGGER tag_publication_insert BEFORE INSERT ON published_tags BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision)
    AND NOT EXISTS (SELECT 1 FROM tag_public WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision)
    THEN RAISE(ABORT, 'catalogue_revision_conflict') END;
  INSERT INTO tag_public (tag_id, revision, created_at, name, normalized_name, notes, featured_order, cover_photo_id)
    SELECT tag_id, revision, created_at, name, normalized_name, notes, featured_order, cover_photo_id FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision
    ON CONFLICT(tag_id) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at, name=excluded.name, normalized_name=excluded.normalized_name, notes=excluded.notes, featured_order=excluded.featured_order, cover_photo_id=excluded.cover_photo_id;
  DELETE FROM tag_public_aliases WHERE tag_id=NEW.tag_id AND EXISTS (SELECT 1 FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision);
  INSERT INTO tag_public_aliases (tag_id, tag_revision, alias, normalized_alias)
    SELECT tag_id, tag_revision, alias, normalized_alias FROM tag_draft_aliases WHERE tag_id=NEW.tag_id AND tag_revision=NEW.tag_revision;
END;
-- statement
CREATE TRIGGER tag_publication_update BEFORE UPDATE ON published_tags BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision)
    AND NOT EXISTS (SELECT 1 FROM tag_public WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision)
    THEN RAISE(ABORT, 'catalogue_revision_conflict') END;
  SELECT CASE WHEN NEW.tag_id<>OLD.tag_id THEN RAISE(ABORT, 'catalogue_publication_conflict') END;
  INSERT INTO tag_public (tag_id, revision, created_at, name, normalized_name, notes, featured_order, cover_photo_id)
    SELECT tag_id, revision, created_at, name, normalized_name, notes, featured_order, cover_photo_id FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision
    ON CONFLICT(tag_id) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at, name=excluded.name, normalized_name=excluded.normalized_name, notes=excluded.notes, featured_order=excluded.featured_order, cover_photo_id=excluded.cover_photo_id;
  DELETE FROM tag_public_aliases WHERE tag_id=NEW.tag_id AND EXISTS (SELECT 1 FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision);
  INSERT INTO tag_public_aliases (tag_id, tag_revision, alias, normalized_alias)
    SELECT tag_id, tag_revision, alias, normalized_alias FROM tag_draft_aliases WHERE tag_id=NEW.tag_id AND tag_revision=NEW.tag_revision;
END;
-- statement
CREATE VIRTUAL TABLE tag_search USING fts5(
  normalized_name, tokenize='unicode61 remove_diacritics 0', prefix='2 3 4'
);
-- statement
CREATE TABLE tag_search_terms (
  id INTEGER PRIMARY KEY,
  normalized_name TEXT NOT NULL UNIQUE
) STRICT;
-- statement
INSERT INTO tag_search_terms (normalized_name) SELECT normalized_name FROM tag_name_claims;
-- statement
INSERT INTO tag_search (rowid, normalized_name) SELECT id, normalized_name FROM tag_search_terms;
-- statement
CREATE TRIGGER tag_search_insert AFTER INSERT ON tag_name_claims BEGIN
  INSERT INTO tag_search_terms (normalized_name) VALUES (NEW.normalized_name);
  INSERT INTO tag_search (rowid, normalized_name)
    SELECT id, normalized_name FROM tag_search_terms WHERE normalized_name=NEW.normalized_name;
END;
-- statement
CREATE TRIGGER tag_search_delete AFTER DELETE ON tag_name_claims BEGIN
  DELETE FROM tag_search WHERE rowid=(SELECT id FROM tag_search_terms WHERE normalized_name=OLD.normalized_name);
  DELETE FROM tag_search_terms WHERE normalized_name=OLD.normalized_name;
END;
-- statement
CREATE TRIGGER tag_search_update AFTER UPDATE OF normalized_name ON tag_name_claims BEGIN
  UPDATE tag_search SET normalized_name=NEW.normalized_name
    WHERE rowid=(SELECT id FROM tag_search_terms WHERE normalized_name=OLD.normalized_name);
  UPDATE tag_search_terms SET normalized_name=NEW.normalized_name WHERE normalized_name=OLD.normalized_name;
END;
-- statement
CREATE TABLE tag_cooccurrences (
  tag_id TEXT NOT NULL REFERENCES tags(id),
  related_id TEXT NOT NULL REFERENCES tags(id),
  photo_count INTEGER NOT NULL CHECK (photo_count > 0),
  PRIMARY KEY (tag_id, related_id),
  CHECK (tag_id <> related_id)
) STRICT;
-- statement
INSERT INTO tag_cooccurrences (tag_id, related_id, photo_count)
  SELECT a.tag_id, b.tag_id, count(*) FROM photo_draft_tags a JOIN photo_draft_tags b
  ON a.photo_id=b.photo_id AND a.photo_revision=b.photo_revision AND a.tag_id<>b.tag_id
  GROUP BY a.tag_id, b.tag_id;
-- statement
CREATE INDEX tag_cooccurrences_by_strength ON tag_cooccurrences(tag_id, photo_count DESC, related_id);
-- statement
CREATE UNIQUE INDEX photo_draft_tags_by_photo_and_tag ON photo_draft_tags(photo_id, tag_id);
-- statement
DROP TRIGGER photo_draft_tags_update;
-- statement
CREATE TRIGGER photo_draft_tags_update BEFORE UPDATE ON photo_draft_tags
  WHEN NEW.photo_id<>OLD.photo_id OR NEW.tag_id<>OLD.tag_id OR NEW.photo_revision<>OLD.photo_revision+1
    OR NEW.photo_revision<>COALESCE((SELECT draft_revision+1 FROM photos WHERE id=NEW.photo_id),1)
  BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER photo_draft_tags_limit BEFORE INSERT ON photo_draft_tags
  WHEN (SELECT count(*) FROM photo_draft_tags WHERE photo_id=NEW.photo_id) >= 64
  BEGIN SELECT RAISE(ABORT, 'photo_tag_limit'); END;
-- statement
CREATE TRIGGER photo_draft_tag_cooccurrence_insert AFTER INSERT ON photo_draft_tags BEGIN
  INSERT INTO tag_cooccurrences (tag_id, related_id, photo_count)
    SELECT NEW.tag_id, tag_id, 1 FROM photo_draft_tags WHERE photo_id=NEW.photo_id AND tag_id<>NEW.tag_id
    UNION ALL
    SELECT tag_id, NEW.tag_id, 1 FROM photo_draft_tags WHERE photo_id=NEW.photo_id AND tag_id<>NEW.tag_id
    ON CONFLICT(tag_id, related_id) DO UPDATE SET photo_count=photo_count+1;
END;
-- statement
CREATE TRIGGER photo_draft_tag_cooccurrence_delete AFTER DELETE ON photo_draft_tags BEGIN
  DELETE FROM tag_cooccurrences WHERE photo_count=1 AND (
    (tag_id=OLD.tag_id AND related_id IN (SELECT tag_id FROM photo_draft_tags WHERE photo_id=OLD.photo_id)) OR
    (related_id=OLD.tag_id AND tag_id IN (SELECT tag_id FROM photo_draft_tags WHERE photo_id=OLD.photo_id))
  );
  UPDATE tag_cooccurrences SET photo_count=photo_count-1 WHERE
    (tag_id=OLD.tag_id AND related_id IN (SELECT tag_id FROM photo_draft_tags WHERE photo_id=OLD.photo_id)) OR
    (related_id=OLD.tag_id AND tag_id IN (SELECT tag_id FROM photo_draft_tags WHERE photo_id=OLD.photo_id));
END;
