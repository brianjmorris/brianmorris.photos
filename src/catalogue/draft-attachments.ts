import type { CatalogueDatabase } from './d1.ts';
import { validId } from './validation.ts';

const pendingLifetime = 24 * 60 * 60 * 1000;
export const draftAttachmentPrefix = 'draft-jpegs/';
export type DraftAttachmentState = 'pending' | 'attached' | 'retired';
export type DraftCleanupTrigger = 'scheduled' | 'manual';

interface DraftCleanupCounts {
  scanned: number;
  retiredKeys: number;
  orphanedKeys: number;
  moreWork: boolean;
}

interface DraftCleanupRun {
  trigger: DraftCleanupTrigger;
  finished_at: number;
  outcome: 'completed' | 'failed';
  scanned: number | null;
  retired_keys: number | null;
  orphaned_keys: number | null;
  more_work: 0 | 1 | null;
}

export interface DraftAttachment {
  id: string;
  photo_id: string;
  sha256: string;
  byte_length: number;
  state: DraftAttachmentState;
}

const active = "state IN ('pending', 'attached')";
const hasDraft =
  'EXISTS (SELECT 1 FROM photos WHERE id=?1 AND draft_revision IS NOT NULL)';

export class DraftAttachmentRepository {
  private readonly db: CatalogueDatabase;

  constructor(db: CatalogueDatabase) {
    this.db = db;
  }

  private statement(sql: string, ...values: (string | number)[]) {
    return this.db.prepare(sql).bind(...values);
  }

  async reserve(photoId: string, sha256: string, size: number, now: number) {
    validId(photoId);
    const id = crypto.randomUUID();
    const [, , draft, own, duplicate] = (await this.db.batch([
      this.statement(
        `UPDATE photo_draft_attachments SET state='retired'
         WHERE state='pending' AND expires_at<=?3 AND (photo_id=?1 OR sha256=?2)`,
        photoId,
        sha256,
        now,
      ),
      this.statement(
        `INSERT INTO photo_draft_attachments (id, photo_id, sha256, byte_length, state, expires_at)
         SELECT ?2, ?1, ?3, ?4, 'pending', ?5 WHERE ${hasDraft}
         ON CONFLICT DO NOTHING`,
        photoId,
        id,
        sha256,
        size,
        now + pendingLifetime,
      ),
      this.statement('SELECT draft_revision FROM photos WHERE id=?', photoId),
      this.statement(
        `SELECT * FROM photo_draft_attachments WHERE photo_id=? AND ${active}`,
        photoId,
      ),
      this.statement(
        `SELECT photo_id FROM photo_draft_attachments WHERE sha256=? AND ${active}`,
        sha256,
      ),
    ])) as [
      unknown,
      unknown,
      { results: { draft_revision: number | null }[] },
      { results: DraftAttachment[] },
      { results: { photo_id: string }[] },
    ];
    return {
      exists: Boolean(draft.results[0]?.draft_revision),
      own: own.results[0],
      duplicate: duplicate.results[0]?.photo_id,
    };
  }

  async get(photoId: string, now: number) {
    validId(photoId);
    return this.statement(
      `SELECT * FROM photo_draft_attachments
       WHERE photo_id=?1 AND ${hasDraft}
         AND (state='attached' OR (state='pending' AND expires_at>?2))`,
      photoId,
      now,
    ).first<DraftAttachment>();
  }

  async promote(attachment: DraftAttachment, now: number) {
    return this.statement(
      `UPDATE photo_draft_attachments SET state='attached', expires_at=0
       WHERE photo_id=?1 AND id=?2 AND ${hasDraft}
         AND (state='attached' OR (state='pending' AND expires_at>?3))
       RETURNING id`,
      attachment.photo_id,
      attachment.id,
      now,
    ).first<{ id: string }>();
  }

  async retire(photoId: string) {
    validId(photoId);
    return this.statement(
      `UPDATE photo_draft_attachments SET state='retired'
       WHERE photo_id=? AND ${active} RETURNING id`,
      photoId,
    ).first<{ id: string }>();
  }

  async retireExpired(now: number) {
    await this.statement(
      `UPDATE photo_draft_attachments SET state='retired'
       WHERE id IN (SELECT id FROM photo_draft_attachments
         WHERE state='pending' AND expires_at<=? ORDER BY expires_at, id LIMIT 32)`,
      now,
    ).run();
  }

  async retiredIds() {
    const { results } = await this.statement(
      `SELECT id FROM photo_draft_attachments
       WHERE state='retired' ORDER BY expires_at, id LIMIT 32`,
    ).all<{ id: string }>();
    return results.map(({ id }) => id);
  }

  async forgetRetired(ids: string[]) {
    await this.statement(
      `DELETE FROM photo_draft_attachments WHERE state='retired'
       AND id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(ids),
    ).run();
  }

  async liveIds(ids: string[]) {
    const { results } = await this.statement(
      `SELECT id FROM photo_draft_attachments WHERE ${active}
       AND id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(ids),
    ).all<{ id: string }>();
    return new Set(results.map(({ id }) => id));
  }

  async cleanupProgress() {
    return this.db
      .prepare(
        'SELECT cursor, revision FROM draft_photo_cleanup_progress WHERE id=1',
      )
      .first<{ cursor: string | null; revision: number }>();
  }

  private cleanupRunStatement(
    trigger: DraftCleanupTrigger,
    startedAt: number,
    result: DraftCleanupCounts | null,
  ) {
    return this.db
      .prepare(
        `INSERT INTO draft_photo_cleanup_runs
          (trigger, started_at, finished_at, outcome, scanned, retired_keys, orphaned_keys, more_work)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trigger) DO UPDATE SET started_at=excluded.started_at,
           finished_at=excluded.finished_at, outcome=excluded.outcome, scanned=excluded.scanned,
           retired_keys=excluded.retired_keys, orphaned_keys=excluded.orphaned_keys,
           more_work=excluded.more_work
         WHERE excluded.started_at >= draft_photo_cleanup_runs.started_at`,
      )
      .bind(
        trigger,
        startedAt,
        Math.max(Date.now(), startedAt),
        result ? 'completed' : 'failed',
        result?.scanned ?? null,
        result?.retiredKeys ?? null,
        result?.orphanedKeys ?? null,
        result ? Number(result.moreWork) : null,
      );
  }

  async completeCleanup(
    revision: number,
    cursor: string | null,
    trigger: DraftCleanupTrigger,
    startedAt: number,
    counts: DraftCleanupCounts,
  ) {
    const [advance] = (await this.db.batch([
      this.db
        .prepare(
          `UPDATE draft_photo_cleanup_progress SET cursor=?, revision=revision+1
         WHERE id=1 AND revision=? RETURNING revision`,
        )
        .bind(cursor, revision),
      this.cleanupRunStatement(trigger, startedAt, counts),
    ])) as [{ results: { revision: number }[] }, unknown];
    return advance.results.length > 0;
  }

  async recordCleanupFailure(trigger: DraftCleanupTrigger, startedAt: number) {
    await this.cleanupRunStatement(trigger, startedAt, null).run();
  }

  async latestCleanupRuns() {
    const { results } = await this.db
      .prepare(
        'SELECT trigger, finished_at, outcome, scanned, retired_keys, orphaned_keys, more_work FROM draft_photo_cleanup_runs',
      )
      .all<DraftCleanupRun>();
    return results;
  }
}
