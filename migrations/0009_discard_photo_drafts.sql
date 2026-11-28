ALTER TABLE photos ADD COLUMN discarded_draft_revision INTEGER
  CHECK (discarded_draft_revision > 0);
-- statement
DROP TRIGGER photo_identity_update;
-- statement
CREATE TRIGGER photo_identity_update BEFORE UPDATE ON photos
WHEN NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
  OR OLD.discarded_draft_revision IS NOT NULL
  OR NOT (
    (NEW.discarded_draft_revision IS NULL
      AND NEW.draft_revision IS COALESCE(OLD.draft_revision, 0) + 1)
    OR (OLD.draft_revision IS NOT NULL AND NEW.draft_revision IS NULL
      AND NEW.discarded_draft_revision IS OLD.draft_revision)
  )
BEGIN
  SELECT CASE WHEN OLD.discarded_draft_revision IS NOT NULL
    THEN RAISE(ABORT, 'photo_draft_discarded') END;
  SELECT RAISE(ABORT, 'invalid_photo_head');
END;
-- statement
CREATE TRIGGER photo_draft_insert_after_discard BEFORE INSERT ON photo_drafts
WHEN EXISTS (SELECT 1 FROM photos WHERE id=NEW.photo_id AND discarded_draft_revision IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'photo_draft_discarded');
END;
-- statement
DROP TRIGGER photo_metadata_drafts_delete;
-- statement
CREATE TRIGGER photo_metadata_drafts_delete BEFORE DELETE ON photo_metadata_drafts
WHEN NOT EXISTS (
  SELECT 1 FROM photos
  WHERE id=OLD.photo_id AND draft_revision IS NULL
    AND discarded_draft_revision=OLD.photo_revision
)
BEGIN
  SELECT RAISE(ABORT, 'immutable_photo_metadata');
END;
-- statement
CREATE TRIGGER photo_discard_draft AFTER UPDATE OF discarded_draft_revision ON photos
WHEN OLD.discarded_draft_revision IS NULL AND NEW.discarded_draft_revision IS NOT NULL
BEGIN
  DELETE FROM photo_draft_tags WHERE photo_id=NEW.id;
  DELETE FROM photo_metadata_drafts WHERE photo_id=NEW.id;
  DELETE FROM photo_drafts WHERE photo_id=NEW.id;
END;
