import { writeCatalogueBatch, type CatalogueDatabase } from './d1.ts';
import { placeChainSql } from './place-snapshot.ts';
import {
  CatalogueError,
  cleanTagName,
  invalid,
  normalizeTagName,
} from './model.ts';
import {
  placeReference,
  text,
  validId,
  validRevision,
  validTime,
  type PlaceReference,
} from './validation.ts';

export type PlaceKind = 'country' | 'region' | 'city' | 'area' | 'site';
export interface PlaceBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}
export interface PlaceInput {
  name: string;
  kind: PlaceKind;
  aliases?: readonly string[];
  parent?: PlaceReference | null;
  bounds?: PlaceBounds | null;
  provenance: {
    kind: 'manual' | 'imported' | 'provider';
    source?: string | null;
    providerId?: string | null;
  };
}
export interface PlaceRevision extends PlaceReference {
  createdAt: number;
  name: string;
  kind: PlaceKind;
  aliases: string[];
  parent: PlaceReference | null;
  bounds: PlaceBounds | null;
  provenance: {
    kind: 'manual' | 'imported' | 'provider';
    source: string | null;
    providerId: string | null;
  };
}
interface PlaceRow {
  revision: number;
  aliases_json: string;
  created_at: number;
  name: string;
  kind: PlaceKind;
  parent_id: string | null;
  parent_revision: number | null;
  south: number | null;
  north: number | null;
  west: number | null;
  east: number | null;
  provenance_kind: PlaceRevision['provenance']['kind'];
  provenance_source: string | null;
  provider_id: string | null;
}

export class PlaceRepository {
  private readonly db: CatalogueDatabase;
  constructor(db: CatalogueDatabase) {
    this.db = db;
  }

  private statements(
    id: string,
    revision: number,
    input: PlaceInput,
    now: number,
  ) {
    validId(id);
    validRevision(revision);
    validTime(now);
    const name = cleanTagName(input.name);
    if (!['country', 'region', 'city', 'area', 'site'].includes(input.kind))
      invalid('Invalid place kind.');
    const parent = placeReference(input.parent);
    if (input.kind === 'country' && parent)
      invalid('A country must be a root place.');
    const bounds = input.bounds ?? null;
    if (
      bounds &&
      (![bounds.south, bounds.north, bounds.west, bounds.east].every(
        Number.isFinite,
      ) ||
        bounds.south < -90 ||
        bounds.north > 90 ||
        bounds.south > bounds.north ||
        Math.abs(bounds.west) > 180 ||
        Math.abs(bounds.east) > 180)
    )
      invalid('Invalid place bounds.');
    if (
      !input.provenance ||
      !['manual', 'imported', 'provider'].includes(input.provenance.kind)
    )
      invalid('Explicit place provenance is required.');
    const source = text(input.provenance.source, 1000);
    const providerId = text(input.provenance.providerId, 300);
    if (
      input.provenance.kind === 'provider' &&
      (!source?.trim() || !providerId?.trim())
    )
      invalid('Provider places require a source and provider ID.');
    const aliases = input.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.length > 32)
      invalid('A place can have at most 32 aliases.');
    const seen = new Set([normalizeTagName(name)]);
    const children = Array.from(aliases, (value) => {
      const alias = cleanTagName(value);
      const normalized = normalizeTagName(alias);
      if (seen.has(normalized)) invalid('Place aliases must be distinct.');
      seen.add(normalized);
      return this.db
        .prepare(
          'INSERT INTO place_draft_aliases (place_id, place_revision, alias, normalized_alias) VALUES (?, ?, ?, ?)',
        )
        .bind(id, revision, alias, normalized);
    });
    return [
      this.db
        .prepare('DELETE FROM place_draft_aliases WHERE place_id = ?')
        .bind(id),
      ...children,
      this.db
        .prepare(
          revision === 1
            ? `INSERT INTO place_drafts (place_id, revision, created_at, name, kind, parent_id, parent_revision,
        south, north, west, east, provenance_kind, provenance_source, provider_id, ancestry_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ${placeChainSql('?6', '?7')})`
            : `UPDATE place_drafts SET revision=?2, created_at=?3, name=?4, kind=?5, parent_id=?6, parent_revision=?7,
          south=?8, north=?9, west=?10, east=?11, provenance_kind=?12, provenance_source=?13, provider_id=?14,
          ancestry_json=CASE WHEN parent_id IS ?6 AND parent_revision IS ?7 THEN ancestry_json ELSE ${placeChainSql('?6', '?7')} END
          WHERE place_id=?1`,
        )
        .bind(
          id,
          revision,
          now,
          name,
          input.kind,
          parent?.placeId ?? null,
          parent?.revision ?? null,
          bounds?.south ?? null,
          bounds?.north ?? null,
          bounds?.west ?? null,
          bounds?.east ?? null,
          input.provenance.kind,
          source,
          providerId,
        ),
      this.db
        .prepare('UPDATE places SET draft_revision = ? WHERE id = ?')
        .bind(revision, id),
    ];
  }

  async create(input: PlaceInput, now = Date.now()): Promise<PlaceRevision> {
    const id = crypto.randomUUID();
    const result = await writeCatalogueBatch(this.db, [
      this.db
        .prepare('INSERT INTO places (id, created_at) VALUES (?, ?)')
        .bind(id, now),
      ...this.statements(id, 1, input, now),
      this.readStatement(id),
    ]);
    return this.result(id, result.at(-1)!.results[0] as unknown as PlaceRow)!;
  }

  async saveDraft(
    id: string,
    expectedRevision: number,
    input: PlaceInput,
    now = Date.now(),
  ): Promise<PlaceRevision> {
    validId(id);
    validRevision(expectedRevision);
    if (!(await this.getDraft(id)))
      throw new CatalogueError('not_found', 'Place not found.');
    const result = await writeCatalogueBatch(this.db, [
      ...this.statements(id, expectedRevision + 1, input, now),
      this.readStatement(id),
    ]);
    return this.result(id, result.at(-1)!.results[0] as unknown as PlaceRow)!;
  }

  async getDraft(id: string): Promise<PlaceRevision | null> {
    validId(id);
    return this.result(id, await this.readStatement(id).first<PlaceRow>());
  }

  async getRevision(ref: PlaceReference): Promise<PlaceRevision | null> {
    placeReference(ref);
    return this.result(
      ref.placeId,
      await this.readStatement(ref.placeId, ref.revision).first<PlaceRow>(),
    );
  }

  private readStatement(id: string, revision?: number) {
    return this.db
      .prepare(
        `SELECT p.revision,p.created_at,p.name,p.kind,p.parent_id,p.parent_revision,p.south,p.north,p.west,p.east,
      p.provenance_kind,p.provenance_source,p.provider_id,
      (SELECT json_group_array(alias) FROM (SELECT alias FROM place_draft_aliases a WHERE a.place_id=p.place_id AND a.place_revision=p.revision ORDER BY normalized_alias)) AS aliases_json
      FROM place_drafts p WHERE p.place_id=? ${revision === undefined ? '' : 'AND p.revision=?'}`,
      )
      .bind(id, ...(revision === undefined ? [] : [revision]));
  }

  private result(id: string, row: PlaceRow | null): PlaceRevision | null {
    if (!row) return null;
    return {
      placeId: id,
      revision: row.revision,
      createdAt: row.created_at,
      name: row.name,
      kind: row.kind,
      aliases: JSON.parse(row.aliases_json),
      parent:
        row.parent_id === null
          ? null
          : { placeId: row.parent_id, revision: row.parent_revision! },
      bounds:
        row.south === null
          ? null
          : {
              south: row.south,
              north: row.north!,
              west: row.west!,
              east: row.east!,
            },
      provenance: {
        kind: row.provenance_kind,
        source: row.provenance_source,
        providerId: row.provider_id,
      },
    };
  }

  async ancestors(
    ref: PlaceReference,
  ): Promise<
    { placeId: string; revision: number; name: string; kind: PlaceKind }[]
  > {
    placeReference(ref);
    const rows = await this.db
      .prepare(
        `SELECT json_extract(a.value, '$.placeId') AS place_id, json_extract(a.value, '$.revision') AS revision,
          json_extract(a.value, '$.name') AS name, json_extract(a.value, '$.kind') AS kind
          FROM place_drafts p, json_each(p.ancestry_json) a WHERE p.place_id=? AND p.revision=? ORDER BY a.key`,
      )
      .bind(ref.placeId, ref.revision)
      .all<{
        place_id: string;
        revision: number;
        name: string;
        kind: PlaceKind;
      }>();
    return rows.results.map((row) => ({
      placeId: row.place_id,
      revision: row.revision,
      name: row.name,
      kind: row.kind,
    }));
  }
}
