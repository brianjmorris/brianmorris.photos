import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CatalogueRepository } from '../src/catalogue/repository.ts';
import {
  CollectionRepository,
  collectionTagIds,
} from '../src/catalogue/collections.ts';
import {
  collectionApi,
  collectionInput,
  readCollectionBody,
} from '../src/authoring/collections.ts';
import { tagInput } from '../src/authoring/tags.ts';
import {
  applyLocalMigrations,
  createLocalCatalogue,
} from './helpers/catalogue.mjs';

describe('distinct collections on disposable D1', () => {
  let local,
    db,
    tags,
    collections,
    sequence = 0;
  before(async () => {
    local = await createLocalCatalogue();
    db = local.db;
    await applyLocalMigrations(db);
    tags = new CatalogueRepository(db);
    collections = new CollectionRepository(db);
  });
  after(async () => local?.close());
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  async function vocabulary() {
    const prefix = ++sequence;
    return Promise.all(
      ['Japan', 'Architecture', 'Night', 'Extra'].map((name) =>
        tags.createTag({
          name: `${prefix} ${name}`,
          slug: `tag-${prefix}-${name.toLowerCase()}`,
          aliases: [`${prefix} Alias ${name}`],
          notes: `Tag Notes ${name}`,
        }),
      ),
    );
  }
  const input = (vocabulary, overrides = {}) => ({
    tagIds: vocabulary.slice(0, 2).map((t) => t.tagId),
    name: null,
    notes: 'Collection Notes',
    featuredOrder: null,
    coverPhotoId: null,
    ...overrides,
  });
  async function publishTags(values) {
    await db.batch(
      values.map((tag) =>
        statement(
          'INSERT INTO published_tags (tag_id, tag_revision) VALUES (?, ?) ON CONFLICT DO NOTHING',
          tag.tagId,
          tag.revision,
        ),
      ),
    );
  }
  async function photo(values, published = true, time = 1000) {
    const first = await tags.createPhoto(values.map((t) => t.tagId));
    const result = await tags.savePhotoMetadataDraft(first.photoId, 1, {
      title: 'Published matching photo',
      caption: 'Keep my caption',
    });
    if (published) {
      await publishTags(values);
      await db.batch([
        statement(
          'INSERT INTO published_photos (photo_id, photo_revision, first_published_at) VALUES (?, ?, ?)',
          result.photoId,
          result.revision,
          time,
        ),
        ...values.map((t) =>
          statement(
            'INSERT INTO published_photo_tags (photo_id, photo_revision, tag_id, first_published_at) VALUES (?, ?, ?, ?)',
            result.photoId,
            result.revision,
            t.tagId,
            time,
          ),
        ),
      ]);
    }
    return result;
  }
  const publish = (c) =>
    statement(
      'INSERT INTO published_collections (collection_id, collection_revision) VALUES (?, ?)',
      c.collectionId,
      c.revision,
    ).run();

  it('keeps tag Notes separate, resolves aliases, and identifies one combination independent of order', async () => {
    const vocabulary = await vocabularyForTest();
    const c = await collections.createDraft(input(vocabulary));
    assert.equal(c.name, null);
    assert.deepEqual(
      await tags.resolveTagNames([
        vocabulary[1].aliases[0],
        vocabulary[0].name,
      ]),
      c.tagIds,
    );
    assert.deepEqual(await collections.findDraft([...c.tagIds].reverse()), c);
    assert.equal(
      (await tags.getTagDraft(vocabulary[0].tagId)).notes,
      'Tag Notes Japan',
    );
    assert(!('featuredOrder' in (await tags.getTagDraft(vocabulary[0].tagId))));
    const before = await statement(
      'SELECT COUNT(*) AS n FROM collection_tags',
    ).first();
    await assert.rejects(
      collections.createDraft(
        input(vocabulary, { tagIds: [...c.tagIds].reverse() }),
      ),
      (e) => e.code === 'conflict',
    );
    assert.deepEqual(
      await statement('SELECT COUNT(*) AS n FROM collection_tags').first(),
      before,
    );
    assert.throws(
      () => collectionTagIds([vocabulary[0].tagId, vocabulary[0].tagId]),
      (e) => e.code === 'invalid_input',
    );
    await assert.rejects(
      collections.createDraft(
        input(vocabulary, { tagIds: [vocabulary[0].tagId, 'missing-tag'] }),
      ),
      (e) => e.code === 'invalid_input',
    );
  });
  // Avoid shadowing the fixture factory with per-test vocabulary variables.
  const vocabularyForTest = () => vocabulary();

  it('recognises only exact published tag sets; extra photo tags still match', async () => {
    const v = await vocabulary();
    const c = await collections.createDraft(input(v));
    const matching = await photo(v.slice(0, 3));
    await photo(v.slice(0, 1));
    assert.equal(await collections.recognizePublished(c.tagIds), null);
    await publish(c);
    assert.equal(
      (await collections.recognizePublished([...c.tagIds].reverse()))
        .collectionId,
      c.collectionId,
    );
    assert.equal(
      await collections.recognizePublished(c.tagIds.slice(0, 1)),
      null,
    );
    assert.equal(
      await collections.recognizePublished(v.slice(0, 3).map((t) => t.tagId)),
      null,
    );
    assert.deepEqual(
      (await collections.listCoverChoices(c.collectionId)).items.map(
        (p) => p.photoId,
      ),
      [matching.photoId],
    );
    assert(
      !(await collections.listSuggestions()).items.some(
        (x) => x.collectionId === c.collectionId,
      ),
    );
  });

  it('restricts featuring to named collections and preserves editorial work when Notes are cleared', async () => {
    const v = await vocabulary();
    await assert.rejects(
      collections.createDraft(input(v, { featuredOrder: 1 })),
      (e) => e.code === 'invalid_input',
    );
    const cover = await photo(v);
    const c = await collections.createDraft(
      input(v, {
        name: 'A named collection',
        featuredOrder: 2,
        coverPhotoId: cover.photoId,
      }),
    );
    await publish(c);
    assert(
      (await collections.listSuggestions()).items.some(
        (x) => x.collectionId === c.collectionId,
      ),
    );
    const cleared = await collections.saveDraft(c.collectionId, 1, {
      ...c,
      notes: '',
    });
    assert.equal(cleared.name, c.name);
    assert.equal(cleared.coverPhotoId, c.coverPhotoId);
    assert.equal(cleared.featuredOrder, 2);
    assert.deepEqual(await collections.getPublished(c.collectionId), c);
    await statement(
      'UPDATE published_collections SET collection_revision = 2 WHERE collection_id = ?',
      c.collectionId,
    ).run();
    assert.equal((await collections.recognizePublished(c.tagIds)).name, c.name);
    assert(
      (await collections.listSuggestions()).items.some(
        (x) => x.collectionId === c.collectionId,
      ),
    );
    await collections.saveDraft(c.collectionId, 2, {
      ...cleared,
      name: null,
      featuredOrder: null,
    });
    await assert.rejects(
      statement(
        'UPDATE published_collections SET collection_revision = 3 WHERE collection_id = ?',
        c.collectionId,
      ).run(),
      /invalid_published_collection/,
    );
    const privateOnly = await collections.createDraft(
      input(v, {
        tagIds: v.slice(1, 3).map((t) => t.tagId),
        name: null,
        notes: '\n\t  ',
      }),
    );
    assert.equal(privateOnly.notes, '');
    await assert.rejects(publish(privateOnly), /invalid_published_collection/);
    assert.equal(
      await collections.recognizePublished(privateOnly.tagIds),
      null,
    );
  });

  it('enforces minimum tags, canonical identity, immutability and named featuring in SQL', async () => {
    const v = await vocabulary();
    await assert.rejects(
      db.batch([
        statement(
          'INSERT INTO collection_tags (collection_id, tag_id) VALUES (?, ?)',
          'bad-combination',
          v[0].tagId,
        ),
        statement(
          'INSERT INTO collections (id, created_at, tag_set_key) VALUES (?, 1, ?)',
          'bad-combination',
          JSON.stringify([v[0].tagId]),
        ),
      ]),
    );
    const c = await collections.createDraft(input(v));
    await assert.rejects(
      statement(
        'UPDATE collection_tags SET tag_id = ? WHERE collection_id = ? AND tag_id = ?',
        v[2].tagId,
        c.collectionId,
        c.tagIds[0],
      ).run(),
      /immutable_collection_definition/,
    );
    await assert.rejects(
      statement(
        'INSERT INTO collection_tags (collection_id, tag_id) VALUES (?, ?)',
        c.collectionId,
        v[2].tagId,
      ).run(),
      /immutable_collection_definition/,
    );
    await assert.rejects(
      statement(
        'UPDATE collection_revisions SET notes = ? WHERE collection_id = ?',
        'changed',
        c.collectionId,
      ).run(),
      /immutable_collection_revision/,
    );
    await assert.rejects(
      statement(
        'INSERT INTO collection_revisions (collection_id, revision, created_at, name, notes, featured_order) VALUES (?, 2, 1, NULL, ?, 0)',
        c.collectionId,
        'Notes',
      ).run(),
    );
    await assert.rejects(
      collections.saveDraft(
        c.collectionId,
        1,
        input(v, { tagIds: v.slice(1, 3).map((t) => t.tagId) }),
      ),
      (e) => e.code === 'invalid_input',
    );
    assert.deepEqual(
      (await statement('PRAGMA foreign_key_check').all()).results,
      [],
    );
  });

  it('checks covers against every tag and published membership, including direct SQL', async () => {
    const v = await vocabulary();
    const c = await collections.createDraft(input(v));
    const partial = await photo(v.slice(0, 1));
    const unpublished = await photo(v, false);
    const matching = await photo(v, true, 2000);
    for (const coverPhotoId of [
      partial.photoId,
      unpublished.photoId,
      'missing-photo',
    ]) {
      await assert.rejects(
        collections.saveDraft(c.collectionId, 1, { ...c, coverPhotoId }),
        (e) => e.code === 'invalid_input',
      );
      assert.deepEqual(await collections.getDraft(c.collectionId), c);
    }
    await assert.rejects(
      statement(
        'INSERT INTO collection_revisions (collection_id, revision, created_at, name, notes, cover_photo_id) VALUES (?, 2, 1, NULL, ?, ?)',
        c.collectionId,
        'Notes',
        partial.photoId,
      ).run(),
      /invalid_collection_cover/,
    );
    const saved = await collections.saveDraft(c.collectionId, 1, {
      ...c,
      coverPhotoId: matching.photoId,
    });
    assert.equal(saved.coverPhotoId, matching.photoId);
    await tags.savePhotoMetadataDraft(matching.photoId, 2, {
      title: 'Private new title',
    });
    assert.equal(
      (await collections.listCoverChoices(c.collectionId, undefined, 1))
        .items[0].title,
      'Published matching photo',
    );
    await assert.rejects(
      collections.listCoverChoices(c.collectionId, undefined, 101),
      (e) => e.code === 'invalid_input',
    );
    await statement(
      'DELETE FROM published_photo_tags WHERE photo_id = ? AND tag_id = ?',
      matching.photoId,
      c.tagIds[0],
    ).run();
    await assert.rejects(publish(saved), /invalid_published_collection/);
  });

  it('rejects stale and competing collection saves without altering published Notes', async () => {
    const v = await vocabulary();
    await publishTags(v);
    const c = await collections.createDraft(input(v));
    await publish(c);
    const results = await Promise.allSettled(
      ['Writer A', 'Writer B'].map((notes) =>
        collections.saveDraft(c.collectionId, 1, { ...c, notes }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      results.find((r) => r.status === 'rejected').reason.code,
      'conflict',
    );
    assert.deepEqual(await collections.getPublished(c.collectionId), c);
    assert.deepEqual(await collections.getRevision(c.collectionId, 1), c);
  });

  it('directly assigns several collections to several photo drafts, preserving extra tags and metadata', async () => {
    const v = await vocabulary();
    const first = await collections.createDraft(input(v));
    const second = await collections.createDraft(
      input(v, { tagIds: [v[1].tagId, v[2].tagId] }),
    );
    const photos = [await photo([v[3]]), await photo([v[3]], false)];
    const assigned = await collections.assignPhotos(
      photos.map((p) => ({ photoId: p.photoId, expectedRevision: p.revision })),
      [first.collectionId, second.collectionId, first.collectionId],
    );
    for (let i = 0; i < assigned.length; i++) {
      assert.deepEqual(assigned[i].tagIds, v.map((t) => t.tagId).sort());
      assert.deepEqual(assigned[i].metadata, photos[i].metadata);
      assert.equal(assigned[i].revision, photos[i].revision + 1);
    }
    assert.deepEqual(
      (await tags.getPhotoRevision(photos[0].photoId, photos[0].revision))
        .tagIds,
      [v[3].tagId],
    );
    assert.deepEqual(
      (
        await statement(
          'SELECT tag_id FROM published_photo_tags WHERE photo_id = ?',
          photos[0].photoId,
        ).all()
      ).results,
      [{ tag_id: v[3].tagId }],
    );
    const before = await tags.getPhotoDraft(photos[0].photoId);
    await assert.rejects(
      collections.assignPhotos(
        [
          { photoId: photos[0].photoId, expectedRevision: before.revision },
          { photoId: photos[1].photoId, expectedRevision: 1 },
        ],
        [first.collectionId],
      ),
      (e) => e.code === 'conflict',
    );
    assert.deepEqual(await tags.getPhotoDraft(photos[0].photoId), before);
    const empty = await collections.saveDraft(first.collectionId, 1, {
      ...first,
      notes: '',
    });
    await assert.rejects(
      collections.assignPhotos(
        [{ photoId: photos[0].photoId, expectedRevision: before.revision }],
        [empty.collectionId],
      ),
      (e) => e.code === 'invalid_input',
    );
  });

  it('pages saved combinations without leaking Notes in summaries', async () => {
    const found = [];
    let cursor;
    do {
      const result = await collections.listDrafts(cursor, 2);
      assert(result.items.every((x) => !('notes' in x) && x.tags.length >= 2));
      found.push(...result.items);
      cursor = result.nextAfter ?? undefined;
    } while (cursor);
    assert.equal(found.length, new Set(found.map((c) => c.collectionId)).size);
    assert.equal(
      found.length,
      (await statement('SELECT COUNT(*) AS n FROM collections').first()).n,
    );
  });
});

describe('collection and tag transport', () => {
  const input = {
    tagIds: ['japan', 'architecture'],
    name: null,
    notes: 'Notes',
    featuredOrder: null,
    coverPhotoId: null,
  };
  it('accepts unnamed combinations and keeps tag-only fields out of collection inputs', () => {
    assert.deepEqual(collectionInput(input).input.tagIds, [
      'architecture',
      'japan',
    ]);
    for (const value of [
      null,
      [],
      { ...input, published: true },
      { ...input, tagIds: ['japan'] },
      { ...input, notes: null },
      { ...input, featuredOrder: '0' },
      { ...input, coverPhotoId: 1 },
      { ...input, aliases: [] },
    ])
      assert.throws(
        () => collectionInput(value),
        (e) => e.code === 'invalid_input',
      );
    assert.throws(
      () => collectionInput(input, true),
      (e) => e.code === 'invalid_input',
    );
    assert.throws(
      () =>
        tagInput({
          name: 'Japan',
          slug: 'japan',
          aliases: [],
          notes: '',
          featuredOrder: 1,
        }),
      (e) => e.code === 'invalid_input',
    );
  });
  it('bounds bodies and permits repeated selection fields only when explicitly declared', async () => {
    const req = (body, type = 'application/json') =>
      new Request('https://photos.test/api/owner/collections', {
        method: 'POST',
        headers: { 'Content-Type': type },
        body,
      });
    await assert.rejects(
      readCollectionBody(req('{broken'), 'json'),
      (e) => e.code === 'invalid_input',
    );
    await assert.rejects(
      readCollectionBody(req('{}', 'text/plain'), 'json'),
      (e) => e.status === 415,
    );
    await assert.rejects(
      readCollectionBody(req('x'.repeat(128 * 1024 + 1)), 'json'),
      (e) => e.status === 413,
    );
    await assert.rejects(
      readCollectionBody(
        req('name=A&name=B', 'application/x-www-form-urlencoded'),
        'form',
      ),
      (e) => e.code === 'invalid_input',
    );
    assert.deepEqual(
      await readCollectionBody(
        req('photos=A&photos=B', 'application/x-www-form-urlencoded'),
        'form',
        ['photos'],
      ),
      { photos: ['A', 'B'] },
    );
  });
  it('denies missing owner or storage and suppresses internal errors', async () => {
    const unused = async () => assert.fail('Storage should not be accessed');
    assert.equal((await collectionApi(null, {}, unused)).status, 401);
    assert.equal((await collectionApi({}, undefined, unused)).status, 503);
    const result = await collectionApi({}, {}, async () => {
      throw Error('Private SQL');
    });
    assert.equal(result.status, 503);
    assert(!(await result.text()).includes('Private SQL'));
  });
});
