// Freeze only descriptive place fields. Provider provenance stays in the private
// place draft, never in an approved photo's public location description.
export interface PlaceDescription {
  placeId: string;
  revision: number;
  name: string;
  kind: string;
  aliases: string[];
  bounds: { south: number; north: number; west: number; east: number } | null;
}

// Expressions are application-owned SQL, never user input. Values remain bound.
export function placeChainSql(id: string, revision: string): string {
  return `(SELECT json_group_array(json(value)) FROM (
    SELECT json_object('placeId', p.place_id, 'revision', p.revision, 'name', p.name, 'kind', p.kind,
      'aliases', json((SELECT json_group_array(alias) FROM (SELECT alias FROM place_draft_aliases a
        WHERE a.place_id=p.place_id AND a.place_revision=p.revision ORDER BY normalized_alias))),
      'bounds', CASE WHEN p.south IS NULL THEN NULL ELSE json_object('south',p.south,'north',p.north,'west',p.west,'east',p.east) END) AS value,
      0 AS position FROM place_drafts p WHERE p.place_id=${id} AND p.revision=${revision}
    UNION ALL SELECT a.value, a.key+1 FROM place_drafts p, json_each(p.ancestry_json) a
      WHERE p.place_id=${id} AND p.revision=${revision}
    ORDER BY position
  ))`;
}
