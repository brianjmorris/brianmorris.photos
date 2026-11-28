import type { CatalogueDatabase } from '../catalogue/d1.ts';
import {
  DraftAttachmentRepository,
  draftAttachmentPrefix,
  type DraftAttachment,
  type DraftCleanupTrigger,
} from '../catalogue/draft-attachments.ts';
import { CatalogueError, invalid } from '../catalogue/model.ts';
import { INPUT_LIMITS, inspectJpeg } from '../photo-review/jpeg-input.ts';
import { collectionError } from './collections.ts';

interface StoredJpeg {
  size: number;
  checksums: { sha256?: ArrayBuffer };
}

export interface DraftPhotoBucket {
  head(key: string): Promise<StoredJpeg | null>;
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
  put(
    key: string,
    value: ReadableStream,
    options: {
      onlyIf: { etagDoesNotMatch: string };
      sha256: string;
      httpMetadata: { contentType: string };
    },
  ): Promise<StoredJpeg | null>;
  delete(keys: string[]): Promise<void>;
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<
    {
      objects: { key: string }[];
    } & ({ truncated: false } | { truncated: true; cursor: string })
  >;
}

declare const FixedLengthStream: new (
  bytes: number,
) => TransformStream<Uint8Array, Uint8Array>;

function key(id: string) {
  return draftAttachmentPrefix + id;
}

function uploadDetails(request: Request) {
  if (request.headers.get('Content-Type') !== 'image/jpeg')
    invalid('Choose a JPEG photograph.');
  const length = request.headers.get('Content-Length');
  const size = Number(length);
  const sha256 = request.headers.get('X-Photo-SHA256');
  if (
    !length ||
    !/^\d{1,8}$/.test(length) ||
    !size ||
    size > INPUT_LIMITS.bytes
  )
    invalid('Choose a JPEG within the 40 MiB input limit.');
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256))
    invalid('The JPEG fingerprint is missing or invalid.');
  if (!request.body) invalid('The JPEG upload is empty.');
  return { size, sha256, body: request.body as ReadableStream<Uint8Array> };
}

function matches(object: StoredJpeg | null, attachment: DraftAttachment) {
  if (!object?.checksums.sha256 || object.size !== attachment.byte_length)
    return false;
  const digest = new Uint8Array(object.checksums.sha256);
  return (
    Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    ) === attachment.sha256
  );
}

async function storeJpeg(
  bucket: DraftPhotoBucket,
  attachment: DraftAttachment,
  body: ReadableStream<Uint8Array>,
) {
  const length = attachment.byte_length;
  const header = new Uint8Array(Math.min(length, INPUT_LIMITS.headerBytes));
  let received = 0;
  let validationError: CatalogueError | undefined;
  const fail = (message: string): never => {
    validationError = new CatalogueError('invalid_input', message);
    throw validationError;
  };
  const checked = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        const prior = received;
        received += chunk.byteLength;
        if (received > length)
          fail('The JPEG length does not match the upload.');
        if (prior < header.length) {
          header.set(chunk.subarray(0, header.length - prior), prior);
          if (received >= header.length) {
            try {
              await inspectJpeg(new Blob([header]));
            } catch (error) {
              fail(
                error instanceof Error ? error.message : 'Invalid JPEG header.',
              );
            }
          }
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== length)
          fail('The JPEG length does not match the upload.');
      },
    }),
  );
  const fixed = new FixedLengthStream(length);
  const abort = new AbortController();
  const transfer = checked.pipeTo(fixed.writable, { signal: abort.signal });
  const store = bucket
    .put(key(attachment.id), fixed.readable, {
      onlyIf: { etagDoesNotMatch: '*' },
      sha256: attachment.sha256,
      httpMetadata: { contentType: 'image/jpeg' },
    })
    .then(
      (object) => {
        if (!object) abort.abort();
        return object;
      },
      (error) => {
        abort.abort();
        throw error;
      },
    );
  const [stored, transferred] = await Promise.allSettled([store, transfer]);
  if (validationError) throw validationError;
  if (stored.status === 'rejected') {
    if (/checksum|sha-?256.*(match|digest)/i.test(String(stored.reason)))
      invalid('The received JPEG did not match its fingerprint.');
    throw stored.reason;
  }
  if (stored.value && transferred.status === 'rejected')
    throw transferred.reason;
  return stored.value ?? (await bucket.head(key(attachment.id)));
}

const attachmentStatus = (status: 'attached' | 'none') =>
  Response.json({ status });

export async function draftPhotoApi(
  owner: unknown,
  db: CatalogueDatabase | undefined,
  bucket: DraftPhotoBucket | undefined,
  operation: (
    repository: DraftAttachmentRepository,
    storage: DraftPhotoBucket,
  ) => Promise<Response>,
) {
  if (!owner)
    return Response.json({ error: 'Sign-in required.' }, { status: 401 });
  try {
    if (!db || !bucket) throw new Error('Missing draft attachment storage.');
    return await operation(new DraftAttachmentRepository(db), bucket);
  } catch (cause) {
    const error = collectionError(cause);
    return Response.json(
      {
        error:
          error.status === 503
            ? 'Private photo storage is temporarily unavailable. Try again.'
            : error.message,
      },
      { status: error.status },
    );
  }
}

export async function writeDraftPhoto(
  repository: DraftAttachmentRepository,
  bucket: DraftPhotoBucket,
  photoId: string,
  request: Request,
) {
  const upload = request.method === 'PUT' ? uploadDetails(request) : null;
  let attachment: DraftAttachment | null;
  if (upload) {
    const { exists, own, duplicate } = await repository.reserve(
      photoId,
      upload.sha256,
      upload.size,
      Date.now(),
    );
    if (!exists) throw new CatalogueError('not_found', 'Draft unavailable.');
    if (duplicate && duplicate !== photoId) {
      return Response.json(
        {
          error: 'This exact JPEG belongs to another draft.',
          existingPhotoId: duplicate,
        },
        { status: 409 },
      );
    }
    if (!own || own.sha256 !== upload.sha256 || own.byte_length !== upload.size)
      throw new CatalogueError(
        'conflict',
        'Remove the current attachment or cancel its upload before attaching a different JPEG.',
      );
    attachment = own;
  } else {
    attachment = await repository.get(photoId, Date.now());
    if (!attachment)
      throw new CatalogueError(
        'not_found',
        'Choose a JPEG to attach to this draft.',
      );
  }
  let object = await bucket.head(key(attachment.id));
  if (attachment.state === 'attached') {
    if (!matches(object, attachment))
      throw new CatalogueError(
        'not_found',
        'The attached JPEG is unavailable.',
      );
    return attachmentStatus('attached');
  }
  if (!object && upload)
    object = await storeJpeg(bucket, attachment, upload.body);
  if (!object)
    throw new CatalogueError(
      'conflict',
      'The upload did not finish. Choose the same JPEG to retry.',
    );
  if (!matches(object, attachment))
    throw new CatalogueError(
      'conflict',
      'The stored JPEG could not be verified. Cancel the upload and try again.',
    );
  if (!(await repository.promote(attachment, Date.now())))
    throw new CatalogueError(
      'conflict',
      'This upload was canceled or expired. Attach the JPEG again.',
    );
  return attachmentStatus('attached');
}

export async function readDraftPhoto(
  repository: DraftAttachmentRepository,
  bucket: DraftPhotoBucket,
  photoId: string,
) {
  const attachment = await repository.get(photoId, Date.now());
  const photo =
    attachment?.state === 'attached'
      ? await bucket.get(key(attachment.id))
      : null;
  if (!photo)
    throw new CatalogueError('not_found', 'The attached JPEG is unavailable.');
  return new Response(photo.body, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(photo.size),
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}

export async function removeDraftPhoto(
  repository: DraftAttachmentRepository,
  bucket: DraftPhotoBucket,
  photoId: string,
) {
  const retired = await repository.retire(photoId);
  if (retired) {
    try {
      await bucket.delete([key(retired.id)]);
      await repository.forgetRetired([retired.id]);
    } catch {
      // Revocation has committed. The retired row remains available for cleanup.
    }
  }
  return attachmentStatus('none');
}

export async function cleanDraftPhotos(
  repository: DraftAttachmentRepository,
  bucket: DraftPhotoBucket,
  cursor?: string,
) {
  await repository.retireExpired(Date.now());
  const retired = await repository.retiredIds();
  if (retired.length) {
    await bucket.delete(retired.map(key));
    await repository.forgetRetired(retired);
  }
  const page = await bucket.list({
    prefix: draftAttachmentPrefix,
    limit: 32,
    cursor,
  });
  const live = await repository.liveIds(
    page.objects.map((object) =>
      object.key.slice(draftAttachmentPrefix.length),
    ),
  );
  const orphaned = page.objects.filter(
    (object) => !live.has(object.key.slice(draftAttachmentPrefix.length)),
  );
  if (orphaned.length)
    await bucket.delete(orphaned.map((object) => object.key));
  return {
    nextCursor: page.truncated ? page.cursor : null,
    moreRetired: retired.length === 32,
    scanned: page.objects.length,
    retiredKeys: retired.length,
    orphanedKeys: orphaned.length,
  };
}

export async function runDraftPhotoCleanup(
  db: CatalogueDatabase,
  bucket: DraftPhotoBucket,
  trigger: DraftCleanupTrigger,
) {
  const startedAt = Date.now();
  const repository = new DraftAttachmentRepository(db);
  try {
    const progress = await repository.cleanupProgress();
    if (!progress) throw new Error('Missing draft photo cleanup checkpoint.');
    const { nextCursor, ...summary } = await cleanDraftPhotos(
      repository,
      bucket,
      progress.cursor ?? undefined,
    );
    // Concurrent invocations can clean the same page. Only the current
    // revision can move the checkpoint past that page.
    const advanced = await repository.completeCleanup(
      progress.revision,
      nextCursor,
      trigger,
      startedAt,
      { ...summary, moreWork: nextCursor !== null || summary.moreRetired },
    );
    return { ...summary, advanced, scanComplete: nextCursor === null };
  } catch (error) {
    try {
      await repository.recordCleanupFailure(trigger, startedAt);
    } catch {
      // A D1 outage can prevent status recording. Preserve the original failure.
    }
    throw error;
  }
}
