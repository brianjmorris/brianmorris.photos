-- Application catalogue. Statements are separated for the local D1 test runner.
CREATE TABLE photos (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  draft_revision INTEGER,
  FOREIGN KEY (id, draft_revision) REFERENCES photo_revisions(photo_id, revision)
) STRICT;
-- statement
CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  draft_revision INTEGER,
  FOREIGN KEY (id, draft_revision) REFERENCES tag_revisions(tag_id, revision)
) STRICT;
-- statement
CREATE TABLE photo_revisions (
  photo_id TEXT NOT NULL REFERENCES photos(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (photo_id, revision)
) STRICT;
-- statement
CREATE TABLE tag_revisions (
  tag_id TEXT NOT NULL REFERENCES tags(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 120 AND slug NOT GLOB '*[^a-z0-9-]*'
    AND substr(slug, 1, 1) <> '-' AND substr(slug, -1) <> '-' AND instr(slug, '--') = 0),
  PRIMARY KEY (tag_id, revision)
) STRICT;
-- statement
CREATE TABLE photo_tags (
  photo_id TEXT NOT NULL,
  photo_revision INTEGER NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (photo_id, photo_revision, tag_id),
  FOREIGN KEY (photo_id, photo_revision) REFERENCES photo_revisions(photo_id, revision)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
CREATE TABLE tag_aliases (
  tag_id TEXT NOT NULL,
  tag_revision INTEGER NOT NULL,
  alias TEXT NOT NULL CHECK (length(trim(alias)) BETWEEN 1 AND 120),
  normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) BETWEEN 1 AND 120),
  PRIMARY KEY (tag_id, tag_revision, normalized_alias),
  FOREIGN KEY (tag_id, tag_revision) REFERENCES tag_revisions(tag_id, revision)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
-- Current authoring namespace: names and explicit aliases compete for the same key.
CREATE TABLE tag_name_claims (
  normalized_name TEXT PRIMARY KEY NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id)
) STRICT;
-- statement
CREATE INDEX tag_name_claims_by_tag ON tag_name_claims(tag_id);
-- statement
-- Reserve historical slugs for their stable tag; public redirects arrive with routing.
CREATE TABLE tag_slugs (
  slug TEXT PRIMARY KEY NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id)
) STRICT;
-- statement
CREATE TABLE published_tags (
  tag_id TEXT PRIMARY KEY NOT NULL,
  tag_revision INTEGER NOT NULL,
  FOREIGN KEY (tag_id, tag_revision) REFERENCES tag_revisions(tag_id, revision)
) STRICT;
-- statement
CREATE TABLE published_photos (
  photo_id TEXT PRIMARY KEY NOT NULL,
  photo_revision INTEGER NOT NULL,
  first_published_at INTEGER NOT NULL CHECK (first_published_at >= 0),
  FOREIGN KEY (photo_id, photo_revision) REFERENCES photo_revisions(photo_id, revision),
  UNIQUE (photo_id, photo_revision, first_published_at)
) STRICT;
-- statement
CREATE TABLE published_photo_tags (
  photo_id TEXT NOT NULL,
  photo_revision INTEGER NOT NULL,
  tag_id TEXT NOT NULL REFERENCES published_tags(tag_id),
  first_published_at INTEGER NOT NULL,
  PRIMARY KEY (photo_id, tag_id),
  FOREIGN KEY (photo_id, photo_revision, first_published_at)
    REFERENCES published_photos(photo_id, photo_revision, first_published_at)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (photo_id, photo_revision, tag_id)
    REFERENCES photo_tags(photo_id, photo_revision, tag_id)
) STRICT;
-- statement
CREATE INDEX published_photo_tags_by_tag
  ON published_photo_tags(tag_id, first_published_at DESC, photo_id DESC);
-- statement
CREATE TRIGGER photo_revision_sequence BEFORE INSERT ON photo_revisions BEGIN
  SELECT CASE WHEN NEW.revision <> COALESCE(
    (SELECT draft_revision + 1 FROM photos WHERE id = NEW.photo_id), 1)
    THEN RAISE(ABORT, 'catalogue_revision_conflict') END;
END;
-- statement
CREATE TRIGGER tag_revision_sequence BEFORE INSERT ON tag_revisions BEGIN
  SELECT CASE WHEN NEW.revision <> COALESCE(
    (SELECT draft_revision + 1 FROM tags WHERE id = NEW.tag_id), 1)
    THEN RAISE(ABORT, 'catalogue_revision_conflict') END;
END;
-- statement
CREATE TRIGGER photo_revision_immutable_update BEFORE UPDATE ON photo_revisions BEGIN
  SELECT RAISE(ABORT, 'immutable_photo_revision');
END;
-- statement
CREATE TRIGGER photo_revision_immutable_delete BEFORE DELETE ON photo_revisions BEGIN
  SELECT RAISE(ABORT, 'immutable_photo_revision');
END;
-- statement
CREATE TRIGGER tag_revision_immutable_update BEFORE UPDATE ON tag_revisions BEGIN
  SELECT RAISE(ABORT, 'immutable_tag_revision');
END;
-- statement
CREATE TRIGGER tag_revision_immutable_delete BEFORE DELETE ON tag_revisions BEGIN
  SELECT RAISE(ABORT, 'immutable_tag_revision');
END;
-- statement
-- Children are inserted before their revision in one batch. Inserting the parent
-- seals the membership/alias snapshot; deferred foreign keys reject orphan children.
CREATE TRIGGER photo_tags_sealed_insert BEFORE INSERT ON photo_tags
WHEN EXISTS (SELECT 1 FROM photo_revisions
  WHERE photo_id = NEW.photo_id AND revision = NEW.photo_revision) BEGIN
  SELECT RAISE(ABORT, 'immutable_photo_membership');
END;
-- statement
CREATE TRIGGER photo_tags_immutable_update BEFORE UPDATE ON photo_tags BEGIN
  SELECT RAISE(ABORT, 'immutable_photo_membership');
END;
-- statement
CREATE TRIGGER photo_tags_immutable_delete BEFORE DELETE ON photo_tags BEGIN
  SELECT RAISE(ABORT, 'immutable_photo_membership');
END;
-- statement
CREATE TRIGGER tag_aliases_sealed_insert BEFORE INSERT ON tag_aliases
WHEN EXISTS (SELECT 1 FROM tag_revisions
  WHERE tag_id = NEW.tag_id AND revision = NEW.tag_revision) BEGIN
  SELECT RAISE(ABORT, 'immutable_tag_aliases');
END;
-- statement
CREATE TRIGGER tag_aliases_immutable_update BEFORE UPDATE ON tag_aliases BEGIN
  SELECT RAISE(ABORT, 'immutable_tag_aliases');
END;
-- statement
CREATE TRIGGER tag_aliases_immutable_delete BEFORE DELETE ON tag_aliases BEGIN
  SELECT RAISE(ABORT, 'immutable_tag_aliases');
END;
-- statement
CREATE TRIGGER photo_identity_update BEFORE UPDATE ON photos
WHEN NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
  OR NEW.draft_revision IS NOT COALESCE(OLD.draft_revision, 0) + 1 BEGIN
  SELECT RAISE(ABORT, 'invalid_photo_head');
END;
-- statement
CREATE TRIGGER tag_identity_update BEFORE UPDATE ON tags
WHEN NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
  OR NEW.draft_revision IS NOT COALESCE(OLD.draft_revision, 0) + 1 BEGIN
  SELECT RAISE(ABORT, 'invalid_tag_head');
END;
-- statement
CREATE TRIGGER tag_slug_reservation BEFORE INSERT ON tag_revisions
WHEN EXISTS (SELECT 1 FROM tag_slugs WHERE slug = NEW.slug AND tag_id <> NEW.tag_id) BEGIN
  SELECT RAISE(ABORT, 'catalogue_slug_conflict');
END;
-- statement
CREATE TRIGGER tag_revision_namespace AFTER INSERT ON tag_revisions BEGIN
  DELETE FROM tag_name_claims WHERE tag_id = NEW.tag_id;
  INSERT INTO tag_name_claims VALUES (NEW.normalized_name, NEW.tag_id);
  INSERT INTO tag_name_claims
    SELECT normalized_alias, NEW.tag_id FROM tag_aliases
    WHERE tag_id = NEW.tag_id AND tag_revision = NEW.revision;
  INSERT INTO tag_slugs VALUES (NEW.slug, NEW.tag_id) ON CONFLICT(slug) DO NOTHING;
END;
