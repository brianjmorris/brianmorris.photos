import { readFile } from 'node:fs/promises';
import { seedCatalogue } from './catalogue-fixtures.mjs';

// A disposable D1 adapter proves the contract's query shapes. Group unions and
// descendant-place memberships are prepared here, never during visitor reads.
export async function seedDiscovery(db, size) {
  const sql = await readFile(
    new URL('../fixtures/discovery.sql', import.meta.url),
    'utf8',
  );
  await db.batch(sql.split('-- statement').map((s) => db.prepare(s.trim())));
  const fixture = await seedCatalogue(db, size, { dense: true });
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  const collections = [
    ...fixture.tags
      .slice(0, 280)
      .map((tag) => ({ kind: 'tag', id: tag.id, name: tag.name })),
    { kind: 'group', id: 'overlap', name: 'Overlapping collections' },
    { kind: 'place', id: 'region', name: 'Québec' },
    { kind: 'place', id: 'city-a', name: 'Saint-Pierre' },
    { kind: 'place', id: 'city-b', name: 'Saint-Pierre' },
    { kind: 'place', id: 'empty', name: 'Empty place' },
  ];
  await db.batch([
    statement(
      `INSERT INTO discovery_test_collections (kind, id, name)
      SELECT json_extract(value, '$.kind'), json_extract(value, '$.id'), json_extract(value, '$.name') FROM json_each(?)`,
      JSON.stringify(collections),
    ),
    statement(`INSERT INTO discovery_test_members (kind, collection_id, photo_id, first_published_at)
      SELECT 'tag', tag_id, photo_id, first_published_at FROM published_photo_tags`),
    statement(
      `INSERT INTO discovery_test_members (kind, collection_id, photo_id, first_published_at)
      SELECT 'group', 'overlap', photo_id, first_published_at FROM published_photo_tags
      WHERE tag_id IN (?, ?) GROUP BY photo_id, first_published_at`,
      fixture.tags[1].id,
      fixture.tags[2].id,
    ),
  ]);
  const places = fixture.expected.flatMap((photo) => {
    const number = Number(photo.id.slice(-6));
    // 90% common city, 1% same-name distinct city, 9% without public place.
    const city =
      number % 100 === 0 ? 'city-b' : number % 10 !== 0 ? 'city-a' : null;
    return city
      ? [city, 'region'].map((placeId) => ({
          placeId,
          photoId: photo.id,
          time: photo.firstPublishedAt,
        }))
      : [];
  });
  for (let start = 0; start < places.length; start += 500) {
    await statement(
      `INSERT INTO discovery_test_members (kind, collection_id, photo_id, first_published_at)
      SELECT 'place', json_extract(value, '$.placeId'), json_extract(value, '$.photoId'), json_extract(value, '$.time') FROM json_each(?)`,
      JSON.stringify(places.slice(start, start + 500)),
    ).run();
  }
  // Counts are prepared with the fixture, not computed on visitor requests.
  await db
    .prepare(
      `UPDATE discovery_test_collections SET photo_count = (
    SELECT COUNT(*) FROM discovery_test_members m WHERE m.kind = discovery_test_collections.kind
    AND m.collection_id = discovery_test_collections.id)`,
    )
    .run();
  return { ...fixture, places, collections };
}

export function discoverySource(db) {
  const measurements = [];
  const statement = (sql, values = []) => db.prepare(sql).bind(...values);
  function build(request) {
    const { query, seek, limit } = request;
    const candidates = [
      query.collection,
      ...query.filters.tagIds.map((id) => ({ kind: 'tag', id })),
      ...(query.filters.placeId
        ? [{ kind: 'place', id: query.filters.placeId }]
        : []),
    ];
    // JSON keeps the parameter count constant even for 64-tag selections.
    const encoded = JSON.stringify(candidates);
    const values = [encoded];
    const driver = `SELECT c.kind, c.id FROM discovery_test_collections c JOIN json_each(?) selected
      ON c.kind = json_extract(selected.value, '$.kind') AND c.id = json_extract(selected.value, '$.id')
      ORDER BY c.photo_count, c.kind, c.id LIMIT 1`;
    let predicate =
      'm.kind = (SELECT kind FROM driver) AND m.collection_id = (SELECT id FROM driver)';
    predicate += ` AND NOT EXISTS (SELECT 1 FROM json_each(?) selected WHERE NOT EXISTS (
      SELECT 1 FROM discovery_test_members f WHERE f.kind = json_extract(selected.value, '$.kind')
      AND f.collection_id = json_extract(selected.value, '$.id') AND f.photo_id = m.photo_id))`;
    values.push(encoded);
    const position = '(m.first_published_at, m.photo_id)';
    let window;
    if (seek.kind === 'anchor') {
      values.push(seek.photoId);
      const newer = Math.floor((limit - 1) / 2);
      window = `SELECT * FROM (SELECT m.* FROM filtered m
          WHERE ${position} > (SELECT first_published_at, photo_id FROM anchor)
          ORDER BY m.first_published_at ASC, m.photo_id ASC LIMIT ${newer})
        UNION ALL SELECT * FROM (SELECT m.* FROM filtered m
          WHERE ${position} <= (SELECT first_published_at, photo_id FROM anchor)
          ORDER BY m.first_published_at DESC, m.photo_id DESC LIMIT ${limit - newer})`;
    } else {
      const direction = seek.kind === 'keyset' ? seek.direction : 'older';
      const boundary =
        seek.kind === 'keyset'
          ? `WHERE ${position} ${direction === 'older' ? '<' : '>'} (?, ?)`
          : '';
      if (seek.kind === 'keyset')
        values.push(seek.position.firstPublishedAt, seek.position.photoId);
      const order = direction === 'older' ? 'DESC' : 'ASC';
      window = `SELECT m.* FROM filtered m ${boundary}
        ORDER BY m.first_published_at ${order}, m.photo_id ${order} LIMIT ${limit}`;
    }
    // NOT MATERIALIZED keeps the selective index seeks; the final sort touches
    // only the bounded window. All data and version checks share a D1 batch.
    const sql = `WITH driver AS MATERIALIZED (${driver}), filtered AS NOT MATERIALIZED (
        SELECT m.* FROM discovery_test_members m WHERE ${predicate}),
      ${seek.kind === 'anchor' ? 'anchor AS (SELECT * FROM filtered WHERE photo_id = ?),' : ''}
      window AS (${window})
      SELECT w.photo_id, p.photo_revision, w.first_published_at, metadata.title, metadata.alt_text,
        EXISTS (SELECT 1 FROM filtered m WHERE (m.first_published_at, m.photo_id) > (w.first_published_at, w.photo_id)) AS has_newer,
        EXISTS (SELECT 1 FROM filtered m WHERE (m.first_published_at, m.photo_id) < (w.first_published_at, w.photo_id)) AS has_older
      FROM window w JOIN published_photos p ON p.photo_id = w.photo_id
      LEFT JOIN photo_metadata_public metadata ON metadata.photo_id = p.photo_id AND metadata.photo_revision = p.photo_revision
      ORDER BY w.first_published_at DESC, w.photo_id DESC`;
    return { sql, values };
  }
  return {
    measurements,
    build,
    async readWindow(request) {
      const { sql, values } = build(request);
      const started = performance.now();
      const [versionResult, collectionResult, page] = await db.batch([
        statement('SELECT version FROM discovery_test_version WHERE id = 1'),
        statement(
          'SELECT 1 FROM discovery_test_collections WHERE kind = ? AND id = ?',
          [request.query.collection.kind, request.query.collection.id],
        ),
        statement(sql, values),
      ]);
      measurements.push({
        ms: performance.now() - started,
        rowsRead: page.meta.rows_read,
        results: page.results.length,
      });
      const version = versionResult.results[0].version;
      if (version !== request.version)
        return { status: 'refresh_required', version };
      if (
        !collectionResult.results.length ||
        (request.seek.kind === 'anchor' &&
          !page.results.some((r) => r.photo_id === request.seek.photoId))
      )
        return { status: 'not_found', version };
      return {
        status: 'ready',
        version,
        items: page.results.map((row) => ({
          photoId: row.photo_id,
          revision: row.photo_revision,
          firstPublishedAt: row.first_published_at,
          title: row.title,
          altText: row.alt_text,
        })),
        hasNewer: Boolean(page.results[0]?.has_newer),
        hasOlder: Boolean(page.results.at(-1)?.has_older),
      };
    },
  };
}
