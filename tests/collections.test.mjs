import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CatalogueRepository } from '../src/catalogue/repository.ts';
import {
  collectionApi,
  collectionInput,
  readCollectionBody,
} from '../src/authoring/collections.ts';
import {
  applyLocalMigrations,
  createLocalCatalogue,
} from './helpers/catalogue.mjs';

describe('collection draft authoring on disposable D1', () => {
  let local, db, repository;
  before(async () => {
    local = await createLocalCatalogue();
    db = local.db;
    await applyLocalMigrations(db);
    repository = new CatalogueRepository(db);
  });
  after(async () => local?.close());
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  let sequence = 0;
  const create = (input = {}) => {
    const id = ++sequence;
    return repository.createTag({
      name: `Collection ${id}`,
      slug: `collection-${id}`,
      ...input,
    });
  };
  async function publishPhoto(tag, title = 'Published cover', time = 100) {
    const first = await repository.createPhoto([tag.tagId]);
    const photo = await repository.savePhotoMetadataDraft(first.photoId, 1, {
      title,
    });
    await db.batch([
      statement(
        'INSERT INTO published_tags (tag_id, tag_revision) VALUES (?, ?) ON CONFLICT DO NOTHING',
        tag.tagId,
        tag.revision,
      ),
      statement(
        'INSERT INTO published_photos (photo_id, photo_revision, first_published_at) VALUES (?, ?, ?)',
        photo.photoId,
        photo.revision,
        time,
      ),
      statement(
        'INSERT INTO published_photo_tags (photo_id, photo_revision, tag_id, first_published_at) VALUES (?, ?, ?, ?)',
        photo.photoId,
        photo.revision,
        tag.tagId,
        time,
      ),
    ]);
    return photo;
  }

  it('saves all editorial values in an immutable draft without changing the published snapshot', async () => {
    const original = await create({ notes: 'Published notes' });
    const cover = await publishPhoto(original);
    const draft = await repository.saveTagDraft(original.tagId, 1, {
      name: original.name,
      slug: original.slug,
      aliases: ['Editorial alias'],
      notes: 'Private replacement notes',
      featuredOrder: 7,
      coverPhotoId: cover.photoId,
    });
    assert.equal(draft.notes, 'Private replacement notes');
    assert.equal(draft.featuredOrder, 7);
    assert.equal(draft.coverPhotoId, cover.photoId);
    assert.deepEqual(
      await repository.getTagRevision(original.tagId, 1),
      original,
    );
    assert.deepEqual(
      await repository.getPublishedTag(original.tagId),
      original,
    );
    await assert.rejects(
      statement(
        'UPDATE tag_revisions SET notes = ? WHERE tag_id = ? AND revision = 2',
        'Changed',
        original.tagId,
      ).run(),
      /immutable_tag_revision/,
    );
    await assert.rejects(
      repository.saveTagDraft(original.tagId, 1, {
        ...draft,
        notes: 'Stale overwrite',
      }),
      (error) => error.code === 'conflict',
    );
    assert.deepEqual(await repository.getTagDraft(original.tagId), draft);
    const cleared = await repository.saveTagDraft(original.tagId, 2, {
      ...draft,
      notes: '',
      featuredOrder: null,
      coverPhotoId: null,
    });
    assert.equal(cleared.notes, '');
    assert.equal(cleared.featuredOrder, null);
    assert.equal(cleared.coverPhotoId, null);
    assert.deepEqual(await repository.getTagRevision(original.tagId, 2), draft);
  });

  it('rejects unpublished and unrelated covers atomically, including through raw SQL', async () => {
    const tag = await create();
    const other = await create();
    const draftPhoto = await repository.createPhoto([tag.tagId]);
    const otherCover = await publishPhoto(other);
    for (const coverPhotoId of [
      draftPhoto.photoId,
      otherCover.photoId,
      'missing-photo',
    ]) {
      await assert.rejects(
        repository.saveTagDraft(tag.tagId, 1, {
          ...tag,
          name: 'Should roll back',
          aliases: ['Should also roll back'],
          coverPhotoId,
        }),
        (error) => error.code === 'invalid_input',
      );
      assert.deepEqual(await repository.getTagDraft(tag.tagId), tag);
      assert.equal(
        await repository.findDraftTag('Should also roll back'),
        null,
      );
    }
    await assert.rejects(
      statement(
        'INSERT INTO tag_revisions (tag_id, revision, created_at, name, normalized_name, slug, cover_photo_id) VALUES (?, 2, 1, ?, ?, ?, ?)',
        tag.tagId,
        tag.name,
        tag.name.toLowerCase(),
        tag.slug,
        otherCover.photoId,
      ).run(),
      /invalid_collection_cover/,
    );
  });

  it('allows one competing writer and reports collisions without losing notes or aliases', async () => {
    const tag = await create({ notes: 'Original' });
    const attempts = await Promise.allSettled([
      repository.saveTagDraft(tag.tagId, 1, {
        ...tag,
        notes: 'Writer A',
        aliases: ['Writer A alias'],
      }),
      repository.saveTagDraft(tag.tagId, 1, {
        ...tag,
        notes: 'Writer B',
        aliases: ['Writer B alias'],
      }),
    ]);
    assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(
      attempts.find((x) => x.status === 'rejected').reason.code,
      'conflict',
    );
    const saved = await repository.getTagDraft(tag.tagId);
    assert.deepEqual(saved.aliases, [saved.notes + ' alias']);
    const collision = await create({ name: 'Claimed name' });
    await assert.rejects(
      repository.saveTagDraft(tag.tagId, 2, {
        ...saved,
        aliases: [collision.name],
      }),
      (error) => error.code === 'conflict',
    );
    assert.deepEqual(await repository.getTagDraft(tag.tagId), saved);
  });

  it('validates notes and editorial limits before creating any identity', async () => {
    const before = await statement(
      'SELECT COUNT(*) AS count FROM tags',
    ).first();
    for (const fields of [
      { notes: 'x'.repeat(20001) },
      { notes: 'Bad\0note' },
      { featuredOrder: -1 },
      { featuredOrder: 1.5 },
      { featuredOrder: 1000001 },
      { coverPhotoId: '../photo' },
    ]) {
      await assert.rejects(
        create(fields),
        (error) => error.code === 'invalid_input',
      );
    }
    assert.deepEqual(
      await statement('SELECT COUNT(*) AS count FROM tags').first(),
      before,
    );
  });

  it('pages owner summaries without notes and reads cover titles from published revisions only', async () => {
    const tag = await create({
      name: 'Z paginated covers',
      notes: 'Private notes',
    });
    for (let index = 0; index < 4; index++) {
      const photo = await publishPhoto(tag, `Cover ${index}`, index + 10);
      await repository.savePhotoMetadataDraft(photo.photoId, 2, {
        title: `Private newer title ${index}`,
      });
    }
    const first = await repository.listCoverChoices(tag.tagId, undefined, 2);
    assert.deepEqual(
      first.items.map((x) => x.title),
      ['Cover 3', 'Cover 2'],
    );
    const second = await repository.listCoverChoices(
      tag.tagId,
      first.nextAfter,
      2,
    );
    assert.deepEqual(
      second.items.map((x) => x.title),
      ['Cover 1', 'Cover 0'],
    );
    assert.equal(second.nextAfter, null);
    const all = [];
    let cursor;
    do {
      const page = await repository.listTagDrafts(cursor, 2);
      assert(page.items.length <= 2);
      assert(
        page.items.every((item) => !('notes' in item) && !('aliases' in item)),
      );
      all.push(...page.items);
      cursor = page.nextAfter ?? undefined;
    } while (cursor);
    assert.equal(new Set(all.map((x) => x.tagId)).size, all.length);
    assert.equal(
      all.length,
      (await statement('SELECT COUNT(*) AS count FROM tags').first()).count,
    );
    assert.equal(all.find((x) => x.tagId === tag.tagId).publishedRevision, 1);
    await assert.rejects(
      repository.listTagDrafts('missing-tag'),
      (error) => error.code === 'invalid_input',
    );
    await assert.rejects(
      repository.listCoverChoices(tag.tagId, undefined, 101),
      (error) => error.code === 'invalid_input',
    );
  });
});

describe('collection transport boundary', () => {
  const input = {
    name: 'Boats',
    slug: 'boats',
    aliases: [],
    notes: '',
    featuredOrder: null,
    coverPhotoId: null,
  };
  it('requires a complete validated shape and rejects unknown fields or stale-version omissions', () => {
    assert.deepEqual(collectionInput(input).input, input);
    for (const value of [
      null,
      [],
      { ...input, published: true },
      { ...input, aliases: 'Boat' },
      { ...input, notes: null },
      { ...input, featuredOrder: '0' },
      { ...input, coverPhotoId: 1 },
    ]) {
      assert.throws(
        () => collectionInput(value),
        (error) => error.code === 'invalid_input',
      );
    }
    assert.throws(
      () => collectionInput(input, true),
      (error) => error.code === 'invalid_input',
    );
  });
  it('rejects malformed, duplicated, wrong-type and oversized request bodies', async () => {
    const req = (body, type = 'application/json') =>
      new Request('https://photos.test/api/owner/tags', {
        method: 'POST',
        headers: { 'Content-Type': type },
        body,
      });
    await assert.rejects(
      readCollectionBody(req('{broken'), 'json'),
      (error) => error.code === 'invalid_input',
    );
    await assert.rejects(
      readCollectionBody(req('{}', 'text/plain'), 'json'),
      (error) => error.status === 415,
    );
    await assert.rejects(
      readCollectionBody(req('x'.repeat(128 * 1024 + 1)), 'json'),
      (error) => error.status === 413,
    );
    await assert.rejects(
      readCollectionBody(
        req('name=First&name=Second', 'application/x-www-form-urlencoded'),
        'form',
      ),
      (error) => error.code === 'invalid_input',
    );
  });
  it('denies missing identity/storage before accessing data and never reveals database failures', async () => {
    const unused = async () => assert.fail('Storage should not be used');
    assert.equal((await collectionApi(null, {}, unused)).status, 401);
    assert.equal((await collectionApi({}, undefined, unused)).status, 503);
    const response = await collectionApi({}, {}, async () => {
      throw Error('private SQL and draft details');
    });
    assert.equal(response.status, 503);
    assert(!JSON.stringify(await response.json()).includes('private SQL'));
  });
});
