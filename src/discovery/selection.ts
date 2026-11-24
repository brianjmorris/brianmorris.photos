import { MAX_FILTER_TAGS, type PhotoQuery } from './contracts.ts';

// Both a plain tag selection and a saved collection use this canonical photo
// query. Name/Notes are separately resolved context and never change the scope.
export function photoQueryForTags(tagIds: readonly string[]): PhotoQuery {
  if (
    !Array.isArray(tagIds) ||
    !tagIds.length ||
    tagIds.length > MAX_FILTER_TAGS ||
    tagIds.some(
      (id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id),
    )
  )
    throw new Error('Invalid tag selection.');
  const ids = [...new Set(tagIds)].sort();
  return {
    collection: { kind: 'tag', id: ids[0]! },
    filters: { tagIds: ids.slice(1) },
  };
}
