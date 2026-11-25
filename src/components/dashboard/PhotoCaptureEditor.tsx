import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaptureEdit, CaptureTime } from '../../catalogue/metadata.ts';
import type { ExifCapture } from '../../photo-review/jpeg-input.ts';
import { correctedJpeg } from '../../photo-review/jpeg-date-export.ts';
import { formatOffset as offsetText } from '../../photo-review/jpeg-date-tags.ts';
import { offsetsAtLocalTime } from '../../photo-review/time-zone.ts';
import type { DateFieldResult } from '../../photo-review/processing-log.ts';
import type { EmbeddedDate } from '../../photo-review/embedded-dates.ts';
import EmbeddedCaptureDates from './EmbeddedCaptureDates.tsx';

export function OriginalCapture({ capture }: { capture: ExifCapture | null }) {
  return capture && Object.values(capture).some((value) => value !== null) ? (
    <dl>
      <dt>Original capture time</dt>
      <dd>{capture.dateTime ?? 'Unavailable'}</dd>
      <dt>Fractional seconds</dt>
      <dd>{capture.subseconds ?? 'Unavailable'}</dd>
      <dt>UTC offset</dt>
      <dd>{capture.offset ?? 'Unavailable'}</dd>
    </dl>
  ) : (
    <p>No readable EXIF capture time fields.</p>
  );
}

const offsetPattern = /^[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00)$/;
const timeZones = ['UTC', ...Intl.supportedValuesOf('timeZone')];
function parseOffset(value: string) {
  if (!value) return null;
  if (!offsetPattern.test(value))
    throw new Error('Enter a UTC offset from -14:00 to +14:00 as ±HH:MM.');
  return (
    (Number(value.slice(1, 3)) * 60 + Number(value.slice(4))) *
    (value[0] === '-' ? -1 : 1)
  );
}

export default function PhotoCaptureEditor({
  title,
  capture,
  original,
  importsOriginal,
  gpsZone,
  file,
  onSave,
  onClose,
  onProcessing,
}: {
  title: string;
  capture: CaptureTime;
  original: ExifCapture | null;
  importsOriginal: boolean;
  gpsZone: string | null;
  file?: File;
  onSave: (capture: CaptureEdit, checkSource: boolean) => Promise<CaptureTime>;
  onClose: () => void;
  onProcessing: (message: string, dates?: DateFieldResult[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const exifTime =
    /^(\d{4}):(\d{2}):(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(
      original?.dateTime?.trim() ?? '',
    );
  const sourceDate = exifTime
    ? `${exifTime[1]}-${exifTime[2]}-${exifTime[3]}`
    : '';
  const parsedDate = new Date(`${sourceDate}T00:00:00Z`);
  const exifDate =
    !sourceDate.startsWith('0000') &&
    Number.isFinite(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === sourceDate
      ? sourceDate
      : null;
  const exifClock = exifDate && exifTime ? exifTime[4] : null;
  const exifOffset = original?.offset?.trim() ?? '';
  const knownExifOffset =
    offsetPattern.test(exifOffset) && exifOffset !== '-00:00';
  const fraction = original?.subseconds?.trim() ?? '';
  const exifFraction = /^\d{1,9}$/.test(fraction) ? fraction : '';
  const prefill =
    importsOriginal &&
    capture.precision === 'unknown' &&
    Boolean(exifDate && exifClock);
  const [precision, setPrecision] = useState(
    prefill ? 'second' : capture.precision,
  );
  const [date, setDate] = useState(
    prefill ? exifDate! : (capture.localDate ?? ''),
  );
  const [time, setTime] = useState(
    prefill ? exifClock! : (capture.localTime ?? ''),
  );
  const [subseconds, setSubseconds] = useState(
    prefill ? exifFraction : (capture.subseconds ?? ''),
  );
  const [offset, setOffset] = useState(
    prefill && knownExifOffset ? exifOffset : offsetText(capture.offsetMinutes),
  );
  const [timeZone, setTimeZone] = useState(capture.timeZone ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmedCapture, setConfirmedCapture] = useState<CaptureTime | null>(
    null,
  );
  const [downloadUrl, setDownloadUrl] = useState('');
  const [usedEmbeddedDate, setUsedEmbeddedDate] = useState(false);
  const editingDisabled = saving || confirmedCapture !== null;
  const gpsMismatch = useMemo(() => {
    if (!gpsZone || !exifDate || !exifClock || !knownExifOffset) return false;
    try {
      const offsets = offsetsAtLocalTime(exifDate, exifClock, gpsZone);
      return !offsets.includes(parseOffset(exifOffset)!);
    } catch {
      return false;
    }
  }, [gpsZone, exifDate, exifClock, exifOffset, knownExifOffset]);
  const zoneCheck = useMemo(() => {
    if (
      precision !== 'second' ||
      !date ||
      time.length !== 8 ||
      !timeZone.trim()
    )
      return null;
    try {
      const offsets = offsetsAtLocalTime(date, time, timeZone.trim());
      return {
        offsets,
        message: offsets.length
          ? null
          : 'That local time did not occur in this timezone.',
      };
    } catch (cause) {
      return {
        offsets: [],
        message:
          cause instanceof Error
            ? cause.message
            : 'Timezone could not be resolved.',
      };
    }
  }, [date, time, timeZone, precision]);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (downloadUrl) return () => URL.revokeObjectURL(downloadUrl);
  }, [downloadUrl]);

  function close() {
    dialog.current?.close();
    onClose();
  }

  function useExif() {
    if (!exifDate || !exifClock) return;
    setPrecision('second');
    setDate(exifDate);
    setTime(exifClock);
    setSubseconds(exifFraction);
    setOffset(knownExifOffset ? exifOffset : '');
    setUsedEmbeddedDate(false);
    setError('');
    onProcessing('Used the original EXIF values to fill the capture editor.');
  }

  function useEmbeddedDate({ label, value }: EmbeddedDate) {
    if (!value) return;
    setPrecision(value.time ? 'second' : 'date');
    setDate(value.date);
    setTime(value.time ?? '');
    setSubseconds(value.fraction ?? '');
    setOffset(offsetText(value.offset));
    setUsedEmbeddedDate(true);
    setError('');
    onProcessing(`Used ${label} to fill the capture editor.`);
  }

  async function prepareCopy(saved: CaptureTime) {
    if (!file) return;
    setSaving(true);
    setError('');
    onProcessing(
      'Started preparing a corrected JPEG from saved capture metadata.',
    );
    try {
      const { image, dates } = await correctedJpeg(file, saved, onProcessing);
      setDownloadUrl(URL.createObjectURL(image));
      onProcessing(
        'Read back and verified the corrected JPEG date fields.',
        dates,
      );
    } catch (cause) {
      const reason =
        cause instanceof Error
          ? cause.message
          : 'The corrected JPEG could not be prepared.';
      setError(`Draft saved. ${reason}`);
      onProcessing(`Corrected JPEG export failed. ${reason}`);
    } finally {
      setSaving(false);
    }
  }

  async function save(exportCopy: boolean) {
    if (saving) return;
    setError('');
    setSaving(true);
    try {
      const saved = await onSave(
        {
          precision,
          localDate: precision === 'unknown' ? null : date,
          localTime: precision === 'second' ? time : null,
          subseconds: precision === 'second' ? subseconds || null : null,
          offsetMinutes:
            precision === 'second' ? parseOffset(offset.trim()) : null,
          timeZone: precision === 'unknown' ? null : timeZone.trim() || null,
        },
        exportCopy || usedEmbeddedDate,
      );
      if (exportCopy) {
        setConfirmedCapture(saved);
        await prepareCopy(saved);
      } else close();
    } catch (cause) {
      const reason =
        cause instanceof Error
          ? cause.message
          : 'Capture metadata could not be saved.';
      setError(reason);
      onProcessing(`Capture save could not be confirmed. ${reason}`);
      setSaving(false);
    }
  }

  return (
    <dialog
      className="capture-editor"
      ref={dialog}
      aria-labelledby="capture-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const submitter = (event.nativeEvent as SubmitEvent).submitter;
          void save(submitter?.getAttribute('value') === 'export');
        }}
      >
        <h2 id="capture-editor-title">Edit capture metadata</h2>
        <p>{title}</p>
        {original && (
          <section className="capture-details" aria-label="Original EXIF">
            <h3>Original EXIF</h3>
            <OriginalCapture capture={original} />
            {exifDate && exifClock && (
              <button
                type="button"
                className="text-button"
                disabled={editingDisabled}
                onClick={useExif}
              >
                Use EXIF values
              </button>
            )}
          </section>
        )}
        {file && (
          <EmbeddedCaptureDates
            file={file}
            disabled={editingDisabled}
            onUse={useEmbeddedDate}
            onProcessing={onProcessing}
          />
        )}
        <fieldset disabled={editingDisabled}>
          <legend>Draft capture values</legend>
          <label>
            Precision
            <select
              value={precision}
              onChange={(event) =>
                setPrecision(event.target.value as CaptureTime['precision'])
              }
            >
              <option value="unknown">Unknown</option>
              <option value="date">Date only</option>
              <option value="second">Date and time</option>
            </select>
          </label>
          {precision !== 'unknown' && (
            <label>
              Capture date
              <input
                type="date"
                min="0001-01-01"
                max="9999-12-31"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </label>
          )}
          {precision === 'second' && (
            <>
              <label>
                Local time
                <input
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  placeholder="HH:MM:SS"
                  maxLength={8}
                  required
                />
              </label>
              <label>
                Fractional seconds (optional)
                <input
                  value={subseconds}
                  onChange={(event) => setSubseconds(event.target.value)}
                  inputMode="numeric"
                  maxLength={9}
                />
              </label>
              <label>
                UTC offset (optional)
                <input
                  value={offset}
                  onChange={(event) => setOffset(event.target.value)}
                  placeholder="-05:00"
                  maxLength={6}
                />
              </label>
            </>
          )}
          {precision !== 'unknown' && (
            <label>
              Timezone (optional)
              <input
                value={timeZone}
                list="capture-time-zones"
                onChange={(event) => setTimeZone(event.target.value)}
                placeholder="America/Toronto"
                maxLength={100}
              />
              <datalist id="capture-time-zones">
                {timeZones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </label>
          )}
        </fieldset>
        {gpsZone && (
          <div className="capture-timezone-note">
            <p>
              GPS suggests {gpsZone}. Confirm this against the camera setting.
            </p>
            {gpsMismatch && (
              <p className="capture-error">
                The original EXIF offset does not match the GPS-suggested
                timezone at the original capture time.
              </p>
            )}
            {precision !== 'unknown' && (
              <button
                className="text-button"
                type="button"
                disabled={editingDisabled}
                onClick={() => {
                  setTimeZone(gpsZone);
                  onProcessing(
                    `Selected the GPS-suggested timezone ${gpsZone}.`,
                  );
                }}
              >
                Use GPS-suggested timezone
              </button>
            )}
          </div>
        )}
        {zoneCheck && (
          <div className="capture-timezone-note">
            {zoneCheck.message ? (
              <p className="capture-error">{zoneCheck.message}</p>
            ) : (
              <>
                <p>
                  {zoneCheck.offsets.length > 1
                    ? 'This local time occurred twice. Choose the offset the camera used.'
                    : offset.trim() &&
                        (!offsetPattern.test(offset.trim()) ||
                          !zoneCheck.offsets.includes(
                            parseOffset(offset.trim())!,
                          ))
                      ? 'The entered offset differs from the timezone at this date and time.'
                      : `Timezone offset at capture was ${offsetText(zoneCheck.offsets[0])}.`}
                </p>
                {zoneCheck.offsets.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className="text-button"
                    disabled={editingDisabled}
                    onClick={() => setOffset(offsetText(minutes))}
                  >
                    Use {offsetText(minutes)}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        {importsOriginal && (
          <p>
            Saving also records the JPEG filename, its fingerprint, and any
            original capture EXIF in the private catalogue.
          </p>
        )}
        {error && (
          <p role="alert" className="capture-error">
            {error}
          </p>
        )}
        <div className="capture-actions">
          <button
            type="button"
            className="secondary"
            onClick={close}
            disabled={saving}
          >
            {confirmedCapture ? 'Close' : 'Cancel'}
          </button>
          {confirmedCapture ? (
            downloadUrl ? (
              <a
                className="capture-download"
                href={downloadUrl}
                download={`${file!.name.replace(/\.jpe?g$/i, '')}-dates.jpg`}
                onClick={() =>
                  onProcessing('Requested download of the corrected JPEG.')
                }
              >
                Download corrected JPEG
              </a>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={saving}
                onClick={() => void prepareCopy(confirmedCapture)}
              >
                {saving ? 'Preparing JPEG…' : 'Retry corrected JPEG'}
              </button>
            )
          ) : (
            <>
              <button
                type="submit"
                className={
                  file && precision !== 'unknown' ? 'secondary' : 'primary'
                }
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save capture metadata'}
              </button>
              {file && precision !== 'unknown' && (
                <button
                  type="submit"
                  value="export"
                  className="primary"
                  disabled={saving}
                >
                  Save and prepare corrected JPEG
                </button>
              )}
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}
