import { writeCatalogueBatch, type CatalogueDatabase } from './d1.ts';
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
      if (seen.has(normalized))
        invalid('Place aliases must be distinct within a revision.');
      seen.add(normalized);
      return this.db
        .prepare(
          'INSERT INTO place_aliases (place_id, place_revision, alias, normalized_alias) VALUES (?, ?, ?, ?)',
        )
        .bind(id, revision, alias, normalized);
    });
    return [
      ...children,
      this.db
        .prepare(
          `INSERT INTO place_revisions (place_id, revision, created_at, name, kind, parent_id, parent_revision,
        south, north, west, east, provenance_kind, provenance_source, provider_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    await writeCatalogueBatch(this.db, [
      this.db
        .prepare('INSERT INTO places (id, created_at) VALUES (?, ?)')
        .bind(id, now),
      ...this.statements(id, 1, input, now),
    ]);
    return (await this.getRevision({ placeId: id, revision: 1 }))!;
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
    await writeCatalogueBatch(
      this.db,
      this.statements(id, expectedRevision + 1, input, now),
    );
    return (await this.getRevision({
      placeId: id,
      revision: expectedRevision + 1,
    }))!;
  }

  async getDraft(id: string): Promise<PlaceRevision | null> {
    validId(id);
    const head = await this.db
      .prepare('SELECT draft_revision FROM places WHERE id = ?')
      .bind(id)
      .first<{ draft_revision: number | null }>();
    return head?.draft_revision
      ? this.getRevision({ placeId: id, revision: head.draft_revision })
      : null;
  }

  async getRevision(ref: PlaceReference): Promise<PlaceRevision | null> {
    placeReference(ref);
    const row = await this.db
      .prepare(
        'SELECT * FROM place_revisions WHERE place_id = ? AND revision = ?',
      )
      .bind(ref.placeId, ref.revision)
      .first<PlaceRow>();
    if (!row) return null;
    const aliases = await this.db
      .prepare(
        'SELECT alias FROM place_aliases WHERE place_id = ? AND place_revision = ? ORDER BY normalized_alias',
      )
      .bind(ref.placeId, ref.revision)
      .all<{ alias: string }>();
    return {
      placeId: ref.placeId,
      revision: ref.revision,
      createdAt: row.created_at,
      name: row.name,
      kind: row.kind,
      aliases: aliases.results.map((entry) => entry.alias),
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
        `WITH RECURSIVE chain(place_id, revision, name, kind, parent_id, parent_revision, depth) AS (
      SELECT place_id, revision, name, kind, parent_id, parent_revision, 0 FROM place_revisions WHERE place_id = ? AND revision = ?
      UNION ALL SELECT p.place_id, p.revision, p.name, p.kind, p.parent_id, p.parent_revision, c.depth + 1
      FROM place_revisions p JOIN chain c ON p.place_id = c.parent_id AND p.revision = c.parent_revision WHERE c.depth < 15
    ) SELECT place_id, revision, name, kind FROM chain WHERE depth > 0 ORDER BY depth`,
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
