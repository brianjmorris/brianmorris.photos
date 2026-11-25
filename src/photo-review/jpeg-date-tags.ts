import type { CaptureTime } from '../catalogue/metadata.ts';

export const gpsDateTags = [
  'GPS:GPSDateStamp',
  'GPS:GPSTimeStamp',
  'XMP-exif:GPSDateTime',
] as const;

export function formatOffset(minutes: number | null) {
  if (minutes === null) return '';
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  return `${minutes < 0 ? '-' : '+'}${hours}:${String(absolute % 60).padStart(2, '0')}`;
}

export function jpegDateTags(
  capture: CaptureTime,
  sourceTags: Record<string, unknown>,
) {
  if (!capture.localDate)
    throw new Error('Choose a capture date before exporting.');
  const date = capture.localDate.replaceAll('-', ':');
  const wall = capture.localTime ? `${date} ${capture.localTime}` : '';
  const fraction = capture.subseconds ? `.${capture.subseconds}` : '';
  const offset = formatOffset(capture.offsetMinutes);
  const xmp = wall ? wall + fraction + offset : date;
  // IIM's time fields require an offset. ExifTool would otherwise use the
  // device timezone. Remove stale values where the saved capture has no offset.
  const iptcTime = wall && offset ? capture.localTime + offset : '';
  const tags: Record<string, string> = {
    'EXIF:DateTimeOriginal': wall,
    'EXIF:CreateDate': wall,
    'EXIF:ModifyDate': wall,
    'EXIF:SubSecTimeOriginal': capture.subseconds ?? '',
    'EXIF:SubSecTimeDigitized': capture.subseconds ?? '',
    'EXIF:SubSecTime': capture.subseconds ?? '',
    'EXIF:OffsetTimeOriginal': offset,
    'EXIF:OffsetTimeDigitized': offset,
    'EXIF:OffsetTime': offset,
    'IPTC:DateCreated': date,
    'IPTC:DigitalCreationDate': date,
    'IPTC:TimeCreated': iptcTime,
    'IPTC:DigitalCreationTime': iptcTime,
    'XMP-exif:DateTimeOriginal': xmp,
    'XMP-exif:DateTimeDigitized': xmp,
    'XMP-photoshop:DateCreated': xmp,
    'XMP-xmp:CreateDate': xmp,
    'XMP-xmp:ModifyDate': xmp,
    'XMP-xmp:MetadataDate': xmp,
  };
  const gpsClock =
    capture.utcInstant
      ?.replace('T', ' ')
      .replace(/^(\d{4})-(\d{2})-(\d{2})/, '$1:$2:$3') ?? '';
  if (gpsDateTags[0] in sourceTags || gpsDateTags[1] in sourceTags) {
    tags[gpsDateTags[0]] = gpsClock.slice(0, 10);
    tags[gpsDateTags[1]] = gpsClock.slice(11).replace('Z', '');
  }
  if (gpsDateTags[2] in sourceTags) tags[gpsDateTags[2]] = gpsClock;
  return tags;
}

export function jpegDateReadbackName(tag: string) {
  if (tag === 'EXIF:ModifyDate') return 'IFD0:ModifyDate';
  return tag.replace(/^EXIF:/, 'ExifIFD:');
}
