// Deterministic, synthetic storage fixtures. No image files or private metadata.
export async function seedCatalogue(db, size) {
  if (![1000, 10000].includes(size))
    throw new Error('Unsupported fixture size');
  const prefix = `fixture-${size}`;
  const tags = Array.from({ length: 300 }, (_, i) => ({
    id: `${prefix}-tag-${i.toString().padStart(3, '0')}`,
    name: `Fixture ${size} collection ${i}`,
    normalized: `fixture ${size} collection ${i}`,
    slug: `${prefix}-collection-${i}`,
  }));
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  const tagJson = JSON.stringify(tags);
  await db.batch([
    statement(
      "INSERT INTO tags (id, created_at) SELECT json_extract(value, '$.id'), 0 FROM json_each(?)",
      tagJson,
    ),
    statement(
      `INSERT INTO tag_revisions SELECT json_extract(value, '$.id'), 1, 0,
      json_extract(value, '$.name'), json_extract(value, '$.normalized'), json_extract(value, '$.slug') FROM json_each(?)`,
      tagJson,
    ),
    statement(
      "UPDATE tags SET draft_revision = 1 WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))",
      tagJson,
    ),
    ...tags
      .slice(0, 280)
      .map((tag) =>
        statement('INSERT INTO published_tags VALUES (?, 1)', tag.id),
      ),
  ]);

  const expected = [];
  for (let start = 0; start < size; start += 250) {
    const photos = Array.from(
      { length: Math.min(250, size - start) },
      (_, offset) => {
        const i = start + offset;
        const tagIndexes =
          i % 19 === 0
            ? []
            : [
                ...new Set([
                  0,
                  ...(i % 2 === 0 ? [1] : []),
                  ...(i % 3 === 0 ? [2] : []),
                  3 + (i % 297),
                  3 + ((i * 13) % 297),
                ]),
              ];
        const photo = {
          id: `${prefix}-photo-${i.toString().padStart(6, '0')}`,
          tagIds: tagIndexes.map((index) => tags[index].id),
          firstPublishedAt: 1700000000000 + Math.floor(i / 5),
          published: i % 17 !== 0 && tagIndexes.length > 0,
        };
        if (photo.published) expected.push(photo);
        return photo;
      },
    );
    const json = JSON.stringify(photos);
    await db.batch([
      statement(
        "INSERT INTO photos (id, created_at) SELECT json_extract(value, '$.id'), 0 FROM json_each(?)",
        json,
      ),
      statement(
        `INSERT INTO photo_tags SELECT json_extract(p.value, '$.id'), 1, t.value
        FROM json_each(?) p, json_each(p.value, '$.tagIds') t`,
        json,
      ),
      statement(
        "INSERT INTO photo_revisions SELECT json_extract(value, '$.id'), 1, 0 FROM json_each(?)",
        json,
      ),
      statement(
        "UPDATE photos SET draft_revision = 1 WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))",
        json,
      ),
      statement(
        `INSERT INTO published_photos SELECT json_extract(value, '$.id'), 1,
        json_extract(value, '$.firstPublishedAt') FROM json_each(?) WHERE json_extract(value, '$.published') = 1`,
        json,
      ),
      statement(
        `INSERT INTO published_photo_tags
        SELECT p.photo_id, p.photo_revision, t.tag_id, p.first_published_at
        FROM published_photos p JOIN photo_tags t
          ON t.photo_id = p.photo_id AND t.photo_revision = p.photo_revision
        JOIN published_tags pt ON pt.tag_id = t.tag_id
        WHERE p.photo_id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
        json,
      ),
    ]);
  }
  return { tags, expected: expected.reverse(), photoCount: size };
}
