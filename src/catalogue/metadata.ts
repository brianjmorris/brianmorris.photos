import type { CatalogueDatabase } from './d1.ts';
import { invalid } from './model.ts';
import { placeChainSql, type PlaceDescription } from './place-snapshot.ts';
import {
  coordinates,
  placeReference,
  text,
  textList,
  validId,
  type Coordinates,
  type PlaceReference,
} from './validation.ts';

export interface CaptureTimeInput {
  precision: 'unknown' | 'date' | 'second';
  localDate?: string | null;
  localTime?: string | null;
  subseconds?: string | null;
  offsetMinutes?: number | null;
  timeZone?: string | null;
  offsetSource?: string | null;
  clockCorrectionSeconds?: number;
  correctionReason?: string | null;
}

export type CaptureEdit = Pick<
  CaptureTimeInput,
  | 'precision'
  | 'localDate'
  | 'localTime'
  | 'subseconds'
  | 'offsetMinutes'
  | 'timeZone'
>;
export interface CaptureTime {
  precision: CaptureTimeInput['precision'];
  localDate: string | null;
  localTime: string | null;
  subseconds: string | null;
  offsetMinutes: number | null;
  timeZone: string | null;
  offsetSource: string | null;
  utcInstant: string | null;
  clockCorrectionSeconds: number;
  correctionReason: string | null;
}
export interface PhotoRights {
  creators: string[];
  copyrightOwners: string[];
  copyrightNotice: string | null;
  creditLine: string | null;
  usageTerms: string | null;
  rightsUrl: string | null;
  publicContactUrl: string | null;
}
export type PublicLocation =
  | { visibility: 'none' }
  | { visibility: 'place'; place: PlaceReference }
  | {
      visibility: 'approximate';
      place: PlaceReference | null;
      point: Coordinates;
      radiusMeters: number;
    }
  | { visibility: 'exact'; place: PlaceReference | null; point: Coordinates };
export interface PhotoMetadata {
  sourceId: string | null;
  title: string | null;
  caption: string | null;
  altText: string | null;
  keywords: string[];
  rights: PhotoRights;
  capture: CaptureTime;
  privateLocation: { place: PlaceReference | null; point: Coordinates | null };
  publicLocation: PublicLocation;
}
export interface PhotoMetadataInput {
  sourceId?: string | null;
  title?: string | null;
  caption?: string | null;
  altText?: string | null;
  keywords?: readonly string[];
  rights?: Partial<PhotoRights>;
  capture?: CaptureTimeInput;
  privateLocation?: {
    place?: PlaceReference | null;
    point?: Coordinates | null;
  };
  publicLocation?: PublicLocation;
}
export type PublicCaptureTime = Omit<
  CaptureTime,
  'offsetSource' | 'clockCorrectionSeconds' | 'correctionReason'
>;
export type PublicPhotoMetadata = Omit<
  PhotoMetadata,
  'sourceId' | 'privateLocation' | 'capture'
> & { capture: PublicCaptureTime };

function url(value: string | null | undefined, contact = false): string | null {
  const result = text(value, 2000);
  if (result === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    return invalid('Invalid absolute URL.');
  }
  if (
    !['https:', 'http:', ...(contact ? ['mailto:'] : [])].includes(
      parsed.protocol,
    ) ||
    parsed.username ||
    parsed.password
  )
    invalid('Unsupported public URL.');
  return result;
}

export function normalizeCapture(
  input: CaptureTimeInput = { precision: 'unknown' },
): CaptureTime {
  const localDate = text(input.localDate, 10);
  const localTime = text(input.localTime, 8);
  const subseconds = text(input.subseconds, 9);
  const offsetMinutes = input.offsetMinutes ?? null;
  const timeZone = text(input.timeZone, 100);
  const offsetSource = text(input.offsetSource, 1000);
  const correctionReason = text(input.correctionReason, 1000);
  const clockCorrectionSeconds = input.clockCorrectionSeconds ?? 0;
  if (
    !Number.isSafeInteger(clockCorrectionSeconds) ||
    (clockCorrectionSeconds !== 0 && !correctionReason?.trim())
  )
    invalid(
      'Clock corrections require an integer number of seconds and a reason.',
    );
  if (!['unknown', 'date', 'second'].includes(input.precision))
    invalid('Invalid capture precision.');
  if (input.precision === 'unknown') {
    if (
      [
        localDate,
        localTime,
        subseconds,
        offsetMinutes,
        timeZone,
        offsetSource,
      ].some((value) => value !== null) ||
      clockCorrectionSeconds !== 0
    )
      invalid(
        'Unknown capture times cannot imply a date, time, offset, or correction.',
      );
  } else {
    if (
      !localDate ||
      !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(localDate) ||
      !Number.isFinite(Date.parse(`${localDate}T00:00:00Z`)) ||
      new Date(`${localDate}T00:00:00Z`).toISOString().slice(0, 10) !==
        localDate
    )
      invalid('Invalid capture date.');
    if (input.precision === 'date') {
      if (localTime !== null || subseconds !== null || offsetMinutes !== null)
        invalid('A date-only capture cannot imply a time or UTC offset.');
    } else {
      if (!localTime || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(localTime))
        invalid('Invalid capture time.');
      if (subseconds !== null && !/^\d{1,9}$/.test(subseconds))
        invalid('Invalid capture subseconds.');
    }
  }
  if (
    offsetMinutes !== null &&
    (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840)
  )
    invalid('Invalid UTC offset.');
  if ((offsetMinutes !== null || timeZone !== null) && !offsetSource?.trim())
    invalid('Offset/timezone decisions require an explicit source.');
  if (timeZone !== null) {
    try {
      new Intl.DateTimeFormat('en', { timeZone });
    } catch {
      invalid('Invalid timezone label.');
    }
  }
  let utcInstant: string | null = null;
  if (input.precision === 'second' && offsetMinutes !== null) {
    utcInstant = new Date(
      Date.parse(`${localDate}T${localTime}Z`) - offsetMinutes * 60000,
    )
      .toISOString()
      .replace('.000Z', subseconds === null ? 'Z' : `.${subseconds}Z`);
    if (!/^(?!0000)\d{4}-/.test(utcInstant))
      invalid('Derived UTC time is outside the supported calendar range.');
  }
  return {
    precision: input.precision,
    localDate,
    localTime,
    subseconds,
    offsetMinutes,
    timeZone,
    offsetSource,
    utcInstant,
    clockCorrectionSeconds,
    correctionReason,
  };
}

function normalizePublicLocation(
  input: PublicLocation = { visibility: 'none' },
): PublicLocation {
  if (
    !input ||
    !['none', 'place', 'approximate', 'exact'].includes(input.visibility)
  )
    invalid('Invalid public location choice.');
  if (input.visibility === 'none') return { visibility: 'none' };
  const place = placeReference(input.place);
  if (input.visibility === 'place') {
    if (!place)
      invalid('A public named place requires a revisioned place reference.');
    return { visibility: 'place', place };
  }
  const point = coordinates(input.point);
  if (!point) invalid('An explicitly selected public point is required.');
  if (input.visibility === 'approximate') {
    if (!Number.isFinite(input.radiusMeters) || input.radiusMeters <= 0)
      invalid('Approximate locations require a positive radius.');
    return {
      visibility: 'approximate',
      place,
      point,
      radiusMeters: input.radiusMeters,
    };
  }
  return { visibility: 'exact', place, point };
}

export function normalizeMetadata(input: PhotoMetadataInput): PhotoMetadata {
  const sourceId = input.sourceId ?? null;
  if (sourceId !== null) validId(sourceId);
  const rights = input.rights ?? {};
  return {
    sourceId,
    title: text(input.title, 300),
    caption: text(input.caption, 10000),
    altText: text(input.altText, 2000),
    keywords: textList(input.keywords, 64, 120),
    rights: {
      creators: textList(rights.creators, 16, 200),
      copyrightOwners: textList(rights.copyrightOwners, 16, 200),
      copyrightNotice: text(rights.copyrightNotice, 1000),
      creditLine: text(rights.creditLine, 1000),
      usageTerms: text(rights.usageTerms, 4000),
      rightsUrl: url(rights.rightsUrl),
      publicContactUrl: url(rights.publicContactUrl, true),
    },
    capture: normalizeCapture(input.capture),
    privateLocation: {
      place: placeReference(input.privateLocation?.place),
      point: coordinates(input.privateLocation?.point),
    },
    publicLocation: normalizePublicLocation(input.publicLocation),
  };
}

function flatten(metadata: PhotoMetadata) {
  const { rights, capture, privateLocation, publicLocation } = metadata;
  const place =
    publicLocation.visibility === 'none' ? null : publicLocation.place;
  const point =
    publicLocation.visibility === 'exact' ||
    publicLocation.visibility === 'approximate'
      ? publicLocation.point
      : null;
  return {
    source_id: metadata.sourceId,
    title: metadata.title,
    caption: metadata.caption,
    alt_text: metadata.altText,
    keywords_json: JSON.stringify(metadata.keywords),
    creators_json: JSON.stringify(rights.creators),
    copyright_owners_json: JSON.stringify(rights.copyrightOwners),
    copyright_notice: rights.copyrightNotice,
    credit_line: rights.creditLine,
    usage_terms: rights.usageTerms,
    rights_url: rights.rightsUrl,
    public_contact_url: rights.publicContactUrl,
    capture_precision: capture.precision,
    capture_date: capture.localDate,
    capture_time: capture.localTime,
    capture_subseconds: capture.subseconds,
    offset_minutes: capture.offsetMinutes,
    time_zone: capture.timeZone,
    offset_source: capture.offsetSource,
    capture_utc: capture.utcInstant,
    clock_correction_seconds: capture.clockCorrectionSeconds,
    correction_reason: capture.correctionReason,
    private_place_id: privateLocation.place?.placeId ?? null,
    private_place_revision: privateLocation.place?.revision ?? null,
    private_latitude: privateLocation.point?.latitude ?? null,
    private_longitude: privateLocation.point?.longitude ?? null,
    public_visibility: publicLocation.visibility,
    public_place_id: place?.placeId ?? null,
    public_place_revision: place?.revision ?? null,
    public_latitude: point?.latitude ?? null,
    public_longitude: point?.longitude ?? null,
    public_radius_meters:
      publicLocation.visibility === 'approximate'
        ? publicLocation.radiusMeters
        : null,
  };
}
type MetadataRow = ReturnType<typeof flatten>;
const COLUMNS = Object.keys(
  flatten(normalizeMetadata({})),
) as (keyof MetadataRow)[];
// An explicit allowlist ensures future storage columns stay private by default.
const PUBLIC_COLUMNS = [
  'title',
  'caption',
  'alt_text',
  'keywords_json',
  'creators_json',
  'copyright_owners_json',
  'copyright_notice',
  'credit_line',
  'usage_terms',
  'rights_url',
  'public_contact_url',
  'capture_precision',
  'capture_date',
  'capture_time',
  'capture_subseconds',
  'offset_minutes',
  'time_zone',
  'capture_utc',
  'public_visibility',
  'public_place_id',
  'public_place_revision',
  'public_latitude',
  'public_longitude',
  'public_radius_meters',
] as const satisfies readonly (keyof MetadataRow)[];
type PublicMetadataRow = Pick<MetadataRow, (typeof PUBLIC_COLUMNS)[number]>;

export function metadataJsonSql(alias: string): string {
  return `CASE WHEN ${alias}.photo_id IS NULL THEN NULL ELSE json_object(${COLUMNS.map((column) => `'${column}', ${alias}.${column}`).join(',')}) END`;
}

function inflatePublic(row: PublicMetadataRow): PublicPhotoMetadata {
  const place =
    row.public_place_id === null
      ? null
      : { placeId: row.public_place_id, revision: row.public_place_revision! };
  const point = {
    latitude: row.public_latitude!,
    longitude: row.public_longitude!,
  };
  let publicLocation: PublicLocation;
  switch (row.public_visibility) {
    case 'none':
      publicLocation = { visibility: 'none' };
      break;
    case 'place':
      publicLocation = { visibility: 'place', place: place! };
      break;
    case 'approximate':
      publicLocation = {
        visibility: 'approximate',
        place,
        point,
        radiusMeters: row.public_radius_meters!,
      };
      break;
    case 'exact':
      publicLocation = { visibility: 'exact', place, point };
      break;
  }
  return {
    title: row.title,
    caption: row.caption,
    altText: row.alt_text,
    keywords: JSON.parse(row.keywords_json),
    rights: {
      creators: JSON.parse(row.creators_json),
      copyrightOwners: JSON.parse(row.copyright_owners_json),
      copyrightNotice: row.copyright_notice,
      creditLine: row.credit_line,
      usageTerms: row.usage_terms,
      rightsUrl: row.rights_url,
      publicContactUrl: row.public_contact_url,
    },
    capture: {
      precision: row.capture_precision,
      localDate: row.capture_date,
      localTime: row.capture_time,
      subseconds: row.capture_subseconds,
      offsetMinutes: row.offset_minutes,
      timeZone: row.time_zone,
      utcInstant: row.capture_utc,
    },
    publicLocation,
  };
}

export function metadataStatement(
  db: CatalogueDatabase,
  photoId: string,
  revision: number,
  input?: PhotoMetadataInput,
) {
  if (input === undefined)
    return db
      .prepare(
        'UPDATE photo_metadata_drafts SET photo_revision = ? WHERE photo_id = ?',
      )
      .bind(revision, photoId);
  const fields = flatten(normalizeMetadata(input));
  // Reusing an already selected place keeps its frozen description even after
  // that place's draft has changed. A new selection must name a current version.
  const frozen = (
    visibility: 'private' | 'public',
  ) => `CASE WHEN :${visibility}_id IS NULL THEN NULL ELSE COALESCE(
    (SELECT ${visibility}_place_json FROM photo_metadata_drafts WHERE photo_id = :photo
      AND ${visibility}_place_id = :${visibility}_id AND ${visibility}_place_revision = :${visibility}_revision),
    ${placeChainSql(`:${visibility}_id`, `:${visibility}_revision`)}
  ) END`;
  // D1 bindings are positional; numbered placeholders also let repeated SQL
  // expressions refer to a value without creating additional parameters.
  const parameters = [
    photoId,
    revision,
    ...COLUMNS.map((column) => fields[column]),
  ];
  const parameter = (name: keyof MetadataRow) =>
    `?${COLUMNS.indexOf(name) + 3}`;
  const locationSql = (kind: 'private' | 'public') =>
    frozen(kind)
      .replaceAll(':photo', '?1')
      .replaceAll(`:${kind}_id`, parameter(`${kind}_place_id`))
      .replaceAll(`:${kind}_revision`, parameter(`${kind}_place_revision`));
  return db
    .prepare(
      `INSERT INTO photo_metadata_drafts (photo_id, photo_revision, ${COLUMNS.join(',')}, private_place_json, public_place_json)
      VALUES (?1, ?2, ${COLUMNS.map((_, i) => `?${i + 3}`).join(',')}, ${locationSql('private')}, ${locationSql('public')})
      ON CONFLICT(photo_id) DO UPDATE SET photo_revision=excluded.photo_revision,
        ${COLUMNS.map((column) => `${column}=excluded.${column}`).join(',')},
        private_place_json=excluded.private_place_json, public_place_json=excluded.public_place_json`,
    )
    .bind(...parameters);
}

export async function readPhotoMetadata(
  db: CatalogueDatabase,
  photoId: string,
  revision: number,
): Promise<PhotoMetadata | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS.join(',')} FROM photo_metadata_states WHERE photo_id = ? AND photo_revision = ?`,
    )
    .bind(photoId, revision)
    .first<MetadataRow>();
  if (!row) return null;
  return inflatePhotoMetadata(row);
}

export function photoMetadataFromJson(
  value: string | null,
): PhotoMetadata | null {
  return value === null
    ? null
    : inflatePhotoMetadata(JSON.parse(value) as MetadataRow);
}

function inflatePhotoMetadata(row: MetadataRow): PhotoMetadata {
  const result = inflatePublic(row);
  return {
    ...result,
    sourceId: row.source_id,
    capture: {
      ...result.capture,
      offsetSource: row.offset_source,
      clockCorrectionSeconds: row.clock_correction_seconds,
      correctionReason: row.correction_reason,
    },
    privateLocation: {
      place:
        row.private_place_id === null
          ? null
          : {
              placeId: row.private_place_id,
              revision: row.private_place_revision!,
            },
      point:
        row.private_latitude === null
          ? null
          : {
              latitude: row.private_latitude,
              longitude: row.private_longitude!,
            },
    },
  };
}

export async function readPublishedPhotoMetadata(
  db: CatalogueDatabase,
  photoId: string,
): Promise<PublicPhotoMetadata | null> {
  validId(photoId);
  // No source evidence, private location, or decision/provenance columns enter this query.
  const row = await db
    .prepare(
      `SELECT ${PUBLIC_COLUMNS.map((column) => `m.${column}`).join(',')}
    FROM published_photos p JOIN photo_metadata_public m ON m.photo_id = p.photo_id AND m.photo_revision = p.photo_revision
    WHERE p.photo_id = ?`,
    )
    .bind(photoId)
    .first<PublicMetadataRow>();
  return row ? inflatePublic(row) : null;
}

// Resolve the selected place without consulting mutable place drafts. Only the
// explicitly approved public location can enter this public read.
export async function readPublishedPhotoPlace(
  db: CatalogueDatabase,
  photoId: string,
): Promise<PlaceDescription[]> {
  validId(photoId);
  const row = await db
    .prepare(
      `SELECT m.public_place_json FROM published_photos p
    JOIN photo_metadata_public m ON m.photo_id=p.photo_id AND m.photo_revision=p.photo_revision
    WHERE p.photo_id=?`,
    )
    .bind(photoId)
    .first<{ public_place_json: string | null }>();
  return row?.public_place_json ? JSON.parse(row.public_place_json) : [];
}

export async function readDraftPhotoPlace(
  db: CatalogueDatabase,
  photoId: string,
  location: 'private' | 'public',
): Promise<PlaceDescription[]> {
  validId(photoId);
  if (location !== 'private' && location !== 'public')
    invalid('Invalid location choice.');
  const row = await db
    .prepare(
      `SELECT ${location}_place_json AS place_json FROM photo_metadata_drafts WHERE photo_id=?`,
    )
    .bind(photoId)
    .first<{ place_json: string | null }>();
  return row?.place_json ? JSON.parse(row.place_json) : [];
}
