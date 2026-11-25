export const INPUT_LIMITS = Object.freeze({
  bytes: 40 * 1024 * 1024,
  pixels: 60_000_000,
  side: 20_000,
  headerBytes: 512 * 1024,
});

export interface ExifCapture {
  dateTime: string | null;
  subseconds: string | null;
  offset: string | null;
}

const captureTags = new Map<number, keyof ExifCapture>([
  [0x9003, 'dateTime'],
  [0x9291, 'subseconds'],
  [0x9011, 'offset'],
]);

function directoryCount(view: DataView, offset: number, little: boolean) {
  if (offset < 8 || offset + 2 > view.byteLength) return null;
  const count = view.getUint16(offset, little);
  return offset + 2 + count * 12 + 4 <= view.byteLength ? count : null;
}

function readCapture(view: DataView, offset: number, little: boolean) {
  const count = directoryCount(view, offset, little);
  if (count === null) return null;
  const capture: ExifCapture = {
    dateTime: null,
    subseconds: null,
    offset: null,
  };
  const seen = new Set<keyof ExifCapture>();
  for (let index = 0; index < count; index++) {
    const entry = offset + 2 + index * 12;
    const field = captureTags.get(view.getUint16(entry, little));
    if (!field) continue;
    if (seen.has(field)) {
      capture[field] = null;
      continue;
    }
    seen.add(field);
    if (view.getUint16(entry + 2, little) !== 2) continue;
    const length = view.getUint32(entry + 4, little);
    if (length < 2 || length > 64) continue;
    const start = length <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
    if (start < 8 || start + length > view.byteLength) continue;
    const bytes = new Uint8Array(view.buffer, view.byteOffset + start, length);
    const text = bytes.subarray(0, length - 1);
    if (
      bytes[length - 1] !== 0 ||
      !text.every((byte) => byte >= 32 && byte < 127)
    )
      continue;
    const value = String.fromCharCode(...text);
    capture[field] = value.trim() ? value : null;
  }
  return Object.values(capture).some((value) => value !== null)
    ? capture
    : null;
}

function readGps(
  view: DataView,
  offset: number,
  little: boolean,
): Coordinates | null {
  const count = directoryCount(view, offset, little);
  if (count === null) return null;
  const fields = new Map<number, number>();
  for (let index = 0; index < count; index++) {
    const entry = offset + 2 + index * 12;
    const tag = view.getUint16(entry, little);
    if (tag < 1 || tag > 4) continue;
    if (fields.has(tag)) return null;
    fields.set(tag, entry);
  }
  function coordinate(
    refTag: number,
    positive: string,
    negative: string,
    max: number,
  ) {
    const ref = fields.get(refTag);
    const value = fields.get(refTag + 1);
    if (
      ref === undefined ||
      value === undefined ||
      view.getUint16(ref + 2, little) !== 2 ||
      view.getUint32(ref + 4, little) !== 2 ||
      view.getUint16(value + 2, little) !== 5 ||
      view.getUint32(value + 4, little) !== 3 ||
      view.getUint8(ref + 9) !== 0
    )
      return null;
    const direction = String.fromCharCode(view.getUint8(ref + 8));
    if (direction !== positive && direction !== negative) return null;
    const start = view.getUint32(value + 8, little);
    if (start < 8 || start + 24 > view.byteLength) return null;
    const [degree, minute, second] = [0, 8, 16].map(
      (index) =>
        view.getUint32(start + index, little) /
        view.getUint32(start + index + 4, little),
    );
    const decimal = degree + minute / 60 + second / 3600;
    if (
      !Number.isFinite(decimal) ||
      decimal > max ||
      minute >= 60 ||
      second >= 60
    )
      return null;
    return direction === negative ? -decimal : decimal;
  }
  const latitude = coordinate(1, 'N', 'S', 90);
  const longitude = coordinate(3, 'E', 'W', 180);
  return latitude === null || longitude === null
    ? null
    : { latitude, longitude };
}

function readExif(view: DataView) {
  const order = view.getUint16(0);
  const little = order === 0x4949;
  if ((!little && order !== 0x4d4d) || view.getUint16(2, little) !== 42)
    throw new Error('Malformed EXIF header');
  const offset = view.getUint32(4, little);
  if (offset < 8 || offset + 2 > view.byteLength)
    throw new Error('Malformed EXIF directory');
  const count = directoryCount(view, offset, little);
  if (count === null) throw new Error('Truncated EXIF directory');
  let orientation: number | undefined;
  let captureOffset: number | undefined;
  let gpsOffset: number | undefined;
  for (let index = 0; index < count; index++) {
    const entry = offset + 2 + index * 12;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const length = view.getUint32(entry + 4, little);
    if (tag === 0x0112) {
      if (type !== 3 || length !== 1)
        throw new Error('Malformed EXIF orientation');
      orientation = view.getUint16(entry + 8, little);
      if (orientation < 1 || orientation > 8)
        throw new Error('Invalid EXIF orientation');
    }
    if (tag === 0x8769)
      captureOffset =
        captureOffset === undefined && type === 4 && length === 1
          ? view.getUint32(entry + 8, little)
          : 0;
    if (tag === 0x8825)
      gpsOffset =
        gpsOffset === undefined && type === 4 && length === 1
          ? view.getUint32(entry + 8, little)
          : 0;
  }
  return {
    orientation,
    capture: readCapture(view, captureOffset ?? 0, little),
    gps: readGps(view, gpsOffset ?? 0, little),
  };
}

// Read only a bounded header before invoking the browser's allocating decoder.
// This is a resource guard, not a replacement for decoding/validating the file.
export async function inspectJpeg(blob: Blob) {
  if (!(blob instanceof Blob) || blob.size > INPUT_LIMITS.bytes)
    throw new Error('JPEG exceeds 40 MiB input limit');
  const bytes = new Uint8Array(
    await blob.slice(0, INPUT_LIMITS.headerBytes).arrayBuffer(),
  );
  if (bytes[0] !== 255 || bytes[1] !== 216)
    throw new Error('Expected JPEG signature');
  let at = 2;
  let orientation = 1;
  let capture: ExifCapture | null = null;
  let captureRead = false;
  let gps: Coordinates | null = null;
  let gpsRead = false;
  while (at < bytes.length) {
    if (bytes[at++] !== 255) throw new Error('Malformed JPEG marker');
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if ([0, 216, 217, 218].includes(marker))
      throw new Error('Missing JPEG frame');
    if (at + 2 > bytes.length) break;
    const length = bytes[at] * 256 + bytes[at + 1];
    if (length < 2 || at + length > bytes.length)
      throw new Error('Truncated or excessive JPEG header');
    if (
      marker === 225 &&
      length >= 16 &&
      String.fromCharCode(...bytes.subarray(at + 2, at + 8)) === 'Exif\0\0'
    ) {
      const tiff = at + 8,
        end = at + length;
      const exif = readExif(new DataView(bytes.buffer, tiff, end - tiff));
      orientation = exif.orientation ?? orientation;
      if (exif.capture) {
        capture = captureRead ? null : exif.capture;
        captureRead = true;
      }
      if (exif.gps) {
        gps = gpsRead ? null : exif.gps;
        gpsRead = true;
      }
    }
    const isFrame =
      marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker);
    if (isFrame) {
      if (![192, 194].includes(marker) || length < 8)
        throw new Error('Only baseline/progressive JPEG supported');
      const precision = bytes[at + 2],
        height = bytes[at + 3] * 256 + bytes[at + 4],
        width = bytes[at + 5] * 256 + bytes[at + 6],
        channels = bytes[at + 7];
      if (
        precision !== 8 ||
        ![1, 3].includes(channels) ||
        length !== 8 + channels * 3
      )
        throw new Error('Unsupported JPEG frame layout');
      if (
        !width ||
        !height ||
        width > INPUT_LIMITS.side ||
        height > INPUT_LIMITS.side ||
        width * height > INPUT_LIMITS.pixels
      )
        throw new Error('JPEG exceeds dimension/pixel limits');
      return { width, height, channels, orientation, capture, gps };
    }
    at += length;
  }
  throw new Error('JPEG frame not found within header limit');
}
import type { Coordinates } from '../catalogue/validation.ts';
