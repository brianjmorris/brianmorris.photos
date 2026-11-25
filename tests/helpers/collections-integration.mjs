import assert from 'node:assert/strict';
import { CatalogueRepository } from '../../src/catalogue/repository.ts';
import { CollectionRepository } from '../../src/catalogue/collections.ts';

export async function verifyCollectionEditor(
  worker,
  db,
  identity,
  assertPrivate,
) {
  const origin = 'https://photos.example.test';
  const send = (path, options = {}) =>
    worker.dispatchFetch(origin + path, {
      ...options,
      headers: { ...identity, ...options.headers },
      redirect: 'manual',
    });
  const json = (path, method, input, extra = {}) =>
    send(path, {
      method,
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json', Origin: origin, ...extra },
    });
  const form = (path, input) =>
    send(path, {
      method: 'POST',
      body: new URLSearchParams(input).toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: origin,
      },
    });
  for (const path of [
    '/dashboard/tags',
    '/dashboard/collections',
    '/dashboard/photos',
    '/api/owner/tags',
    '/api/owner/tags/search?q=Nippon',
    '/api/owner/collections',
    '/api/owner/photos',
  ]) {
    const denied = await worker.dispatchFetch(origin + path);
    assert.equal(denied.status, 401);
    assertPrivate(denied);
  }
  const tagInput = {
    name: 'Japan',
    aliases: ['Nippon'],
    notes: 'Tag Notes',
  };
  const forbidden = await json('/api/owner/tags', 'POST', tagInput, {
    Origin: 'https://untrusted.example.test',
  });
  assert.equal(forbidden.status, 403);
  assertPrivate(forbidden);
  const tags = [];
  for (const input of [tagInput, { name: 'Architecture' }, { name: 'Night' }]) {
    const response = await json('/api/owner/tags', 'POST', input);
    assert.equal(response.status, 201);
    assertPrivate(response);
    tags.push(await response.json());
  }
  const existingTag = await json('/api/owner/tags', 'POST', {
    name: '  NIPPON ',
  });
  assert.equal(existingTag.status, 200);
  assert.equal((await existingTag.json()).tagId, tags[0].tagId);
  const tagPage = await send('/dashboard/tags');
  assert(!(await tagPage.text()).includes('Tag address'));
  const tagSearch = await send('/api/owner/tags/search?q=nippon');
  assert.equal(tagSearch.status, 200);
  assertPrivate(tagSearch);
  assert.deepEqual((await tagSearch.json()).items[0], {
    tagId: tags[0].tagId,
    name: 'Japan',
    match: 'alias',
    alias: 'Nippon',
    via: null,
    exact: true,
  });
  assert.equal(
    (await json('/api/owner/tags', 'POST', { ...tagInput, featuredOrder: 1 }))
      .status,
    400,
  );
  const tagForm = await form('/dashboard/tags', {
    tagId: tags[0].tagId,
    expectedRevision: '1',
    ...tagInput,
    aliases: 'Nippon',
    notes: 'Updated tag Notes',
  });
  assert.equal(tagForm.status, 303);
  assertPrivate(tagForm);
  const input = {
    tagIds: tags.slice(0, 2).map((t) => t.tagId),
    name: null,
    notes: 'Original collection Notes',
    featuredOrder: null,
    coverPhotoId: null,
  };
  const created = await json('/api/owner/collections', 'POST', input);
  assert.equal(created.status, 201);
  assertPrivate(created);
  const c = await created.json();
  assert.equal(c.name, null);
  const endpoint = `/api/owner/collections/${c.collectionId}`,
    page = `/dashboard/collections?edit=${c.collectionId}`;
  assert.equal(
    (
      await json('/api/owner/collections', 'POST', {
        ...input,
        tagIds: [...input.tagIds].reverse(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await json('/api/owner/collections', 'POST', {
        ...input,
        tagIds: [tags[0].tagId],
      })
    ).status,
    400,
  );
  const namedResponse = await json('/api/owner/collections', 'POST', {
    ...input,
    tagIds: tags.slice(1).map((t) => t.tagId),
    name: 'Architecture at night',
    notes: '',
  });
  assert.equal(namedResponse.status, 201);
  const named = await namedResponse.json();
  const nameOnlyForm = await form('/dashboard/collections', {
    collectionId: '',
    expectedRevision: '',
    tagNames: 'Japan\nNight',
    name: 'Night in Japan',
    notes: '',
    featuredOrder: '0',
    coverPhotoId: '',
  });
  assert.equal(nameOnlyForm.status, 303);
  const nameOnlyPage = await send(nameOnlyForm.headers.get('location'));
  assert.equal(nameOnlyPage.status, 200);
  assert((await nameOnlyPage.text()).includes('Notes (optional)'));
  const renamed = await json(`/api/owner/tags/${tags[0].tagId}`, 'PUT', {
    ...tagInput,
    name: 'Japan renamed',
    aliases: [],
    notes: 'Updated tag Notes',
    expectedRevision: 2,
  });
  assert.equal(renamed.status, 200);
  const attack =
    'Private </textarea><script>window.collectionAttack=true</script>';
  const edit = {
    collectionId: c.collectionId,
    expectedRevision: '1',
    tagNames: 'Nippon\nArchitecture',
    name: '',
    notes: attack,
    featuredOrder: '0',
    coverPhotoId: '',
  };
  const saved = await form('/dashboard/collections', edit);
  assert.equal(saved.status, 303);
  assertPrivate(saved);
  const edited = await send(saved.headers.get('location'));
  const html = await edited.text();
  assert(html.includes('Draft saved. Published content has not changed.'));
  assert(html.includes('&lt;/textarea&gt;'));
  assert(!html.includes('<script>window.collectionAttack'));
  assert(html.includes('Name (optional)'));
  assert(html.includes('Japan'));
  assertPrivate(edited);
  const collectionList = await (await send('/api/owner/collections')).json();
  assert.equal(collectionList.items.length, 3);
  assert(collectionList.items.every((x) => !('notes' in x)));
  assert.equal((await (await send('/api/owner/tags')).json()).items.length, 3);
  const repository = new CatalogueRepository(db),
    collections = new CollectionRepository(db);
  const draftId = crypto.randomUUID();
  const draftBody = {
    photos: [
      {
        photoId: draftId,
        title: 'Local review draft',
        tagIds: [tags[0].tagId],
      },
    ],
  };
  const draftResponse = await json('/api/owner/photos', 'POST', draftBody);
  assert.equal(draftResponse.status, 201);
  assertPrivate(draftResponse);
  const draftPage = await draftResponse.json();
  assert.equal(draftPage.items[0].photoId, draftId);
  assert.equal(draftPage.items[0].tags[0].name, 'Japan renamed');
  const repeated = await json('/api/owner/photos', 'POST', draftBody);
  assert.equal(repeated.status, 201);
  assert.equal((await repeated.json()).items[0].photoId, draftId);
  const loaded = await send(`/api/owner/photos?ids=${draftId}`);
  assert.equal(loaded.status, 200);
  assertPrivate(loaded);
  assert.equal((await loaded.json()).items[0].title, 'Local review draft');
  assert.equal(
    (
      await json('/api/owner/photos', 'POST', draftBody, {
        Origin: 'https://untrusted.example.test',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await json('/api/owner/photos', 'POST', {
        photos: [{ ...draftBody.photos[0], file: 'private-image-data' }],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await send('/api/owner/photos', {
        method: 'POST',
        body: 'fake JPEG bytes',
        headers: { Origin: origin, 'Content-Type': 'image/jpeg' },
      })
    ).status,
    415,
  );
  assert.equal(await repository.getPublishedPhotoMetadata(draftId), null);
  const photo = await repository.createPhoto(tags.map((t) => t.tagId));
  const cover = await repository.savePhotoMetadataDraft(photo.photoId, 1, {
    title: 'Published matching photograph',
  });
  await db.batch([
    ...tags.map((tag) =>
      db
        .prepare(
          'INSERT INTO published_tags (tag_id, tag_revision) VALUES (?, ?)',
        )
        .bind(tag.tagId, tag.tagId === tags[0].tagId ? 3 : 1),
    ),
    db
      .prepare(
        'INSERT INTO published_photos (photo_id, photo_revision, first_published_at) VALUES (?, 2, 1000)',
      )
      .bind(cover.photoId),
    ...tags.map((tag) =>
      db
        .prepare(
          'INSERT INTO published_photo_tags (photo_id, photo_revision, tag_id, first_published_at) VALUES (?, 2, ?, 1000)',
        )
        .bind(cover.photoId, tag.tagId),
    ),
    db
      .prepare(
        'INSERT INTO published_collections (collection_id, collection_revision) VALUES (?, 2)',
      )
      .bind(c.collectionId),
  ]);
  const update = await json(endpoint, 'PUT', {
    ...input,
    name: 'Japan architecture',
    notes: 'Private new draft',
    featuredOrder: 0,
    coverPhotoId: cover.photoId,
    expectedRevision: 2,
  });
  assert.equal(update.status, 200);
  assertPrivate(update);
  assert.equal((await collections.getPublished(c.collectionId)).notes, attack);
  assert(
    (await (await send(page)).text()).includes('Published matching photograph'),
  );
  const stale = await form('/dashboard/collections', {
    ...edit,
    notes: 'Unsaved stale Notes',
  });
  assert.equal(stale.status, 409);
  assertPrivate(stale);
  const staleHtml = await stale.text();
  assert(staleHtml.includes('Unsaved stale Notes'));
  assert(staleHtml.includes('Reload the saved draft'));
  const untagged = await repository.createPhoto();
  const initialReview = await send('/dashboard/photos');
  assert((await initialReview.text()).includes('No tags yet'));
  const assignment = await json(
    '/api/owner/photos/assign-collections',
    'POST',
    {
      photos: [{ photoId: untagged.photoId, expectedRevision: 1 }],
      collectionIds: [c.collectionId, named.collectionId],
    },
  );
  assert.equal(assignment.status, 200);
  assertPrivate(assignment);
  assert.deepEqual(
    (await repository.getPhotoDraft(untagged.photoId)).tagIds,
    tags.map((t) => t.tagId).sort(),
  );
  const selectionForm = new URLSearchParams();
  selectionForm.append('photos', `${untagged.photoId}:2`);
  selectionForm.append('photos', `${cover.photoId}:2`);
  selectionForm.append('collectionIds', c.collectionId);
  selectionForm.append('collectionIds', named.collectionId);
  const applied = await form('/dashboard/photos', selectionForm);
  assert.equal(applied.status, 303);
  assertPrivate(applied);
  const review = await send('/dashboard/photos');
  assert.equal(review.status, 200);
  const reviewHtml = await review.text();
  assert(reviewHtml.includes('Published matching photograph'));
  assert.match(reviewHtml, /Tags:\s*Architecture, Japan renamed, Night/);
  const assignedSummary = (await repository.listPhotoDrafts()).items.find(
    (item) => item.photoId === untagged.photoId,
  );
  assert.deepEqual(
    assignedSummary.tags.map((tag) => tag.name),
    ['Architecture', 'Japan renamed', 'Night'],
  );
  const individualAssignment = await json(
    '/api/owner/photos/assign-collections',
    'POST',
    {
      photos: [{ photoId: untagged.photoId, expectedRevision: 3 }],
      collectionIds: [],
      tagNames: ['Japan', 'city lights'],
    },
  );
  assert.equal(individualAssignment.status, 200);
  const assignedTags = (await individualAssignment.json()).items[0].tags;
  assert.deepEqual(
    assignedTags.map((tag) => tag.name),
    ['Architecture', 'city lights', 'Japan renamed', 'Night'],
  );
  const denial = await json(
    '/api/owner/photos/assign-collections',
    'POST',
    {
      photos: [{ photoId: cover.photoId, expectedRevision: 3 }],
      collectionIds: [c.collectionId],
    },
    { Origin: 'https://untrusted.example.test' },
  );
  assert.equal(denial.status, 403);
  assert.equal(
    (
      await json(endpoint, 'PUT', {
        ...input,
        expectedRevision: 3,
        publish: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await json('/api/owner/photos/assign-collections', 'POST', {
        photos: [null],
        collectionIds: [],
      })
    ).status,
    400,
  );
  assert.equal((await send('/api/owner/collections/missing')).status, 404);
  assert.equal((await collections.getPublished(c.collectionId)).revision, 2);
}
