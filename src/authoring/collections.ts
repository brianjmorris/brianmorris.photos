import type { CatalogueDatabase } from '../catalogue/d1.ts';
import { CatalogueError, invalid } from '../catalogue/model.ts';
import {
  CollectionRepository,
  normalizeCollection,
  type CollectionInput,
} from '../catalogue/collections.ts';
import { validRevision } from '../catalogue/validation.ts';

export class CollectionRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function readCollectionBody(
  request: Request,
  format: 'json' | 'form',
  multiple: readonly string[] = [],
): Promise<unknown> {
  const expected =
    format === 'json'
      ? 'application/json'
      : 'application/x-www-form-urlencoded';
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    expected
  )
    throw new CollectionRequestError(415, 'Unsupported request format.');
  const reader = request.body?.getReader();
  if (!reader) invalid('A collection is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > (format === 'form' ? 256 : 128) * 1024) {
        await reader.cancel();
        throw new CollectionRequestError(
          413,
          'The collection is too large to save.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const body = new TextDecoder().decode(bytes);
  if (format === 'form') {
    const params = new URLSearchParams(body);
    for (const key of params.keys())
      if (!multiple.includes(key) && params.getAll(key).length !== 1)
        invalid('Duplicate form fields are not allowed.');
    return Object.fromEntries(
      [...new Set(params.keys())].map((key) => [
        key,
        multiple.includes(key) ? params.getAll(key) : params.get(key),
      ]),
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    invalid('A valid JSON collection is required.');
  }
}

export function collectionInput(
  value: unknown,
  editing = false,
): { input: CollectionInput; expectedRevision?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('A collection is required.');
  const data = value as Record<string, unknown>;
  const allowed = [
    'name',
    'tagIds',
    'notes',
    'featuredOrder',
    'coverPhotoId',
    ...(editing ? ['expectedRevision'] : []),
  ];
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    invalid('Unexpected collection field.');
  if (
    !(data.name === null || typeof data.name === 'string') ||
    !Array.isArray(data.tagIds) ||
    data.tagIds.some((tag) => typeof tag !== 'string') ||
    typeof data.notes !== 'string' ||
    !(data.featuredOrder === null || typeof data.featuredOrder === 'number') ||
    !(data.coverPhotoId === null || typeof data.coverPhotoId === 'string')
  )
    invalid(
      'Supply the defining tags, optional name, Notes, featured order and cover.',
    );
  if (editing) validRevision(data.expectedRevision as number);
  return {
    input: normalizeCollection(data as unknown as CollectionInput),
    ...(editing ? { expectedRevision: data.expectedRevision as number } : {}),
  };
}

export function collectionError(error: unknown): {
  status: number;
  message: string;
} {
  if (error instanceof CollectionRequestError)
    return { status: error.status, message: error.message };
  if (error instanceof CatalogueError)
    return {
      status: { invalid_input: 400, conflict: 409, not_found: 404 }[error.code],
      message: error.message,
    };
  return {
    status: 503,
    message: 'Collections are temporarily unavailable. Please try again later.',
  };
}

export async function collectionApi(
  owner: unknown,
  db: CatalogueDatabase | undefined,
  operation: (repository: CollectionRepository) => Promise<Response>,
): Promise<Response> {
  if (!owner)
    return Response.json({ error: 'Sign-in required.' }, { status: 401 });
  if (!db)
    return Response.json(
      {
        error:
          'Collections are temporarily unavailable. Please try again later.',
      },
      { status: 503 },
    );
  try {
    return await operation(new CollectionRepository(db));
  } catch (error) {
    const result = collectionError(error);
    return Response.json({ error: result.message }, { status: result.status });
  }
}
