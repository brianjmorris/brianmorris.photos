-- Replace editorial history with one mutable draft and one published copy.
-- Run the entire migration in one transaction; source evidence is retained.
PRAGMA defer_foreign_keys = ON;
-- statement
CREATE TABLE photo_drafts (
  photo_id TEXT NOT NULL REFERENCES photos(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (photo_id),
  UNIQUE (photo_id, revision)
) STRICT;
-- statement
CREATE TABLE tag_drafts (
  tag_id TEXT NOT NULL REFERENCES tags(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 120 AND slug NOT GLOB '*[^a-z0-9-]*'
    AND substr(slug, 1, 1) <> '-' AND substr(slug, -1) <> '-' AND instr(slug, '--') = 0), notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 20000), featured_order INTEGER CHECK (featured_order BETWEEN 0 AND 1000000), cover_photo_id TEXT REFERENCES photos(id),
  PRIMARY KEY (tag_id),
  UNIQUE (tag_id, revision)
) STRICT;
-- statement
CREATE TABLE place_drafts (
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
  ancestry_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ancestry_json) AND json_type(ancestry_json) = 'array' AND json_array_length(ancestry_json) <= 15),
  PRIMARY KEY (place_id),
  UNIQUE (place_id, revision),
  FOREIGN KEY (parent_id) REFERENCES places(id),
  CHECK ((parent_id IS NULL AND parent_revision IS NULL) OR (parent_id IS NOT NULL AND parent_revision IS NOT NULL)),
  CHECK (kind <> 'country' OR parent_id IS NULL),
  CHECK ((south IS NULL AND north IS NULL AND west IS NULL AND east IS NULL) OR
    (south IS NOT NULL AND north IS NOT NULL AND west IS NOT NULL AND east IS NOT NULL AND
     south BETWEEN -90 AND 90 AND north BETWEEN -90 AND 90 AND south <= north AND
     west BETWEEN -180 AND 180 AND east BETWEEN -180 AND 180))
) STRICT;
-- statement
CREATE TABLE collection_drafts (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  name TEXT CHECK (name IS NULL OR length(trim(name)) BETWEEN 1 AND 120),
  notes TEXT NOT NULL CHECK (length(notes) <= 20000),
  featured_order INTEGER CHECK (featured_order BETWEEN 0 AND 1000000),
  cover_photo_id TEXT REFERENCES photos(id),
  PRIMARY KEY (collection_id),
  UNIQUE (collection_id, revision),
  CHECK (featured_order IS NULL OR name IS NOT NULL)
) STRICT;
-- statement
CREATE TABLE photo_draft_tags (
  photo_id TEXT NOT NULL,
  photo_revision INTEGER NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (photo_id, photo_revision, tag_id),
  FOREIGN KEY (photo_id, photo_revision) REFERENCES photo_drafts(photo_id, revision)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
CREATE TABLE tag_draft_aliases (
  tag_id TEXT NOT NULL,
  tag_revision INTEGER NOT NULL,
  alias TEXT NOT NULL CHECK (length(trim(alias)) BETWEEN 1 AND 120),
  normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) BETWEEN 1 AND 120),
  PRIMARY KEY (tag_id, tag_revision, normalized_alias),
  FOREIGN KEY (tag_id, tag_revision) REFERENCES tag_drafts(tag_id, revision)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
CREATE TABLE place_draft_aliases (
  place_id TEXT NOT NULL,
  place_revision INTEGER NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  PRIMARY KEY (place_id, place_revision, normalized_alias),
  FOREIGN KEY (place_id, place_revision) REFERENCES place_drafts(place_id, revision)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
CREATE TABLE photo_metadata_drafts (
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
  private_place_json TEXT CHECK (private_place_json IS NULL OR (json_valid(private_place_json) AND json_type(private_place_json) = 'array' AND json_array_length(private_place_json) BETWEEN 1 AND 16)),
  public_place_json TEXT CHECK (public_place_json IS NULL OR (json_valid(public_place_json) AND json_type(public_place_json) = 'array' AND json_array_length(public_place_json) BETWEEN 1 AND 16)),
  PRIMARY KEY (photo_id),
  UNIQUE (photo_id, photo_revision),
  FOREIGN KEY (photo_id, photo_revision) REFERENCES photo_drafts(photo_id, revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (photo_id, source_id) REFERENCES photo_source_metadata(photo_id, id),
  CHECK ((private_place_id IS NULL) = (private_place_json IS NULL)),
  CHECK ((public_place_id IS NULL) = (public_place_json IS NULL)),
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
CREATE TABLE photo_public (
  photo_id TEXT NOT NULL REFERENCES photos(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (photo_id),
  UNIQUE (photo_id, revision)
) STRICT;
-- statement
CREATE TABLE tag_public (
  tag_id TEXT NOT NULL REFERENCES tags(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 120 AND slug NOT GLOB '*[^a-z0-9-]*'
    AND substr(slug, 1, 1) <> '-' AND substr(slug, -1) <> '-' AND instr(slug, '--') = 0), notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 20000), featured_order INTEGER CHECK (featured_order BETWEEN 0 AND 1000000), cover_photo_id TEXT REFERENCES photos(id),
  PRIMARY KEY (tag_id),
  UNIQUE (tag_id, revision)
) STRICT;
-- statement
CREATE TABLE collection_public (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  name TEXT CHECK (name IS NULL OR length(trim(name)) BETWEEN 1 AND 120),
  notes TEXT NOT NULL CHECK (length(notes) <= 20000),
  featured_order INTEGER CHECK (featured_order BETWEEN 0 AND 1000000),
  cover_photo_id TEXT REFERENCES photos(id),
  PRIMARY KEY (collection_id),
  UNIQUE (collection_id, revision),
  CHECK (featured_order IS NULL OR name IS NOT NULL)
) STRICT;
-- statement
CREATE TABLE tag_public_aliases (
  tag_id TEXT NOT NULL,
  tag_revision INTEGER NOT NULL,
  alias TEXT NOT NULL CHECK (length(trim(alias)) BETWEEN 1 AND 120),
  normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) BETWEEN 1 AND 120),
  PRIMARY KEY (tag_id, tag_revision, normalized_alias),
  FOREIGN KEY (tag_id, tag_revision) REFERENCES tag_public(tag_id, revision)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
CREATE TABLE photo_public_all_tags (
  photo_id TEXT NOT NULL,
  photo_revision INTEGER NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (photo_id, photo_revision, tag_id),
  FOREIGN KEY (photo_id, photo_revision) REFERENCES photo_public(photo_id, revision)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
CREATE TABLE photo_metadata_public (
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
  private_place_json TEXT CHECK (private_place_json IS NULL OR (json_valid(private_place_json) AND json_type(private_place_json) = 'array' AND json_array_length(private_place_json) BETWEEN 1 AND 16)),
  public_place_json TEXT CHECK (public_place_json IS NULL OR (json_valid(public_place_json) AND json_type(public_place_json) = 'array' AND json_array_length(public_place_json) BETWEEN 1 AND 16)),
  PRIMARY KEY (photo_id),
  UNIQUE (photo_id, photo_revision),
  FOREIGN KEY (photo_id, photo_revision) REFERENCES photo_public(photo_id, revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (photo_id, source_id) REFERENCES photo_source_metadata(photo_id, id),
  CHECK ((private_place_id IS NULL) = (private_place_json IS NULL)),
  CHECK ((public_place_id IS NULL) = (public_place_json IS NULL)),
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
INSERT INTO photo_drafts (photo_id, revision, created_at)
    SELECT r.photo_id, r.revision, r.created_at
    FROM photo_revisions r JOIN photos i ON i.id = r.photo_id AND i.draft_revision = r.revision;
-- statement
INSERT INTO photo_public (photo_id, revision, created_at) SELECT r.photo_id, r.revision, r.created_at
    FROM photo_revisions r JOIN published_photos p ON p.photo_id = r.photo_id AND p.photo_revision = r.revision;
-- statement
INSERT INTO tag_drafts (tag_id, revision, created_at, name, normalized_name, slug, notes, featured_order, cover_photo_id)
    SELECT r.tag_id, r.revision, r.created_at, r.name, r.normalized_name, r.slug, r.notes, r.featured_order, r.cover_photo_id
    FROM tag_revisions r JOIN tags i ON i.id = r.tag_id AND i.draft_revision = r.revision;
-- statement
INSERT INTO tag_public (tag_id, revision, created_at, name, normalized_name, slug, notes, featured_order, cover_photo_id) SELECT r.tag_id, r.revision, r.created_at, r.name, r.normalized_name, r.slug, r.notes, r.featured_order, r.cover_photo_id
    FROM tag_revisions r JOIN published_tags p ON p.tag_id = r.tag_id AND p.tag_revision = r.revision;
-- statement
INSERT INTO place_drafts (place_id, revision, created_at, name, kind, parent_id, parent_revision, south, north, west, east, provenance_kind, provenance_source, provider_id, ancestry_json)
    SELECT r.place_id, r.revision, r.created_at, r.name, r.kind, r.parent_id, r.parent_revision, r.south, r.north, r.west, r.east, r.provenance_kind, r.provenance_source, r.provider_id, CASE WHEN r.parent_id IS NULL THEN '[]' ELSE (WITH RECURSIVE chain AS (
  SELECT p.*, 0 AS depth FROM place_revisions p WHERE p.place_id = r.parent_id AND p.revision = r.parent_revision
  UNION ALL SELECT p.*, c.depth + 1 FROM place_revisions p JOIN chain c
    ON p.place_id = c.parent_id AND p.revision = c.parent_revision WHERE c.depth < 15
) SELECT json_group_array(json_object('placeId', place_id, 'revision', revision, 'name', name, 'kind', kind,
  'aliases', json((SELECT json_group_array(alias) FROM (SELECT alias FROM place_aliases a WHERE a.place_id = ordered.place_id AND a.place_revision = ordered.revision ORDER BY normalized_alias))),
  'bounds', CASE WHEN south IS NULL THEN NULL ELSE json_object('south', south, 'north', north, 'west', west, 'east', east) END))
  FROM (SELECT * FROM chain ORDER BY depth) ordered) END
    FROM place_revisions r JOIN places i ON i.id = r.place_id AND i.draft_revision = r.revision;
-- statement
INSERT INTO collection_drafts (collection_id, revision, created_at, name, notes, featured_order, cover_photo_id)
    SELECT r.collection_id, r.revision, r.created_at, r.name, r.notes, r.featured_order, r.cover_photo_id
    FROM collection_revisions r JOIN collections i ON i.id = r.collection_id AND i.draft_revision = r.revision;
-- statement
INSERT INTO collection_public (collection_id, revision, created_at, name, notes, featured_order, cover_photo_id) SELECT r.collection_id, r.revision, r.created_at, r.name, r.notes, r.featured_order, r.cover_photo_id
    FROM collection_revisions r JOIN published_collections p ON p.collection_id = r.collection_id AND p.collection_revision = r.revision;
-- statement
INSERT INTO photo_draft_tags (photo_id, photo_revision, tag_id) SELECT r.photo_id, r.photo_revision, r.tag_id FROM photo_tags r JOIN photos i ON i.id=r.photo_id AND i.draft_revision=r.photo_revision;
-- statement
INSERT INTO photo_public_all_tags (photo_id, photo_revision, tag_id)
    SELECT r.photo_id, r.photo_revision, r.tag_id FROM photo_tags r JOIN published_photos p ON p.photo_id=r.photo_id AND p.photo_revision=r.photo_revision;
-- statement
INSERT INTO tag_draft_aliases (tag_id, tag_revision, alias, normalized_alias) SELECT r.tag_id, r.tag_revision, r.alias, r.normalized_alias FROM tag_aliases r JOIN tags i ON i.id=r.tag_id AND i.draft_revision=r.tag_revision;
-- statement
INSERT INTO tag_public_aliases (tag_id, tag_revision, alias, normalized_alias)
    SELECT r.tag_id, r.tag_revision, r.alias, r.normalized_alias FROM tag_aliases r JOIN published_tags p ON p.tag_id=r.tag_id AND p.tag_revision=r.tag_revision;
-- statement
INSERT INTO place_draft_aliases (place_id, place_revision, alias, normalized_alias) SELECT r.place_id, r.place_revision, r.alias, r.normalized_alias FROM place_aliases r JOIN places i ON i.id=r.place_id AND i.draft_revision=r.place_revision;
-- statement
INSERT INTO photo_metadata_drafts (photo_id, photo_revision, source_id, title, caption, alt_text, keywords_json, creators_json, copyright_owners_json, copyright_notice, credit_line, usage_terms, rights_url, public_contact_url, capture_precision, capture_date, capture_time, capture_subseconds, offset_minutes, time_zone, offset_source, capture_utc, clock_correction_seconds, correction_reason, private_place_id, private_place_revision, private_latitude, private_longitude, public_visibility, public_place_id, public_place_revision, public_latitude, public_longitude, public_radius_meters, private_place_json, public_place_json)
    SELECT m.photo_id, m.photo_revision, m.source_id, m.title, m.caption, m.alt_text, m.keywords_json, m.creators_json, m.copyright_owners_json, m.copyright_notice, m.credit_line, m.usage_terms, m.rights_url, m.public_contact_url, m.capture_precision, m.capture_date, m.capture_time, m.capture_subseconds, m.offset_minutes, m.time_zone, m.offset_source, m.capture_utc, m.clock_correction_seconds, m.correction_reason, m.private_place_id, m.private_place_revision, m.private_latitude, m.private_longitude, m.public_visibility, m.public_place_id, m.public_place_revision, m.public_latitude, m.public_longitude, m.public_radius_meters,
      CASE WHEN m.private_place_id IS NULL THEN NULL ELSE (WITH RECURSIVE chain AS (
  SELECT p.*, 0 AS depth FROM place_revisions p WHERE p.place_id = m.private_place_id AND p.revision = m.private_place_revision
  UNION ALL SELECT p.*, c.depth + 1 FROM place_revisions p JOIN chain c
    ON p.place_id = c.parent_id AND p.revision = c.parent_revision WHERE c.depth < 15
) SELECT json_group_array(json_object('placeId', place_id, 'revision', revision, 'name', name, 'kind', kind,
  'aliases', json((SELECT json_group_array(alias) FROM (SELECT alias FROM place_aliases a WHERE a.place_id = ordered.place_id AND a.place_revision = ordered.revision ORDER BY normalized_alias))),
  'bounds', CASE WHEN south IS NULL THEN NULL ELSE json_object('south', south, 'north', north, 'west', west, 'east', east) END))
  FROM (SELECT * FROM chain ORDER BY depth) ordered) END,
      CASE WHEN m.public_place_id IS NULL THEN NULL ELSE (WITH RECURSIVE chain AS (
  SELECT p.*, 0 AS depth FROM place_revisions p WHERE p.place_id = m.public_place_id AND p.revision = m.public_place_revision
  UNION ALL SELECT p.*, c.depth + 1 FROM place_revisions p JOIN chain c
    ON p.place_id = c.parent_id AND p.revision = c.parent_revision WHERE c.depth < 15
) SELECT json_group_array(json_object('placeId', place_id, 'revision', revision, 'name', name, 'kind', kind,
  'aliases', json((SELECT json_group_array(alias) FROM (SELECT alias FROM place_aliases a WHERE a.place_id = ordered.place_id AND a.place_revision = ordered.revision ORDER BY normalized_alias))),
  'bounds', CASE WHEN south IS NULL THEN NULL ELSE json_object('south', south, 'north', north, 'west', west, 'east', east) END))
  FROM (SELECT * FROM chain ORDER BY depth) ordered) END
    FROM photo_metadata_revisions m JOIN photos p ON p.id=m.photo_id AND p.draft_revision=m.photo_revision;
-- statement
INSERT INTO photo_metadata_public (photo_id, photo_revision, source_id, title, caption, alt_text, keywords_json, creators_json, copyright_owners_json, copyright_notice, credit_line, usage_terms, rights_url, public_contact_url, capture_precision, capture_date, capture_time, capture_subseconds, offset_minutes, time_zone, offset_source, capture_utc, clock_correction_seconds, correction_reason, private_place_id, private_place_revision, private_latitude, private_longitude, public_visibility, public_place_id, public_place_revision, public_latitude, public_longitude, public_radius_meters, private_place_json, public_place_json)
    SELECT m.photo_id, m.photo_revision, m.source_id, m.title, m.caption, m.alt_text, m.keywords_json, m.creators_json, m.copyright_owners_json, m.copyright_notice, m.credit_line, m.usage_terms, m.rights_url, m.public_contact_url, m.capture_precision, m.capture_date, m.capture_time, m.capture_subseconds, m.offset_minutes, m.time_zone, m.offset_source, m.capture_utc, m.clock_correction_seconds, m.correction_reason, m.private_place_id, m.private_place_revision, m.private_latitude, m.private_longitude, m.public_visibility, m.public_place_id, m.public_place_revision, m.public_latitude, m.public_longitude, m.public_radius_meters,
      CASE WHEN m.private_place_id IS NULL THEN NULL ELSE (WITH RECURSIVE chain AS (
  SELECT p.*, 0 AS depth FROM place_revisions p WHERE p.place_id = m.private_place_id AND p.revision = m.private_place_revision
  UNION ALL SELECT p.*, c.depth + 1 FROM place_revisions p JOIN chain c
    ON p.place_id = c.parent_id AND p.revision = c.parent_revision WHERE c.depth < 15
) SELECT json_group_array(json_object('placeId', place_id, 'revision', revision, 'name', name, 'kind', kind,
  'aliases', json((SELECT json_group_array(alias) FROM (SELECT alias FROM place_aliases a WHERE a.place_id = ordered.place_id AND a.place_revision = ordered.revision ORDER BY normalized_alias))),
  'bounds', CASE WHEN south IS NULL THEN NULL ELSE json_object('south', south, 'north', north, 'west', west, 'east', east) END))
  FROM (SELECT * FROM chain ORDER BY depth) ordered) END,
      CASE WHEN m.public_place_id IS NULL THEN NULL ELSE (WITH RECURSIVE chain AS (
  SELECT p.*, 0 AS depth FROM place_revisions p WHERE p.place_id = m.public_place_id AND p.revision = m.public_place_revision
  UNION ALL SELECT p.*, c.depth + 1 FROM place_revisions p JOIN chain c
    ON p.place_id = c.parent_id AND p.revision = c.parent_revision WHERE c.depth < 15
) SELECT json_group_array(json_object('placeId', place_id, 'revision', revision, 'name', name, 'kind', kind,
  'aliases', json((SELECT json_group_array(alias) FROM (SELECT alias FROM place_aliases a WHERE a.place_id = ordered.place_id AND a.place_revision = ordered.revision ORDER BY normalized_alias))),
  'bounds', CASE WHEN south IS NULL THEN NULL ELSE json_object('south', south, 'north', north, 'west', west, 'east', east) END))
  FROM (SELECT * FROM chain ORDER BY depth) ordered) END
    FROM photo_metadata_revisions m JOIN published_photos p ON p.photo_id=m.photo_id AND p.photo_revision=m.photo_revision;
-- statement
CREATE TABLE transition_photos AS SELECT * FROM photos;
-- statement
CREATE TABLE transition_tags AS SELECT * FROM tags;
-- statement
CREATE TABLE transition_places AS SELECT * FROM places;
-- statement
CREATE TABLE transition_collections AS SELECT * FROM collections;
-- statement
CREATE TABLE transition_published_tags AS SELECT * FROM published_tags;
-- statement
CREATE TABLE transition_published_photos AS SELECT * FROM published_photos;
-- statement
CREATE TABLE transition_published_collections AS SELECT * FROM published_collections;
-- statement
CREATE TABLE transition_published_photo_tags AS SELECT * FROM published_photo_tags;
-- statement
DROP TRIGGER photo_revision_sequence;
-- statement
DROP TRIGGER tag_revision_sequence;
-- statement
DROP TRIGGER photo_revision_immutable_update;
-- statement
DROP TRIGGER photo_revision_immutable_delete;
-- statement
DROP TRIGGER tag_revision_immutable_update;
-- statement
DROP TRIGGER tag_revision_immutable_delete;
-- statement
DROP TRIGGER photo_tags_sealed_insert;
-- statement
DROP TRIGGER photo_tags_immutable_update;
-- statement
DROP TRIGGER photo_tags_immutable_delete;
-- statement
DROP TRIGGER tag_aliases_sealed_insert;
-- statement
DROP TRIGGER tag_aliases_immutable_update;
-- statement
DROP TRIGGER tag_aliases_immutable_delete;
-- statement
DROP TRIGGER photo_identity_update;
-- statement
DROP TRIGGER tag_identity_update;
-- statement
DROP TRIGGER tag_slug_reservation;
-- statement
DROP TRIGGER place_revision_sequence;
-- statement
DROP TRIGGER place_revision_immutable_update;
-- statement
DROP TRIGGER place_revision_immutable_delete;
-- statement
DROP TRIGGER place_identity_update;
-- statement
DROP TRIGGER place_aliases_sealed_insert;
-- statement
DROP TRIGGER place_aliases_immutable_update;
-- statement
DROP TRIGGER place_aliases_immutable_delete;
-- statement
DROP TRIGGER photo_metadata_sealed_insert;
-- statement
DROP TRIGGER photo_metadata_immutable_update;
-- statement
DROP TRIGGER photo_metadata_immutable_delete;
-- statement
DROP TRIGGER tag_revision_namespace;
-- statement
DROP TRIGGER tag_cover_published_member;
-- statement
DROP TRIGGER collection_definition;
-- statement
DROP TRIGGER collection_tags_sealed_insert;
-- statement
DROP TRIGGER collection_tags_immutable_update;
-- statement
DROP TRIGGER collection_tags_immutable_delete;
-- statement
DROP TRIGGER collection_identity_update;
-- statement
DROP TRIGGER collection_identity_delete;
-- statement
DROP TRIGGER collection_revision_sequence;
-- statement
DROP TRIGGER collection_revision_immutable_update;
-- statement
DROP TRIGGER collection_revision_immutable_delete;
-- statement
DROP TRIGGER collection_cover_published_member;
-- statement
DROP TRIGGER published_collection_valid_insert;
-- statement
DROP TRIGGER published_collection_valid_update;
-- statement
DROP TABLE published_photo_tags;
-- statement
DROP TABLE published_collections;
-- statement
DROP TABLE published_photos;
-- statement
DROP TABLE published_tags;
-- statement
DROP TABLE photo_metadata_revisions;
-- statement
DROP TABLE place_aliases;
-- statement
DROP TABLE tag_aliases;
-- statement
DROP TABLE photo_tags;
-- statement
DROP TABLE collection_revisions;
-- statement
DROP TABLE place_revisions;
-- statement
DROP TABLE tag_revisions;
-- statement
DROP TABLE photo_revisions;
-- statement
DROP TABLE collections;
-- statement
DROP TABLE places;
-- statement
DROP TABLE tags;
-- statement
DROP TABLE photos;
-- statement
CREATE TABLE photos (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  draft_revision INTEGER,
  FOREIGN KEY (id, draft_revision) REFERENCES photo_drafts(photo_id, revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
INSERT INTO photos (id, created_at, draft_revision) SELECT id, created_at, draft_revision FROM transition_photos;
-- statement
DROP TABLE transition_photos;
-- statement
CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  draft_revision INTEGER,
  FOREIGN KEY (id, draft_revision) REFERENCES tag_drafts(tag_id, revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
INSERT INTO tags (id, created_at, draft_revision) SELECT id, created_at, draft_revision FROM transition_tags;
-- statement
DROP TABLE transition_tags;
-- statement
CREATE TABLE places (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  draft_revision INTEGER,
  FOREIGN KEY (id, draft_revision) REFERENCES place_drafts(place_id, revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
INSERT INTO places (id, created_at, draft_revision) SELECT id, created_at, draft_revision FROM transition_places;
-- statement
DROP TABLE transition_places;
-- statement
CREATE TABLE collections (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  tag_set_key TEXT NOT NULL UNIQUE CHECK (json_valid(tag_set_key) AND json_type(tag_set_key) = 'array' AND json_array_length(tag_set_key) BETWEEN 2 AND 64),
  draft_revision INTEGER,
  FOREIGN KEY (id, draft_revision) REFERENCES collection_drafts(collection_id, revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
INSERT INTO collections (id, created_at, tag_set_key, draft_revision) SELECT id, created_at, tag_set_key, draft_revision FROM transition_collections;
-- statement
DROP TABLE transition_collections;
-- statement
CREATE TABLE published_tags (
  tag_id TEXT PRIMARY KEY NOT NULL,
  tag_revision INTEGER NOT NULL,
  FOREIGN KEY (tag_id, tag_revision) REFERENCES tag_public(tag_id, revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
INSERT INTO published_tags (tag_id, tag_revision) SELECT tag_id, tag_revision FROM transition_published_tags;
-- statement
DROP TABLE transition_published_tags;
-- statement
CREATE TABLE published_photos (
  photo_id TEXT PRIMARY KEY NOT NULL,
  photo_revision INTEGER NOT NULL,
  first_published_at INTEGER NOT NULL CHECK (first_published_at >= 0),
  FOREIGN KEY (photo_id, photo_revision) REFERENCES photo_public(photo_id, revision) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (photo_id, photo_revision, first_published_at)
) STRICT;
-- statement
INSERT INTO published_photos (photo_id, photo_revision, first_published_at) SELECT photo_id, photo_revision, first_published_at FROM transition_published_photos;
-- statement
DROP TABLE transition_published_photos;
-- statement
CREATE TABLE published_collections (
  collection_id TEXT PRIMARY KEY NOT NULL,
  collection_revision INTEGER NOT NULL,
  FOREIGN KEY (collection_id, collection_revision) REFERENCES collection_public(collection_id, revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
INSERT INTO published_collections (collection_id, collection_revision) SELECT collection_id, collection_revision FROM transition_published_collections;
-- statement
DROP TABLE transition_published_collections;
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
    REFERENCES photo_public_all_tags(photo_id, photo_revision, tag_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- statement
INSERT INTO published_photo_tags (photo_id, photo_revision, tag_id, first_published_at) SELECT photo_id, photo_revision, tag_id, first_published_at FROM transition_published_photo_tags;
-- statement
DROP TABLE transition_published_photo_tags;
-- statement
CREATE INDEX published_photo_tags_by_tag ON published_photo_tags(tag_id, first_published_at DESC, photo_id DESC);
-- statement
CREATE INDEX tag_drafts_by_name ON tag_drafts(normalized_name, tag_id, revision);
-- statement
CREATE VIEW photo_states AS SELECT photo_id, revision, created_at FROM photo_drafts UNION ALL SELECT p.photo_id, p.revision, p.created_at FROM photo_public p
    WHERE NOT EXISTS (SELECT 1 FROM photo_drafts d WHERE d.photo_id=p.photo_id AND d.revision=p.revision);
-- statement
CREATE VIEW tag_states AS SELECT tag_id, revision, created_at, name, normalized_name, slug, notes, featured_order, cover_photo_id FROM tag_drafts UNION ALL SELECT p.tag_id, p.revision, p.created_at, p.name, p.normalized_name, p.slug, p.notes, p.featured_order, p.cover_photo_id FROM tag_public p
    WHERE NOT EXISTS (SELECT 1 FROM tag_drafts d WHERE d.tag_id=p.tag_id AND d.revision=p.revision);
-- statement
CREATE VIEW collection_states AS SELECT collection_id, revision, created_at, name, notes, featured_order, cover_photo_id FROM collection_drafts UNION ALL SELECT p.collection_id, p.revision, p.created_at, p.name, p.notes, p.featured_order, p.cover_photo_id FROM collection_public p
    WHERE NOT EXISTS (SELECT 1 FROM collection_drafts d WHERE d.collection_id=p.collection_id AND d.revision=p.revision);
-- statement
CREATE VIEW photo_tags AS SELECT photo_id, photo_revision, tag_id FROM photo_draft_tags UNION ALL SELECT p.photo_id, p.photo_revision, p.tag_id FROM photo_public_all_tags p
    WHERE NOT EXISTS (SELECT 1 FROM photo_drafts d WHERE d.photo_id=p.photo_id AND d.revision=p.photo_revision);
-- statement
CREATE VIEW tag_aliases AS SELECT tag_id, tag_revision, alias, normalized_alias FROM tag_draft_aliases UNION ALL SELECT p.tag_id, p.tag_revision, p.alias, p.normalized_alias FROM tag_public_aliases p
    WHERE NOT EXISTS (SELECT 1 FROM tag_drafts d WHERE d.tag_id=p.tag_id AND d.revision=p.tag_revision);
-- statement
CREATE VIEW photo_metadata_states AS SELECT photo_id, photo_revision, source_id, title, caption, alt_text, keywords_json, creators_json, copyright_owners_json, copyright_notice, credit_line, usage_terms, rights_url, public_contact_url, capture_precision, capture_date, capture_time, capture_subseconds, offset_minutes, time_zone, offset_source, capture_utc, clock_correction_seconds, correction_reason, private_place_id, private_place_revision, private_latitude, private_longitude, public_visibility, public_place_id, public_place_revision, public_latitude, public_longitude, public_radius_meters, private_place_json, public_place_json FROM photo_metadata_drafts UNION ALL SELECT p.photo_id, p.photo_revision, p.source_id, p.title, p.caption, p.alt_text, p.keywords_json, p.creators_json, p.copyright_owners_json, p.copyright_notice, p.credit_line, p.usage_terms, p.rights_url, p.public_contact_url, p.capture_precision, p.capture_date, p.capture_time, p.capture_subseconds, p.offset_minutes, p.time_zone, p.offset_source, p.capture_utc, p.clock_correction_seconds, p.correction_reason, p.private_place_id, p.private_place_revision, p.private_latitude, p.private_longitude, p.public_visibility, p.public_place_id, p.public_place_revision, p.public_latitude, p.public_longitude, p.public_radius_meters, p.private_place_json, p.public_place_json FROM photo_metadata_public p
    WHERE NOT EXISTS (SELECT 1 FROM photo_drafts d WHERE d.photo_id=p.photo_id AND d.revision=p.photo_revision);
-- statement
CREATE TRIGGER photo_draft_insert BEFORE INSERT ON photo_drafts WHEN NEW.revision <> 1 BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER photo_draft_update BEFORE UPDATE ON photo_drafts
    WHEN NEW.photo_id <> OLD.photo_id OR NEW.revision <> OLD.revision + 1
    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER photo_identity_update BEFORE UPDATE ON photos
WHEN NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
  OR NEW.draft_revision IS NOT COALESCE(OLD.draft_revision, 0) + 1 BEGIN
  SELECT RAISE(ABORT, 'invalid_photo_head');
END;
-- statement
CREATE TRIGGER tag_draft_insert BEFORE INSERT ON tag_drafts WHEN NEW.revision <> 1 BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER tag_draft_update BEFORE UPDATE ON tag_drafts
    WHEN NEW.tag_id <> OLD.tag_id OR NEW.revision <> OLD.revision + 1
    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER tag_identity_update BEFORE UPDATE ON tags
WHEN NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
  OR NEW.draft_revision IS NOT COALESCE(OLD.draft_revision, 0) + 1 BEGIN
  SELECT RAISE(ABORT, 'invalid_tag_head');
END;
-- statement
CREATE TRIGGER place_draft_insert BEFORE INSERT ON place_drafts WHEN NEW.revision <> 1 BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER place_draft_update BEFORE UPDATE ON place_drafts
    WHEN NEW.place_id <> OLD.place_id OR NEW.revision <> OLD.revision + 1
    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER place_identity_update BEFORE UPDATE ON places
WHEN NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
  OR NEW.draft_revision IS NOT COALESCE(OLD.draft_revision, 0) + 1 BEGIN
  SELECT RAISE(ABORT, 'invalid_place_head');
END;
-- statement
CREATE TRIGGER collection_draft_insert BEFORE INSERT ON collection_drafts WHEN NEW.revision <> 1 BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER collection_draft_update BEFORE UPDATE ON collection_drafts
    WHEN NEW.collection_id <> OLD.collection_id OR NEW.revision <> OLD.revision + 1
    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER collection_identity_update BEFORE UPDATE ON collections
WHEN NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at OR NEW.tag_set_key <> OLD.tag_set_key
  OR NEW.draft_revision IS NOT COALESCE(OLD.draft_revision, 0) + 1 BEGIN
  SELECT RAISE(ABORT, 'invalid_collection_head');
END;
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
CREATE TRIGGER collection_identity_delete BEFORE DELETE ON collections BEGIN
  SELECT RAISE(ABORT, 'immutable_collection_definition');
END;
-- statement
CREATE TRIGGER photo_draft_tags_next_version BEFORE INSERT ON photo_draft_tags
    WHEN NEW.photo_revision <> COALESCE((SELECT draft_revision+1 FROM photos WHERE id=NEW.photo_id),1)
    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER photo_draft_tags_update BEFORE UPDATE ON photo_draft_tags

    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER tag_draft_aliases_next_version BEFORE INSERT ON tag_draft_aliases
    WHEN NEW.tag_revision <> COALESCE((SELECT draft_revision+1 FROM tags WHERE id=NEW.tag_id),1)
    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER tag_draft_aliases_update BEFORE UPDATE ON tag_draft_aliases

    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER place_draft_aliases_next_version BEFORE INSERT ON place_draft_aliases
    WHEN NEW.place_revision <> COALESCE((SELECT draft_revision+1 FROM places WHERE id=NEW.place_id),1)
    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER place_draft_aliases_update BEFORE UPDATE ON place_draft_aliases

    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER photo_metadata_drafts_next_version BEFORE INSERT ON photo_metadata_drafts
    WHEN NEW.photo_revision <> COALESCE((SELECT draft_revision+1 FROM photos WHERE id=NEW.photo_id),1)
    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER photo_metadata_drafts_update BEFORE UPDATE ON photo_metadata_drafts
    WHEN NEW.photo_id<>OLD.photo_id OR NEW.photo_revision<>OLD.photo_revision+1
      OR NEW.photo_revision <> (SELECT draft_revision+1 FROM photos WHERE id=NEW.photo_id)
    BEGIN SELECT RAISE(ABORT, 'catalogue_revision_conflict'); END;
-- statement
CREATE TRIGGER photo_metadata_drafts_delete BEFORE DELETE ON photo_metadata_drafts
  BEGIN SELECT RAISE(ABORT, 'immutable_photo_metadata'); END;
-- statement
CREATE TRIGGER place_draft_hierarchy_insert BEFORE INSERT ON place_drafts
    WHEN (NEW.parent_id IS NOT NULL AND (json_array_length(NEW.ancestry_json)=0
      OR json_extract(NEW.ancestry_json,'$[0].placeId') IS NOT NEW.parent_id
      OR json_extract(NEW.ancestry_json,'$[0].revision') IS NOT NEW.parent_revision))
      OR (NEW.parent_id IS NULL AND json_array_length(NEW.ancestry_json)<>0)
      OR EXISTS (SELECT 1 FROM json_each(NEW.ancestry_json) WHERE json_extract(value,'$.placeId')=NEW.place_id)
      OR json_array_length(NEW.ancestry_json)>15
    BEGIN SELECT RAISE(ABORT, 'invalid_place_hierarchy'); END;
-- statement
CREATE TRIGGER place_draft_parent_kind_insert BEFORE INSERT ON place_drafts
    WHEN NEW.parent_id IS NOT NULL AND NEW.kind IN ('region','city') AND json_extract(NEW.ancestry_json,'$[0].kind') NOT IN ('country','region')
    BEGIN SELECT RAISE(ABORT, 'invalid_place_parent_kind'); END;
-- statement
CREATE TRIGGER tag_draft_slug_insert BEFORE INSERT ON tag_drafts WHEN EXISTS
    (SELECT 1 FROM tag_slugs WHERE slug=NEW.slug AND tag_id<>NEW.tag_id)
    BEGIN SELECT RAISE(ABORT, 'catalogue_slug_conflict'); END;
-- statement
CREATE TRIGGER tag_draft_namespace_insert AFTER INSERT ON tag_drafts BEGIN
    DELETE FROM tag_name_claims WHERE tag_id=NEW.tag_id;
    INSERT INTO tag_name_claims (normalized_name,tag_id) VALUES (NEW.normalized_name,NEW.tag_id);
    INSERT INTO tag_name_claims (normalized_name,tag_id) SELECT normalized_alias,NEW.tag_id FROM tag_draft_aliases WHERE tag_id=NEW.tag_id AND tag_revision=NEW.revision;
    INSERT INTO tag_slugs (slug,tag_id) VALUES (NEW.slug,NEW.tag_id) ON CONFLICT(slug) DO NOTHING;
  END;
-- statement
CREATE TRIGGER collection_draft_cover_insert BEFORE INSERT ON collection_drafts
    WHEN NEW.cover_photo_id IS NOT NULL AND EXISTS (SELECT 1 FROM collection_tags t WHERE t.collection_id=NEW.collection_id
      AND NOT EXISTS (SELECT 1 FROM published_photo_tags p WHERE p.tag_id=t.tag_id AND p.photo_id=NEW.cover_photo_id))
    BEGIN SELECT RAISE(ABORT, 'invalid_collection_cover'); END;
-- statement
CREATE TRIGGER place_draft_hierarchy_update BEFORE UPDATE ON place_drafts
    WHEN (NEW.parent_id IS NOT NULL AND (json_array_length(NEW.ancestry_json)=0
      OR json_extract(NEW.ancestry_json,'$[0].placeId') IS NOT NEW.parent_id
      OR json_extract(NEW.ancestry_json,'$[0].revision') IS NOT NEW.parent_revision))
      OR (NEW.parent_id IS NULL AND json_array_length(NEW.ancestry_json)<>0)
      OR EXISTS (SELECT 1 FROM json_each(NEW.ancestry_json) WHERE json_extract(value,'$.placeId')=NEW.place_id)
      OR json_array_length(NEW.ancestry_json)>15
    BEGIN SELECT RAISE(ABORT, 'invalid_place_hierarchy'); END;
-- statement
CREATE TRIGGER place_draft_parent_kind_update BEFORE UPDATE ON place_drafts
    WHEN NEW.parent_id IS NOT NULL AND NEW.kind IN ('region','city') AND json_extract(NEW.ancestry_json,'$[0].kind') NOT IN ('country','region')
    BEGIN SELECT RAISE(ABORT, 'invalid_place_parent_kind'); END;
-- statement
CREATE TRIGGER tag_draft_slug_update BEFORE UPDATE ON tag_drafts WHEN EXISTS
    (SELECT 1 FROM tag_slugs WHERE slug=NEW.slug AND tag_id<>NEW.tag_id)
    BEGIN SELECT RAISE(ABORT, 'catalogue_slug_conflict'); END;
-- statement
CREATE TRIGGER tag_draft_namespace_update AFTER UPDATE ON tag_drafts BEGIN
    DELETE FROM tag_name_claims WHERE tag_id=NEW.tag_id;
    INSERT INTO tag_name_claims (normalized_name,tag_id) VALUES (NEW.normalized_name,NEW.tag_id);
    INSERT INTO tag_name_claims (normalized_name,tag_id) SELECT normalized_alias,NEW.tag_id FROM tag_draft_aliases WHERE tag_id=NEW.tag_id AND tag_revision=NEW.revision;
    INSERT INTO tag_slugs (slug,tag_id) VALUES (NEW.slug,NEW.tag_id) ON CONFLICT(slug) DO NOTHING;
  END;
-- statement
CREATE TRIGGER collection_draft_cover_update BEFORE UPDATE ON collection_drafts
    WHEN NEW.cover_photo_id IS NOT NULL AND EXISTS (SELECT 1 FROM collection_tags t WHERE t.collection_id=NEW.collection_id
      AND NOT EXISTS (SELECT 1 FROM published_photo_tags p WHERE p.tag_id=t.tag_id AND p.photo_id=NEW.cover_photo_id))
    BEGIN SELECT RAISE(ABORT, 'invalid_collection_cover'); END;
-- statement
CREATE TRIGGER photo_publication_insert BEFORE INSERT ON published_photos BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM photo_drafts WHERE photo_id=NEW.photo_id AND revision=NEW.photo_revision)
        AND NOT EXISTS (SELECT 1 FROM photo_public WHERE photo_id=NEW.photo_id AND revision=NEW.photo_revision)
        THEN RAISE(ABORT, 'catalogue_revision_conflict') END;


      INSERT INTO photo_public (photo_id, revision, created_at) SELECT photo_id, revision, created_at FROM photo_drafts WHERE photo_id=NEW.photo_id AND revision=NEW.photo_revision
        ON CONFLICT(photo_id) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at;

      DELETE FROM photo_public_all_tags WHERE photo_id=NEW.photo_id AND EXISTS (SELECT 1 FROM photo_drafts WHERE photo_id=NEW.photo_id AND revision=NEW.photo_revision);
        INSERT INTO photo_public_all_tags (photo_id,photo_revision,tag_id) SELECT photo_id,photo_revision,tag_id FROM photo_draft_tags WHERE photo_id=NEW.photo_id AND photo_revision=NEW.photo_revision;
        DELETE FROM photo_metadata_public WHERE photo_id=NEW.photo_id AND EXISTS (SELECT 1 FROM photo_drafts WHERE photo_id=NEW.photo_id AND revision=NEW.photo_revision);
        INSERT INTO photo_metadata_public (photo_id, photo_revision, source_id, title, caption, alt_text, keywords_json, creators_json, copyright_owners_json, copyright_notice, credit_line, usage_terms, rights_url, public_contact_url, capture_precision, capture_date, capture_time, capture_subseconds, offset_minutes, time_zone, offset_source, capture_utc, clock_correction_seconds, correction_reason, private_place_id, private_place_revision, private_latitude, private_longitude, public_visibility, public_place_id, public_place_revision, public_latitude, public_longitude, public_radius_meters,private_place_json,public_place_json)
          SELECT photo_id, photo_revision, source_id, title, caption, alt_text, keywords_json, creators_json, copyright_owners_json, copyright_notice, credit_line, usage_terms, rights_url, public_contact_url, capture_precision, capture_date, capture_time, capture_subseconds, offset_minutes, time_zone, offset_source, capture_utc, clock_correction_seconds, correction_reason, private_place_id, private_place_revision, private_latitude, private_longitude, public_visibility, public_place_id, public_place_revision, public_latitude, public_longitude, public_radius_meters,private_place_json,public_place_json FROM photo_metadata_drafts WHERE photo_id=NEW.photo_id AND photo_revision=NEW.photo_revision;
    END;
-- statement
CREATE TRIGGER photo_publication_update BEFORE UPDATE ON published_photos BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM photo_drafts WHERE photo_id=NEW.photo_id AND revision=NEW.photo_revision)
        AND NOT EXISTS (SELECT 1 FROM photo_public WHERE photo_id=NEW.photo_id AND revision=NEW.photo_revision)
        THEN RAISE(ABORT, 'catalogue_revision_conflict') END;
      SELECT CASE WHEN NEW.photo_id <> OLD.photo_id OR NEW.first_published_at <> OLD.first_published_at THEN RAISE(ABORT, 'catalogue_publication_conflict') END;

      INSERT INTO photo_public (photo_id, revision, created_at) SELECT photo_id, revision, created_at FROM photo_drafts WHERE photo_id=NEW.photo_id AND revision=NEW.photo_revision
        ON CONFLICT(photo_id) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at;

      DELETE FROM photo_public_all_tags WHERE photo_id=NEW.photo_id AND EXISTS (SELECT 1 FROM photo_drafts WHERE photo_id=NEW.photo_id AND revision=NEW.photo_revision);
        INSERT INTO photo_public_all_tags (photo_id,photo_revision,tag_id) SELECT photo_id,photo_revision,tag_id FROM photo_draft_tags WHERE photo_id=NEW.photo_id AND photo_revision=NEW.photo_revision;
        DELETE FROM photo_metadata_public WHERE photo_id=NEW.photo_id AND EXISTS (SELECT 1 FROM photo_drafts WHERE photo_id=NEW.photo_id AND revision=NEW.photo_revision);
        INSERT INTO photo_metadata_public (photo_id, photo_revision, source_id, title, caption, alt_text, keywords_json, creators_json, copyright_owners_json, copyright_notice, credit_line, usage_terms, rights_url, public_contact_url, capture_precision, capture_date, capture_time, capture_subseconds, offset_minutes, time_zone, offset_source, capture_utc, clock_correction_seconds, correction_reason, private_place_id, private_place_revision, private_latitude, private_longitude, public_visibility, public_place_id, public_place_revision, public_latitude, public_longitude, public_radius_meters,private_place_json,public_place_json)
          SELECT photo_id, photo_revision, source_id, title, caption, alt_text, keywords_json, creators_json, copyright_owners_json, copyright_notice, credit_line, usage_terms, rights_url, public_contact_url, capture_precision, capture_date, capture_time, capture_subseconds, offset_minutes, time_zone, offset_source, capture_utc, clock_correction_seconds, correction_reason, private_place_id, private_place_revision, private_latitude, private_longitude, public_visibility, public_place_id, public_place_revision, public_latitude, public_longitude, public_radius_meters,private_place_json,public_place_json FROM photo_metadata_drafts WHERE photo_id=NEW.photo_id AND photo_revision=NEW.photo_revision;
    END;
-- statement
CREATE TRIGGER photo_withdrawal AFTER DELETE ON published_photos BEGIN
    DELETE FROM photo_metadata_public WHERE photo_id=OLD.photo_id; DELETE FROM photo_public_all_tags WHERE photo_id=OLD.photo_id;

    DELETE FROM photo_public WHERE photo_id=OLD.photo_id;
  END;
-- statement
CREATE TRIGGER tag_publication_insert BEFORE INSERT ON published_tags BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision)
        AND NOT EXISTS (SELECT 1 FROM tag_public WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision)
        THEN RAISE(ABORT, 'catalogue_revision_conflict') END;


      INSERT INTO tag_public (tag_id, revision, created_at, name, normalized_name, slug, notes, featured_order, cover_photo_id) SELECT tag_id, revision, created_at, name, normalized_name, slug, notes, featured_order, cover_photo_id FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision
        ON CONFLICT(tag_id) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at, name=excluded.name, normalized_name=excluded.normalized_name, slug=excluded.slug, notes=excluded.notes, featured_order=excluded.featured_order, cover_photo_id=excluded.cover_photo_id;
      DELETE FROM tag_public_aliases WHERE tag_id=NEW.tag_id AND EXISTS (SELECT 1 FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision);
        INSERT INTO tag_public_aliases (tag_id,tag_revision,alias,normalized_alias) SELECT tag_id,tag_revision,alias,normalized_alias FROM tag_draft_aliases WHERE tag_id=NEW.tag_id AND tag_revision=NEW.tag_revision;

    END;
-- statement
CREATE TRIGGER tag_publication_update BEFORE UPDATE ON published_tags BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision)
        AND NOT EXISTS (SELECT 1 FROM tag_public WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision)
        THEN RAISE(ABORT, 'catalogue_revision_conflict') END;
      SELECT CASE WHEN NEW.tag_id <> OLD.tag_id  THEN RAISE(ABORT, 'catalogue_publication_conflict') END;

      INSERT INTO tag_public (tag_id, revision, created_at, name, normalized_name, slug, notes, featured_order, cover_photo_id) SELECT tag_id, revision, created_at, name, normalized_name, slug, notes, featured_order, cover_photo_id FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision
        ON CONFLICT(tag_id) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at, name=excluded.name, normalized_name=excluded.normalized_name, slug=excluded.slug, notes=excluded.notes, featured_order=excluded.featured_order, cover_photo_id=excluded.cover_photo_id;
      DELETE FROM tag_public_aliases WHERE tag_id=NEW.tag_id AND EXISTS (SELECT 1 FROM tag_drafts WHERE tag_id=NEW.tag_id AND revision=NEW.tag_revision);
        INSERT INTO tag_public_aliases (tag_id,tag_revision,alias,normalized_alias) SELECT tag_id,tag_revision,alias,normalized_alias FROM tag_draft_aliases WHERE tag_id=NEW.tag_id AND tag_revision=NEW.tag_revision;

    END;
-- statement
CREATE TRIGGER tag_withdrawal AFTER DELETE ON published_tags BEGIN

    DELETE FROM tag_public_aliases WHERE tag_id=OLD.tag_id;
    DELETE FROM tag_public WHERE tag_id=OLD.tag_id;
  END;
-- statement
CREATE TRIGGER collection_publication_insert BEFORE INSERT ON published_collections BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM collection_drafts WHERE collection_id=NEW.collection_id AND revision=NEW.collection_revision)
        AND NOT EXISTS (SELECT 1 FROM collection_public WHERE collection_id=NEW.collection_id AND revision=NEW.collection_revision)
        THEN RAISE(ABORT, 'catalogue_revision_conflict') END;

      SELECT CASE WHEN EXISTS (SELECT 1 FROM collection_states r WHERE r.collection_id=NEW.collection_id AND r.revision=NEW.collection_revision AND r.name IS NULL AND length(trim(r.notes, char(9)||char(10)||char(13)||' '))=0)
        OR EXISTS (SELECT 1 FROM collection_tags t WHERE t.collection_id=NEW.collection_id AND NOT EXISTS (SELECT 1 FROM published_tags p WHERE p.tag_id=t.tag_id))
        OR EXISTS (SELECT 1 FROM collection_states r JOIN collection_tags t ON t.collection_id=r.collection_id WHERE r.collection_id=NEW.collection_id AND r.revision=NEW.collection_revision AND r.cover_photo_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM published_photo_tags p WHERE p.photo_id=r.cover_photo_id AND p.tag_id=t.tag_id))
        THEN RAISE(ABORT, 'invalid_published_collection') END;
      INSERT INTO collection_public (collection_id, revision, created_at, name, notes, featured_order, cover_photo_id) SELECT collection_id, revision, created_at, name, notes, featured_order, cover_photo_id FROM collection_drafts WHERE collection_id=NEW.collection_id AND revision=NEW.collection_revision
        ON CONFLICT(collection_id) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at, name=excluded.name, notes=excluded.notes, featured_order=excluded.featured_order, cover_photo_id=excluded.cover_photo_id;


    END;
-- statement
CREATE TRIGGER collection_publication_update BEFORE UPDATE ON published_collections BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM collection_drafts WHERE collection_id=NEW.collection_id AND revision=NEW.collection_revision)
        AND NOT EXISTS (SELECT 1 FROM collection_public WHERE collection_id=NEW.collection_id AND revision=NEW.collection_revision)
        THEN RAISE(ABORT, 'catalogue_revision_conflict') END;
      SELECT CASE WHEN NEW.collection_id <> OLD.collection_id  THEN RAISE(ABORT, 'catalogue_publication_conflict') END;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM collection_states r WHERE r.collection_id=NEW.collection_id AND r.revision=NEW.collection_revision AND r.name IS NULL AND length(trim(r.notes, char(9)||char(10)||char(13)||' '))=0)
        OR EXISTS (SELECT 1 FROM collection_tags t WHERE t.collection_id=NEW.collection_id AND NOT EXISTS (SELECT 1 FROM published_tags p WHERE p.tag_id=t.tag_id))
        OR EXISTS (SELECT 1 FROM collection_states r JOIN collection_tags t ON t.collection_id=r.collection_id WHERE r.collection_id=NEW.collection_id AND r.revision=NEW.collection_revision AND r.cover_photo_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM published_photo_tags p WHERE p.photo_id=r.cover_photo_id AND p.tag_id=t.tag_id))
        THEN RAISE(ABORT, 'invalid_published_collection') END;
      INSERT INTO collection_public (collection_id, revision, created_at, name, notes, featured_order, cover_photo_id) SELECT collection_id, revision, created_at, name, notes, featured_order, cover_photo_id FROM collection_drafts WHERE collection_id=NEW.collection_id AND revision=NEW.collection_revision
        ON CONFLICT(collection_id) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at, name=excluded.name, notes=excluded.notes, featured_order=excluded.featured_order, cover_photo_id=excluded.cover_photo_id;


    END;
-- statement
CREATE TRIGGER collection_withdrawal AFTER DELETE ON published_collections BEGIN


    DELETE FROM collection_public WHERE collection_id=OLD.collection_id;
  END;
-- statement
CREATE TABLE transition_integrity (valid INTEGER NOT NULL CHECK (valid=1)) STRICT;
-- statement
INSERT INTO transition_integrity (valid) SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
-- statement
DROP TABLE transition_integrity;
