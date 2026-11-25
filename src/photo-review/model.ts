export interface ReviewTag {
  tagId: string;
  name: string;
}
export interface ReviewDraft {
  photoId: string;
  revision: number;
  title: string | null;
  tags: ReviewTag[];
}
export interface ReviewCollection {
  collectionId: string;
  name: string | null;
  tags: ReviewTag[];
  hasNotes: boolean;
}
export interface ReviewItem extends ReviewDraft {
  origin: 'local' | 'saved';
  saved: boolean;
  fileName?: string;
  hash?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
}

export function tagCoverage(
  photos: readonly Pick<ReviewDraft, 'tags'>[],
  required: readonly ReviewTag[] = [],
) {
  const names = new Map<string, string>(),
    counts = new Map<string, number>();
  for (const photo of photos)
    for (const tag of new Map(
      photo.tags.map((tag) => [tag.tagId, tag]),
    ).values()) {
      names.set(tag.tagId, tag.name);
      counts.set(tag.tagId, (counts.get(tag.tagId) ?? 0) + 1);
    }
  for (const tag of required) names.set(tag.tagId, tag.name);
  return [...names]
    .map(([tagId, name]) => ({
      tagId,
      name,
      count: counts.get(tagId) ?? 0,
      adding:
        required.some((tag) => tag.tagId === tagId) &&
        (counts.get(tagId) ?? 0) < photos.length,
    }))
    .sort(
      (a, b) => a.name.localeCompare(b.name) || a.tagId.localeCompare(b.tagId),
    );
}

export function requiredTags(
  collections: readonly ReviewCollection[],
): ReviewTag[] {
  return [
    ...new Map(
      collections.flatMap((c) => c.tags).map((tag) => [tag.tagId, tag]),
    ).values(),
  ];
}
export function addRequiredTags(
  existing: readonly ReviewTag[],
  required: readonly ReviewTag[],
) {
  return [
    ...new Map(
      [...existing, ...required].map((tag) => [tag.tagId, tag]),
    ).values(),
  ].sort(
    (a, b) => a.name.localeCompare(b.name) || a.tagId.localeCompare(b.tagId),
  );
}
export function matchingCollections(
  tags: readonly ReviewTag[],
  collections: readonly ReviewCollection[],
) {
  const ids = new Set(tags.map((tag) => tag.tagId));
  return collections.filter(
    (collection) =>
      (collection.name || collection.hasNotes) &&
      collection.tags.every((tag) => ids.has(tag.tagId)),
  );
}
export function collectionLabel(collection: ReviewCollection) {
  return collection.name ?? collection.tags.map((tag) => tag.name).join(' + ');
}

// The only creation payload: browser files, previews, filenames, hashes and
// source metadata cannot accidentally enter this request through a spread.
export function draftDetails(photos: readonly ReviewItem[]) {
  return {
    photos: photos
      .filter((photo) => !photo.saved)
      .map((photo) => ({
        photoId: photo.photoId,
        title: photo.title,
        tagIds: photo.tags.map((tag) => tag.tagId),
      })),
  };
}
