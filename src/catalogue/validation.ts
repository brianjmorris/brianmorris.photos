import { invalid } from './model.ts';

export function validId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id))
    invalid('Invalid record ID.');
}

export function validRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1)
    invalid('An existing positive revision is required.');
}

export function validTime(time: number): void {
  if (!Number.isSafeInteger(time) || time < 0) invalid('Invalid timestamp.');
}

export function text(
  value: string | null | undefined,
  max: number,
): string | null {
  if (value == null) return null;
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    invalid('Invalid text field.');
  return value;
}

export function requiredText(value: string, max: number): string {
  const result = text(value, max);
  if (!result?.trim()) invalid('A nonempty text field is required.');
  return result;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}
export interface PlaceReference {
  placeId: string;
  revision: number;
}

export function coordinates(
  value: Coordinates | null | undefined,
): Coordinates | null {
  if (value == null) return null;
  if (
    !Number.isFinite(value.latitude) ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.latitude) > 90 ||
    Math.abs(value.longitude) > 180
  )
    invalid('Invalid coordinates.');
  return { latitude: value.latitude, longitude: value.longitude };
}

export function placeReference(
  value: PlaceReference | null | undefined,
): PlaceReference | null {
  if (value == null) return null;
  validId(value.placeId);
  validRevision(value.revision);
  return { placeId: value.placeId, revision: value.revision };
}

export function textList(
  value: readonly string[] | undefined,
  limit: number,
  length: number,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit)
    invalid('Too many text values.');
  return Array.from(value, (entry) => requiredText(entry, length));
}
