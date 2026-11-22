-- Preserve applied migration files; replace the trigger with column-explicit
-- inserts so future optional namespace fields do not break authoring writes.
DROP TRIGGER tag_revision_namespace;
-- statement
CREATE TRIGGER tag_revision_namespace AFTER INSERT ON tag_revisions BEGIN
  DELETE FROM tag_name_claims WHERE tag_id = NEW.tag_id;
  INSERT INTO tag_name_claims (normalized_name, tag_id) VALUES (NEW.normalized_name, NEW.tag_id);
  INSERT INTO tag_name_claims (normalized_name, tag_id)
    SELECT normalized_alias, NEW.tag_id FROM tag_aliases
    WHERE tag_id = NEW.tag_id AND tag_revision = NEW.revision;
  INSERT INTO tag_slugs (slug, tag_id) VALUES (NEW.slug, NEW.tag_id) ON CONFLICT(slug) DO NOTHING;
END;
