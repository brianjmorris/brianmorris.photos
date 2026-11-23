import type { CatalogueDatabase } from '../catalogue/d1.ts';
import { CatalogueError, invalid } from '../catalogue/model.ts';
import { CatalogueRepository, type TagInput } from '../catalogue/repository.ts';
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
      if (params.getAll(key).length !== 1)
        invalid('Duplicate form fields are not allowed.');
    return Object.fromEntries(params);
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
): { input: TagInput; expectedRevision?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('A collection is required.');
  const data = value as Record<string, unknown>;
  const allowed = [
    'name',
    'slug',
    'aliases',
    'notes',
    'featuredOrder',
    'coverPhotoId',
    ...(editing ? ['expectedRevision'] : []),
  ];
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    invalid('Unexpected collection field.');
  if (
    typeof data.name !== 'string' ||
    typeof data.slug !== 'string' ||
    !Array.isArray(data.aliases) ||
    data.aliases.some((alias) => typeof alias !== 'string') ||
    typeof data.notes !== 'string' ||
    !(data.featuredOrder === null || typeof data.featuredOrder === 'number') ||
    !(data.coverPhotoId === null || typeof data.coverPhotoId === 'string')
  )
    invalid(
      'Supply the complete collection, including aliases, notes, featured order and cover.',
    );
  if (editing) validRevision(data.expectedRevision as number);
  return {
    input: {
      name: data.name,
      slug: data.slug,
      aliases: data.aliases,
      notes: data.notes,
      featuredOrder: data.featuredOrder,
      coverPhotoId: data.coverPhotoId,
    },
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
      message:
        error.code === 'conflict' &&
        !error.message.startsWith('This collection changed')
          ? 'A name, alias, address or revision conflicts with another collection. Check your changes and try again.'
          : error.message,
    };
  return {
    status: 503,
    message: 'Collections are temporarily unavailable. Please try again later.',
  };
}

export async function collectionApi(
  owner: unknown,
  db: CatalogueDatabase | undefined,
  operation: (repository: CatalogueRepository) => Promise<Response>,
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
    return await operation(new CatalogueRepository(db));
  } catch (error) {
    const result = collectionError(error);
    return Response.json({ error: result.message }, { status: result.status });
  }
}
