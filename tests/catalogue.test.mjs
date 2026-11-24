import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CatalogueRepository } from '../src/catalogue/repository.ts';
import { normalizeTagName } from '../src/catalogue/model.ts';
import { seedCatalogue } from './helpers/catalogue-fixtures.mjs';
import {
  applyLocalMigrations,
  createLocalCatalogue,
} from './helpers/catalogue.mjs';

describe('local D1 catalogue', () => {
  let local;
  let db;
  let repository;
  let sequence = 0;
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  const scalar = async (sql, ...values) =>
    Object.values(await statement(sql, ...values).first())[0];
  const tag = () => {
    const number = ++sequence;
    return repository.createTag({
      name: `Collection ${number}`,
      slug: `collection-${number}`,
      aliases: [`Alias ${number}`],
    });
  };
  const isError = (code) => (error) => error.code === code;

  // Explicit synthetic projection fixture; this is not a publication API.
  const project = async (photo, tags, time = 1000) =>
    db.batch([
      ...tags.map((entry) =>
        statement(
          'INSERT INTO published_tags VALUES (?, ?) ON CONFLICT(tag_id) DO NOTHING',
          entry.tagId,
          entry.revision,
        ),
      ),
      statement(
        'INSERT INTO published_photos VALUES (?, ?, ?)',
        photo.photoId,
        photo.revision,
        time,
      ),
      ...tags.map((entry) =>
        statement(
          'INSERT INTO published_photo_tags VALUES (?, ?, ?, ?)',
          photo.photoId,
          photo.revision,
          entry.tagId,
          time,
        ),
      ),
    ]);

  before(async () => {
    local = await createLocalCatalogue();
    db = local.db;
    await applyLocalMigrations(db);
    repository = new CatalogueRepository(db);
  });
  after(async () => local?.close());

  it('applies the application migration once and keeps foreign keys valid', async () => {
    await applyLocalMigrations(db);
    assert.equal(
      await scalar('SELECT COUNT(*) FROM catalogue_test_migrations'),
      5,
    );
    assert.deepEqual(
      (await db.prepare('PRAGMA foreign_key_check').all()).results,
      [],
    );
  });

  it('runs the repository inside the local Worker runtime', async () => {
    const response = await local.fetch('http://catalogue.test/');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.photo.revision, 1);
    assert.deepEqual(result.photo.tagIds, [result.tag.tagId]);
    assert.equal(result.next.revision, 2);
    assert.equal(result.resolved.tagId, result.tag.tagId);
    assert.equal(result.conflict, 'conflict');
    assert.deepEqual(result.published, []);
  });

  it('rolls back failed migration DDL and its ledger entry', async () => {
    await assert.rejects(
      db.batch([
        db.prepare('CREATE TABLE failed_catalogue_migration (id INTEGER)'),
        db.prepare(
          "INSERT INTO catalogue_test_migrations VALUES ('failure', 'test')",
        ),
        db.prepare('INSERT INTO nonexistent_catalogue_table VALUES (1)'),
      ]),
    );
    assert.equal(
      await statement(
        "SELECT name FROM sqlite_master WHERE name = 'failed_catalogue_migration'",
      ).first(),
      null,
    );
    assert.equal(
      await statement(
        "SELECT name FROM catalogue_test_migrations WHERE name = 'failure'",
      ).first(),
      null,
    );
  });

  it('normalizes names consistently without stemming or removing accents', async () => {
    const entry = await repository.createTag({
      name: '  Ｂｏａｔｓ\u00a0  Québec ',
      slug: 'boats-quebec',
      aliases: [' BOAT Québec '],
    });
    assert.equal(entry.name, 'Boats Québec');
    assert.equal(normalizeTagName(' BＯＡＴＳ\tQuébec '), 'boats québec');
    assert.equal(
      (await repository.findDraftTag('boat québec')).tagId,
      entry.tagId,
    );
    assert.equal(await repository.findDraftTag('boat quebec'), null);
    assert.equal(await repository.findDraftTag('boating québec'), null);
  });

  it('rejects name/alias collisions atomically, including canonical-to-alias collisions', async () => {
    const first = await tag();
    const count = await scalar('SELECT COUNT(*) FROM tags');
    await assert.rejects(
      repository.createTag({
        name: first.aliases[0].toUpperCase(),
        slug: 'collision-one',
      }),
      isError('conflict'),
    );
    await assert.rejects(
      repository.createTag({
        name: 'Other collision name',
        slug: 'collision-two',
        aliases: [first.name],
      }),
      isError('conflict'),
    );
    assert.equal(await scalar('SELECT COUNT(*) FROM tags'), count);
    await assert.rejects(
      repository.createTag({
        name: 'Self duplicate',
        slug: 'self-duplicate',
        aliases: ['SELF DUPLICATE'],
      }),
      isError('invalid_input'),
    );
    assert.equal(await scalar('SELECT COUNT(*) FROM tags'), count);
  });

  it('keeps stable tag IDs, historical aliases and reserved slugs through renames', async () => {
    const first = await tag();
    const second = await repository.saveTagDraft(
      first.tagId,
      1,
      {
        name: 'Renamed collection',
        slug: 'renamed-collection',
        aliases: ['Renamed alias'],
      },
      2000,
    );
    assert.equal(second.tagId, first.tagId);
    assert.equal(second.revision, 2);
    assert.deepEqual(await repository.getTagRevision(first.tagId, 1), first);
    assert.equal(await repository.findDraftTag(first.aliases[0]), null);
    assert.equal(
      (await repository.findDraftTag('RENAMED ALIAS')).tagId,
      first.tagId,
    );
    await assert.rejects(
      repository.createTag({ name: 'Slug thief', slug: first.slug }),
      isError('conflict'),
    );
    await repository.saveTagDraft(first.tagId, 2, {
      name: second.name,
      slug: first.slug,
    });
    assert.equal((await repository.getTagDraft(first.tagId)).slug, first.slug);
  });

  it('rolls back a conflicting rename without losing the previous head or claims', async () => {
    const first = await tag();
    const other = await tag();
    await assert.rejects(
      repository.saveTagDraft(first.tagId, 1, {
        name: other.name,
        slug: 'failed-rename',
        aliases: ['Temporary alias'],
      }),
      isError('conflict'),
    );
    assert.deepEqual(await repository.getTagDraft(first.tagId), first);
    assert.equal(await repository.getTagRevision(first.tagId, 2), null);
    assert.equal(await repository.findDraftTag('Temporary alias'), null);
    assert.equal(
      (await repository.findDraftTag(first.name)).tagId,
      first.tagId,
    );
    assert.equal(
      await statement(
        'SELECT * FROM tag_slugs WHERE slug = ?',
        'failed-rename',
      ).first(),
      null,
    );
  });

  it('supports untagged drafts and deduplicates photo memberships', async () => {
    const first = await tag();
    const second = await tag();
    const photo = await repository.createPhoto();
    assert.deepEqual(photo.tagIds, []);
    const next = await repository.savePhotoDraft(
      photo.photoId,
      1,
      [first.tagId, first.tagId, second.tagId],
      3000,
    );
    assert.deepEqual(next.tagIds, [first.tagId, second.tagId].sort());
    assert.equal(next.photoId, photo.photoId);
    assert.deepEqual(
      await repository.getPhotoRevision(photo.photoId, 1),
      photo,
    );
  });

  it('rejects orphan relationships and rolls back failed draft creation and saves', async () => {
    const count = await scalar('SELECT COUNT(*) FROM photos');
    await assert.rejects(repository.createPhoto(['missing-tag']));
    assert.equal(await scalar('SELECT COUNT(*) FROM photos'), count);
    const photo = await repository.createPhoto();
    await assert.rejects(
      repository.savePhotoDraft(photo.photoId, 1, ['missing-tag']),
    );
    assert.deepEqual(await repository.getPhotoDraft(photo.photoId), photo);
    assert.equal(await repository.getPhotoRevision(photo.photoId, 2), null);
    const entry = await tag();
    await assert.rejects(
      statement(
        'INSERT INTO photo_tags VALUES (?, ?, ?)',
        photo.photoId,
        99,
        entry.tagId,
      ).run(),
    );
    await assert.rejects(
      statement('DELETE FROM tags WHERE id = ?', entry.tagId).run(),
    );
  });

  it('rejects stale and future revision writes without leaving children behind', async () => {
    const entry = await tag();
    const photo = await repository.createPhoto();
    await repository.savePhotoDraft(photo.photoId, 1, [entry.tagId]);
    await assert.rejects(
      repository.savePhotoDraft(photo.photoId, 1, []),
      isError('conflict'),
    );
    await assert.rejects(
      repository.savePhotoDraft(photo.photoId, 1, [entry.tagId]),
      isError('conflict'),
    );
    await assert.rejects(
      repository.savePhotoDraft(photo.photoId, 20, [entry.tagId]),
      isError('conflict'),
    );
    assert.equal(
      await scalar(
        'SELECT COUNT(*) FROM photo_tags WHERE photo_id = ? AND photo_revision = 21',
        photo.photoId,
      ),
      0,
    );
    await repository.saveTagDraft(entry.tagId, 1, {
      name: 'Latest tag',
      slug: 'latest-tag',
    });
    await assert.rejects(
      repository.saveTagDraft(entry.tagId, 1, {
        name: 'Stale tag',
        slug: 'stale-tag',
        aliases: ['Stale alias'],
      }),
      isError('conflict'),
    );
    await assert.rejects(
      repository.saveTagDraft(entry.tagId, 12, {
        name: 'Future tag',
        slug: 'future-tag',
        aliases: ['Future alias'],
      }),
      isError('conflict'),
    );
    assert.equal(
      await scalar(
        'SELECT COUNT(*) FROM tag_aliases WHERE tag_id = ? AND tag_revision = 13',
        entry.tagId,
      ),
      0,
    );
  });

  it('allows only one competing writer at a given revision', async () => {
    const photo = await repository.createPhoto();
    const outcomes = await Promise.allSettled([
      repository.savePhotoDraft(photo.photoId, 1, [], 4000),
      repository.savePhotoDraft(photo.photoId, 1, [], 5000),
    ]);
    assert.equal(
      outcomes.filter((value) => value.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      outcomes.filter(
        (value) =>
          value.status === 'rejected' && value.reason.code === 'conflict',
      ).length,
      1,
    );
    assert.equal((await repository.getPhotoDraft(photo.photoId)).revision, 2);
  });

  it('seals revisions, memberships, aliases, and stable identities against SQL mutation', async () => {
    const entry = await tag();
    const other = await tag();
    const photo = await repository.createPhoto([entry.tagId]);
    const mutations = [
      statement(
        'UPDATE photo_revisions SET created_at = 1 WHERE photo_id = ?',
        photo.photoId,
      ),
      statement(
        'DELETE FROM photo_revisions WHERE photo_id = ?',
        photo.photoId,
      ),
      statement(
        'INSERT INTO photo_tags VALUES (?, 1, ?)',
        photo.photoId,
        other.tagId,
      ),
      statement('DELETE FROM photo_tags WHERE photo_id = ?', photo.photoId),
      statement(
        'UPDATE photo_tags SET tag_id = ? WHERE photo_id = ?',
        other.tagId,
        photo.photoId,
      ),
      statement(
        'UPDATE tag_revisions SET name = ? WHERE tag_id = ?',
        'Changed',
        entry.tagId,
      ),
      statement('DELETE FROM tag_revisions WHERE tag_id = ?', entry.tagId),
      statement(
        'INSERT INTO tag_aliases VALUES (?, 1, ?, ?)',
        entry.tagId,
        'Late alias',
        'late alias',
      ),
      statement('DELETE FROM tag_aliases WHERE tag_id = ?', entry.tagId),
      statement(
        'UPDATE tag_aliases SET alias = ? WHERE tag_id = ?',
        'Changed',
        entry.tagId,
      ),
      statement(
        'UPDATE photos SET id = ? WHERE id = ?',
        'replacement-id',
        photo.photoId,
      ),
      statement(
        'UPDATE tags SET draft_revision = NULL WHERE id = ?',
        entry.tagId,
      ),
    ];
    for (const mutation of mutations) await assert.rejects(mutation.run());
    assert.deepEqual(await repository.getPhotoDraft(photo.photoId), photo);
    assert.deepEqual(await repository.getTagDraft(entry.tagId), entry);
  });

  it('keeps public memberships and tag names/aliases unchanged when drafts change', async () => {
    const entry = await tag();
    const other = await tag();
    const photo = await repository.createPhoto([entry.tagId]);
    await project(photo, [entry]);
    const publicTag = await repository.getPublishedTag(entry.tagId);
    const memberships = await repository.listPublishedTagPhotos(entry.tagId);
    await repository.savePhotoDraft(photo.photoId, 1, [other.tagId]);
    await repository.saveTagDraft(entry.tagId, 1, {
      name: 'Private draft label',
      slug: 'private-draft-label',
      aliases: ['Private draft alias'],
    });
    assert.deepEqual(await repository.getPublishedTag(entry.tagId), publicTag);
    assert.deepEqual(
      await repository.listPublishedTagPhotos(entry.tagId),
      memberships,
    );
    assert.deepEqual(await repository.listPublishedTagPhotos(other.tagId), []);
    assert.equal(await repository.getPublishedTag(other.tagId), null);
    await assert.rejects(
      statement(
        'INSERT INTO published_photo_tags VALUES (?, ?, ?, ?)',
        photo.photoId,
        2,
        other.tagId,
        1000,
      ).run(),
    );
  });

  it('enforces public membership provenance, uniqueness, and ordering timestamps', async () => {
    const entry = await tag();
    const other = await tag();
    const photo = await repository.createPhoto([entry.tagId]);
    await project(photo, [entry]);
    await statement(
      'INSERT INTO published_tags VALUES (?, ?)',
      other.tagId,
      1,
    ).run();
    await assert.rejects(
      statement(
        'INSERT INTO published_photo_tags VALUES (?, ?, ?, ?)',
        photo.photoId,
        1,
        other.tagId,
        1000,
      ).run(),
    );
    await assert.rejects(
      statement(
        'INSERT INTO published_photo_tags VALUES (?, ?, ?, ?)',
        photo.photoId,
        1,
        entry.tagId,
        1000,
      ).run(),
    );
    await assert.rejects(
      statement(
        'UPDATE published_photo_tags SET first_published_at = 2 WHERE photo_id = ?',
        photo.photoId,
      ).run(),
    );
    await assert.rejects(
      statement(
        'DELETE FROM published_tags WHERE tag_id = ?',
        entry.tagId,
      ).run(),
    );
    await assert.rejects(
      statement(
        'DELETE FROM published_photos WHERE photo_id = ?',
        photo.photoId,
      ).run(),
    );
    assert.deepEqual(
      (await db.prepare('PRAGMA foreign_key_check').all()).results,
      [],
    );
  });

  it('paginates published membership by deterministic indexed keysets', async () => {
    const entry = await tag();
    const photos = [];
    for (let i = 0; i < 5; i++) {
      const photo = await repository.createPhoto([entry.tagId]);
      photos.push(photo.photoId);
      await project(photo, [entry], i < 3 ? 1000 : 2000);
    }
    const expected = [
      ...photos.slice(3).sort().reverse(),
      ...photos.slice(0, 3).sort().reverse(),
    ];
    const first = await repository.listPublishedTagPhotos(entry.tagId, 2);
    const second = await repository.listPublishedTagPhotos(
      entry.tagId,
      2,
      first.at(-1),
    );
    const third = await repository.listPublishedTagPhotos(
      entry.tagId,
      2,
      second.at(-1),
    );
    assert.deepEqual(
      [...first, ...second, ...third].map((row) => row.photoId),
      expected,
    );
    const plans = await Promise.all([
      statement(
        'EXPLAIN QUERY PLAN SELECT photo_id, photo_revision, first_published_at FROM published_photo_tags WHERE tag_id = ? ORDER BY first_published_at DESC, photo_id DESC LIMIT 30',
        entry.tagId,
      ).all(),
      statement(
        'EXPLAIN QUERY PLAN SELECT photo_id, photo_revision, first_published_at FROM published_photo_tags WHERE tag_id = ? AND (first_published_at, photo_id) < (?, ?) ORDER BY first_published_at DESC, photo_id DESC LIMIT 30',
        entry.tagId,
        2000,
        photos[3],
      ).all(),
      statement(
        'EXPLAIN QUERY PLAN SELECT tag_id FROM published_photo_tags WHERE photo_id = ?',
        photos[0],
      ).all(),
      statement(
        'EXPLAIN QUERY PLAN SELECT tag_id FROM tag_name_claims WHERE normalized_name = ?',
        normalizeTagName(entry.name),
      ).all(),
    ]);
    for (const plan of plans) {
      const details = plan.results.map((row) => row.detail).join(' ');
      assert.match(details, /SEARCH .*USING (?:COVERING )?INDEX/);
      assert.doesNotMatch(details, /TEMP B-TREE|SCAN /);
    }
  });

  for (const size of [1000, 10000]) {
    it(`keeps ${size.toLocaleString('en')} synthetic photos bounded and indexed with 300 skewed tags`, async (context) => {
      const fixture = await seedCatalogue(db, size);
      const broadTag = fixture.tags[0].id;
      const page = await repository.listPublishedTagPhotos(broadTag, 30);
      assert.deepEqual(
        page.map((row) => row.photoId),
        fixture.expected.slice(0, 30).map((row) => row.id),
      );
      const next = await repository.listPublishedTagPhotos(
        broadTag,
        30,
        page.at(-1),
      );
      assert.deepEqual(
        next.map((row) => row.photoId),
        fixture.expected.slice(30, 60).map((row) => row.id),
      );
      const result = await statement(
        `SELECT photo_id FROM published_photo_tags WHERE tag_id = ?
        AND (first_published_at, photo_id) < (?, ?)
        ORDER BY first_published_at DESC, photo_id DESC LIMIT 30`,
        broadTag,
        page.at(-1).firstPublishedAt,
        page.at(-1).photoId,
      ).all();
      assert(
        result.meta.rows_read <= 100,
        `Unexpected row reads: ${result.meta.rows_read}`,
      );
      assert.equal(
        await scalar(
          'SELECT COUNT(*) FROM published_photo_tags WHERE tag_id = ?',
          broadTag,
        ),
        fixture.expected.length,
      );
      assert.deepEqual(
        await repository.listPublishedTagPhotos(fixture.tags[299].id),
        [],
      );
      assert.deepEqual(
        (await db.prepare('PRAGMA foreign_key_check').all()).results,
        [],
      );
      context.diagnostic(
        `Local D1 keyset: ${result.meta.rows_read} rows read for ${result.results.length} results; ${fixture.expected.length} published broad-tag members.`,
      );
    });
  }

  it('validates input bounds and reports missing records', async () => {
    await assert.rejects(
      repository.createTag({ name: '', slug: 'empty' }),
      isError('invalid_input'),
    );
    await assert.rejects(
      repository.createTag({ name: 'Control\0name', slug: 'control' }),
      isError('invalid_input'),
    );
    await assert.rejects(
      repository.createTag({ name: 'Bad slug', slug: 'Not a slug' }),
      isError('invalid_input'),
    );
    await assert.rejects(
      repository.createTag({
        name: 'Too many aliases',
        slug: 'too-many-aliases',
        aliases: Array.from({ length: 33 }, (_, i) => `Alias ${i}`),
      }),
      isError('invalid_input'),
    );
    await assert.rejects(
      repository.createPhoto(Array(65).fill('tag')),
      isError('invalid_input'),
    );
    await assert.rejects(
      repository.createPhoto([], -1),
      isError('invalid_input'),
    );
    await assert.rejects(
      repository.listPublishedTagPhotos('tag', 101),
      isError('invalid_input'),
    );
    await assert.rejects(
      repository.listPublishedTagPhotos('tag', 0),
      isError('invalid_input'),
    );
    await assert.rejects(
      repository.savePhotoDraft('missing', 1, []),
      isError('not_found'),
    );
    await assert.rejects(
      repository.saveTagDraft('missing', 1, {
        name: 'Missing',
        slug: 'missing',
      }),
      isError('not_found'),
    );
    await assert.rejects(
      repository.getPhotoDraft("' OR 1=1 --"),
      isError('invalid_input'),
    );
  });
});
