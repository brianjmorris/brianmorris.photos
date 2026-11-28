import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import {
  readPublicCollection,
  normalizeCollectionQuery,
} from '../src/discovery/reader.ts';
import { CatalogueRepository } from '../src/catalogue/repository.ts';
import { CollectionRepository } from '../src/catalogue/collections.ts';
import { photoQueryForTags } from '../src/discovery/selection.ts';
import {
  applyLocalMigrations,
  createLocalCatalogue,
} from './helpers/catalogue.mjs';
import { discoverySource, seedDiscovery } from './helpers/discovery.mjs';

const request = (overrides = {}) => ({
  version: 1,
  collection: { kind: 'tag', id: 'tag' },
  ...overrides,
});
const error = (code, currentVersion) => ({
  ok: false,
  error: { code, ...(currentVersion ? { currentVersion } : {}) },
});
const preview = (i) => ({
  photoId: `photo-${i}`,
  revision: 1,
  firstPublishedAt: 100 + i,
  title: null,
  altText: null,
});
const ready = (items, extra = {}) => ({
  status: 'ready',
  version: 1,
  items,
  hasNewer: false,
  hasOlder: true,
  ...extra,
});

describe('portable public discovery contracts', () => {
  it('canonicalizes filter sets without mixing tag/group/place identities', () => {
    const query = normalizeCollectionQuery(
      request({
        collection: { kind: 'place', id: 'tag' },
        filters: { tagIds: ['b', 'a', 'b'], placeId: 'region' },
      }),
    );
    assert.deepEqual(query, {
      collection: { kind: 'place', id: 'tag' },
      filters: { tagIds: ['a', 'b'], placeId: 'region' },
      sort: 'first-published-desc',
    });
  });

  it('rejects malformed, excessive, conflicting, and unsupported requests before querying', async () => {
    const source = {
      readWindow() {
        assert.fail('Invalid request reached source');
      },
    };
    for (const input of [
      null,
      request({ version: 0 }),
      request({ version: 1.1 }),
      request({ limit: 0 }),
      request({ limit: 51 }),
      request({ limit: null }),
      request({ collection: { kind: 'synthetic-place', id: 'a' } }),
      request({ collection: { kind: 'tag', id: "x' OR 1=1" } }),
      request({ sort: 'capture-date' }),
      request({ filters: [] }),
      request({ filters: { unknown: 'ignored-filter' } }),
      request({ filters: { tagIds: null } }),
      request({ filters: { placeId: null } }),
      request({ filters: { tagIds: Array(65).fill('a') } }),
      request({ filters: { placeId: '' } }),
      request({ cursor: 'a', anchorPhotoId: 'photo-1' }),
      request({ anchorPhotoId: '' }),
    ]) {
      assert.deepEqual(
        await readPublicCollection(source, input),
        error('invalid_request'),
      );
    }
    for (const cursor of [
      '',
      '!',
      'a'.repeat(4097),
      btoa('{}'),
      btoa('null'),
    ]) {
      assert.deepEqual(
        await readPublicCollection(source, request({ cursor })),
        error('invalid_cursor'),
      );
    }
  });

  it('binds cursors to version, collection kind/id, normalized filters, sort, and direction', async () => {
    const source = {
      async readWindow() {
        return ready([preview(2)]);
      },
    };
    const first = await readPublicCollection(
      source,
      request({ filters: { tagIds: ['b', 'a'] } }),
    );
    let captured;
    await readPublicCollection(
      {
        async readWindow(value) {
          captured = value;
          return ready([preview(1)]);
        },
      },
      request({
        cursor: first.nextCursor,
        filters: { tagIds: ['a', 'b', 'a'] },
      }),
    );
    assert.equal(captured.seek.direction, 'older');
    assert.deepEqual(captured.seek.position, {
      firstPublishedAt: 102,
      photoId: 'photo-2',
    });
    for (const changed of [
      { version: 2 },
      { collection: { kind: 'group', id: 'tag' } },
      { collection: { kind: 'tag', id: 'other' } },
      { filters: { tagIds: ['a'] } },
      { filters: { tagIds: ['a', 'b'], placeId: 'p' } },
    ]) {
      assert.deepEqual(
        await readPublicCollection(
          source,
          request({
            filters: { tagIds: ['a', 'b'] },
            cursor: first.nextCursor,
            ...changed,
          }),
        ),
        error('invalid_cursor'),
      );
    }
    const payload = JSON.parse(
      atob(first.nextCursor.replaceAll('-', '+').replaceAll('_', '/')),
    );
    for (const changed of [
      { schema: 1 },
      { direction: 'sideways' },
      { position: { firstPublishedAt: -1, photoId: 'p' } },
    ]) {
      const cursor = btoa(JSON.stringify({ ...payload, ...changed }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
      assert.deepEqual(
        await readPublicCollection(
          source,
          request({ filters: { tagIds: ['a', 'b'] }, cursor }),
        ),
        error('invalid_cursor'),
      );
    }
  });

  it('returns typed refresh/missing responses and strips private and future source fields', async () => {
    assert.deepEqual(
      await readPublicCollection(
        {
          async readWindow() {
            return ready([preview(1)], { version: 2 });
          },
        },
        request(),
      ),
      error('refresh_required', 2),
    );
    assert.deepEqual(
      await readPublicCollection(
        {
          async readWindow() {
            return { status: 'not_found', version: 1 };
          },
        },
        request(),
      ),
      error('not_found'),
    );
    const page = await readPublicCollection(
      {
        async readWindow() {
          return ready([
            {
              ...preview(1),
              originalFilename: 'private-marker',
              sourceId: 'private-marker',
              privateLocation: { latitude: 42 },
              unexpectedFutureField: 'private-marker',
            },
          ]);
        },
      },
      request(),
    );
    assert.deepEqual(page.items, [preview(1)]);
    assert(!JSON.stringify(page).includes('private-marker'));
    assert(!JSON.stringify(page).includes('latitude'));
    assert.equal(page.items.length, 1);
  });

  it('fails closed on source overflow, wrong ordering, missing anchor, or crossed boundaries', async () => {
    for (const items of [
      [preview(1), preview(2)],
      [preview(1), preview(1)],
      Array(25).fill(preview(1)),
    ]) {
      await assert.rejects(
        readPublicCollection(
          {
            async readWindow() {
              return ready(items);
            },
          },
          request(),
        ),
      );
    }
    await assert.rejects(
      readPublicCollection(
        {
          async readWindow() {
            return ready([preview(1)]);
          },
        },
        request({ anchorPhotoId: 'missing' }),
      ),
    );
    const source = {
      async readWindow() {
        return ready([preview(1)]);
      },
    };
    const page = await readPublicCollection(source, request());
    await assert.rejects(
      readPublicCollection(source, request({ cursor: page.nextCursor })),
      /keyset boundary/,
    );
    await assert.rejects(
      readPublicCollection(
        {
          async readWindow() {
            throw new Error('database unavailable');
          },
        },
        request(),
      ),
      /database unavailable/,
    );
  });

  it('keeps the portable runtime small and independent of catalogue/provider/UI code', async (context) => {
    let source = '';
    for (const file of ['contracts.ts', 'reader.ts'])
      source += await readFile(
        new URL(`../src/discovery/${file}`, import.meta.url),
        'utf8',
      );
    assert.doesNotMatch(
      source,
      /from ['"](?:react|.*catalogue|.*cloudflare|node:)/,
    );
    const bytes = gzipSync(source).length;
    assert(bytes < 10_000);
    context.diagnostic(
      `Contract source gzip baseline (not a client bundle): ${bytes} bytes.`,
    );
  });
});

describe('collection context uses the ordinary tag-filtered photo view', () => {
  it('has identical pages, order, cursors and anchors when Name/Notes are added or changed', async () => {
    const local = await createLocalCatalogue();
    try {
      await applyLocalMigrations(local.db);
      const fixture = await seedDiscovery(local.db, 1000);
      const source = discoverySource(local.db);
      const tags = fixture.tags.slice(0, 2).map((t) => t.id);
      const query = { version: 1, ...photoQueryForTags(tags) };
      const ordinary = await readPublicCollection(source, query);
      const repository = new CollectionRepository(local.db);
      assert.equal(await repository.recognizePublished(tags), null);
      const c = await repository.createDraft({
        tagIds: [...tags].reverse(),
        name: null,
        notes: 'Context for these tags',
        featuredOrder: null,
        coverPhotoId: null,
      });
      await local.db
        .prepare(
          'INSERT INTO published_collections (collection_id, collection_revision) VALUES (?, 1)',
        )
        .bind(c.collectionId)
        .run();
      const context = await repository.recognizePublished(tags);
      const decoratedQuery = {
        version: 1,
        ...photoQueryForTags(context.tagIds),
      };
      assert.deepEqual(query, decoratedQuery);
      assert.deepEqual(
        await readPublicCollection(source, decoratedQuery),
        ordinary,
      );
      const next = { ...query, cursor: ordinary.nextCursor };
      assert.deepEqual(
        await readPublicCollection(source, next),
        await readPublicCollection(source, {
          ...decoratedQuery,
          cursor: ordinary.nextCursor,
        }),
      );
      const anchor = ordinary.items[10].photoId;
      assert.deepEqual(
        await readPublicCollection(source, { ...query, anchorPhotoId: anchor }),
        await readPublicCollection(source, {
          ...decoratedQuery,
          anchorPhotoId: anchor,
        }),
      );
      await repository.saveDraft(c.collectionId, 1, {
        ...c,
        name: 'A name without Notes',
        notes: '',
      });
      await local.db
        .prepare(
          'UPDATE published_collections SET collection_revision = 2 WHERE collection_id = ?',
        )
        .bind(c.collectionId)
        .run();
      assert.equal(
        (await repository.recognizePublished(tags)).name,
        'A name without Notes',
      );
      assert.deepEqual(
        await readPublicCollection(source, decoratedQuery),
        ordinary,
      );
      const many = fixture.tags.slice(0, 64).map((t) => t.id);
      const result = await readPublicCollection(source, {
        version: 1,
        ...photoQueryForTags(many),
      });
      assert(result.ok);
      assert(
        result.items.every(
          (p) =>
            fixture.expected.find((photo) => photo.id === p.photoId).tagIds
              .length === 64,
        ),
      );
      assert(
        source.build({
          version: 1,
          query: normalizeCollectionQuery({
            version: 1,
            ...photoQueryForTags(many),
          }),
          limit: 24,
          seek: { kind: 'start' },
        }).values.length < 10,
      );
    } finally {
      await local.close();
    }
  });
});

for (const size of [1000, 10000]) {
  describe(`${size} synthetic photos: public discovery D1 contract qualification`, () => {
    it('qualifies bounded pages, reverse navigation, deep anchors, prepared groups/places, privacy and query cost', async (context) => {
      const local = await createLocalCatalogue();
      try {
        const db = local.db;
        await applyLocalMigrations(db);
        const fixture = await seedDiscovery(db, size);
        const source = discoverySource(db);
        const base = request({
          collection: { kind: 'tag', id: fixture.tags[0].id },
        });
        const ids = (result) => {
          assert.equal(result.ok, true);
          return result.items.map((row) => row.photoId);
        };
        const first = await readPublicCollection(source, base);
        assert.deepEqual(
          ids(first),
          fixture.expected.slice(0, 24).map((p) => p.id),
        );
        assert.equal(first.previousCursor, null);
        assert.deepEqual(
          ids(await readPublicCollection(source, { ...base, limit: 50 })),
          fixture.expected.slice(0, 50).map((p) => p.id),
        );
        assert(fixture.expected.some((p) => p.tagIds.length === 64));
        const second = await readPublicCollection(source, {
          ...base,
          cursor: first.nextCursor,
        });
        assert.deepEqual(
          ids(second),
          fixture.expected.slice(24, 48).map((p) => p.id),
        );
        assert.deepEqual(
          ids(
            await readPublicCollection(source, {
              ...base,
              cursor: second.previousCursor,
            }),
          ),
          ids(first),
        );
        const anchorIndex = Math.floor(fixture.expected.length * 0.8);
        const anchored = await readPublicCollection(source, {
          ...base,
          anchorPhotoId: fixture.expected[anchorIndex].id,
        });
        assert.deepEqual(
          ids(anchored),
          fixture.expected
            .slice(anchorIndex - 11, anchorIndex + 13)
            .map((p) => p.id),
        );
        assert.deepEqual(
          ids(
            await readPublicCollection(source, {
              ...base,
              limit: 1,
              anchorPhotoId: fixture.expected[anchorIndex].id,
            }),
          ),
          [fixture.expected[anchorIndex].id],
        );
        const last = await readPublicCollection(source, {
          ...base,
          anchorPhotoId: fixture.expected.at(-1).id,
        });
        assert.equal(last.nextCursor, null);
        assert.equal(last.items.at(-1).photoId, fixture.expected.at(-1).id);
        assert.deepEqual(
          await readPublicCollection(source, {
            ...base,
            anchorPhotoId: 'missing',
          }),
          error('not_found'),
        );

        const union = fixture.expected.filter(
          (p) =>
            p.tagIds.includes(fixture.tags[1].id) ||
            p.tagIds.includes(fixture.tags[2].id),
        );
        assert.deepEqual(
          ids(
            await readPublicCollection(source, {
              ...base,
              collection: { kind: 'group', id: 'overlap' },
              limit: 50,
            }),
          ),
          union.slice(0, 50).map((p) => p.id),
        );
        const intersection = fixture.expected.filter(
          (p) =>
            p.tagIds.includes(fixture.tags[1].id) &&
            p.tagIds.includes(fixture.tags[2].id),
        );
        assert.deepEqual(
          ids(
            await readPublicCollection(source, {
              ...base,
              filters: { tagIds: [fixture.tags[1].id, fixture.tags[2].id] },
            }),
          ),
          intersection.slice(0, 24).map((p) => p.id),
        );
        assert.equal(
          fixture.collections.find((c) => c.id === 'city-a').name,
          fixture.collections.find((c) => c.id === 'city-b').name,
        );
        for (const place of ['region', 'city-a', 'city-b', 'empty']) {
          const expected = new Set(
            fixture.places
              .filter((p) => p.placeId === place)
              .map((p) => p.photoId),
          );
          const page = await readPublicCollection(source, {
            ...base,
            collection: { kind: 'place', id: place },
          });
          assert.deepEqual(
            ids(page),
            fixture.expected
              .filter((p) => expected.has(p.id))
              .slice(0, 24)
              .map((p) => p.id),
          );
          assert.deepEqual(
            ids(
              await readPublicCollection(source, {
                ...base,
                filters: { placeId: place },
              }),
            ),
            ids(page),
          );
          assert(
            source.measurements.at(-1).rowsRead <= 1200,
            `${place} filtering exceeded the fixture query budget`,
          );
        }
        assert.deepEqual(
          await readPublicCollection(source, {
            ...base,
            collection: { kind: 'place', id: 'missing' },
          }),
          error('not_found'),
        );

        // Traverse ties fully at normal scale to expose skips and duplicates.
        if (size === 1000) {
          const collected = [];
          let page = first;
          do {
            collected.push(...ids(page));
            if (!page.nextCursor) break;
            page = await readPublicCollection(source, {
              ...base,
              cursor: page.nextCursor,
            });
          } while (true);
          assert.deepEqual(
            collected,
            fixture.expected.map((p) => p.id),
          );
        }

        // Published revision stays stable when owner metadata changes.
        const catalogue = new CatalogueRepository(db);
        const photoId = first.items[0].photoId;
        await catalogue.savePhotoMetadataDraft(photoId, 1, {
          title: 'private-draft-marker',
          privateLocation: { point: { latitude: 42, longitude: -70 } },
        });
        const publicPage = await readPublicCollection(source, base);
        assert.equal(publicPage.items[0].revision, 1);
        assert.equal(publicPage.items[0].title, null);
        assert(!JSON.stringify(publicPage).includes('private-draft-marker'));
        await db.batch([
          db
            .prepare('DELETE FROM published_photo_tags WHERE photo_id = ?')
            .bind(photoId),
          db
            .prepare('DELETE FROM published_photos WHERE photo_id = ?')
            .bind(photoId),
          db.prepare(
            'UPDATE discovery_test_version SET version = 2 WHERE id = 1',
          ),
        ]);
        assert.deepEqual(
          await readPublicCollection(source, {
            ...base,
            cursor: first.nextCursor,
          }),
          error('refresh_required', 2),
        );
        assert.deepEqual(
          await readPublicCollection(source, {
            ...base,
            version: 2,
            anchorPhotoId: photoId,
          }),
          error('not_found'),
        );
        assert(
          !ids(
            await readPublicCollection(source, { ...base, version: 2 }),
          ).includes(photoId),
        );

        for (const variant of [
          base,
          { ...base, collection: { kind: 'place', id: 'city-b' } },
          { ...base, collection: { kind: 'group', id: 'overlap' } },
          {
            ...base,
            filters: { placeId: 'city-b', tagIds: [fixture.tags[1].id] },
          },
        ]) {
          for (const seek of [
            { kind: 'start' },
            {
              kind: 'keyset',
              direction: 'older',
              position: first.items.at(-1),
            },
            { kind: 'keyset', direction: 'newer', position: second.items[0] },
            { kind: 'anchor', photoId: fixture.expected[anchorIndex].id },
          ]) {
            const query = source.build({
              version: 2,
              query: normalizeCollectionQuery(variant),
              limit: 24,
              seek,
            });
            const plan = (
              await db
                .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
                .bind(...query.values)
                .all()
            ).results
              .map((r) => r.detail)
              .join('\n');
            assert.match(
              plan,
              /USING (?:COVERING )?INDEX discovery_test_members_order/,
            );
            assert.doesNotMatch(
              plan,
              /SCAN (?:m|discovery_test_members|published_photos)\b/,
            );
            assert.doesNotMatch(query.sql, /\bOFFSET\b|COUNT\(/i);
          }
        }
        const timings = [];
        for (let i = 0; i < 12; i++) {
          const start = performance.now();
          await readPublicCollection(source, {
            ...base,
            version: 2,
            anchorPhotoId: fixture.expected[anchorIndex].id,
          });
          timings.push(performance.now() - start);
        }
        const samples = source.measurements.slice(-12);
        assert(
          samples.every((sample) => sample.rowsRead <= 500),
          JSON.stringify(samples),
        );
        const jsonBytes = Buffer.byteLength(JSON.stringify(first));
        const gzipBytes = gzipSync(JSON.stringify(first)).length;
        assert(jsonBytes < 20_000);
        assert(gzipBytes < 5000);
        timings.sort((a, b) => a - b);
        context.diagnostic(
          JSON.stringify({
            fixture: size,
            profile:
              'Windows Node 24; disposable local D1; warm 12 sequential anchor requests; no network/device simulation',
            firstRequestMs: source.measurements[0].ms,
            warmAnchorP95Ms: timings.at(-1),
            anchorRowsRead: samples[0].rowsRead,
            pageItems: first.items.length,
            jsonBytes,
            gzipBytes,
          }),
        );
        assert.deepEqual(
          (await db.prepare('PRAGMA foreign_key_check').all()).results,
          [],
        );
      } finally {
        await local.close();
      }
    });
  });
}
