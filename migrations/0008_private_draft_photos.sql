CREATE TABLE photo_draft_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  photo_id TEXT NOT NULL REFERENCES photos(id),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 41943040),
  state TEXT NOT NULL CHECK (state IN ('pending', 'attached', 'retired')),
  expires_at INTEGER NOT NULL,
  CHECK (state <> 'attached' OR expires_at = 0)
) STRICT;
-- statement
CREATE UNIQUE INDEX photo_draft_attachment_one_photo
  ON photo_draft_attachments(photo_id) WHERE state IN ('pending', 'attached');
-- statement
CREATE UNIQUE INDEX photo_draft_attachment_one_digest
  ON photo_draft_attachments(sha256) WHERE state IN ('pending', 'attached');
-- statement
CREATE INDEX photo_draft_attachment_cleanup
  ON photo_draft_attachments(state, expires_at, id) WHERE state <> 'attached';
-- statement
CREATE TRIGGER photo_draft_attachment_discard
  AFTER DELETE ON photo_drafts
BEGIN
  UPDATE photo_draft_attachments SET state='retired'
    WHERE photo_id=OLD.photo_id AND state IN ('pending', 'attached');
END;
