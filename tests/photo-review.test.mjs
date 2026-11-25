import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addRequiredTags,
  draftDetails,
  matchingCollections,
  requiredTags,
  tagCoverage,
} from '../src/photo-review/model.ts';
import { CatalogueRepository } from '../src/catalogue/repository.ts';
import {
  applyLocalMigrations,
  createLocalCatalogue,
} from './helpers/catalogue.mjs';

const a = { tagId: 'a', name: 'Harbour' },
  b = { tagId: 'b', name: 'Winter' },
  c = { tagId: 'c', name: 'Night' };
describe('local photograph selection', () => {
  it('distinguishes common, mixed and newly required tags without losing unrelated tags', () => {
    const photos = [{ tags: [a, b] }, { tags: [a, c] }];
    const coverage = tagCoverage(photos, [b]);
    assert.deepEqual(
      coverage.find((t) => t.tagId === 'a'),
      { ...a, count: 2, adding: false },
    );
    assert.deepEqual(
      coverage.find((t) => t.tagId === 'b'),
      { ...b, count: 1, adding: true },
    );
    assert.deepEqual(
      coverage.find((t) => t.tagId === 'c'),
      { ...c, count: 1, adding: false },
    );
    assert.deepEqual(
      new Set(addRequiredTags([a, c], [a, b]).map((tag) => tag.tagId)),
      new Set(['a', 'b', 'c']),
    );
  });
  it('unions named and unnamed collection tags and derives all-tag matches with extra tags', () => {
    const collections = [
      {
        collectionId: 'ab',
        name: 'Winter harbour',
        tags: [a, b],
        hasNotes: false,
      },
      { collectionId: 'bc', name: null, tags: [b, c], hasNotes: true },
    ];
    assert.equal(requiredTags(collections).length, 3);
    assert.deepEqual(
      matchingCollections([a, b, c], collections).map((c) => c.collectionId),
      ['ab', 'bc'],
    );
    assert.deepEqual(matchingCollections([a], collections), []);
  });
  it('serializes only new draft identifiers, titles and tags; excludes files, previews, fingerprints and saved records', () => {
    const input = {
      photoId: 'local-id',
      title: null,
      tags: [a],
      origin: 'local',
      saved: false,
      fileName: 'private-original.jpg',
      hash: 'private-fingerprint',
      previewUrl: 'blob:private-preview',
      thumbnailUrl: 'blob:private-thumb',
      source: { GPSLatitude: 42 },
    };
    assert.deepEqual(
      draftDetails([input, { ...input, photoId: 'saved-id', saved: true }]),
      { photos: [{ photoId: 'local-id', title: null, tagIds: ['a'] }] },
    );
    const serialized = JSON.stringify(draftDetails([input]));
    assert(!serialized.includes('private'));
    assert(!serialized.includes('GPS'));
  });
});

describe('local batch draft persistence on D1', () => {
  let local, repository, tag;
  before(async () => {
    local = await createLocalCatalogue();
    await applyLocalMigrations(local.db);
    repository = new CatalogueRepository(local.db);
    tag = await repository.createTag({
      name: 'Review tag',
      slug: 'review-tag',
    });
  });
  after(async () => local?.close());
  const input = (overrides = {}) => ({
    photoId: crypto.randomUUID(),
    title: null,
    tagIds: [tag.tagId],
    ...overrides,
  });
  it('creates several private drafts atomically and preserves the explicit per-file identifiers', async () => {
    const batch = [
      input({ title: 'First draft' }),
      input({ title: 'Second draft', tagIds: [] }),
    ];
    const saved = await repository.createPhotoDraftBatch(batch);
    assert.deepEqual(
      saved.map((p) => p.photoId),
      batch.map((p) => p.photoId),
    );
    assert.equal(saved[0].metadata.title, 'First draft');
    assert.deepEqual(saved[0].tagIds, [tag.tagId]);
    assert.deepEqual(saved[1].tagIds, []);
    assert.equal(
      await repository.getPublishedPhotoMetadata(saved[0].photoId),
      null,
    );
    const page = await repository.listPhotoDrafts(
      undefined,
      30,
      batch.map((p) => p.photoId),
    );
    assert.equal(page.items.length, 2);
    assert.equal(
      page.items.find((p) => p.photoId === batch[0].photoId).tags[0].name,
      'Review tag',
    );
  });
  it('retries an ambiguous creation response without duplicates or overwriting newer edits', async () => {
    const first = input({ title: 'Original draft' });
    await repository.createPhotoDraftBatch([first]);
    await repository.savePhotoMetadataDraft(first.photoId, 1, {
      title: 'Later edit',
    });
    const retry = await repository.createPhotoDraftBatch([
      { ...first, title: 'Old retried title' },
    ]);
    assert.equal(retry[0].revision, 2);
    assert.equal(retry[0].metadata.title, 'Later edit');
    assert.equal(
      (
        await local.db
          .prepare('SELECT COUNT(*) AS n FROM photos WHERE id=?')
          .bind(first.photoId)
          .first()
      ).n,
      1,
    );
  });
  it('rolls back valid earlier items when a later item has a missing tag', async () => {
    const batch = [input(), input({ tagIds: ['missing-tag'] })];
    await assert.rejects(repository.createPhotoDraftBatch(batch));
    for (const photo of batch)
      assert.equal(await repository.getPhotoDraft(photo.photoId), null);
    assert.deepEqual(
      (await local.db.prepare('PRAGMA foreign_key_check').all()).results,
      [],
    );
  });
  it('rejects duplicate identifiers, excessive batches and malformed local identifiers before writing', async () => {
    const photo = input();
    for (const batch of [
      [photo, photo],
      [],
      Array.from({ length: 31 }, () => input()),
      [input({ photoId: 'not-a-local-uuid' })],
    ])
      await assert.rejects(
        repository.createPhotoDraftBatch(batch),
        (error) => error.code === 'invalid_input',
      );
    assert.equal(await repository.getPhotoDraft(photo.photoId), null);
  });
});
