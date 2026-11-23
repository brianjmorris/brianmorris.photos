import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { CatalogueRepository } from '../src/catalogue/repository.ts';
import { PlaceRepository } from '../src/catalogue/places.ts';
import {
  applyLocalMigrations,
  createLocalCatalogue,
} from './helpers/catalogue.mjs';

async function withCatalogue(operation, through) {
  const local = await createLocalCatalogue();
  try {
    await applyLocalMigrations(local.db, through);
    const catalogue = new CatalogueRepository(local.db);
    const places = new PlaceRepository(local.db);
    await operation({ db: local.db, catalogue, places });
  } finally {
    await local.close();
  }
}

async function extendSchema(db) {
  const sql = await readFile(
    new URL('./fixtures/catalogue-extension.sql', import.meta.url),
    'utf8',
  );
  await db.batch(
    sql
      .split('-- statement')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => db.prepare(part)),
  );
}

async function seed(catalogue, places, db) {
  // Seed the original schema directly so a populated upgrade does not depend
  // on newer authoring code being compatible with an unmigrated database.
  const tag = {
    tagId: crypto.randomUUID(),
    revision: 1,
    createdAt: 100,
    name: 'Migration boats',
    slug: 'migration-boats',
    aliases: ['Migration vessel'],
    notes: '',
    featuredOrder: null,
    coverPhotoId: null,
  };
  await db.batch([
    db
      .prepare('INSERT INTO tags (id, created_at) VALUES (?, ?)')
      .bind(tag.tagId, 100),
    db
      .prepare(
        'INSERT INTO tag_aliases (tag_id, tag_revision, alias, normalized_alias) VALUES (?, 1, ?, ?)',
      )
      .bind(tag.tagId, 'Migration vessel', 'migration vessel'),
    db
      .prepare(
        'INSERT INTO tag_revisions (tag_id, revision, created_at, name, normalized_name, slug) VALUES (?, 1, 100, ?, ?, ?)',
      )
      .bind(tag.tagId, tag.name, 'migration boats', tag.slug),
    db
      .prepare('UPDATE tags SET draft_revision = 1 WHERE id = ?')
      .bind(tag.tagId),
  ]);
  const photo = await catalogue.createPhoto([tag.tagId]);
  const place = await places.create({
    name: 'Migration harbour',
    kind: 'site',
    aliases: ['Migration port'],
    provenance: { kind: 'manual' },
  });
  const revision = await catalogue.savePhotoMetadataDraft(photo.photoId, 1, {
    title: 'Existing title',
    rights: { creators: ['Élodie'] },
    publicLocation: {
      visibility: 'place',
      place: { placeId: place.placeId, revision: 1 },
    },
  });
  await db.batch([
    db
      .prepare(
        'INSERT INTO published_tags (tag_id, tag_revision) VALUES (?, ?)',
      )
      .bind(tag.tagId, 1),
    db
      .prepare(
        'INSERT INTO published_photos (photo_id, photo_revision, first_published_at) VALUES (?, ?, ?)',
      )
      .bind(photo.photoId, 2, 1000),
    db
      .prepare(
        'INSERT INTO published_photo_tags (photo_id, photo_revision, tag_id, first_published_at) VALUES (?, ?, ?, ?)',
      )
      .bind(photo.photoId, 2, tag.tagId, 1000),
  ]);
  return {
    tag,
    photo: revision,
    place,
    published: await catalogue.getPublishedPhotoMetadata(photo.photoId),
  };
}

describe('catalogue migration compatibility', () => {
  it('upgrades populated tables with optional columns and retains authoring and public snapshots', async () => {
    await withCatalogue(async ({ db, catalogue, places }) => {
      const before = await seed(catalogue, places, db);
      await extendSchema(db);
      // The application migration must also work with an extended ledger table.
      await applyLocalMigrations(db);
      const nextTag = await catalogue.saveTagDraft(before.tag.tagId, 1, {
        name: 'Renamed migration boats',
        slug: 'renamed-migration-boats',
        aliases: ['Renamed migration vessel'],
      });
      const nextPhoto = await catalogue.savePhotoDraft(
        before.photo.photoId,
        2,
        [],
      );
      const nextPlace = await places.saveDraft(before.place.placeId, 1, {
        name: 'Renamed harbour',
        kind: 'site',
        aliases: ['Renamed port'],
        provenance: { kind: 'manual' },
      });
      assert.equal(nextTag.revision, 2);
      assert.deepEqual(nextPhoto.metadata, before.photo.metadata);
      assert.deepEqual(nextPlace.aliases, ['Renamed port']);
      assert.equal(
        (await catalogue.findDraftTag('RENAMED MIGRATION VESSEL')).tagId,
        before.tag.tagId,
      );
      assert.deepEqual(
        await catalogue.getTagRevision(before.tag.tagId, 1),
        before.tag,
      );
      assert.deepEqual(
        await catalogue.getPhotoRevision(before.photo.photoId, 2),
        before.photo,
      );
      assert.deepEqual(
        await places.getRevision({
          placeId: before.place.placeId,
          revision: 1,
        }),
        before.place,
      );
      assert.deepEqual(
        await catalogue.getPublishedPhotoMetadata(before.photo.photoId),
        before.published,
      );
      assert.equal(
        (await catalogue.listPublishedTagPhotos(before.tag.tagId))[0]
          .firstPublishedAt,
        1000,
      );
      const freshTag = await catalogue.createTag({
        name: 'Fresh extended tag',
        slug: 'fresh-extended-tag',
        aliases: ['Fresh extended alias'],
      });
      await catalogue.createPhoto([freshTag.tagId]);
      await places.create({
        name: 'Fresh extended place',
        kind: 'site',
        aliases: ['Fresh place alias'],
        provenance: { kind: 'manual' },
      });
      await assert.rejects(
        catalogue.saveTagDraft(before.tag.tagId, 2, {
          name: freshTag.name,
          slug: 'collision-after-extension',
        }),
        (error) => error.code === 'conflict',
      );
      assert.deepEqual(await catalogue.getTagDraft(before.tag.tagId), nextTag);
      assert.equal(
        (await catalogue.findDraftTag('RENAMED MIGRATION VESSEL')).tagId,
        before.tag.tagId,
      );
      assert.equal(await catalogue.getTagRevision(before.tag.tagId, 3), null);
      assert.equal(
        (
          await db
            .prepare('SELECT COUNT(*) AS count FROM catalogue_test_migrations')
            .first()
        ).count,
        4,
      );
      assert.deepEqual(
        (await db.prepare('PRAGMA foreign_key_check').all()).results,
        [],
      );
    }, '0002_metadata_places.sql');
  });

  it('adds a relationship using existing stable IDs without changing old revisions', async () => {
    await withCatalogue(async ({ db, catalogue, places }) => {
      const before = await seed(catalogue, places, db);
      const related = await catalogue.createPhoto();
      await extendSchema(db);
      await db
        .prepare(
          'INSERT INTO migration_test_photo_links (photo_id, related_photo_id) VALUES (?, ?)',
        )
        .bind(before.photo.photoId, related.photoId)
        .run();
      await catalogue.savePhotoDraft(before.photo.photoId, 2, []);
      assert.deepEqual(
        (
          await db
            .prepare(
              'SELECT photo_id, related_photo_id FROM migration_test_photo_links',
            )
            .all()
        ).results,
        [{ photo_id: before.photo.photoId, related_photo_id: related.photoId }],
      );
      assert.deepEqual(
        await catalogue.getPhotoRevision(before.photo.photoId, 2),
        before.photo,
      );
      assert.deepEqual(
        await catalogue.getPublishedPhotoMetadata(before.photo.photoId),
        before.published,
      );
      await assert.rejects(
        db
          .prepare(
            'INSERT INTO migration_test_photo_links (photo_id, related_photo_id) VALUES (?, ?)',
          )
          .bind(before.photo.photoId, 'missing-photo')
          .run(),
      );
      assert.deepEqual(
        (await db.prepare('PRAGMA foreign_key_check').all()).results,
        [],
      );
    });
  });

  it('backfills a new column transactionally and restores revision immutability', async () => {
    await withCatalogue(async ({ db, catalogue, places }) => {
      const before = await seed(catalogue, places, db);
      await extendSchema(db);
      const trigger = await db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'photo_revision_immutable_update'",
        )
        .first();
      await db.batch([
        db.prepare('DROP TRIGGER photo_revision_immutable_update'),
        db
          .prepare(
            'UPDATE photo_revisions SET editorial_label = ? WHERE photo_id = ? AND revision = ? AND editorial_label IS NULL',
          )
          .bind('Backfilled label', before.photo.photoId, 2),
        db.prepare(trigger.sql),
      ]);
      assert.equal(
        (
          await db
            .prepare(
              'SELECT editorial_label FROM photo_revisions WHERE photo_id = ? AND revision = 2',
            )
            .bind(before.photo.photoId)
            .first()
        ).editorial_label,
        'Backfilled label',
      );
      assert.deepEqual(
        await catalogue.getPhotoRevision(before.photo.photoId, 2),
        before.photo,
      );
      assert.deepEqual(
        await catalogue.getPublishedPhotoMetadata(before.photo.photoId),
        before.published,
      );
      await assert.rejects(
        db
          .prepare(
            'UPDATE photo_revisions SET created_at = 1 WHERE photo_id = ?',
          )
          .bind(before.photo.photoId)
          .run(),
      );
      await assert.rejects(
        db
          .prepare(
            'UPDATE photo_revisions SET editorial_label = ? WHERE photo_id = ?',
          )
          .bind('Later mutation', before.photo.photoId)
          .run(),
      );
      assert.deepEqual(
        (await db.prepare('PRAGMA foreign_key_check').all()).results,
        [],
      );
    });
  });

  it('rolls back a failed backfill, its DDL and ledger entry, including the immutable trigger', async () => {
    await withCatalogue(async ({ db, catalogue, places }) => {
      const before = await seed(catalogue, places, db);
      await extendSchema(db);
      const trigger = await db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'photo_revision_immutable_update'",
        )
        .first();
      await assert.rejects(
        db.batch([
          db.prepare('DROP TRIGGER photo_revision_immutable_update'),
          db
            .prepare(
              'UPDATE photo_revisions SET editorial_label = ? WHERE photo_id = ?',
            )
            .bind('Uncommitted label', before.photo.photoId),
          db.prepare(
            'CREATE INDEX failed_backfill_index ON photo_revisions(editorial_label)',
          ),
          db
            .prepare(
              'INSERT INTO catalogue_test_migrations (name, sha256) VALUES (?, ?)',
            )
            .bind('failed-backfill', 'test-only'),
          db.prepare('INSERT INTO missing_backfill_target (id) VALUES (1)'),
        ]),
      );
      assert.equal(
        (
          await db
            .prepare(
              'SELECT editorial_label FROM photo_revisions WHERE photo_id = ? AND revision = 2',
            )
            .bind(before.photo.photoId)
            .first()
        ).editorial_label,
        null,
      );
      assert.deepEqual(
        await db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'photo_revision_immutable_update'",
          )
          .first(),
        trigger,
      );
      assert.equal(
        await db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'failed_backfill_index'",
          )
          .first(),
        null,
      );
      assert.equal(
        await db
          .prepare(
            "SELECT name FROM catalogue_test_migrations WHERE name = 'failed-backfill'",
          )
          .first(),
        null,
      );
      await assert.rejects(
        db
          .prepare(
            'UPDATE photo_revisions SET created_at = 1 WHERE photo_id = ?',
          )
          .bind(before.photo.photoId)
          .run(),
      );
      assert.deepEqual(
        await catalogue.getPhotoRevision(before.photo.photoId, 2),
        before.photo,
      );
      assert.deepEqual(
        await catalogue.getPublishedPhotoMetadata(before.photo.photoId),
        before.published,
      );
    });
  });

  it('rejects an applied migration hash mismatch before applying later migrations', async () => {
    await withCatalogue(async ({ db }) => {
      const old = await db
        .prepare('SELECT sha256 FROM catalogue_test_migrations WHERE name = ?')
        .bind('0001_catalogue.sql')
        .first();
      await db
        .prepare(
          'UPDATE catalogue_test_migrations SET sha256 = ? WHERE name = ?',
        )
        .bind('mismatched-hash', '0001_catalogue.sql')
        .run();
      await assert.rejects(
        applyLocalMigrations(db),
        /Applied migration changed: 0001_catalogue\.sql/,
      );
      assert.equal(
        await db
          .prepare('SELECT name FROM catalogue_test_migrations WHERE name = ?')
          .bind('0003_explicit_namespace_columns.sql')
          .first(),
        null,
      );
      await db
        .prepare(
          'UPDATE catalogue_test_migrations SET sha256 = ? WHERE name = ?',
        )
        .bind(old.sha256, '0001_catalogue.sql')
        .run();
      await applyLocalMigrations(db);
      await applyLocalMigrations(db);
      assert.equal(
        (
          await db
            .prepare('SELECT COUNT(*) AS count FROM catalogue_test_migrations')
            .first()
        ).count,
        4,
      );
    }, '0002_metadata_places.sql');
  });
});
