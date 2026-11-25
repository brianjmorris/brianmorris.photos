import type { CatalogueDatabase } from './d1.ts';
import { invalid, normalizeTagName } from './model.ts';
import { validId } from './validation.ts';

export interface TagSearchResult {
  tagId: string;
  name: string;
  match: 'name' | 'alias' | 'direct' | 'indirect';
  alias: string | null;
  via: string | null;
  exact: boolean;
}

// SQLite's binary ordering compares UTF-8, which follows code point order.
function prefixEnd(prefix: string) {
  const points = Array.from(prefix);
  while (points.length) {
    const last = points.pop()!.codePointAt(0)!;
    if (last < 0x10ffff)
      return (
        points.join('') +
        String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1)
      );
  }
  return null;
}

export async function searchDraftTags(
  db: CatalogueDatabase,
  query: string,
  context: readonly string[],
): Promise<TagSearchResult[]> {
  if (query.length > 120 || context.length > 8)
    invalid('Tag search is too long.');
  context.forEach(validId);
  const normalized = query.trim() ? normalizeTagName(query) : '';
  const terms = normalized.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  const match = terms.map((term) => `"${term}"*`).join(' AND ') || '""';
  const end = prefixEnd(normalized);
  const { results } = await db
    .prepare(
      `
    WITH prefixes AS MATERIALIZED (
      SELECT normalized_name, CASE WHEN normalized_name=?1 THEN 0 ELSE 1 END priority
      FROM tag_name_claims
      WHERE ?1<>'' AND normalized_name>=?1 ${end === null ? 'AND ?2 IS NULL' : 'AND normalized_name<?2'}
      ORDER BY normalized_name LIMIT 100
    ), words AS MATERIALIZED (
      SELECT normalized_name, 2 priority FROM tag_search WHERE tag_search MATCH ?3
      ORDER BY rank LIMIT 100
    ), candidates AS (
      SELECT * FROM prefixes UNION ALL SELECT * FROM words
    ), matches AS MATERIALIZED (
      SELECT draft.tag_id, draft.name, alias.alias, priority,
        row_number() OVER (PARTITION BY draft.tag_id
          ORDER BY priority, alias.alias IS NOT NULL, candidate.normalized_name) AS preferred
      FROM candidates candidate JOIN tag_name_claims claim USING (normalized_name)
      JOIN tag_drafts draft ON draft.tag_id=claim.tag_id
      LEFT JOIN tag_draft_aliases alias ON alias.tag_id=draft.tag_id AND alias.tag_revision=draft.revision
        AND alias.normalized_alias=candidate.normalized_name
    ), text_results AS MATERIALIZED (
      SELECT * FROM matches WHERE preferred=1 ORDER BY priority, alias IS NOT NULL, name, tag_id LIMIT 20
    ), text_seeds AS (
      SELECT tag_id FROM text_results ORDER BY priority, alias IS NOT NULL, name, tag_id LIMIT 4
    ), seeds AS MATERIALIZED (
      SELECT tag_id FROM text_seeds UNION SELECT value FROM json_each(?4)
    ), direct_edges AS MATERIALIZED (
      SELECT edge.related_id, edge.photo_count, seeds.tag_id AS via_id
      FROM seeds CROSS JOIN tag_cooccurrences edge INDEXED BY sqlite_autoindex_tag_cooccurrences_1
      WHERE edge.tag_id=seeds.tag_id AND edge.related_id IN (
        SELECT related_id FROM tag_cooccurrences WHERE tag_id=seeds.tag_id ORDER BY photo_count DESC, related_id LIMIT 12
      )
      AND edge.related_id NOT IN (SELECT tag_id FROM seeds)
    ), bridges AS MATERIALIZED (
      SELECT related_id AS tag_id, max(photo_count) AS strength FROM direct_edges
      GROUP BY related_id ORDER BY strength DESC, related_id LIMIT 8
    ), related AS (
      SELECT related_id, photo_count AS strength, via_id, 0 AS distance FROM direct_edges
      UNION ALL
      SELECT edge.related_id, min(edge.photo_count, bridges.strength), bridges.tag_id, 1
      FROM bridges CROSS JOIN tag_cooccurrences edge INDEXED BY sqlite_autoindex_tag_cooccurrences_1
      WHERE edge.tag_id=bridges.tag_id AND edge.related_id IN (
        SELECT related_id FROM tag_cooccurrences WHERE tag_id=bridges.tag_id ORDER BY photo_count DESC, related_id LIMIT 12
      )
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY related_id ORDER BY distance, strength DESC, via_id) AS preferred
      FROM related WHERE related_id NOT IN (SELECT tag_id FROM seeds)
        AND related_id NOT IN (SELECT tag_id FROM text_results)
    ), relation_results AS (
      SELECT ranked.*, draft.name, via.name AS via
      FROM ranked JOIN tag_drafts draft ON draft.tag_id=ranked.related_id
      JOIN tag_drafts via ON via.tag_id=ranked.via_id
      WHERE preferred=1 ORDER BY distance, strength DESC, draft.name, related_id LIMIT 12
    ), combined AS (
      SELECT tag_id AS tagId, name, CASE WHEN alias IS NULL THEN 'name' ELSE 'alias' END AS match,
        alias, NULL AS via, priority=0 AS exact, priority, 0 AS strength
      FROM text_results
      UNION ALL
      SELECT related_id, name, CASE distance WHEN 0 THEN 'direct' ELSE 'indirect' END,
        NULL, via, 0, 3+distance, strength FROM relation_results
    )
    SELECT tagId, name, match, alias, via, exact FROM combined
    ORDER BY priority, alias IS NOT NULL, strength DESC, name, tagId
  `,
    )
    .bind(normalized, end, match, JSON.stringify(context))
    .all<Omit<TagSearchResult, 'exact'> & { exact: number }>();
  return results.map(({ tagId, name, match, alias, via, exact }) => ({
    tagId,
    name,
    match,
    alias,
    via,
    exact: Boolean(exact),
  }));
}
