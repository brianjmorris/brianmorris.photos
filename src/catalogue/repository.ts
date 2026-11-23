import { writeCatalogueBatch, type CatalogueDatabase } from './d1.ts';
import {
  metadataStatement,
  readPhotoMetadata,
  readPublishedPhotoMetadata,
  type PhotoMetadataInput,
  type PublicPhotoMetadata,
} from './metadata.ts';
import { text, validId, validRevision, validTime } from './validation.ts';
import {
  CatalogueError,
  cleanTagName,
  invalid,
  normalizeTagName,
  type PhotoRevision,
  type PublishedMembership,
  type TagRevision,
  type TagDraftSummary,
  type CoverChoice,
} from './model.ts';

const MAX_PHOTO_TAGS = 64;
const MAX_TAG_ALIASES = 32;

export class CatalogueRepository {
  private readonly db: CatalogueDatabase;

  constructor(db: CatalogueDatabase) {
    this.db = db;
  }

  private statement(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).bind(...values);
  }

  private photoStatements(
    id: string,
    revision: number,
    tagIds: readonly string[],
    now: number,
    metadata?: PhotoMetadataInput,
  ) {
    validId(id);
    validRevision(revision);
    validTime(now);
    if (!Array.isArray(tagIds) || tagIds.length > MAX_PHOTO_TAGS) {
      invalid(`A photo can have at most ${MAX_PHOTO_TAGS} tags.`);
    }
    tagIds.forEach(validId);
    const uniqueTags = [...new Set(tagIds)];
    return [
      metadataStatement(this.db, id, revision, metadata),
      ...uniqueTags.map((tagId) =>
        this.statement(
          'INSERT INTO photo_tags (photo_id, photo_revision, tag_id) VALUES (?, ?, ?)',
          id,
          revision,
          tagId,
        ),
      ),
      this.statement(
        'INSERT INTO photo_revisions (photo_id, revision, created_at) VALUES (?, ?, ?)',
        id,
        revision,
        now,
      ),
      this.statement(
        'UPDATE photos SET draft_revision = ? WHERE id = ?',
        revision,
        id,
      ),
    ];
  }

  async createPhoto(
    tagIds: readonly string[] = [],
    now = Date.now(),
  ): Promise<PhotoRevision> {
    const id = crypto.randomUUID();
    await writeCatalogueBatch(this.db, [
      this.statement(
        'INSERT INTO photos (id, created_at) VALUES (?, ?)',
        id,
        now,
      ),
      ...this.photoStatements(id, 1, tagIds, now),
    ]);
    return (await this.getPhotoRevision(id, 1))!;
  }

  async savePhotoDraft(
    id: string,
    expectedRevision: number,
    tagIds: readonly string[],
    now = Date.now(),
  ): Promise<PhotoRevision> {
    validRevision(expectedRevision);
    validId(id);
    if (!(await this.getPhotoDraft(id)))
      throw new CatalogueError('not_found', 'Photo not found.');
    const revision = expectedRevision + 1;
    await writeCatalogueBatch(
      this.db,
      this.photoStatements(id, revision, tagIds, now),
    );
    return (await this.getPhotoRevision(id, revision))!;
  }

  async savePhotoMetadataDraft(
    id: string,
    expectedRevision: number,
    metadata: PhotoMetadataInput,
    now = Date.now(),
  ): Promise<PhotoRevision> {
    validId(id);
    validRevision(expectedRevision);
    const current = await this.getPhotoDraft(id);
    if (!current) throw new CatalogueError('not_found', 'Photo not found.');
    if (current.revision !== expectedRevision)
      throw new CatalogueError('conflict', 'Photo revision changed.');
    const revision = expectedRevision + 1;
    await writeCatalogueBatch(
      this.db,
      this.photoStatements(id, revision, current.tagIds, now, metadata),
    );
    return (await this.getPhotoRevision(id, revision))!;
  }

  async getPublishedPhotoMetadata(
    id: string,
  ): Promise<PublicPhotoMetadata | null> {
    return readPublishedPhotoMetadata(this.db, id);
  }

  async getPhotoRevision(
    id: string,
    revision: number,
  ): Promise<PhotoRevision | null> {
    validId(id);
    validRevision(revision);
    const row = await this.statement(
      'SELECT created_at FROM photo_revisions WHERE photo_id = ? AND revision = ?',
      id,
      revision,
    ).first<{ created_at: number }>();
    if (!row) return null;
    const tags = await this.statement(
      'SELECT tag_id FROM photo_tags WHERE photo_id = ? AND photo_revision = ? ORDER BY tag_id',
      id,
      revision,
    ).all<{ tag_id: string }>();
    return {
      photoId: id,
      revision,
      createdAt: row.created_at,
      tagIds: tags.results.map((tag) => tag.tag_id),
      metadata: await readPhotoMetadata(this.db, id, revision),
    };
  }

  async getPhotoDraft(id: string): Promise<PhotoRevision | null> {
    validId(id);
    const head = await this.statement(
      'SELECT draft_revision FROM photos WHERE id = ?',
      id,
    ).first<{ draft_revision: number | null }>();
    return head?.draft_revision
      ? this.getPhotoRevision(id, head.draft_revision)
      : null;
  }

  private tagStatements(
    id: string,
    revision: number,
    input: TagInput,
    now: number,
  ) {
    validId(id);
    validRevision(revision);
    validTime(now);
    const name = cleanTagName(input.name);
    const notes = input.notes ?? '';
    if (typeof notes !== 'string') invalid('Collection notes must be text.');
    text(notes, 20_000);
    const featuredOrder = input.featuredOrder ?? null;
    if (
      featuredOrder !== null &&
      (!Number.isSafeInteger(featuredOrder) ||
        featuredOrder < 0 ||
        featuredOrder > 1_000_000)
    )
      invalid('Featured order must be a whole number from 0 to 1000000.');
    const coverPhotoId = input.coverPhotoId ?? null;
    if (coverPhotoId !== null) validId(coverPhotoId);
    if (
      typeof input.slug !== 'string' ||
      input.slug.length > 120 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)
    ) {
      invalid('A lowercase ASCII slug is required.');
    }
    const aliases = input.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.length > MAX_TAG_ALIASES)
      invalid(`A tag can have at most ${MAX_TAG_ALIASES} aliases.`);
    const seen = new Set([normalizeTagName(name)]);
    const aliasStatements = aliases.map((value) => {
      const alias = cleanTagName(value);
      const normalized = normalizeTagName(alias);
      if (seen.has(normalized))
        invalid('Aliases must be distinct from the name and each other.');
      seen.add(normalized);
      return this.statement(
        'INSERT INTO tag_aliases (tag_id, tag_revision, alias, normalized_alias) VALUES (?, ?, ?, ?)',
        id,
        revision,
        alias,
        normalized,
      );
    });
    return [
      ...aliasStatements,
      this.statement(
        'INSERT INTO tag_revisions (tag_id, revision, created_at, name, normalized_name, slug, notes, featured_order, cover_photo_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        revision,
        now,
        name,
        normalizeTagName(name),
        input.slug,
        notes,
        featuredOrder,
        coverPhotoId,
      ),
      this.statement(
        'UPDATE tags SET draft_revision = ? WHERE id = ?',
        revision,
        id,
      ),
    ];
  }

  async createTag(input: TagInput, now = Date.now()): Promise<TagRevision> {
    const id = crypto.randomUUID();
    await writeCatalogueBatch(this.db, [
      this.statement(
        'INSERT INTO tags (id, created_at) VALUES (?, ?)',
        id,
        now,
      ),
      ...this.tagStatements(id, 1, input, now),
    ]);
    return (await this.getTagRevision(id, 1))!;
  }

  async saveTagDraft(
    id: string,
    expectedRevision: number,
    input: TagInput,
    now = Date.now(),
  ): Promise<TagRevision> {
    validId(id);
    validRevision(expectedRevision);
    const current = await this.getTagDraft(id);
    if (!current) throw new CatalogueError('not_found', 'Tag not found.');
    if (current.revision !== expectedRevision)
      throw new CatalogueError(
        'conflict',
        'This collection changed in another window. Reload it before saving.',
      );
    const revision = expectedRevision + 1;
    await writeCatalogueBatch(
      this.db,
      this.tagStatements(id, revision, input, now),
    );
    return (await this.getTagRevision(id, revision))!;
  }

  async getTagRevision(
    id: string,
    revision: number,
  ): Promise<TagRevision | null> {
    validId(id);
    validRevision(revision);
    const row = await this.statement(
      'SELECT name, slug, created_at, notes, featured_order, cover_photo_id FROM tag_revisions WHERE tag_id = ? AND revision = ?',
      id,
      revision,
    ).first<{
      name: string;
      slug: string;
      created_at: number;
      notes: string;
      featured_order: number | null;
      cover_photo_id: string | null;
    }>();
    if (!row) return null;
    const aliases = await this.statement(
      'SELECT alias FROM tag_aliases WHERE tag_id = ? AND tag_revision = ? ORDER BY normalized_alias',
      id,
      revision,
    ).all<{ alias: string }>();
    return {
      tagId: id,
      revision,
      createdAt: row.created_at,
      name: row.name,
      slug: row.slug,
      aliases: aliases.results.map((entry) => entry.alias),
      notes: row.notes,
      featuredOrder: row.featured_order,
      coverPhotoId: row.cover_photo_id,
    };
  }

  async getTagDraft(id: string): Promise<TagRevision | null> {
    validId(id);
    const head = await this.statement(
      'SELECT draft_revision FROM tags WHERE id = ?',
      id,
    ).first<{ draft_revision: number | null }>();
    return head?.draft_revision
      ? this.getTagRevision(id, head.draft_revision)
      : null;
  }

  async findDraftTag(name: string): Promise<TagRevision | null> {
    const claim = await this.statement(
      'SELECT tag_id FROM tag_name_claims WHERE normalized_name = ?',
      normalizeTagName(name),
    ).first<{ tag_id: string }>();
    return claim ? this.getTagDraft(claim.tag_id) : null;
  }

  async listTagDrafts(
    afterId?: string,
    limit = 30,
  ): Promise<{ items: TagDraftSummary[]; nextAfter: string | null }> {
    if (afterId !== undefined) validId(afterId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      invalid('Invalid page size.');
    const after = afterId
      ? await this.statement(
          'SELECT r.normalized_name FROM tags t JOIN tag_revisions r ON r.tag_id = t.id AND r.revision = t.draft_revision WHERE t.id = ?',
          afterId,
        ).first<{ normalized_name: string }>()
      : null;
    if (afterId && !after)
      invalid('The collection page is no longer available.');
    const rows = await this.statement(
      `SELECT t.id, r.revision, r.name, r.slug, r.featured_order, p.tag_revision AS published_revision
       FROM tag_revisions r JOIN tags t ON t.id = r.tag_id AND t.draft_revision = r.revision
       LEFT JOIN published_tags p ON p.tag_id = t.id
       ${after ? 'WHERE (r.normalized_name, t.id) > (?, ?)' : ''}
       ORDER BY r.normalized_name, t.id LIMIT ?`,
      ...(after ? [after.normalized_name, afterId!] : []),
      limit + 1,
    ).all<{
      id: string;
      revision: number;
      name: string;
      slug: string;
      featured_order: number | null;
      published_revision: number | null;
    }>();
    const items = rows.results.slice(0, limit).map((row) => ({
      tagId: row.id,
      revision: row.revision,
      name: row.name,
      slug: row.slug,
      featuredOrder: row.featured_order,
      publishedRevision: row.published_revision,
    }));
    return {
      items,
      nextAfter: rows.results.length > limit ? items.at(-1)!.tagId : null,
    };
  }

  async listCoverChoices(
    tagId: string,
    after?: Pick<PublishedMembership, 'photoId' | 'firstPublishedAt'>,
    limit = 30,
  ): Promise<{ items: CoverChoice[]; nextAfter: PublishedMembership | null }> {
    validId(tagId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      invalid('Invalid page size.');
    if (after) {
      validId(after.photoId);
      validTime(after.firstPublishedAt);
    }
    const rows = await this.statement(
      `SELECT p.photo_id, p.photo_revision, p.first_published_at, m.title
       FROM published_photo_tags p LEFT JOIN photo_metadata_revisions m
       ON m.photo_id = p.photo_id AND m.photo_revision = p.photo_revision
       WHERE p.tag_id = ? ${after ? 'AND (p.first_published_at, p.photo_id) < (?, ?)' : ''}
       ORDER BY p.first_published_at DESC, p.photo_id DESC LIMIT ?`,
      tagId,
      ...(after ? [after.firstPublishedAt, after.photoId] : []),
      limit + 1,
    ).all<{
      photo_id: string;
      photo_revision: number;
      first_published_at: number;
      title: string | null;
    }>();
    const items = rows.results.slice(0, limit).map((row) => ({
      photoId: row.photo_id,
      photoRevision: row.photo_revision,
      firstPublishedAt: row.first_published_at,
      title: row.title,
    }));
    const last = items.at(-1);
    return {
      items,
      nextAfter:
        rows.results.length > limit && last
          ? {
              photoId: last.photoId,
              photoRevision: last.photoRevision,
              firstPublishedAt: last.firstPublishedAt,
            }
          : null,
    };
  }

  async getPublishedTag(id: string): Promise<TagRevision | null> {
    validId(id);
    const head = await this.statement(
      'SELECT tag_revision FROM published_tags WHERE tag_id = ?',
      id,
    ).first<{ tag_revision: number }>();
    return head ? this.getTagRevision(id, head.tag_revision) : null;
  }

  // Storage-level bounded read only. Versioned public DTOs/cursors follow later.
  async listPublishedTagPhotos(
    tagId: string,
    limit = 30,
    after?: PublishedMembership,
  ): Promise<PublishedMembership[]> {
    validId(tagId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      invalid('Page size must be between 1 and 100.');
    if (after) {
      validId(after.photoId);
      validTime(after.firstPublishedAt);
    }
    const rows = await this.statement(
      `SELECT photo_id, photo_revision, first_published_at FROM published_photo_tags
       WHERE tag_id = ? ${after ? 'AND (first_published_at, photo_id) < (?, ?)' : ''}
       ORDER BY first_published_at DESC, photo_id DESC LIMIT ?`,
      tagId,
      ...(after ? [after.firstPublishedAt, after.photoId] : []),
      limit,
    ).all<{
      photo_id: string;
      photo_revision: number;
      first_published_at: number;
    }>();
    return rows.results.map((row) => ({
      photoId: row.photo_id,
      photoRevision: row.photo_revision,
      firstPublishedAt: row.first_published_at,
    }));
  }
}

export interface TagInput {
  name: string;
  slug: string;
  aliases?: readonly string[];
  notes?: string;
  featuredOrder?: number | null;
  coverPhotoId?: string | null;
}
