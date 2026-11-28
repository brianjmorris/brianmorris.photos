interface CaptureValue {
  date: string;
  time: string | null;
  fraction: string | null;
  offset: number | null;
}

export interface EmbeddedDate {
  tag: string;
  label: string;
  purpose: 'capture' | 'other';
  raw: string;
  value: CaptureValue | null;
}

const sources = [
  {
    tag: 'EXIF:DateTimeOriginal',
    key: 'ExifIFD:DateTimeOriginal',
    label: 'EXIF capture',
    purpose: 'capture',
    fraction: 'SubSecTimeOriginal',
    offset: 'OffsetTimeOriginal',
  },
  {
    tag: 'XMP-exif:DateTimeOriginal',
    key: 'XMP-exif:DateTimeOriginal',
    label: 'XMP EXIF capture',
    purpose: 'capture',
  },
  {
    tag: 'XMP-photoshop:DateCreated',
    key: 'XMP-photoshop:DateCreated',
    label: 'XMP Photoshop capture',
    purpose: 'capture',
  },
  {
    tag: 'IPTC:DateCreated',
    key: 'IPTC:DateCreated',
    label: 'IPTC capture',
    purpose: 'capture',
    time: 'IPTC:TimeCreated',
  },
  {
    tag: 'EXIF:CreateDate',
    key: 'ExifIFD:CreateDate',
    label: 'EXIF digitized',
    purpose: 'other',
    fraction: 'SubSecTimeDigitized',
    offset: 'OffsetTimeDigitized',
  },
  {
    tag: 'XMP-exif:DateTimeDigitized',
    key: 'XMP-exif:DateTimeDigitized',
    label: 'XMP EXIF digitized',
    purpose: 'other',
  },
  {
    tag: 'IPTC:DigitalCreationDate',
    key: 'IPTC:DigitalCreationDate',
    label: 'IPTC digitized',
    purpose: 'other',
    time: 'IPTC:DigitalCreationTime',
  },
  {
    tag: 'EXIF:ModifyDate',
    key: 'IFD0:ModifyDate',
    label: 'EXIF modified',
    purpose: 'other',
    fraction: 'SubSecTime',
    offset: 'OffsetTime',
  },
  {
    tag: 'XMP-xmp:CreateDate',
    key: 'XMP-xmp:CreateDate',
    label: 'XMP created',
    purpose: 'other',
  },
  {
    tag: 'XMP-xmp:ModifyDate',
    key: 'XMP-xmp:ModifyDate',
    label: 'XMP modified',
    purpose: 'other',
  },
  {
    tag: 'XMP-xmp:MetadataDate',
    key: 'XMP-xmp:MetadataDate',
    label: 'XMP metadata modified',
    purpose: 'other',
  },
] as const;

export const embeddedDateTags = sources.flatMap((source) => [
  source.tag,
  ...('time' in source ? [source.time] : []),
  ...('fraction' in source
    ? [`EXIF:${source.fraction}`, `EXIF:${source.offset}`]
    : []),
]);

function readText(tags: Record<string, unknown>, key: string) {
  const value = tags[key];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().slice(0, 100)
    : '';
}

function parseDate(
  dateTime: string,
  exifFraction: string,
  exifOffset: string,
): CaptureValue | null {
  const match =
    /^(\d{4})([:-])(\d{2})\2(\d{2})(?:[T ]((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      dateTime,
    );
  if (!match || match[1] === '0000') return null;
  const date = `${match[1]}-${match[3]}-${match[4]}`;
  const midnight = new Date(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== date
  )
    return null;
  if (!match[5] && (exifFraction || exifOffset)) return null;
  const fraction = match[6] ?? (exifFraction || null);
  if (fraction !== null && !/^\d{1,9}$/.test(fraction)) return null;
  const offsetText = match[7] ?? exifOffset;
  let offset: number | null = offsetText === 'Z' ? 0 : null;
  if (offsetText && offsetText !== 'Z' && !/^-00:?00$/.test(offsetText)) {
    const utc = /^([+-])(\d{2}):?([0-5]\d)$/.exec(offsetText);
    if (!utc) return null;
    const minutes = Number(utc[2]) * 60 + Number(utc[3]);
    if (minutes > 840) return null;
    offset = minutes * (utc[1] === '-' ? -1 : 1);
  }
  return { date, time: match[5] ?? null, fraction, offset };
}

export function embeddedDates(tags: Record<string, unknown>): EmbeddedDate[] {
  const dates: EmbeddedDate[] = [];
  for (const source of sources) {
    const date = readText(tags, source.key);
    const time = 'time' in source ? readText(tags, source.time) : '';
    const fraction =
      'fraction' in source ? readText(tags, `ExifIFD:${source.fraction}`) : '';
    const offset =
      'offset' in source ? readText(tags, `ExifIFD:${source.offset}`) : '';
    if (!date && !time && !fraction && !offset) continue;
    const dateTime = time ? `${date} ${time}` : date;
    dates.push({
      tag: source.tag,
      label: source.label,
      purpose: source.purpose,
      raw: [dateTime, fraction && `fraction ${fraction}`, offset]
        .filter(Boolean)
        .join(' · '),
      value: parseDate(dateTime, fraction, offset),
    });
  }
  return dates;
}

function disagree(left: CaptureValue, right: CaptureValue) {
  if (!left.time || !right.time) return left.date !== right.date;
  if (left.offset !== null && right.offset !== null) {
    const leftUtc =
      Date.parse(`${left.date}T${left.time}Z`) - left.offset * 60000;
    const rightUtc =
      Date.parse(`${right.date}T${right.time}Z`) - right.offset * 60000;
    if (leftUtc !== rightUtc) return true;
  } else if (left.date !== right.date || left.time !== right.time) return true;
  return (
    left.fraction !== null &&
    right.fraction !== null &&
    left.fraction.padEnd(9, '0') !== right.fraction.padEnd(9, '0')
  );
}

export function captureDatesDisagree(dates: EmbeddedDate[]) {
  const captures = dates.flatMap(({ purpose, value }) =>
    purpose === 'capture' && value ? [value] : [],
  );
  return captures.some((date, index) =>
    captures.slice(index + 1).some((other) => disagree(date, other)),
  );
}
