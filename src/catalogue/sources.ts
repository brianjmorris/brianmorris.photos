import { writeCatalogueBatch, type CatalogueDatabase } from './d1.ts';
import { invalid } from './model.ts';
import {
  coordinates,
  requiredText,
  text,
  validId,
  validTime,
  type Coordinates,
} from './validation.ts';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface SourceEvidenceInput {
  sha256: string;
  originalFilename: string;
  parser: { name: string; version: string };
  rawMetadata: { [key: string]: JsonValue };
  captureText?: string | null;
  captureSubseconds?: string | null;
  captureOffsetText?: string | null;
  gps?: Coordinates | null;
}
export interface SourceEvidence extends SourceEvidenceInput {
  id: string;
  photoId: string;
  extractedAt: number;
  captureText: string | null;
  captureSubseconds: string | null;
  captureOffsetText: string | null;
  gps: Coordinates | null;
}

// Bound data before serialization; reject lossy/non-JSON values and cycles.
function rawJson(input: SourceEvidenceInput['rawMetadata']): string {
  let nodes = 0;
  const stack = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (++nodes > 20000 || depth > 32)
      invalid('Source metadata is too complex.');
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    )
      return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || stack.has(value))
      invalid('Source metadata must be lossless JSON.');
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      invalid('Source metadata must contain plain JSON objects.');
    if (Object.getOwnPropertySymbols(value).length > 0)
      invalid('Source metadata cannot contain symbol keys.');
    stack.add(value);
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else for (const item of Object.values(value)) visit(item, depth + 1);
    stack.delete(value);
  }
  if (!input || Array.isArray(input) || typeof input !== 'object')
    invalid('Raw metadata must be an object.');
  visit(input, 0);
  const json = JSON.stringify(input);
  if (new TextEncoder().encode(json).byteLength > 256 * 1024)
    invalid('Source metadata exceeds 256 KiB.');
  return json;
}

export class SourceMetadataRepository {
  private readonly db: CatalogueDatabase;
  constructor(db: CatalogueDatabase) {
    this.db = db;
  }

  async record(
    photoId: string,
    input: SourceEvidenceInput,
    now = Date.now(),
  ): Promise<SourceEvidence> {
    const { id, statement } = this.prepareRecord(photoId, input, now);
    await writeCatalogueBatch(this.db, [statement]);
    return (await this.get(id))!;
  }

  // Callers can include the immutable insert in an editorial save transaction.
  prepareRecord(photoId: string, input: SourceEvidenceInput, now: number) {
    validId(photoId);
    validTime(now);
    if (
      typeof input.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(input.sha256)
    )
      invalid('A lowercase SHA-256 fingerprint is required.');
    const gps = coordinates(input.gps);
    const id = crypto.randomUUID();
    const filename = requiredText(input.originalFilename, 255);
    const parserName = requiredText(input.parser?.name, 120);
    const parserVersion = requiredText(input.parser?.version, 120);
    const captureText = text(input.captureText, 200);
    const subseconds = text(input.captureSubseconds, 100);
    const offset = text(input.captureOffsetText, 100);
    return {
      id,
      statement: this.db
        .prepare(
          `INSERT INTO photo_source_metadata
      (id, photo_id, source_sha256, original_filename, parser_name, parser_version, extracted_at, raw_json,
       capture_text, capture_subseconds, capture_offset_text, gps_latitude, gps_longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          photoId,
          input.sha256,
          filename,
          parserName,
          parserVersion,
          now,
          rawJson(input.rawMetadata),
          captureText,
          subseconds,
          offset,
          gps?.latitude ?? null,
          gps?.longitude ?? null,
        ),
    };
  }

  async findId(photoId: string, input: SourceEvidenceInput) {
    const row = await this.db
      .prepare(
        `SELECT id FROM photo_source_metadata
         WHERE photo_id = ? AND source_sha256 = ? AND parser_name = ? AND parser_version = ?`,
      )
      .bind(photoId, input.sha256, input.parser.name, input.parser.version)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async get(id: string): Promise<SourceEvidence | null> {
    validId(id);
    const row = await this.db
      .prepare('SELECT * FROM photo_source_metadata WHERE id = ?')
      .bind(id)
      .first<{
        id: string;
        photo_id: string;
        source_sha256: string;
        original_filename: string;
        parser_name: string;
        parser_version: string;
        extracted_at: number;
        raw_json: string;
        capture_text: string | null;
        capture_subseconds: string | null;
        capture_offset_text: string | null;
        gps_latitude: number | null;
        gps_longitude: number | null;
      }>();
    return row
      ? {
          id: row.id,
          photoId: row.photo_id,
          sha256: row.source_sha256,
          originalFilename: row.original_filename,
          parser: { name: row.parser_name, version: row.parser_version },
          extractedAt: row.extracted_at,
          rawMetadata: JSON.parse(row.raw_json),
          captureText: row.capture_text,
          captureSubseconds: row.capture_subseconds,
          captureOffsetText: row.capture_offset_text,
          gps:
            row.gps_latitude === null
              ? null
              : { latitude: row.gps_latitude, longitude: row.gps_longitude! },
        }
      : null;
  }
}
