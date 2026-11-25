import { writeCatalogueBatch, type CatalogueDatabase } from './d1.ts';
import {
  metadataStatement,
  metadataJsonSql,
  photoMetadataFromJson,
  readPublishedPhotoMetadata,
  readPublishedPhotoPlace,
  readDraftPhotoPlace,
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

  private photoRead(id: string, revision?: number) {
    return this.statement(
      `SELECT r.revision, r.created_at,
      (SELECT json_group_array(tag_id) FROM (SELECT tag_id FROM ${revision === undefined ? 'photo_draft_tags' : 'photo_tags'} t
        WHERE t.photo_id=r.photo_id AND t.photo_revision=r.revision ORDER BY tag_id)) AS tags_json,
      ${metadataJsonSql('m')} AS metadata_json
      FROM ${revision === undefined ? 'photo_drafts' : 'photo_states'} r
      LEFT JOIN ${revision === undefined ? 'photo_metadata_drafts' : 'photo_metadata_states'} m ON m.photo_id=r.photo_id AND m.photo_revision=r.revision
      WHERE r.photo_id=? ${revision === undefined ? '' : 'AND r.revision=?'}`,
      id,
      ...(revision === undefined ? [] : [revision]),
    );
  }

  private photoResult(
    id: string,
    row: Record<string, unknown> | null,
  ): PhotoRevision | null {
    return row
      ? {
          photoId: id,
          revision: row.revision as number,
          createdAt: row.created_at as number,
          tagIds: JSON.parse(row.tags_json as string),
          metadata: photoMetadataFromJson(row.metadata_json as string | null),
        }
      : null;
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
      this.statement('DELETE FROM photo_draft_tags WHERE photo_id = ?', id),
      metadataStatement(this.db, id, revision, metadata),
      ...uniqueTags.map((tagId) =>
        this.statement(
          'INSERT INTO photo_draft_tags (photo_id, photo_revision, tag_id) VALUES (?, ?, ?)',
          id,
          revision,
          tagId,
        ),
      ),
      this.statement(
        revision === 1
          ? 'INSERT INTO photo_drafts (photo_id, revision, created_at) VALUES (?, ?, ?)'
          : 'UPDATE photo_drafts SET revision = ?2, created_at = ?3 WHERE photo_id = ?1',
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
    const result = await writeCatalogueBatch(this.db, [
      this.statement(
        'INSERT INTO photos (id, created_at) VALUES (?, ?)',
        id,
        now,
      ),
      ...this.photoStatements(id, 1, tagIds, now),
      this.photoRead(id),
    ]);
    return this.photoResult(id, result.at(-1)!.results[0])!;
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
    const result = await writeCatalogueBatch(this.db, [
      ...this.photoStatements(id, revision, tagIds, now),
      this.photoRead(id),
    ]);
    return this.photoResult(id, result.at(-1)!.results[0])!;
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
    const result = await writeCatalogueBatch(this.db, [
      ...this.photoStatements(id, revision, current.tagIds, now, metadata),
      this.photoRead(id),
    ]);
    return this.photoResult(id, result.at(-1)!.results[0])!;
  }

  // One transaction adds a union of required tags to every selected draft.
  // Expected versions and SQL counter guards protect the whole batch from races.
  async addTagsToPhotoDrafts(
    photos: readonly PhotoDraftSelection[],
    tagIds: readonly string[],
  ) {
    if (!Array.isArray(photos) || !photos.length || photos.length > 30)
      invalid('Choose between 1 and 30 photographs.');
    if (!Array.isArray(tagIds)) invalid('Invalid tags.');
    tagIds.forEach(validId);
    if (photos.some((photo) => !photo || typeof photo !== 'object'))
      invalid('Invalid photograph selection.');
    if (new Set(photos.map((photo) => photo.photoId)).size !== photos.length)
      invalid('Choose each photograph only once.');
    const statements = [];
    const now = Date.now();
    for (const photo of photos) {
      validId(photo.photoId);
      validRevision(photo.expectedRevision);
      const current = await this.getPhotoDraft(photo.photoId);
      if (!current)
        throw new CatalogueError('not_found', 'Photograph not found.');
      if (current.revision !== photo.expectedRevision)
        throw new CatalogueError(
          'conflict',
          'A selected photograph changed. Reload before assigning collections.',
        );
      const tags = [...new Set([...current.tagIds, ...tagIds])].sort();
      statements.push(
        ...this.photoStatements(photo.photoId, current.revision + 1, tags, now),
      );
    }
    const result = await writeCatalogueBatch(this.db, [
      ...statements,
      ...photos.map((photo) => this.photoRead(photo.photoId)),
    ]);
    return photos.map((photo, index) =>
      this.photoResult(
        photo.photoId,
        result[statements.length + index].results[0],
      ),
    );
  }

  async listPhotoDrafts(afterId?: string, limit = 30) {
    if (afterId !== undefined) validId(afterId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30)
      invalid('Invalid page size.');
    const rows = await this.statement(
      `SELECT p.id, p.draft_revision, m.title,
      (SELECT json_group_array(json_object('tagId', tagged.tag_id, 'name', tagged.name)) FROM (
        SELECT pt.tag_id, tr.name FROM photo_tags pt
        JOIN tags t ON t.id = pt.tag_id
        JOIN tag_states tr ON tr.tag_id = t.id AND tr.revision = t.draft_revision
        WHERE pt.photo_id = p.id AND pt.photo_revision = p.draft_revision
        ORDER BY tr.name COLLATE NOCASE, pt.tag_id
      ) tagged) AS tags_json FROM photos p
      LEFT JOIN photo_metadata_states m ON m.photo_id = p.id AND m.photo_revision = p.draft_revision
      WHERE p.draft_revision IS NOT NULL ${afterId ? 'AND p.id > ?' : ''} ORDER BY p.id LIMIT ?`,
      ...(afterId ? [afterId] : []),
      limit + 1,
    ).all<{
      id: string;
      draft_revision: number;
      title: string | null;
      tags_json: string;
    }>();
    const items = rows.results.slice(0, limit).map((row) => ({
      photoId: row.id,
      revision: row.draft_revision,
      title: row.title,
      tags: JSON.parse(row.tags_json) as { tagId: string; name: string }[],
    }));
    return {
      items,
      nextAfter: rows.results.length > limit ? items.at(-1)!.photoId : null,
    };
  }

  async getPublishedPhotoMetadata(
    id: string,
  ): Promise<PublicPhotoMetadata | null> {
    return readPublishedPhotoMetadata(this.db, id);
  }

  async getPublishedPhotoPlace(id: string) {
    return readPublishedPhotoPlace(this.db, id);
  }

  async getPhotoDraftPlace(id: string, location: 'private' | 'public') {
    return readDraftPhotoPlace(this.db, id, location);
  }

  async getPhotoRevision(
    id: string,
    revision: number,
  ): Promise<PhotoRevision | null> {
    validId(id);
    validRevision(revision);
    return this.photoResult(id, await this.photoRead(id, revision).first());
  }

  async getPhotoDraft(id: string): Promise<PhotoRevision | null> {
    validId(id);
    return this.photoResult(id, await this.photoRead(id).first());
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
    if (typeof notes !== 'string') invalid('Notes must be text.');
    text(notes, 20_000);
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
        'INSERT INTO tag_draft_aliases (tag_id, tag_revision, alias, normalized_alias) VALUES (?, ?, ?, ?)',
        id,
        revision,
        alias,
        normalized,
      );
    });
    return [
      this.statement('DELETE FROM tag_draft_aliases WHERE tag_id = ?', id),
      ...aliasStatements,
      this.statement(
        revision === 1
          ? 'INSERT INTO tag_drafts (tag_id, revision, created_at, name, normalized_name, slug, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
          : 'UPDATE tag_drafts SET revision=?2, created_at=?3, name=?4, normalized_name=?5, slug=?6, notes=?7 WHERE tag_id=?1',
        id,
        revision,
        now,
        name,
        normalizeTagName(name),
        input.slug,
        notes,
      ),
      this.statement(
        'UPDATE tags SET draft_revision = ? WHERE id = ?',
        revision,
        id,
      ),
    ];
  }

  private tagRead(id: string, revision?: number, published = false) {
    const table = published
      ? 'tag_public'
      : revision === undefined
        ? 'tag_drafts'
        : 'tag_states';
    const aliases = published
      ? 'tag_public_aliases'
      : revision === undefined
        ? 'tag_draft_aliases'
        : 'tag_aliases';
    return this.statement(
      `SELECT r.revision,r.name,r.slug,r.created_at,r.notes,
      (SELECT json_group_array(alias) FROM (SELECT alias FROM ${aliases} a WHERE a.tag_id=r.tag_id AND a.tag_revision=r.revision ORDER BY normalized_alias)) AS aliases_json
      FROM ${table} r ${published ? 'JOIN published_tags p ON p.tag_id=r.tag_id AND p.tag_revision=r.revision' : ''}
      WHERE r.tag_id=? ${revision === undefined ? '' : 'AND r.revision=?'}`,
      id,
      ...(revision === undefined ? [] : [revision]),
    );
  }

  private tagResult(
    id: string,
    row: Record<string, unknown> | null,
  ): TagRevision | null {
    return row
      ? {
          tagId: id,
          revision: row.revision as number,
          createdAt: row.created_at as number,
          name: row.name as string,
          slug: row.slug as string,
          notes: row.notes as string,
          aliases: JSON.parse(row.aliases_json as string),
        }
      : null;
  }

  async createTag(input: TagInput, now = Date.now()): Promise<TagRevision> {
    const id = crypto.randomUUID();
    const result = await writeCatalogueBatch(this.db, [
      this.statement(
        'INSERT INTO tags (id, created_at) VALUES (?, ?)',
        id,
        now,
      ),
      ...this.tagStatements(id, 1, input, now),
      this.tagRead(id),
    ]);
    return this.tagResult(id, result.at(-1)!.results[0])!;
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
        'This tag changed in another window. Reload it before saving.',
      );
    const revision = expectedRevision + 1;
    const result = await writeCatalogueBatch(this.db, [
      ...this.tagStatements(id, revision, input, now),
      this.tagRead(id),
    ]);
    return this.tagResult(id, result.at(-1)!.results[0])!;
  }

  async getTagRevision(
    id: string,
    revision: number,
  ): Promise<TagRevision | null> {
    validId(id);
    validRevision(revision);
    return this.tagResult(id, await this.tagRead(id, revision).first());
  }

  async getTagDraft(id: string): Promise<TagRevision | null> {
    validId(id);
    return this.tagResult(id, await this.tagRead(id).first());
  }

  async findDraftTag(name: string): Promise<TagRevision | null> {
    const claim = await this.statement(
      'SELECT tag_id FROM tag_name_claims WHERE normalized_name = ?',
      normalizeTagName(name),
    ).first<{ tag_id: string }>();
    return claim ? this.getTagDraft(claim.tag_id) : null;
  }

  async resolveTagNames(names: readonly string[]): Promise<string[]> {
    if (!Array.isArray(names) || names.length < 2 || names.length > 64)
      invalid('Enter between 2 and 64 existing tags, one per line.');
    const normalized = [...new Set(names.map(normalizeTagName))];
    const rows = await this.statement(
      'SELECT normalized_name, tag_id FROM tag_name_claims WHERE normalized_name IN (SELECT value FROM json_each(?))',
      JSON.stringify(normalized),
    ).all<{ normalized_name: string; tag_id: string }>();
    if (rows.results.length !== normalized.length)
      invalid(
        'One or more tags were not found. Create those tags first, or use an existing name or alias.',
      );
    return [...new Set(rows.results.map((row) => row.tag_id))].sort();
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
          'SELECT r.normalized_name FROM tags t JOIN tag_states r ON r.tag_id = t.id AND r.revision = t.draft_revision WHERE t.id = ?',
          afterId,
        ).first<{ normalized_name: string }>()
      : null;
    if (afterId && !after) invalid('The tag page is no longer available.');
    const rows = await this.statement(
      `SELECT t.id, r.revision, r.name, r.slug, p.tag_revision AS published_revision
       FROM tag_states r JOIN tags t ON t.id = r.tag_id AND t.draft_revision = r.revision
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
      published_revision: number | null;
    }>();
    const items = rows.results.slice(0, limit).map((row) => ({
      tagId: row.id,
      revision: row.revision,
      name: row.name,
      slug: row.slug,
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
       FROM published_photo_tags p LEFT JOIN photo_metadata_public m
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
    return this.tagResult(id, await this.tagRead(id, undefined, true).first());
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
}

export interface PhotoDraftSelection {
  photoId: string;
  expectedRevision: number;
}
