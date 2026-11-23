import type { PhotoMetadata } from './metadata.ts';

export interface PhotoRevision {
  photoId: string;
  revision: number;
  createdAt: number;
  tagIds: string[];
  metadata: PhotoMetadata | null;
}

export interface TagRevision {
  tagId: string;
  revision: number;
  createdAt: number;
  name: string;
  slug: string;
  aliases: string[];
  notes: string;
  featuredOrder: number | null;
  coverPhotoId: string | null;
}

export interface TagDraftSummary {
  tagId: string;
  revision: number;
  name: string;
  slug: string;
  featuredOrder: number | null;
  publishedRevision: number | null;
}

export interface CoverChoice extends PublishedMembership {
  title: string | null;
}

export interface PublishedMembership {
  photoId: string;
  photoRevision: number;
  firstPublishedAt: number;
}

export type CatalogueErrorCode = 'invalid_input' | 'conflict' | 'not_found';

export class CatalogueError extends Error {
  readonly code: CatalogueErrorCode;

  constructor(
    code: CatalogueErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CatalogueError';
    this.code = code;
  }
}

// Normalization v1: NFKC, collapsed Unicode whitespace, locale-independent case.
// Diacritics and singular/plural distinctions remain meaningful.
export function cleanTagName(value: string): string {
  if (typeof value !== 'string') invalid('Tag names must be text.');
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || name.length > 120 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    invalid(
      'Tag names must contain 1–120 characters without control characters.',
    );
  }
  return name;
}

export function normalizeTagName(value: string): string {
  return cleanTagName(value).toLowerCase();
}

export function invalid(message: string): never {
  throw new CatalogueError('invalid_input', message);
}
