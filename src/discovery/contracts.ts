// Portable public contracts. No database, owner metadata, or rendering imports.
export const DISCOVERY_SCHEMA = 2;
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 50;
export const MAX_FILTER_TAGS = 64;
export const PUBLIC_SORT = 'first-published-desc';

// View anchors are navigation/filter inputs, not editorial collections.
export type PhotoViewReference =
  | { kind: 'tag'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'place'; id: string };

export interface PhotoQuery {
  collection: PhotoViewReference;
  // A group is a union; these tags are an additional intersection. Place
  // membership includes approved descendants, prepared outside public reads.
  filters?: { tagIds?: readonly string[]; placeId?: string };
  sort?: typeof PUBLIC_SORT;
}

export interface NormalizedQuery {
  collection: PhotoViewReference;
  filters: { tagIds: string[]; placeId: string | null };
  sort: typeof PUBLIC_SORT;
}

export interface PublicViewSummary {
  reference: PhotoViewReference;
  name: string;
  slug: string;
  photoCount: number;
}

// Optional editorial context decorates the SAME tag-filtered photo viewer.
// It never chooses photo membership, ordering, page size or layout.
export interface PublicCollectionContext {
  collectionId: string;
  tagIds: readonly string[];
  name: string | null;
  notes: string;
}

export interface PhotoPosition {
  firstPublishedAt: number;
  photoId: string;
}

// Small carousel records; full captions, rights, and approved locations belong
// to a separate selected-photo response. Assets arrive with the asset contract.
export interface PublicPhotoPreview extends PhotoPosition {
  revision: number;
  title: string | null;
  altText: string | null;
}

export type DiscoveryRequest = PhotoQuery & {
  version: number;
  limit?: number;
} & (
    | { cursor?: string; anchorPhotoId?: never }
    | { anchorPhotoId: string; cursor?: never }
  );

export type DiscoveryError =
  | { code: 'invalid_request' | 'invalid_cursor' | 'not_found' }
  | { code: 'refresh_required'; currentVersion: number };

export type DiscoveryResponse =
  | { ok: false; error: DiscoveryError }
  | {
      ok: true;
      schema: typeof DISCOVERY_SCHEMA;
      version: number;
      query: NormalizedQuery;
      items: PublicPhotoPreview[];
      previousCursor: string | null;
      nextCursor: string | null;
      anchorPhotoId: string | null;
    };

export interface WindowRequest {
  version: number;
  query: NormalizedQuery;
  limit: number;
  seek:
    | { kind: 'start' }
    | { kind: 'keyset'; direction: 'older' | 'newer'; position: PhotoPosition }
    | { kind: 'anchor'; photoId: string };
}

export interface PublicDiscoverySource {
  // Read version, collection existence, membership, and preview fields from ONE
  // consistent snapshot. Never read a version then query mutable rows separately.
  // Return at most limit items in descending (firstPublishedAt, photoId) order.
  // Anchor windows include the anchor with floor((limit-1)/2) newer slots and
  // the remaining older slots. Missing anchors/collections return not_found.
  // Probe boundaries with limit+1 or indexed existence checks, never per-photo
  // requests or catalogue counts. Choose selective indexes for skewed filters.
  readWindow(request: WindowRequest): Promise<
    | { status: 'refresh_required'; version: number }
    | { status: 'not_found'; version: number }
    | {
        status: 'ready';
        version: number;
        items: PublicPhotoPreview[];
        hasNewer: boolean;
        hasOlder: boolean;
      }
  >;
}
