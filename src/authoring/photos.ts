import type { CatalogueDatabase } from '../catalogue/d1.ts';
import { normalizeCapture, type CaptureEdit } from '../catalogue/metadata.ts';
import { invalid } from '../catalogue/model.ts';
import { CatalogueRepository } from '../catalogue/repository.ts';
import type { SourceEvidenceInput } from '../catalogue/sources.ts';
import {
  namedTimeZone,
  offsetsAtLocalTime,
} from '../photo-review/time-zone.ts';
import { collectionError } from './collections.ts';

export async function photoApi(
  owner: unknown,
  database: CatalogueDatabase | undefined,
  operation: (repository: CatalogueRepository) => Promise<Response>,
) {
  if (!owner)
    return Response.json({ error: 'Sign-in required.' }, { status: 401 });
  if (!database)
    return Response.json(
      {
        error:
          'Draft storage is temporarily unavailable. Your local batch stays on this device.',
      },
      { status: 503 },
    );
  try {
    return await operation(new CatalogueRepository(database));
  } catch (cause) {
    const error = collectionError(cause);
    return Response.json({ error: error.message }, { status: error.status });
  }
}

function fields(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Supply capture metadata.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !keys.includes(key)))
    invalid('Unexpected capture metadata field.');
  return data;
}

function captureEdit(value: unknown): CaptureEdit {
  const {
    precision,
    localDate,
    localTime,
    subseconds,
    offsetMinutes,
    timeZone,
  } = fields(value, [
    'precision',
    'localDate',
    'localTime',
    'subseconds',
    'offsetMinutes',
    'timeZone',
  ]);
  if (
    (precision !== 'unknown' &&
      precision !== 'date' &&
      precision !== 'second') ||
    !(localDate === null || typeof localDate === 'string') ||
    !(localTime === null || typeof localTime === 'string') ||
    !(subseconds === null || typeof subseconds === 'string') ||
    !(offsetMinutes === null || typeof offsetMinutes === 'number') ||
    !(
      timeZone === null ||
      timeZone === undefined ||
      typeof timeZone === 'string'
    )
  )
    invalid('Supply date, time and offset values for the selected precision.');
  const input = {
    precision,
    localDate,
    localTime,
    subseconds,
    offsetMinutes,
    timeZone: timeZone ?? null,
  } as const;
  normalizeCapture({
    ...input,
    offsetSource: timeZone || offsetMinutes !== null ? 'Owner confirmed' : null,
  });
  if (!timeZone) return input;
  try {
    const zone = namedTimeZone(timeZone);
    if (precision !== 'second') return { ...input, timeZone: zone };
    const offsets = offsetsAtLocalTime(localDate!, localTime!, zone);
    if (!offsets.length)
      invalid('That local time did not occur in the selected timezone.');
    if (offsetMinutes === null && offsets.length > 1)
      invalid(
        'That local time occurred twice. Choose the UTC offset for the photograph.',
      );
    if (offsetMinutes !== null && !offsets.includes(offsetMinutes))
      invalid(
        'The UTC offset does not match the selected timezone at that local time.',
      );
    return {
      ...input,
      timeZone: zone,
      offsetMinutes: offsetMinutes ?? offsets[0],
    };
  } catch (cause) {
    invalid(
      cause instanceof Error
        ? cause.message
        : 'The timezone could not be resolved.',
    );
  }
}

function exifText(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[\x20-\x7e]{1,63}$/.test(value))
    invalid('Invalid original EXIF capture value.');
  return value;
}

function sourceEvidence(value: unknown): SourceEvidenceInput {
  const { sha256, originalFilename, dateTime, subseconds, offset } = fields(
    value,
    ['sha256', 'originalFilename', 'dateTime', 'subseconds', 'offset'],
  );
  if (typeof sha256 !== 'string' || typeof originalFilename !== 'string')
    invalid(
      'Original EXIF requires the selected JPEG’s filename and fingerprint.',
    );
  const captureText = exifText(dateTime);
  const captureSubseconds = exifText(subseconds);
  const captureOffsetText = exifText(offset);
  return {
    sha256,
    originalFilename,
    parser: { name: 'photo-review-exif', version: '1' },
    rawMetadata: {
      DateTimeOriginal: captureText,
      SubSecTimeOriginal: captureSubseconds,
      OffsetTimeOriginal: captureOffsetText,
    },
    captureText,
    captureSubseconds,
    captureOffsetText,
  };
}

export function photoCaptureInput(value: unknown) {
  const { photoId, expectedRevision, capture, original } = fields(value, [
    'photoId',
    'expectedRevision',
    'capture',
    'original',
  ]);
  if (typeof photoId !== 'string' || typeof expectedRevision !== 'number')
    invalid('Supply the saved photograph and its revision.');
  return {
    photoId,
    expectedRevision,
    capture: captureEdit(capture),
    original: original === undefined ? undefined : sourceEvidence(original),
  };
}
