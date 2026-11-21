import { writeCatalogueBatch, type CatalogueDatabase } from './d1.ts';
import { validId, validRevision, validTime } from './validation.ts';
import {
  CatalogueError,
  cleanTagName,
  invalid,
  normalizeTagName,
  type PhotoRevision,
  type PublishedMembership,
  type TagRevision,
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
      ...uniqueTags.map((tagId) =>
        this.statement(
          'INSERT INTO photo_tags (photo_id, photo_revision, tag_id) VALUES (?, ?, ?)',
          id,
          revision,
          tagId,
        ),
      ),
      this.statement(
        'INSERT INTO photo_revisions VALUES (?, ?, ?)',
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
        'INSERT INTO tag_aliases VALUES (?, ?, ?, ?)',
        id,
        revision,
        alias,
        normalized,
      );
    });
    return [
      ...aliasStatements,
      this.statement(
        'INSERT INTO tag_revisions VALUES (?, ?, ?, ?, ?, ?)',
        id,
        revision,
        now,
        name,
        normalizeTagName(name),
        input.slug,
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
    if (!(await this.getTagDraft(id)))
      throw new CatalogueError('not_found', 'Tag not found.');
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
      'SELECT name, slug, created_at FROM tag_revisions WHERE tag_id = ? AND revision = ?',
      id,
      revision,
    ).first<{ name: string; slug: string; created_at: number }>();
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
}
