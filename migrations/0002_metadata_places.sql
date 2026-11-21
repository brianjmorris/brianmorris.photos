-- Immutable extracted evidence; these records do not imply retained source files.
CREATE TABLE photo_source_metadata (
  id TEXT PRIMARY KEY NOT NULL,
  photo_id TEXT NOT NULL REFERENCES photos(id),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  original_filename TEXT NOT NULL,
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  extracted_at INTEGER NOT NULL CHECK (extracted_at >= 0),
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json) AND json_type(raw_json) = 'object'),
  capture_text TEXT,
  capture_subseconds TEXT,
  capture_offset_text TEXT,
  gps_latitude REAL,
  gps_longitude REAL,
  CHECK ((gps_latitude IS NULL AND gps_longitude IS NULL) OR
    (gps_latitude IS NOT NULL AND gps_longitude IS NOT NULL AND
     gps_latitude BETWEEN -90 AND 90 AND gps_longitude BETWEEN -180 AND 180)),
  UNIQUE (photo_id, id),
  UNIQUE (photo_id, source_sha256, parser_name, parser_version)
) STRICT;
-- statement
CREATE TRIGGER source_metadata_immutable_update BEFORE UPDATE ON photo_source_metadata BEGIN
  SELECT RAISE(ABORT, 'immutable_source_metadata');
END;
-- statement
CREATE TRIGGER source_metadata_immutable_delete BEFORE DELETE ON photo_source_metadata BEGIN
  SELECT RAISE(ABORT, 'immutable_source_metadata');
END;
-- statement
CREATE TABLE places (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  draft_revision INTEGER,
  FOREIGN KEY (id, draft_revision) REFERENCES place_revisions(place_id, revision)
) STRICT;
-- statement
CREATE TABLE place_revisions (
  place_id TEXT NOT NULL REFERENCES places(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  kind TEXT NOT NULL CHECK (kind IN ('country', 'region', 'city', 'area', 'site')),
  parent_id TEXT,
  parent_revision INTEGER,
  south REAL,
  north REAL,
  west REAL,
  east REAL,
  provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('manual', 'imported', 'provider')),
  provenance_source TEXT,
  provider_id TEXT,
  PRIMARY KEY (place_id, revision),
  FOREIGN KEY (parent_id, parent_revision) REFERENCES place_revisions(place_id, revision),
  CHECK ((parent_id IS NULL AND parent_revision IS NULL) OR (parent_id IS NOT NULL AND parent_revision IS NOT NULL)),
  CHECK (kind <> 'country' OR parent_id IS NULL),
  CHECK ((south IS NULL AND north IS NULL AND west IS NULL AND east IS NULL) OR
    (south IS NOT NULL AND north IS NOT NULL AND west IS NOT NULL AND east IS NOT NULL AND
     south BETWEEN -90 AND 90 AND north BETWEEN -90 AND 90 AND south <= north AND
     west BETWEEN -180 AND 180 AND east BETWEEN -180 AND 180))
) STRICT;
-- statement
CREATE TABLE place_aliases (
  place_id TEXT NOT NULL,
  place_revision INTEGER NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  PRIMARY KEY (place_id, place_revision, normalized_alias),
  FOREIGN KEY (place_id, place_revision) REFERENCES place_revisions(place_id, revision)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
CREATE TRIGGER place_revision_sequence BEFORE INSERT ON place_revisions BEGIN
  SELECT CASE WHEN NEW.revision <> COALESCE(
    (SELECT draft_revision + 1 FROM places WHERE id = NEW.place_id), 1)
    THEN RAISE(ABORT, 'catalogue_revision_conflict') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM place_revisions WHERE place_id = NEW.parent_id AND revision = NEW.parent_revision
      AND NEW.kind IN ('region', 'city') AND kind NOT IN ('country', 'region')
  ) THEN RAISE(ABORT, 'invalid_place_parent_kind') END;
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE ancestors(place_id, revision, parent_id, parent_revision, depth) AS (
      SELECT place_id, revision, parent_id, parent_revision, 1 FROM place_revisions
        WHERE place_id = NEW.parent_id AND revision = NEW.parent_revision
      UNION ALL
      SELECT p.place_id, p.revision, p.parent_id, p.parent_revision, a.depth + 1
        FROM place_revisions p JOIN ancestors a
        ON p.place_id = a.parent_id AND p.revision = a.parent_revision WHERE a.depth < 16
    ) SELECT 1 FROM ancestors WHERE place_id = NEW.place_id OR depth >= 16
  ) OR NEW.parent_id = NEW.place_id THEN RAISE(ABORT, 'invalid_place_hierarchy') END;
END;
-- statement
CREATE TRIGGER place_revision_immutable_update BEFORE UPDATE ON place_revisions BEGIN
  SELECT RAISE(ABORT, 'immutable_place_revision');
END;
-- statement
CREATE TRIGGER place_revision_immutable_delete BEFORE DELETE ON place_revisions BEGIN
  SELECT RAISE(ABORT, 'immutable_place_revision');
END;
-- statement
CREATE TRIGGER place_identity_update BEFORE UPDATE ON places
WHEN NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
  OR NEW.draft_revision IS NOT COALESCE(OLD.draft_revision, 0) + 1 BEGIN
  SELECT RAISE(ABORT, 'invalid_place_head');
END;
-- statement
CREATE TRIGGER place_aliases_sealed_insert BEFORE INSERT ON place_aliases
WHEN EXISTS (SELECT 1 FROM place_revisions WHERE place_id = NEW.place_id AND revision = NEW.place_revision) BEGIN
  SELECT RAISE(ABORT, 'catalogue_revision_conflict: immutable_place_aliases');
END;
-- statement
CREATE TRIGGER place_aliases_immutable_update BEFORE UPDATE ON place_aliases BEGIN
  SELECT RAISE(ABORT, 'immutable_place_aliases');
END;
-- statement
CREATE TRIGGER place_aliases_immutable_delete BEFORE DELETE ON place_aliases BEGIN
  SELECT RAISE(ABORT, 'immutable_place_aliases');
END;
-- statement
-- Metadata is a child of the same photo revision as its tag memberships.
CREATE TABLE photo_metadata_revisions (
  photo_id TEXT NOT NULL,
  photo_revision INTEGER NOT NULL,
  source_id TEXT,
  title TEXT,
  caption TEXT,
  alt_text TEXT,
  keywords_json TEXT NOT NULL CHECK (json_valid(keywords_json) AND json_type(keywords_json) = 'array'),
  creators_json TEXT NOT NULL CHECK (json_valid(creators_json) AND json_type(creators_json) = 'array'),
  copyright_owners_json TEXT NOT NULL CHECK (json_valid(copyright_owners_json) AND json_type(copyright_owners_json) = 'array'),
  copyright_notice TEXT,
  credit_line TEXT,
  usage_terms TEXT,
  rights_url TEXT,
  public_contact_url TEXT,
  capture_precision TEXT NOT NULL CHECK (capture_precision IN ('unknown', 'date', 'second')),
  capture_date TEXT,
  capture_time TEXT,
  capture_subseconds TEXT,
  offset_minutes INTEGER CHECK (offset_minutes BETWEEN -840 AND 840),
  time_zone TEXT,
  offset_source TEXT,
  capture_utc TEXT,
  clock_correction_seconds INTEGER NOT NULL,
  correction_reason TEXT,
  private_place_id TEXT,
  private_place_revision INTEGER,
  private_latitude REAL,
  private_longitude REAL,
  public_visibility TEXT NOT NULL CHECK (public_visibility IN ('none', 'place', 'approximate', 'exact')),
  public_place_id TEXT,
  public_place_revision INTEGER,
  public_latitude REAL,
  public_longitude REAL,
  public_radius_meters REAL,
  PRIMARY KEY (photo_id, photo_revision),
  FOREIGN KEY (photo_id, photo_revision) REFERENCES photo_revisions(photo_id, revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (photo_id, source_id) REFERENCES photo_source_metadata(photo_id, id),
  FOREIGN KEY (private_place_id, private_place_revision) REFERENCES place_revisions(place_id, revision),
  FOREIGN KEY (public_place_id, public_place_revision) REFERENCES place_revisions(place_id, revision),
  CHECK ((private_place_id IS NULL AND private_place_revision IS NULL) OR (private_place_id IS NOT NULL AND private_place_revision IS NOT NULL)),
  CHECK ((public_place_id IS NULL AND public_place_revision IS NULL) OR (public_place_id IS NOT NULL AND public_place_revision IS NOT NULL)),
  CHECK ((private_latitude IS NULL AND private_longitude IS NULL) OR
    (private_latitude IS NOT NULL AND private_longitude IS NOT NULL AND private_latitude BETWEEN -90 AND 90 AND private_longitude BETWEEN -180 AND 180)),
  CHECK ((public_latitude IS NULL AND public_longitude IS NULL) OR
    (public_latitude IS NOT NULL AND public_longitude IS NOT NULL AND public_latitude BETWEEN -90 AND 90 AND public_longitude BETWEEN -180 AND 180)),
  CHECK ((capture_precision = 'unknown' AND capture_date IS NULL AND capture_time IS NULL AND capture_subseconds IS NULL AND offset_minutes IS NULL AND time_zone IS NULL AND offset_source IS NULL AND capture_utc IS NULL) OR
    (capture_precision = 'date' AND capture_date IS NOT NULL AND capture_time IS NULL AND capture_subseconds IS NULL AND offset_minutes IS NULL AND capture_utc IS NULL) OR
    (capture_precision = 'second' AND capture_date IS NOT NULL AND capture_time IS NOT NULL AND ((offset_minutes IS NULL AND capture_utc IS NULL) OR (offset_minutes IS NOT NULL AND capture_utc IS NOT NULL)))),
  CHECK ((offset_minutes IS NULL AND time_zone IS NULL) OR offset_source IS NOT NULL),
  CHECK (clock_correction_seconds = 0 OR correction_reason IS NOT NULL),
  CHECK (
    (public_visibility = 'none' AND public_place_id IS NULL AND public_latitude IS NULL AND public_longitude IS NULL AND public_radius_meters IS NULL) OR
    (public_visibility = 'place' AND public_place_id IS NOT NULL AND public_latitude IS NULL AND public_longitude IS NULL AND public_radius_meters IS NULL) OR
    (public_visibility = 'approximate' AND public_latitude IS NOT NULL AND public_longitude IS NOT NULL AND public_radius_meters IS NOT NULL AND public_radius_meters > 0) OR
    (public_visibility = 'exact' AND public_latitude IS NOT NULL AND public_longitude IS NOT NULL AND public_radius_meters IS NULL)
  )
) STRICT;
-- statement
CREATE TRIGGER photo_metadata_sealed_insert BEFORE INSERT ON photo_metadata_revisions
WHEN EXISTS (SELECT 1 FROM photo_revisions WHERE photo_id = NEW.photo_id AND revision = NEW.photo_revision) BEGIN
  SELECT RAISE(ABORT, 'catalogue_revision_conflict: immutable_photo_metadata');
END;
-- statement
CREATE TRIGGER photo_metadata_immutable_update BEFORE UPDATE ON photo_metadata_revisions BEGIN
  SELECT RAISE(ABORT, 'immutable_photo_metadata');
END;
-- statement
CREATE TRIGGER photo_metadata_immutable_delete BEFORE DELETE ON photo_metadata_revisions BEGIN
  SELECT RAISE(ABORT, 'immutable_photo_metadata');
END;
