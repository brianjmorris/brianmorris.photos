import { SourceMetadataRepository } from '../../src/catalogue/sources.ts';

// Deliberately write the applied 0005 schema without using current authoring
// repositories. This fixture includes discarded, draft and published edits.
export async function seedLegacyCatalogue(db) {
  const s = (sql, ...values) => db.prepare(sql).bind(...values);
  await db.batch([
    s("INSERT INTO photos (id,created_at) VALUES ('legacy-photo',10)"),
    s(
      "INSERT INTO tags (id,created_at) VALUES ('legacy-tag-a',10),('legacy-tag-b',10)",
    ),
    s(
      "INSERT INTO places (id,created_at) VALUES ('legacy-region',10),('legacy-city',10)",
    ),
    s(
      "INSERT INTO collection_tags (collection_id,tag_id) VALUES ('legacy-collection','legacy-tag-a'),('legacy-collection','legacy-tag-b')",
    ),
    s(
      `INSERT INTO collections (id,created_at,tag_set_key) VALUES ('legacy-collection',10,'["legacy-tag-a","legacy-tag-b"]')`,
    ),
  ]);
  const source = await new SourceMetadataRepository(db).record(
    'legacy-photo',
    {
      sha256: 'a'.repeat(64),
      originalFilename: 'synthetic-source.jpg',
      parser: { name: 'fixture', version: '1' },
      rawMetadata: { Original: 'source-private-marker' },
      gps: { latitude: 42, longitude: -70 },
    },
    20,
  );
  for (const revision of [1, 2, 3]) {
    const label = ['', 'Published', 'Discarded', 'Draft'][revision];
    const statements = [];
    for (const id of ['legacy-tag-a', 'legacy-tag-b'])
      statements.push(
        s(
          'INSERT INTO tag_aliases (tag_id,tag_revision,alias,normalized_alias) VALUES (?,?,?,?)',
          id,
          revision,
          `${label} ${id} alias`,
          `${label.toLowerCase()} ${id} alias`,
        ),
        s(
          'INSERT INTO tag_revisions (tag_id,revision,created_at,name,normalized_name,slug,notes) VALUES (?,?,?,?,?,?,?)',
          id,
          revision,
          revision * 100,
          `${label} ${id}`,
          `${label.toLowerCase()} ${id}`,
          `${id}-${revision}`,
          `${label} tag notes`,
        ),
        s('UPDATE tags SET draft_revision=? WHERE id=?', revision, id),
      );
    statements.push(
      s(
        "INSERT INTO place_aliases (place_id,place_revision,alias,normalized_alias) VALUES ('legacy-region',?,?,?)",
        revision,
        `${label} region alias`,
        `${label.toLowerCase()} region alias`,
      ),
      s(
        "INSERT INTO place_revisions (place_id,revision,created_at,name,kind,provenance_kind) VALUES ('legacy-region',?,?,?,'region','manual')",
        revision,
        revision * 100,
        `${label} region`,
      ),
      s(
        "UPDATE places SET draft_revision=? WHERE id='legacy-region'",
        revision,
      ),
      s(
        "INSERT INTO place_revisions (place_id,revision,created_at,name,kind,parent_id,parent_revision,provenance_kind) VALUES ('legacy-city',?,?,?,'city','legacy-region',?,'manual')",
        revision,
        revision * 100,
        `${label} city`,
        revision,
      ),
      s("UPDATE places SET draft_revision=? WHERE id='legacy-city'", revision),
      s(
        "INSERT INTO photo_tags (photo_id,photo_revision,tag_id) VALUES ('legacy-photo',?,'legacy-tag-a'),('legacy-photo',?,'legacy-tag-b')",
        revision,
        revision,
      ),
      s(
        `INSERT INTO photo_metadata_revisions (photo_id,photo_revision,source_id,title,keywords_json,creators_json,copyright_owners_json,capture_precision,clock_correction_seconds,
        private_place_id,private_place_revision,private_latitude,private_longitude,public_visibility,public_place_id,public_place_revision)
        VALUES ('legacy-photo',?,?,?,'[]','["Owner"]','[]','unknown',0,'legacy-city',?,42,-70,'place','legacy-city',?)`,
        revision,
        source.id,
        `${label} title`,
        revision,
        revision,
      ),
      s(
        "INSERT INTO photo_revisions (photo_id,revision,created_at) VALUES ('legacy-photo',?,?)",
        revision,
        revision * 100,
      ),
      s("UPDATE photos SET draft_revision=? WHERE id='legacy-photo'", revision),
      s(
        "INSERT INTO collection_revisions (collection_id,revision,created_at,name,notes,featured_order) VALUES ('legacy-collection',?,?,?, ?,0)",
        revision,
        revision * 100,
        `${label} collection`,
        `${label} notes`,
      ),
      s(
        "UPDATE collections SET draft_revision=? WHERE id='legacy-collection'",
        revision,
      ),
    );
    if (revision === 1)
      statements.push(
        s(
          "INSERT INTO published_tags (tag_id,tag_revision) VALUES ('legacy-tag-a',1),('legacy-tag-b',1)",
        ),
        s(
          "INSERT INTO published_photos (photo_id,photo_revision,first_published_at) VALUES ('legacy-photo',1,1000)",
        ),
        s(
          "INSERT INTO published_photo_tags (photo_id,photo_revision,tag_id,first_published_at) VALUES ('legacy-photo',1,'legacy-tag-a',1000),('legacy-photo',1,'legacy-tag-b',1000)",
        ),
        s(
          "INSERT INTO published_collections (collection_id,collection_revision) VALUES ('legacy-collection',1)",
        ),
      );
    await db.batch(statements);
  }
  // A relationship belonging to another feature must survive identity rebuilds.
  await db.batch([
    s(
      'CREATE TABLE migration_test_links (photo_id TEXT PRIMARY KEY REFERENCES photos(id), tag_id TEXT REFERENCES tags(id)) STRICT',
    ),
    s(
      "INSERT INTO migration_test_links (photo_id,tag_id) VALUES ('legacy-photo','legacy-tag-a')",
    ),
  ]);
  return source;
}
