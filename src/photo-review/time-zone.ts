import { Temporal } from '@js-temporal/polyfill';

export function namedTimeZone(value: string) {
  if (!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/i.test(value))
    throw new Error('Enter a named timezone such as America/Toronto.');
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    throw new Error('Choose a valid named timezone.');
  }
}

// Match the actual local clock against both sides of a transition. A skipped
// time matches neither side, and a repeated time matches both distinct offsets.
export function offsetsAtLocalTime(date: string, time: string, zone: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)
  )
    throw new Error('Enter a valid capture date and time first.');
  let local: Temporal.PlainDateTime;
  try {
    local = Temporal.PlainDateTime.from(`${date}T${time}`, {
      overflow: 'reject',
    });
  } catch {
    throw new Error('Enter a valid capture date and time first.');
  }
  const timeZone = namedTimeZone(zone);
  const offsets = new Set<number>();
  for (const disambiguation of ['earlier', 'later'] as const) {
    const zoned = local.toZonedDateTime(timeZone, { disambiguation });
    if (!zoned.toPlainDateTime().equals(local)) continue;
    const minutes = zoned.offsetNanoseconds / 60_000_000_000;
    if (!Number.isInteger(minutes) || Math.abs(minutes) > 840)
      throw new Error(
        'This historical UTC offset cannot be stored exactly in minutes.',
      );
    offsets.add(minutes);
  }
  return [...offsets];
}
