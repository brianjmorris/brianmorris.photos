import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { CatalogueRepository } from '../src/catalogue/repository.ts';
import { CollectionRepository } from '../src/catalogue/collections.ts';
import { PlaceRepository } from '../src/catalogue/places.ts';
import { SourceMetadataRepository } from '../src/catalogue/sources.ts';
import {
  applyLocalMigrations,
  createLocalCatalogue,
} from './helpers/catalogue.mjs';
import { seedLegacyCatalogue } from './helpers/legacy-catalogue.mjs';

const upgrade = '0006_current_editorial_state.sql';
const statement = (db, sql, ...values) => db.prepare(sql).bind(...values);
async function withLegacy(operation) {
  const local = await createLocalCatalogue();
  try {
    await applyLocalMigrations(local.db, '0005_distinct_collections.sql');
    const source = await seedLegacyCatalogue(local.db);
    await operation(local.db, source);
  } finally {
    await local.close();
  }
}
async function integrity(db) {
  assert.deepEqual(
    (await db.prepare('PRAGMA foreign_key_check').all()).results,
    [],
  );
  assert.equal(
    Object.values(await db.prepare('PRAGMA quick_check').first())[0],
    'ok',
  );
}
describe('current-state migration on populated D1', () => {
  it('preserves current and published content, source evidence, namespaces and dependent relationships', async () => {
    await withLegacy(async (db, source) => {
      await applyLocalMigrations(db);
      await applyLocalMigrations(db);
      const photos = new CatalogueRepository(db),
        collections = new CollectionRepository(db),
        places = new PlaceRepository(db);
      assert.equal(
        (await photos.getPhotoDraft('legacy-photo')).metadata.title,
        'Draft title',
      );
      assert.equal(
        (await photos.getPublishedPhotoMetadata('legacy-photo')).title,
        'Published title',
      );
      assert.equal(
        (await photos.getPublishedTag('legacy-tag-a')).name,
        'Published legacy-tag-a',
      );
      assert.equal(
        (await photos.getTagDraft('legacy-tag-a')).notes,
        'Draft tag notes',
      );
      assert.equal(
        (await collections.getDraft('legacy-collection')).name,
        'Draft collection',
      );
      assert.equal(
        (await collections.getPublished('legacy-collection')).name,
        'Published collection',
      );
      assert.equal((await places.getDraft('legacy-city')).name, 'Draft city');
      assert.deepEqual(
        (await places.ancestors({ placeId: 'legacy-city', revision: 3 })).map(
          (p) => p.name,
        ),
        ['Draft region'],
      );
      assert.deepEqual(
        (await photos.getPublishedPhotoPlace('legacy-photo')).map(
          (p) => p.name,
        ),
        ['Published city', 'Published region'],
      );
      assert.deepEqual(
        await new SourceMetadataRepository(db).get(source.id),
        source,
      );
      assert.equal(
        (await photos.findDraftTag('DRAFT LEGACY-TAG-A ALIAS')).tagId,
        'legacy-tag-a',
      );
      assert.deepEqual(
        (await db.prepare('SELECT * FROM migration_test_links').all()).results,
        [{ photo_id: 'legacy-photo', tag_id: 'legacy-tag-a' }],
      );
      assert.equal(
        (await db.prepare('SELECT COUNT(*) AS n FROM tag_slugs').first()).n,
        6,
      );
      assert.equal(
        (
          await db
            .prepare('SELECT COUNT(*) AS n FROM catalogue_test_migrations')
            .first()
        ).n,
        6,
      );
      await integrity(db);
    });
  });

  it('removes discarded history and keeps storage bounded across repeated saves and publications', async () => {
    await withLegacy(async (db) => {
      await applyLocalMigrations(db);
      const photos = new CatalogueRepository(db),
        collections = new CollectionRepository(db),
        places = new PlaceRepository(db);
      assert.equal(await photos.getPhotoRevision('legacy-photo', 2), null);
      assert.equal(await photos.getTagRevision('legacy-tag-a', 2), null);
      assert.equal(await collections.getRevision('legacy-collection', 2), null);
      assert.equal(
        await places.getRevision({ placeId: 'legacy-city', revision: 1 }),
        null,
      );
      assert.deepEqual(
        (
          await db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name LIKE '%_revisions'",
            )
            .all()
        ).results,
        [],
      );
      for (let version = 3; version < 8; version++) {
        const photo = await photos.savePhotoMetadataDraft(
          'legacy-photo',
          version,
          {
            ...(await photos.getPhotoDraft('legacy-photo')).metadata,
            title: `Edit ${version}`,
          },
        );
        await photos.saveTagDraft('legacy-tag-a', version, {
          name: `Tag edit ${version}`,
          slug: `tag-edit-${version}`,
          aliases: [`Alias edit ${version}`],
        });
        const collection = await collections.getDraft('legacy-collection');
        await collections.saveDraft(collection.collectionId, version, {
          ...collection,
          notes: `Notes ${version}`,
        });
        const place = await places.getDraft('legacy-city');
        await places.saveDraft(place.placeId, version, {
          ...place,
          name: `City edit ${version}`,
        });
        assert.equal(photo.revision, version + 1);
      }
      for (const [table, n] of [
        ['photo_drafts', 1],
        ['photo_public', 1],
        ['photo_metadata_drafts', 1],
        ['photo_metadata_public', 1],
        ['tag_drafts', 2],
        ['tag_public', 2],
        ['collection_drafts', 1],
        ['collection_public', 1],
        ['place_drafts', 2],
      ])
        assert.equal(
          (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,
          n,
          table,
        );
      // Publishing replaces the single snapshot without changing first-publication order.
      await db.batch([
        db.prepare(
          "DELETE FROM published_photo_tags WHERE photo_id='legacy-photo'",
        ),
        db.prepare(
          "UPDATE published_photos SET photo_revision=8 WHERE photo_id='legacy-photo'",
        ),
        db.prepare(
          "INSERT INTO published_photo_tags (photo_id,photo_revision,tag_id,first_published_at) SELECT photo_id,photo_revision,tag_id,1000 FROM photo_public_all_tags WHERE photo_id='legacy-photo'",
        ),
        db.prepare(
          "UPDATE published_tags SET tag_revision=8 WHERE tag_id='legacy-tag-a'",
        ),
        db.prepare(
          "UPDATE published_collections SET collection_revision=8 WHERE collection_id='legacy-collection'",
        ),
      ]);
      assert.equal(await photos.getPhotoRevision('legacy-photo', 1), null);
      assert.equal(await photos.getTagRevision('legacy-tag-a', 1), null);
      assert.equal(await collections.getRevision('legacy-collection', 1), null);
      assert.equal(
        (await photos.getPublishedPhotoMetadata('legacy-photo')).title,
        'Edit 7',
      );
      assert.equal(
        (await photos.listPublishedTagPhotos('legacy-tag-a'))[0]
          .firstPublishedAt,
        1000,
      );
      assert.equal(
        (await db.prepare('SELECT COUNT(*) AS n FROM photo_public').first()).n,
        1,
      );
      await integrity(db);
    });
  });

  it('rolls back the table rebuild, dropped history and ledger when a later statement fails', async () => {
    await withLegacy(async (db) => {
      const sql = await readFile(
        new URL(`../migrations/${upgrade}`, import.meta.url),
        'utf8',
      );
      const before = (
        await db
          .prepare(
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
      ).results;
      const sources = (
        await db.prepare('SELECT * FROM photo_source_metadata').all()
      ).results;
      await assert.rejects(
        db.batch([
          ...sql
            .split('-- statement')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => db.prepare(s)),
          statement(
            db,
            'INSERT INTO catalogue_test_migrations (name,sha256) VALUES (?,?)',
            upgrade,
            'failure',
          ),
          db.prepare('INSERT INTO nonexistent_migration_table (id) VALUES (1)'),
        ]),
      );
      assert.deepEqual(
        (
          await db
            .prepare(
              "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all()
        ).results,
        before,
      );
      assert.equal(
        (await db.prepare('SELECT COUNT(*) AS n FROM photo_revisions').first())
          .n,
        3,
      );
      assert.equal(
        await statement(
          db,
          'SELECT name FROM catalogue_test_migrations WHERE name=?',
          upgrade,
        ).first(),
        null,
      );
      assert.deepEqual(
        (await db.prepare('SELECT * FROM photo_source_metadata').all()).results,
        sources,
      );
      await integrity(db);
      await applyLocalMigrations(db);
      await integrity(db);
    });
  });

  it('keeps publication retries idempotent after newer drafts and rejects discarded targets', async () => {
    await withLegacy(async (db) => {
      await applyLocalMigrations(db);
      const photos = new CatalogueRepository(db),
        collections = new CollectionRepository(db);
      const before = await photos.getPublishedPhotoMetadata('legacy-photo');
      const tag = await photos.getPublishedTag('legacy-tag-a');
      const collection = await collections.getPublished('legacy-collection');
      await db.batch([
        db.prepare(
          "UPDATE published_photos SET photo_revision=1 WHERE photo_id='legacy-photo'",
        ),
        db.prepare(
          "UPDATE published_tags SET tag_revision=1 WHERE tag_id='legacy-tag-a'",
        ),
        db.prepare(
          "UPDATE published_collections SET collection_revision=1 WHERE collection_id='legacy-collection'",
        ),
        db.prepare(
          "INSERT INTO published_tags (tag_id,tag_revision) VALUES ('legacy-tag-a',1) ON CONFLICT DO NOTHING",
        ),
      ]);
      assert.deepEqual(
        await photos.getPublishedPhotoMetadata('legacy-photo'),
        before,
      );
      assert.deepEqual(await photos.getPublishedTag('legacy-tag-a'), tag);
      assert.deepEqual(
        await collections.getPublished('legacy-collection'),
        collection,
      );
      for (const [table, column, id] of [
        ['published_photos', 'photo', 'legacy-photo'],
        ['published_tags', 'tag', 'legacy-tag-a'],
        ['published_collections', 'collection', 'legacy-collection'],
      ])
        await assert.rejects(
          statement(
            db,
            `UPDATE ${table} SET ${column}_revision=2 WHERE ${column}_id=?`,
            id,
          ).run(),
          /catalogue_revision_conflict/,
        );
      await integrity(db);
    });
  });

  it('retains frozen locations through unrelated edits and exposes only approved public descriptions', async () => {
    await withLegacy(async (db) => {
      await applyLocalMigrations(db);
      const photos = new CatalogueRepository(db),
        places = new PlaceRepository(db);
      const draft = await photos.getPhotoDraft('legacy-photo');
      const privateBefore = await photos.getPhotoDraftPlace(
        'legacy-photo',
        'private',
      );
      const publicBefore = await photos.getPublishedPhotoPlace('legacy-photo');
      assert.deepEqual(
        privateBefore.map((p) => p.name),
        ['Draft city', 'Draft region'],
      );
      assert.deepEqual(privateBefore[1].aliases, ['Draft region alias']);
      await places.saveDraft('legacy-city', 3, {
        name: 'New city draft',
        kind: 'city',
        parent: { placeId: 'legacy-region', revision: 3 },
        provenance: { kind: 'manual' },
      });
      await photos.savePhotoMetadataDraft('legacy-photo', 3, {
        ...draft.metadata,
        title: 'Unrelated title edit',
      });
      await photos.addTagsToPhotoDrafts(
        [{ photoId: 'legacy-photo', expectedRevision: 4 }],
        ['legacy-tag-a'],
      );
      assert.deepEqual(
        await photos.getPhotoDraftPlace('legacy-photo', 'private'),
        privateBefore,
      );
      assert.deepEqual(
        await photos.getPublishedPhotoPlace('legacy-photo'),
        publicBefore,
      );
      const output = JSON.stringify(publicBefore);
      for (const secret of [
        'private',
        'provenance',
        'providerId',
        'source-private-marker',
        'latitude',
        'longitude',
      ])
        assert(!output.includes(secret));
      assert.deepEqual(
        await photos.getPublishedPhotoPlace('missing-photo'),
        [],
      );
      await db.batch([
        db.prepare(
          "DELETE FROM published_photo_tags WHERE photo_id='legacy-photo'",
        ),
        db.prepare(
          "DELETE FROM published_photos WHERE photo_id='legacy-photo'",
        ),
      ]);
      assert.deepEqual(await photos.getPublishedPhotoPlace('legacy-photo'), []);
      assert.equal(
        (
          await db
            .prepare('SELECT COUNT(*) AS n FROM photo_metadata_public')
            .first()
        ).n,
        0,
      );
      assert.deepEqual(
        await photos.getPhotoDraftPlace('legacy-photo', 'private'),
        privateBefore,
      );
      await integrity(db);
    });
  });

  it('retains column-explicit writes after future optional fields and relationships are added', async () => {
    await withLegacy(async (db) => {
      await applyLocalMigrations(db);
      await db.batch([
        ...[
          'photo_drafts',
          'tag_drafts',
          'tag_draft_aliases',
          'place_draft_aliases',
          'tag_name_claims',
          'tag_slugs',
          'catalogue_test_migrations',
        ].map((t) =>
          db.prepare(`ALTER TABLE ${t} ADD COLUMN extension_note TEXT`),
        ),
      ]);
      const photos = new CatalogueRepository(db),
        places = new PlaceRepository(db);
      const tag = await photos.createTag({
        name: 'Extended tag',
        slug: 'extended-tag',
        aliases: ['Extended alias'],
      });
      await photos.saveTagDraft(tag.tagId, 1, {
        ...tag,
        name: 'Extended renamed',
      });
      const photo = await photos.createPhoto([tag.tagId]);
      await photos.savePhotoMetadataDraft(photo.photoId, 1, {
        title: 'Extended title',
      });
      const place = await places.create({
        name: 'Extended place',
        kind: 'site',
        aliases: ['Extended location'],
        provenance: { kind: 'manual' },
      });
      await places.saveDraft(place.placeId, 1, {
        ...place,
        name: 'Extended location name',
        aliases: [],
      });
      assert.equal(
        (await photos.getPhotoDraft(photo.photoId)).metadata.title,
        'Extended title',
      );
      assert.deepEqual((await places.getDraft(place.placeId)).aliases, []);
      await integrity(db);
    });
  });

  it('rejects changed applied migration hashes before running the transition', async () => {
    await withLegacy(async (db) => {
      const original = await db
        .prepare(
          "SELECT sha256 FROM catalogue_test_migrations WHERE name='0001_catalogue.sql'",
        )
        .first();
      await db
        .prepare(
          "UPDATE catalogue_test_migrations SET sha256='mismatch' WHERE name='0001_catalogue.sql'",
        )
        .run();
      await assert.rejects(
        applyLocalMigrations(db),
        /Applied migration changed/,
      );
      assert.equal(
        await statement(
          db,
          'SELECT name FROM catalogue_test_migrations WHERE name=?',
          upgrade,
        ).first(),
        null,
      );
      await statement(
        db,
        "UPDATE catalogue_test_migrations SET sha256=? WHERE name='0001_catalogue.sql'",
        original.sha256,
      ).run();
      await applyLocalMigrations(db);
      await integrity(db);
    });
  });
});
