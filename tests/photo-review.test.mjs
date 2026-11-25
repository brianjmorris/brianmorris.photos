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
import { searchDraftTags } from '../src/catalogue/tag-search.ts';
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
      capture: {
        dateTime: '2024:11:03 01:30:00',
        subseconds: '040',
        offset: null,
      },
      gps: { latitude: 43.6, longitude: -79.4 },
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
    const batch = [
      input({ tagNames: ['Rolled back tag'] }),
      input({ tagIds: ['missing-tag'] }),
    ];
    await assert.rejects(repository.createPhotoDraftBatch(batch));
    for (const photo of batch)
      assert.equal(await repository.getPhotoDraft(photo.photoId), null);
    assert.equal(await repository.findDraftTag('Rolled back tag'), null);
    assert.deepEqual(
      (await local.db.prepare('PRAGMA foreign_key_check').all()).results,
      [],
    );
  });
  it('resolves existing aliases and repeated proposals atomically without creating tags on a retry', async () => {
    const existing = await repository.createTag({
      name: 'street photography',
      aliases: ['street photo'],
    });
    const batch = [
      input({ tagNames: ['  STREET  Photo', 'Blue hour'] }),
      input({ tagNames: ['blue  HOUR'] }),
    ];
    const written = await repository.createPhotoDraftBatch(batch);
    const shared = await repository.findDraftTag('blue hour');
    assert.deepEqual(
      new Set(written[0].tagIds),
      new Set([tag.tagId, existing.tagId, shared.tagId]),
    );
    assert(written[1].tagIds.includes(shared.tagId));
    await repository.createPhotoDraftBatch([
      { ...batch[0], tagNames: ['Unexpected retry proposal'] },
    ]);
    assert.equal(
      await repository.findDraftTag('Unexpected retry proposal'),
      null,
    );
    await assert.rejects(
      repository.addTagsToPhotoDrafts(
        [
          { photoId: batch[0].photoId, expectedRevision: 1 },
          { photoId: batch[1].photoId, expectedRevision: 2 },
        ],
        [],
        ['Rejected saved proposal'],
      ),
      (error) => error.code === 'conflict',
    );
    assert.equal(
      await repository.findDraftTag('Rejected saved proposal'),
      null,
    );
  });

  it('ranks names and aliases before direct and indirect suggestions, with fresh counts after edits', async () => {
    const seed = await repository.createTag({
      name: 'Québec bridge',
      aliases: ['Québec crossing'],
    });
    const bridge = await repository.createTag({ name: 'river valley' });
    const indirect = await repository.createTag({ name: 'waterfall' });
    await repository.createPhoto([bridge.tagId, indirect.tagId]);
    const photo = await repository.createPhoto([seed.tagId, bridge.tagId]);
    const results = await searchDraftTags(local.db, 'Québec crossing', []);
    assert.deepEqual(
      results.map(({ name, match, via, exact }) => ({
        name,
        match,
        via,
        exact,
      })),
      [
        { name: seed.name, match: 'alias', via: null, exact: true },
        { name: bridge.name, match: 'direct', via: seed.name, exact: false },
        {
          name: indirect.name,
          match: 'indirect',
          via: bridge.name,
          exact: false,
        },
      ],
    );
    assert.equal(
      (await searchDraftTags(local.db, 'brid', []))[0].tagId,
      seed.tagId,
    );
    assert.deepEqual(
      await searchDraftTags(local.db, 'Quebec crossing', []),
      [],
    );
    assert.deepEqual(await searchDraftTags(local.db, '") OR *', []), []);
    assert.equal(
      (await searchDraftTags(local.db, '', [seed.tagId]))[0].tagId,
      bridge.tagId,
    );
    await repository.savePhotoMetadataDraft(photo.photoId, 1, {
      title: 'Updated only',
    });
    assert.deepEqual(
      await searchDraftTags(local.db, 'Québec crossing', []),
      results,
    );
    await repository.savePhotoDraft(photo.photoId, 2, [seed.tagId]);
    assert.deepEqual(
      (await searchDraftTags(local.db, 'Québec crossing', [])).map(
        (result) => result.tagId,
      ),
      [seed.tagId],
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
