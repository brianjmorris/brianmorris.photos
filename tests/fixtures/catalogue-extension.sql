-- Synthetic future schema, applied only by migration regression tests.
ALTER TABLE photo_revisions ADD COLUMN editorial_label TEXT;
-- statement
ALTER TABLE tag_revisions ADD COLUMN editorial_label TEXT;
-- statement
ALTER TABLE tag_aliases ADD COLUMN naming_note TEXT;
-- statement
ALTER TABLE place_aliases ADD COLUMN naming_note TEXT;
-- statement
ALTER TABLE tag_name_claims ADD COLUMN naming_note TEXT;
-- statement
ALTER TABLE tag_slugs ADD COLUMN redirect_note TEXT;
-- statement
ALTER TABLE catalogue_test_migrations ADD COLUMN applied_note TEXT;
-- statement
CREATE TABLE migration_test_photo_links (
  photo_id TEXT NOT NULL REFERENCES photos(id),
  related_photo_id TEXT NOT NULL REFERENCES photos(id),
  PRIMARY KEY (photo_id, related_photo_id),
  CHECK (photo_id <> related_photo_id)
) STRICT;
