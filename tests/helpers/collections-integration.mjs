import assert from 'node:assert/strict';
import { CatalogueRepository } from '../../src/catalogue/repository.ts';

// Exercise the real built Astro pages, transport, auth middleware and D1 together.
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
  const json = (path, method, input, extraHeaders = {}) =>
    send(path, {
      method,
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...extraHeaders,
      },
    });
  const input = {
    name: 'Worker boats',
    slug: 'worker-boats',
    aliases: ['Worker vessels'],
    notes: 'Original notes',
    featuredOrder: null,
    coverPhotoId: null,
  };
  const count = async () =>
    (await db.prepare('SELECT COUNT(*) AS count FROM tags').first()).count;

  for (const path of ['/dashboard/collections', '/api/owner/tags']) {
    const denied = await worker.dispatchFetch(origin + path);
    assert.equal(denied.status, 401);
    assertPrivate(denied);
  }
  const forbidden = await json('/api/owner/tags', 'POST', input, {
    Origin: 'https://untrusted.example.test',
  });
  assert.equal(forbidden.status, 403);
  assertPrivate(forbidden);
  assert.equal(await count(), 0);
  const created = await json('/api/owner/tags', 'POST', input);
  assert.equal(created.status, 201);
  assertPrivate(created);
  const tag = await created.json();
  assert.equal(tag.notes, input.notes);
  const endpoint = `/api/owner/tags/${tag.tagId}`;
  const pageUrl = `/dashboard/collections?edit=${tag.tagId}`;
  const listed = await send('/api/owner/tags');
  assertPrivate(listed);
  const list = await listed.json();
  assert.equal(list.items[0].name, input.name);
  assert(!('notes' in list.items[0]));
  const initial = await send(pageUrl);
  assert.equal(initial.status, 200);
  assertPrivate(initial);
  assert((await initial.text()).includes('name="expectedRevision" value="1"'));

  const attack =
    'Private </textarea><script>window.collectionAttack=true</script>';
  const form = {
    tagId: tag.tagId,
    expectedRevision: '1',
    name: input.name,
    slug: input.slug,
    aliases: input.aliases.join('\n'),
    notes: attack,
    featuredOrder: '0',
    coverPhotoId: '',
  };
  const submitted = await send('/dashboard/collections', {
    method: 'POST',
    body: new URLSearchParams(form).toString(),
    headers: {
      Origin: origin,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  assert.equal(submitted.status, 303);
  assertPrivate(submitted);
  assert.equal(submitted.headers.get('location'), pageUrl + '&saved=1');
  const escaped = await send(submitted.headers.get('location'));
  const html = await escaped.text();
  assert(html.includes('Draft saved. Published content has not changed.'));
  assert(html.includes('&lt;/textarea&gt;'));
  assert(!html.includes('<script>window.collectionAttack'));
  const saved = await (await send(endpoint)).json();
  assert.equal(saved.revision, 2);
  assert.equal(saved.notes, attack);

  const collision = await json('/api/owner/tags', 'POST', {
    ...input,
    name: input.aliases[0],
    slug: 'colliding-alias',
    aliases: [],
  });
  assert.equal(collision.status, 409);
  assertPrivate(collision);
  assert.equal(await count(), 1);
  const repository = new CatalogueRepository(db);
  const firstPhoto = await repository.createPhoto([tag.tagId]);
  const cover = await repository.savePhotoMetadataDraft(firstPhoto.photoId, 1, {
    title: 'Published harbour photograph',
  });
  await db.batch([
    db
      .prepare(
        'INSERT INTO published_tags (tag_id, tag_revision) VALUES (?, 2)',
      )
      .bind(tag.tagId),
    db
      .prepare(
        'INSERT INTO published_photos (photo_id, photo_revision, first_published_at) VALUES (?, 2, 1000)',
      )
      .bind(cover.photoId),
    db
      .prepare(
        'INSERT INTO published_photo_tags (photo_id, photo_revision, tag_id, first_published_at) VALUES (?, 2, ?, 1000)',
      )
      .bind(cover.photoId, tag.tagId),
  ]);
  const edited = await json(endpoint, 'PUT', {
    ...input,
    notes: 'New private draft',
    featuredOrder: 3,
    coverPhotoId: cover.photoId,
    expectedRevision: 2,
  });
  assert.equal(edited.status, 200);
  assertPrivate(edited);
  const draft = await edited.json();
  assert.equal(draft.revision, 3);
  assert.equal(draft.coverPhotoId, cover.photoId);
  assert.equal((await repository.getPublishedTag(tag.tagId)).notes, attack);
  const editor = await send(pageUrl);
  const editorHtml = await editor.text();
  assert(editorHtml.includes('Published harbour photograph'));
  assert(editorHtml.includes('New private draft'));
  const stale = await send('/dashboard/collections', {
    method: 'POST',
    body: new URLSearchParams({
      ...form,
      notes: 'Unsaved stale input',
    }).toString(),
    headers: {
      Origin: origin,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  assert.equal(stale.status, 409);
  assertPrivate(stale);
  const staleHtml = await stale.text();
  assert(staleHtml.includes('Unsaved stale input'));
  assert(staleHtml.includes('Reload the saved draft'));
  assert.equal(
    (await repository.getTagDraft(tag.tagId)).notes,
    'New private draft',
  );

  for (const [body, status] of [
    [{ ...input, expectedRevision: 2 }, 409],
    [{ ...input, expectedRevision: 3, coverPhotoId: 'not-published' }, 400],
    [{ ...input, expectedRevision: 3, notes: 'x'.repeat(20001) }, 400],
    [{ ...input, expectedRevision: 3, publish: true }, 400],
  ]) {
    const response = await json(endpoint, 'PUT', body);
    assert.equal(response.status, status);
    assertPrivate(response);
  }
  assert.equal((await send('/api/owner/tags/nonexistent')).status, 404);
  const malformed = await send('/api/owner/tags', {
    method: 'POST',
    body: '{broken',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
  });
  assert.equal(malformed.status, 400);
  assertPrivate(malformed);
  const duplicate = await send('/dashboard/collections', {
    method: 'POST',
    body: 'name=One&name=Two',
    headers: {
      Origin: origin,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  assert.equal(duplicate.status, 400);
  assertPrivate(duplicate);
  assert.equal((await repository.getPublishedTag(tag.tagId)).revision, 2);
  assert.equal(await count(), 1);
}
