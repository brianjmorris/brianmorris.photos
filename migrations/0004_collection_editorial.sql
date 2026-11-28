-- Editorial values are part of the same immutable tag revision as its aliases.
ALTER TABLE tag_revisions ADD COLUMN notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 20000);
-- statement
ALTER TABLE tag_revisions ADD COLUMN featured_order INTEGER CHECK (featured_order BETWEEN 0 AND 1000000);
-- statement
ALTER TABLE tag_revisions ADD COLUMN cover_photo_id TEXT REFERENCES photos(id);
-- statement
CREATE INDEX tag_revisions_by_name ON tag_revisions(normalized_name, tag_id, revision);
-- statement
-- Validate at save time; publication must revalidate covers against its release.
CREATE TRIGGER tag_cover_published_member BEFORE INSERT ON tag_revisions
WHEN NEW.cover_photo_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM published_photo_tags
  WHERE tag_id = NEW.tag_id AND photo_id = NEW.cover_photo_id
) BEGIN
  SELECT RAISE(ABORT, 'invalid_collection_cover');
END;
