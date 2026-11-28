import {
  DEFAULT_PAGE_SIZE,
  DISCOVERY_SCHEMA,
  MAX_FILTER_TAGS,
  MAX_PAGE_SIZE,
  PUBLIC_SORT,
  type PhotoQuery,
  type PhotoViewReference,
  type DiscoveryError,
  type DiscoveryRequest,
  type DiscoveryResponse,
  type NormalizedQuery,
  type PhotoPosition,
  type PublicDiscoverySource,
  type PublicPhotoPreview,
  type WindowRequest,
} from './contracts.ts';

class RequestError extends Error {
  readonly code: 'invalid_request' | 'invalid_cursor';
  constructor(code: 'invalid_request' | 'invalid_cursor') {
    super(code);
    this.code = code;
  }
}

function check(condition: unknown): asserts condition {
  if (!condition) throw new RequestError('invalid_request');
}

function id(value: unknown): asserts value is string {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value));
}

function version(value: unknown): asserts value is number {
  check(Number.isSafeInteger(value) && (value as number) > 0);
}

function reference(value: PhotoViewReference): PhotoViewReference {
  check(value && ['tag', 'group', 'place'].includes(value.kind));
  id(value.id);
  return { kind: value.kind, id: value.id };
}

export function normalizeCollectionQuery(input: PhotoQuery): NormalizedQuery {
  check(input && typeof input === 'object');
  const collection = reference(input.collection);
  check(input.sort === undefined || input.sort === PUBLIC_SORT);
  check(
    input.filters === undefined ||
      (input.filters !== null &&
        typeof input.filters === 'object' &&
        !Array.isArray(input.filters)),
  );
  check(
    !input.filters ||
      Object.keys(input.filters).every(
        (key) => key === 'tagIds' || key === 'placeId',
      ),
  );
  const tags = input.filters?.tagIds === undefined ? [] : input.filters.tagIds;
  check(Array.isArray(tags) && tags.length <= MAX_FILTER_TAGS);
  for (const tag of tags) id(tag);
  const placeId =
    input.filters?.placeId === undefined ? null : input.filters.placeId;
  if (input.filters?.placeId !== undefined) id(placeId);
  return {
    collection,
    filters: { tagIds: [...new Set(tags)].sort(), placeId },
    sort: PUBLIC_SORT,
  };
}

interface Cursor {
  schema: number;
  version: number;
  scope: string;
  direction: 'older' | 'newer';
  position: PhotoPosition;
}

// ASCII canonical JSON encoded as base64url. Tokens are untrusted navigation
// hints, never authorization or publication evidence; the source rechecks both.
function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function decodeCursor(token: string, query: NormalizedQuery): Cursor {
  try {
    check(
      typeof token === 'string' &&
        token.length <= 4096 &&
        /^[A-Za-z0-9_-]+$/.test(token),
    );
    const value = JSON.parse(
      atob(token.replaceAll('-', '+').replaceAll('_', '/')),
    ) as Cursor;
    check(value && value.schema === DISCOVERY_SCHEMA);
    version(value.version);
    check(value.scope === JSON.stringify(query));
    check(value.direction === 'older' || value.direction === 'newer');
    check(
      value.position &&
        Number.isSafeInteger(value.position.firstPublishedAt) &&
        value.position.firstPublishedAt >= 0,
    );
    id(value.position.photoId);
    check(encodeCursor(value) === token);
    return value;
  } catch {
    throw new RequestError('invalid_cursor');
  }
}

function preview(row: PublicPhotoPreview): PublicPhotoPreview {
  // Construct every public field explicitly, even when an adapter returns extra
  // authoring/source fields. Never spread a database row into a public DTO.
  id(row.photoId);
  version(row.revision);
  check(
    Number.isSafeInteger(row.firstPublishedAt) && row.firstPublishedAt >= 0,
  );
  check(
    row.title === null ||
      (typeof row.title === 'string' && row.title.length <= 300),
  );
  check(
    row.altText === null ||
      (typeof row.altText === 'string' && row.altText.length <= 2000),
  );
  return {
    photoId: row.photoId,
    revision: row.revision,
    firstPublishedAt: row.firstPublishedAt,
    title: row.title,
    altText: row.altText,
  };
}

function compare(a: PhotoPosition, b: PhotoPosition): number {
  return (
    a.firstPublishedAt - b.firstPublishedAt ||
    (a.photoId < b.photoId ? -1 : a.photoId > b.photoId ? 1 : 0)
  );
}

export async function readPublicCollection(
  source: PublicDiscoverySource,
  input: DiscoveryRequest,
): Promise<DiscoveryResponse> {
  let request: WindowRequest;
  try {
    const query = normalizeCollectionQuery(input);
    version(input.version);
    const limit = input.limit === undefined ? DEFAULT_PAGE_SIZE : input.limit;
    check(Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE);
    check(!(input.cursor !== undefined && input.anchorPhotoId !== undefined));
    let seek: WindowRequest['seek'] = { kind: 'start' };
    if (input.anchorPhotoId !== undefined) {
      id(input.anchorPhotoId);
      seek = { kind: 'anchor', photoId: input.anchorPhotoId };
    } else if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, query);
      // A caller cannot relabel an old cursor with a new request version.
      if (cursor.version !== input.version)
        throw new RequestError('invalid_cursor');
      seek = {
        kind: 'keyset',
        direction: cursor.direction,
        position: cursor.position,
      };
    }
    request = { version: input.version, query, limit, seek };
  } catch (error) {
    if (error instanceof RequestError)
      return { ok: false, error: { code: error.code } };
    throw error;
  }

  const window = await source.readWindow(request);
  version(window.version);
  const fail = (error: DiscoveryError): DiscoveryResponse => ({
    ok: false,
    error,
  });
  if (
    window.version !== request.version ||
    window.status === 'refresh_required'
  ) {
    return fail({ code: 'refresh_required', currentVersion: window.version });
  }
  if (window.status === 'not_found') return fail({ code: 'not_found' });
  // Adapter faults are server errors, never successful truncated pages.
  if (window.items.length > request.limit)
    throw new Error('Discovery source exceeded the page bound.');
  const items = window.items.map(preview);
  if (new Set(items.map((item) => item.photoId)).size !== items.length)
    throw new Error('Discovery source returned duplicate photos.');
  for (let i = 1; i < items.length; i++) {
    if (compare(items[i - 1]!, items[i]!) <= 0)
      throw new Error('Discovery source returned unstable ordering.');
  }
  const seek = request.seek;
  if (
    seek.kind === 'anchor' &&
    !items.some((item) => item.photoId === seek.photoId)
  )
    throw new Error('Discovery source omitted the requested anchor.');
  if (request.seek.kind === 'keyset') {
    for (const item of items) {
      const order = compare(item, request.seek.position);
      if (request.seek.direction === 'older' ? order >= 0 : order <= 0)
        throw new Error('Discovery source crossed the keyset boundary.');
    }
  }
  const cursor = (direction: 'older' | 'newer', position: PhotoPosition) =>
    encodeCursor({
      schema: DISCOVERY_SCHEMA,
      version: window.version,
      scope: JSON.stringify(request.query),
      direction,
      position: {
        firstPublishedAt: position.firstPublishedAt,
        photoId: position.photoId,
      },
    });
  return {
    ok: true,
    schema: DISCOVERY_SCHEMA,
    version: window.version,
    query: request.query,
    items,
    previousCursor:
      window.hasNewer && items.length ? cursor('newer', items[0]!) : null,
    nextCursor:
      window.hasOlder && items.length ? cursor('older', items.at(-1)!) : null,
    anchorPhotoId: request.seek.kind === 'anchor' ? request.seek.photoId : null,
  };
}
