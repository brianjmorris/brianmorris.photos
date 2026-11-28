import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  await db
    .prepare('INSERT INTO published_photos VALUES (?, 2, 100)')
    .bind(ids[2])
    .run();
  assert.equal((await send(url(ids[2]))).status, 200);

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
}
