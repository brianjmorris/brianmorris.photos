import type { CatalogueDatabase } from './d1.ts';
import { writeCatalogueBatch } from './d1.ts';
import {
  CatalogueError,
  cleanTagName,
  invalid,
  type CoverChoice,
  type PublishedMembership,
} from './model.ts';
import { text, validId, validRevision, validTime } from './validation.ts';
import { CatalogueRepository, type PhotoDraftSelection } from './repository.ts';

export interface CollectionInput {
  tagIds: readonly string[];
  name: string | null;
  notes: string;
  featuredOrder: number | null;
  coverPhotoId: string | null;
}
export interface CollectionRevision extends Omit<CollectionInput, 'tagIds'> {
  collectionId: string;
  revision: number;
  createdAt: number;
  tagIds: string[];
}
export interface CollectionSummary {
  collectionId: string;
  revision: number;
  name: string | null;
  tags: { tagId: string; name: string }[];
  hasNotes: boolean;
  featuredOrder: number | null;
  publishedRevision: number | null;
}

// Sorted canonical IDs define the combination, not its label or current photos.
export function collectionTagIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 64)
    invalid('Choose between 2 and 64 tags.');
  value.forEach(validId);
  const ids = [...new Set(value)].sort();
  if (ids.length < 2)
    invalid('A collection needs at least two different tags.');
  return ids;
}
export function normalizeCollection(input: CollectionInput): CollectionInput {
  const tagIds = collectionTagIds(input.tagIds);
  const name =
    input.name === null || input.name === '' ? null : cleanTagName(input.name);
  if (typeof input.notes !== 'string') invalid('Notes must be text.');
  text(input.notes, 20000);
  // Keep empty private drafts so clearing Notes never destroys editorial work.
  const notes = input.notes.trim() ? input.notes : '';
  if (
    input.featuredOrder !== null &&
    (!Number.isSafeInteger(input.featuredOrder) ||
      input.featuredOrder < 0 ||
      input.featuredOrder > 1000000)
  )
    invalid('Featured order must be a whole number from 0 to 1000000.');
  if (input.featuredOrder !== null && name === null)
    invalid('Give this collection a name before featuring it.');
  if (input.coverPhotoId !== null) validId(input.coverPhotoId);
  return {
    tagIds,
    name,
    notes,
    featuredOrder: input.featuredOrder,
    coverPhotoId: input.coverPhotoId,
  };
}
function page(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    invalid('Invalid page size.');
}

export class CollectionRepository {
  private readonly db: CatalogueDatabase;
  constructor(db: CatalogueDatabase) {
    this.db = db;
  }
  private statement(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).bind(...values);
  }
  private revisionStatements(
    id: string,
    revision: number,
    input: CollectionInput,
    now: number,
  ) {
    return [
      this.statement(
        'INSERT INTO collection_revisions (collection_id, revision, created_at, name, notes, featured_order, cover_photo_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        revision,
        now,
        input.name,
        input.notes,
        input.featuredOrder,
        input.coverPhotoId,
      ),
      this.statement(
        'UPDATE collections SET draft_revision = ? WHERE id = ?',
        revision,
        id,
      ),
    ];
  }
  async createDraft(
    value: CollectionInput,
    now = Date.now(),
  ): Promise<CollectionRevision> {
    validTime(now);
    const input = normalizeCollection(value);
    const id = crypto.randomUUID();
    await writeCatalogueBatch(this.db, [
      ...input.tagIds.map((tag) =>
        this.statement(
          'INSERT INTO collection_tags (collection_id, tag_id) VALUES (?, ?)',
          id,
          tag,
        ),
      ),
      this.statement(
        'INSERT INTO collections (id, created_at, tag_set_key) VALUES (?, ?, ?)',
        id,
        now,
        JSON.stringify(input.tagIds),
      ),
      ...this.revisionStatements(id, 1, input, now),
    ]);
    return (await this.getRevision(id, 1))!;
  }
  async saveDraft(
    id: string,
    expectedRevision: number,
    value: CollectionInput,
    now = Date.now(),
  ): Promise<CollectionRevision> {
    validId(id);
    validRevision(expectedRevision);
    validTime(now);
    const input = normalizeCollection(value);
    const current = await this.getDraft(id);
    if (!current)
      throw new CatalogueError('not_found', 'Collection not found.');
    if (current.revision !== expectedRevision)
      throw new CatalogueError(
        'conflict',
        'This collection changed in another window. Reload it before saving.',
      );
    if (JSON.stringify(input.tagIds) !== JSON.stringify(current.tagIds))
      invalid(
        'These tags define this collection. Create another combination to change them.',
      );
    await writeCatalogueBatch(
      this.db,
      this.revisionStatements(id, expectedRevision + 1, input, now),
    );
    return (await this.getRevision(id, expectedRevision + 1))!;
  }
  async getRevision(
    id: string,
    revision: number,
  ): Promise<CollectionRevision | null> {
    validId(id);
    validRevision(revision);
    const row = await this.statement(
      `SELECT c.tag_set_key, r.created_at, r.name, r.notes, r.featured_order, r.cover_photo_id
      FROM collection_revisions r JOIN collections c ON c.id = r.collection_id WHERE r.collection_id = ? AND r.revision = ?`,
      id,
      revision,
    ).first<{
      tag_set_key: string;
      created_at: number;
      name: string | null;
      notes: string;
      featured_order: number | null;
      cover_photo_id: string | null;
    }>();
    return row
      ? {
          collectionId: id,
          revision,
          createdAt: row.created_at,
          name: row.name,
          notes: row.notes,
          tagIds: JSON.parse(row.tag_set_key),
          featuredOrder: row.featured_order,
          coverPhotoId: row.cover_photo_id,
        }
      : null;
  }
  async getDraft(id: string): Promise<CollectionRevision | null> {
    validId(id);
    const row = await this.statement(
      'SELECT draft_revision FROM collections WHERE id = ?',
      id,
    ).first<{ draft_revision: number | null }>();
    return row?.draft_revision
      ? this.getRevision(id, row.draft_revision)
      : null;
  }
  async findDraft(
    tagIds: readonly string[],
  ): Promise<CollectionRevision | null> {
    const row = await this.statement(
      'SELECT id, draft_revision FROM collections WHERE tag_set_key = ?',
      JSON.stringify(collectionTagIds(tagIds)),
    ).first<{ id: string; draft_revision: number }>();
    return row ? this.getRevision(row.id, row.draft_revision) : null;
  }
  async definingTags(id: string): Promise<{ tagId: string; name: string }[]> {
    validId(id);
    const rows = await this.statement(
      `SELECT t.tag_id, r.name FROM collection_tags t JOIN tags i ON i.id = t.tag_id
      JOIN tag_revisions r ON r.tag_id = i.id AND r.revision = i.draft_revision WHERE t.collection_id = ? ORDER BY r.normalized_name, t.tag_id`,
      id,
    ).all<{ tag_id: string; name: string }>();
    return rows.results.map((row) => ({ tagId: row.tag_id, name: row.name }));
  }
  async getPublished(id: string): Promise<CollectionRevision | null> {
    validId(id);
    const row = await this.statement(
      `SELECT p.collection_revision FROM published_collections p WHERE p.collection_id = ? AND NOT EXISTS (
      SELECT 1 FROM collection_tags t WHERE t.collection_id = p.collection_id AND NOT EXISTS (SELECT 1 FROM published_tags pt WHERE pt.tag_id = t.tag_id))`,
      id,
    ).first<{ collection_revision: number }>();
    return row ? this.getRevision(id, row.collection_revision) : null;
  }
  async recognizePublished(
    tagIds: readonly string[],
  ): Promise<CollectionRevision | null> {
    if (tagIds.length < 2) return null;
    const row = await this.statement(
      'SELECT id FROM collections WHERE tag_set_key = ?',
      JSON.stringify(collectionTagIds(tagIds)),
    ).first<{ id: string }>();
    return row ? this.getPublished(row.id) : null;
  }
  async listDrafts(
    afterId?: string,
    limit = 30,
  ): Promise<{ items: CollectionSummary[]; nextAfter: string | null }> {
    page(limit);
    if (afterId !== undefined) validId(afterId);
    const rows = await this.statement(
      `SELECT c.id, r.revision, r.name, r.notes <> '' AS has_notes, r.featured_order, p.collection_revision,
      (SELECT json_group_array(json_object('tagId', t.tag_id, 'name', tr.name)) FROM collection_tags t JOIN tags ti ON ti.id = t.tag_id
      JOIN tag_revisions tr ON tr.tag_id = ti.id AND tr.revision = ti.draft_revision WHERE t.collection_id = c.id) AS tags
      FROM collections c JOIN collection_revisions r ON r.collection_id = c.id AND r.revision = c.draft_revision
      LEFT JOIN published_collections p ON p.collection_id = c.id ${afterId ? 'WHERE c.id > ?' : ''} ORDER BY c.id LIMIT ?`,
      ...(afterId ? [afterId] : []),
      limit + 1,
    ).all<{
      id: string;
      revision: number;
      name: string | null;
      has_notes: number;
      featured_order: number | null;
      collection_revision: number | null;
      tags: string;
    }>();
    const items = rows.results.slice(0, limit).map((r) => ({
      collectionId: r.id,
      revision: r.revision,
      name: r.name,
      hasNotes: Boolean(r.has_notes),
      featuredOrder: r.featured_order,
      publishedRevision: r.collection_revision,
      tags: JSON.parse(r.tags),
    }));
    return {
      items,
      nextAfter:
        rows.results.length > limit ? items.at(-1)!.collectionId : null,
    };
  }
  async listSuggestions(afterId?: string, limit = 30) {
    page(limit);
    if (afterId !== undefined) validId(afterId);
    const rows = await this.statement(
      `SELECT c.id, c.tag_set_key, r.name, r.featured_order, r.cover_photo_id FROM published_collections p
      JOIN collections c ON c.id = p.collection_id JOIN collection_revisions r ON r.collection_id = c.id AND r.revision = p.collection_revision
      WHERE r.name IS NOT NULL AND NOT EXISTS (SELECT 1 FROM collection_tags t WHERE t.collection_id = c.id
        AND NOT EXISTS (SELECT 1 FROM published_tags pt WHERE pt.tag_id = t.tag_id)) ${afterId ? 'AND c.id > ?' : ''} ORDER BY c.id LIMIT ?`,
      ...(afterId ? [afterId] : []),
      limit + 1,
    ).all<{
      id: string;
      tag_set_key: string;
      name: string;
      featured_order: number | null;
      cover_photo_id: string | null;
    }>();
    const items = rows.results.slice(0, limit).map((r) => ({
      collectionId: r.id,
      name: r.name,
      tagIds: JSON.parse(r.tag_set_key) as string[],
      featuredOrder: r.featured_order,
      coverPhotoId: r.cover_photo_id,
    }));
    return {
      items,
      nextAfter:
        rows.results.length > limit ? items.at(-1)!.collectionId : null,
    };
  }
  async listCoverChoices(
    id: string,
    after?: Pick<PublishedMembership, 'photoId' | 'firstPublishedAt'>,
    limit = 30,
  ): Promise<{ items: CoverChoice[]; nextAfter: PublishedMembership | null }> {
    page(limit);
    validId(id);
    if (after) {
      validId(after.photoId);
      validTime(after.firstPublishedAt);
    }
    // Drive from one indexed tag, then require every other defining tag. Extra
    // photo tags never disqualify a match. Labels come from published metadata.
    const rows = await this.statement(
      `SELECT p.photo_id, p.photo_revision, p.first_published_at, m.title FROM published_photo_tags p
      LEFT JOIN photo_metadata_revisions m ON m.photo_id = p.photo_id AND m.photo_revision = p.photo_revision
      WHERE p.tag_id = (SELECT tag_id FROM collection_tags WHERE collection_id = ? ORDER BY tag_id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM collection_tags t WHERE t.collection_id = ? AND NOT EXISTS (
        SELECT 1 FROM published_photo_tags other WHERE other.photo_id = p.photo_id AND other.tag_id = t.tag_id))
      ${after ? 'AND (p.first_published_at, p.photo_id) < (?, ?)' : ''}
      ORDER BY p.first_published_at DESC, p.photo_id DESC LIMIT ?`,
      id,
      id,
      ...(after ? [after.firstPublishedAt, after.photoId] : []),
      limit + 1,
    ).all<{
      photo_id: string;
      photo_revision: number;
      first_published_at: number;
      title: string | null;
    }>();
    const items = rows.results.slice(0, limit).map((r) => ({
      photoId: r.photo_id,
      photoRevision: r.photo_revision,
      firstPublishedAt: r.first_published_at,
      title: r.title,
    }));
    return {
      items,
      nextAfter: rows.results.length > limit ? items.at(-1)! : null,
    };
  }
  async assignPhotos(
    photos: readonly PhotoDraftSelection[],
    collectionIds: readonly string[],
  ) {
    if (
      !Array.isArray(collectionIds) ||
      !collectionIds.length ||
      collectionIds.length > 30
    )
      invalid('Choose between 1 and 30 collections.');
    const required: string[] = [];
    for (const id of new Set(collectionIds)) {
      const collection = await this.getDraft(id);
      if (!collection)
        throw new CatalogueError('not_found', 'Collection not found.');
      if (!collection.name && !collection.notes.trim())
        invalid(
          'Add a name or Notes to the selected combination before assigning photographs.',
        );
      required.push(...collection.tagIds);
    }
    return new CatalogueRepository(this.db).addTagsToPhotoDrafts(photos, [
      ...new Set(required),
    ]);
  }
}
