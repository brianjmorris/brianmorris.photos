import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runDraftPhotoCleanup } from '../../src/authoring/photo-attachments.ts';
import { DraftAttachmentRepository } from '../../src/catalogue/draft-attachments.ts';
import { CatalogueRepository } from '../../src/catalogue/repository.ts';

// Synthetic 2×2 JPEG, with a comment added so exact metadata preservation is checked.
const baseJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==',
  'base64',
);
const withComment = (comment) =>
  Buffer.concat([
    baseJpeg.subarray(0, 2),
    Buffer.from([255, 254, 0, comment.length + 2]),
    Buffer.from(comment),
    baseJpeg.subarray(2),
  ]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function verifyDraftCleanup(
  worker,
  db,
  bucket,
  identity,
  assertPrivate,
) {
  const photos = new CatalogueRepository(db);
  const attachments = new DraftAttachmentRepository(db);
  const origin = 'https://photos.example.test';
  const page = origin + '/dashboard/storage';
  const openPage = async (path = page) => {
    const response = await worker.dispatchFetch(path, { headers: identity });
    assert.equal(response.status, 200);
    assertPrivate(response);
    return response.text();
  };
  const post = (requestOrigin) =>
    worker.dispatchFetch(page, {
      method: 'POST',
      headers: { ...identity, Origin: requestOrigin },
      redirect: 'manual',
    });
  const now = Date.now();
  const progress = await attachments.cleanupProgress();
  assert.deepEqual(progress, { cursor: null, revision: 0 });
  assert.match(await openPage(), /No runs recorded/);
  for (const method of ['GET', 'POST']) {
    const denied = await worker.dispatchFetch(page, { method });
    assert.equal(denied.status, 401);
    assertPrivate(denied);
  }
  const crossOrigin = await post('https://elsewhere.example.test');
  assert.equal(crossOrigin.status, 403);
  assert.doesNotMatch(
    await crossOrigin.text(),
    /Scheduled cleanup|Manual cleanup/,
  );
  assert.deepEqual(await attachments.cleanupProgress(), progress);

  async function storedFixture(name, reservedAt = now) {
    const { photoId } = await photos.createPhoto();
    const bytes = withComment(name);
    const digest = hash(bytes);
    const { own } = await attachments.reserve(
      photoId,
      digest,
      bytes.length,
      reservedAt,
    );
    const key = `draft-jpegs/${own.id}`;
    await bucket.put(key, bytes, { sha256: digest });
    return { own, key };
  }
  const active = await storedFixture('Cleanup attached fixture');
  assert(await attachments.promote(active.own, now));
  const pending = await storedFixture('Cleanup live upload fixture');
  const expired = await storedFixture(
    'Cleanup expired fixture',
    now - 25 * 60 * 60 * 1000,
  );
  const orphanKeys = Array.from(
    { length: 34 },
    (_, index) =>
      `draft-jpegs/cleanup-orphan-${String(index).padStart(2, '0')}`,
  );
  await Promise.all(orphanKeys.map((key) => bucket.put(key, baseJpeg)));
  await bucket.put('another-prefix/untouched', baseJpeg);

  const unavailable = {
    delete() {
      throw new Error('Simulated R2 deletion failure');
    },
  };
  await assert.rejects(
    runDraftPhotoCleanup(db, unavailable, 'scheduled'),
    /Simulated R2 deletion failure/,
  );
  assert.deepEqual(await attachments.cleanupProgress(), progress);
  assert((await attachments.retiredIds()).includes(expired.own.id));
  assert(await bucket.head(expired.key));
  const failedPage = await openPage();
  assert.match(failedPage, /<strong\b[^>]*>Failed<\/strong>/);
  assert.doesNotMatch(failedPage, /Simulated R2|draft-jpegs\//);

  async function scheduled() {
    const response = await worker.dispatchFetch(
      'http://localhost/cdn-cgi/local/scheduled?format=json',
    );
    assert.equal(response.status, 200, await response.text());
  }

  await scheduled();
  const first = await attachments.cleanupProgress();
  assert.equal(first.revision, 1);
  assert(first.cursor);
  assert.equal(await bucket.head(expired.key), null);
  const scheduledResult = (await attachments.latestCleanupRuns())[0];
  assert.equal(scheduledResult.outcome, 'completed');
  assert.match(await openPage(), /Another pass may be needed/);

  const stale = await attachments.completeCleanup(
    progress.revision,
    null,
    'scheduled',
    now - 1000,
    { scanned: 0, retiredKeys: 0, orphanedKeys: 0, moreWork: false },
  );
  assert.equal(stale, false);
  assert.deepEqual(await attachments.cleanupProgress(), first);
  assert.deepEqual(await attachments.latestCleanupRuns(), [scheduledResult]);

  const manual = await post(origin);
  assert.equal(manual.status, 303);
  assertPrivate(manual);
  const manualPage = await openPage(
    new URL(manual.headers.get('Location'), origin).href,
  );
  assert.match(manualPage, /Manual cleanup pass finished/);
  assert.match(manualPage, /The pass reached the end of the scan/);
  assert.doesNotMatch(manualPage, /draft-jpegs\//);
  const runs = await attachments.latestCleanupRuns();
  assert.deepEqual(
    runs.find((run) => run.trigger === 'scheduled'),
    scheduledResult,
  );
  assert.equal(
    runs.find((run) => run.trigger === 'manual').outcome,
    'completed',
  );
  assert.deepEqual(await attachments.cleanupProgress(), {
    cursor: null,
    revision: 2,
  });
  const remaining = await bucket.list({ prefix: 'draft-jpegs/' });
  assert.deepEqual(
    remaining.objects.map(({ key }) => key).sort(),
    [active.key, pending.key].sort(),
  );
  assert(await bucket.head('another-prefix/untouched'));
  assert.equal(
    (await attachments.get(active.own.photo_id, now)).state,
    'attached',
  );
  assert.equal(
    (await attachments.get(pending.own.photo_id, now)).state,
    'pending',
  );

  await scheduled();
  assert.deepEqual(await attachments.cleanupProgress(), {
    cursor: null,
    revision: 3,
  });
  assert(await bucket.head(active.key));
  assert(await bucket.head(pending.key));
  assert.equal((await attachments.latestCleanupRuns()).length, 2);
}

export async function verifyDraftAttachments(
  worker,
  db,
  bucket,
  identity,
  assertPrivate,
) {
  const origin = 'https://photos.example.test';
  const photos = '/api/owner/photos';
  const url = (id) => `${photos}/${id}/attachment`;
  const cleanup = () =>
    send(`${photos}/attachment-cleanup`, { method: 'POST' });
  const send = (path, options = {}) =>
    worker.dispatchFetch(origin + path, {
      ...options,
      headers: { ...identity, Origin: origin, ...options.headers },
    });
  const put = (id, bytes, options = {}) =>
    send(url(id), {
      method: 'PUT',
      body: bytes,
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Photo-SHA256': hash(bytes),
        ...options,
      },
    });
  const discard = (id, revision, headers = {}) =>
    send(`${photos}/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision: revision }),
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  const getDraft = async (id) =>
    (await (await send(`${photos}?ids=${id}`)).json()).items[0];
  const row = (id) =>
    db
      .prepare(
        "SELECT id, state FROM photo_draft_attachments WHERE photo_id=? AND state <> 'retired'",
      )
      .bind(id)
      .first();
  const jpeg = withComment('Private synthetic metadata');
  const other = withComment('Different bytes');
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
  const created = await send(photos, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      photos: ids.map((photoId) => ({ photoId, title: photoId, tagIds: [] })),
    }),
  });
  assert.equal(created.status, 201, await created.text());
  assert.equal((await getDraft(ids[0])).attachment, 'none');
  assert.equal((await bucket.list()).objects.length, 0);
  for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
    const denied = await worker.dispatchFetch(origin + url(ids[0]), { method });
    assert.equal(denied.status, 401);
    assertPrivate(denied);
  }
  assert.equal(
    (await put(ids[0], jpeg, { Origin: 'https://elsewhere.example.test' }))
      .status,
    403,
  );
  assert.equal((await put('missing-draft', jpeg)).status, 404);

  const malformed = await put(ids[3], Buffer.from('plain text'));
  assert.equal(malformed.status, 400, await malformed.text());
  assert.equal((await bucket.list()).objects.length, 0);
  await send(url(ids[3]), { method: 'DELETE' });
  const oversizeFrame = Buffer.from(jpeg);
  const frameOffset = oversizeFrame.indexOf(Buffer.from([255, 192]));
  oversizeFrame.writeUInt16BE(20001, frameOffset + 7);
  const oversize = await put(ids[3], oversizeFrame);
  assert.equal(oversize.status, 400, await oversize.text());
  await send(url(ids[3]), { method: 'DELETE' });
  const mismatch = await put(ids[3], jpeg, { 'X-Photo-SHA256': hash(other) });
  assert.equal(mismatch.status, 400, await mismatch.text());
  assert.equal((await bucket.list()).objects.length, 0);
  await send(url(ids[3]), { method: 'DELETE' });

  const simultaneous = await Promise.all([
    put(ids[0], jpeg),
    put(ids[0], jpeg),
  ]);
  for (const response of simultaneous)
    assert.equal(response.status, 200, await response.text());
  assert.equal((await bucket.list()).objects.length, 1);
  const attached = await getDraft(ids[0]);
  assert.deepEqual(attached, {
    photoId: ids[0],
    title: ids[0],
    revision: 1,
    tags: [],
    attachment: 'attached',
  });
  const reopened = await send(url(ids[0]));
  assert.equal(reopened.status, 200);
  assertPrivate(reopened);
  assert.equal(reopened.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(
    reopened.headers.get('Cross-Origin-Resource-Policy'),
    'same-origin',
  );
  assert.deepEqual(Buffer.from(await reopened.arrayBuffer()), jpeg);
  const duplicate = await put(ids[1], jpeg);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).existingPhotoId, ids[0]);
  assert.equal((await getDraft(ids[1])).attachment, 'none');

  // Model a dropped response after R2 accepted bytes and before D1 promotion.
  const recoverId = crypto.randomUUID();
  const recoverKey = `draft-jpegs/${recoverId}`;
  await db
    .prepare(
      `INSERT INTO photo_draft_attachments
    VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(recoverId, ids[2], hash(other), other.length, Date.now() + 60_000)
    .run();
  assert.equal((await getDraft(ids[2])).attachment, 'pending');
  assert.equal((await send(url(ids[2]))).status, 404);
  assert.equal((await send(url(ids[2]), { method: 'POST' })).status, 409);
  await bucket.put(recoverKey, other, { sha256: hash(other) });
  const repository = new CatalogueRepository(db);
  await repository.savePhotoMetadataDraft(ids[2], 1, {
    title: 'Edited during upload',
    caption: 'Keep this caption through recovery.',
  });
  const recovered = await send(url(ids[2]), { method: 'POST' });
  assert.equal(recovered.status, 200, await recovered.text());
  assert.equal((await getDraft(ids[2])).attachment, 'attached');
  assert.equal((await getDraft(ids[2])).title, 'Edited during upload');
  assert.equal(
    (await repository.getPhotoDraft(ids[2])).metadata.caption,
    'Keep this caption through recovery.',
  );
  const removed = await send(url(ids[0]), { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assertPrivate(removed);
  assert.equal((await getDraft(ids[0])).title, ids[0]);
  assert.equal((await getDraft(ids[0])).attachment, 'none');
  assert.equal((await send(url(ids[0]))).status, 404);
  assert.equal((await put(ids[1], jpeg)).status, 200);
  const secondKey = `draft-jpegs/${(await row(ids[1])).id}`;
  await bucket.delete(secondKey);
  assert.equal((await send(url(ids[1]))).status, 404);
  assert.equal((await getDraft(ids[1])).attachment, 'attached');
  const expired = crypto.randomUUID();
  const expiredKey = `draft-jpegs/${expired}`;
  await db
    .prepare(
      `INSERT INTO photo_draft_attachments
    VALUES (?, ?, ?, ?, 'pending', 1)`,
    )
    .bind(expired, ids[3], hash(baseJpeg), baseJpeg.length)
    .run();
  await bucket.put(expiredKey, baseJpeg, { sha256: hash(baseJpeg) });
  assert.equal((await getDraft(ids[3])).attachment, 'none');
  assert.equal((await cleanup()).status, 200);
  assert.equal(await bucket.head(expiredKey), null);
  await bucket.put(expiredKey, baseJpeg, { sha256: hash(baseJpeg) });
  assert.equal((await cleanup()).status, 200);
  assert.equal(await bucket.head(expiredKey), null);
  assert.equal((await send(url(ids[3]), { method: 'POST' })).status, 404);
  assert(await bucket.head(recoverKey));

  const tagA = await repository.createTag({
    name: 'Discard fixture first tag',
  });
  const tagB = await repository.createTag({
    name: 'Discard fixture second tag',
  });
  const tags = [tagA.tagId, tagB.tagId];
  const photoId = ids[2];
  await repository.savePhotoDraft(photoId, 2, tags);
  await db.batch([
    ...tags.map((tag) =>
      db.prepare('INSERT INTO published_tags VALUES (?, 1)').bind(tag),
    ),
    db.prepare('INSERT INTO published_photos VALUES (?, 3, 100)').bind(photoId),
    ...tags.map((tag) =>
      db
        .prepare('INSERT INTO published_photo_tags VALUES (?, 3, ?, 100)')
        .bind(photoId, tag),
    ),
  ]);
  await repository.savePhotoMetadataDraft(photoId, 3, {
    title: 'Unpublished draft edits',
  });
  const related = () =>
    db
      .prepare(
        'SELECT photo_count FROM tag_cooccurrences WHERE tag_id=? AND related_id=?',
      )
      .bind(...tags)
      .first();
  assert.equal((await related()).photo_count, 1);
  const deniedDiscard = await worker.dispatchFetch(
    origin + `${photos}/${photoId}`,
    {
      method: 'DELETE',
    },
  );
  assert.equal(deniedDiscard.status, 401);
  assertPrivate(deniedDiscard);
  assert.equal(
    (await discard(photoId, 4, { Origin: 'https://elsewhere.example.test' }))
      .status,
    403,
  );
  assert.equal((await discard(photoId, 0)).status, 400);
  assert.equal((await discard(photoId, 3)).status, 409);
  assert.equal((await getDraft(photoId)).title, 'Unpublished draft edits');
  assert.equal((await send(url(photoId))).status, 200);
  const discarded = await discard(photoId, 4);
  assert.equal(discarded.status, 200, await discarded.text());
  assertPrivate(discarded);
  assert.equal((await discard(photoId, 4)).status, 200);
  assert.equal((await discard(photoId, 3)).status, 404);
  assert.equal(await getDraft(photoId), undefined);
  assert.equal(
    (await send(`${photos}/capture?photoId=${photoId}`)).status,
    404,
  );
  assert.equal((await send(url(photoId))).status, 404);
  assert.equal(await related(), null);
  assert.equal(await repository.getPhotoRevision(photoId, 4), null);
  assert.equal(
    (await repository.getPublishedPhotoMetadata(photoId)).title,
    'Edited during upload',
  );
  assert.deepEqual(
    (await repository.listPublishedTagPhotos(tags[0])).map(
      (entry) => entry.photoId,
    ),
    [photoId],
  );
  assert(await bucket.head(recoverKey));
  assert.equal((await cleanup()).status, 200);
  assert.equal(await bucket.head(recoverKey), null);

  const newId = crypto.randomUUID();
  const retryCreation = await send(photos, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      photos: [newId, photoId].map((id) => ({
        photoId: id,
        title: 'Retry',
        tagIds: [],
        tagNames: ['Discarded retry tag'],
      })),
    }),
  });
  assert.equal(retryCreation.status, 409);
  assert.equal(await getDraft(newId), undefined);
  assert.equal(await repository.findDraftTag('Discarded retry tag'), null);

  const attachments = new DraftAttachmentRepository(db);
  const pending = (
    await attachments.reserve(
      ids[3],
      hash(baseJpeg),
      baseJpeg.length,
      Date.now(),
    )
  ).own;
  assert.equal(pending.state, 'pending');
  assert.equal((await discard(ids[3], 1)).status, 200);
  assert.equal((await put(ids[3], baseJpeg)).status, 404);
  assert.equal((await cleanup()).status, 200);
  const lateKey = `draft-jpegs/${pending.id}`;
  await bucket.put(lateKey, baseJpeg, { sha256: hash(baseJpeg) });
  assert.equal(await attachments.promote(pending, Date.now()), null);
  assert.equal((await send(url(ids[3]), { method: 'POST' })).status, 404);
  assert.equal((await cleanup()).status, 200);
  assert.equal(await bucket.head(lateKey), null);
  assert.deepEqual(
    (await db.prepare('PRAGMA foreign_key_check').all()).results,
    [],
  );
}
