import { useEffect, useRef, useState } from 'react';
import {
  captureDatesDisagree,
  type EmbeddedDate,
} from '../../photo-review/embedded-dates.ts';
import { inspectEmbeddedDates } from '../../photo-review/jpeg-date-export.ts';

export default function EmbeddedCaptureDates({
  file,
  disabled,
  onUse,
  onProcessing,
}: {
  file: File;
  disabled: boolean;
  onUse: (date: EmbeddedDate) => void;
  onProcessing: (message: string) => void;
}) {
  const pending = useRef<AbortController | null>(null);
  const [reading, setReading] = useState(false);
  const [dates, setDates] = useState<EmbeddedDate[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (disabled && pending.current) {
      pending.current.abort();
      pending.current = null;
      setReading(false);
    }
  }, [disabled]);

  async function readDates() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setReading(true);
    setError('');
    onProcessing('Started comparing embedded JPEG dates.');
    try {
      const result = await inspectEmbeddedDates(file, controller.signal);
      if (controller.signal.aborted) return;
      setDates(result);
      onProcessing(
        `Read ${result.length} embedded date ${result.length === 1 ? 'record' : 'records'}${captureDatesDisagree(result) ? ' and found conflicting capture dates' : ''}.`,
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      const reason =
        cause instanceof Error
          ? cause.message
          : 'Embedded dates could not be read.';
      setError(reason);
      onProcessing(`Embedded date comparison failed. ${reason}`);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (!controller.signal.aborted) setReading(false);
      }
    }
  }

  function list(entries: EmbeddedDate[]) {
    return (
      <ul className="embedded-date-list">
        {entries.map((date) => (
          <li key={date.tag}>
            <span>
              <strong>{date.label}</strong>
              <br />
              {date.raw}
            </span>
            {date.value ? (
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                onClick={() => onUse(date)}
              >
                Use {date.label}
              </button>
            ) : (
              <span>Unsupported value</span>
            )}
          </li>
        ))}
      </ul>
    );
  }

  if (dates) {
    const captures = dates.filter((date) => date.purpose === 'capture');
    const otherDates = dates.filter((date) => date.purpose === 'other');
    return (
      <section className="capture-details" aria-label="Embedded JPEG dates">
        <h3>Embedded JPEG dates</h3>
        {!dates.length && <p>No supported embedded date fields were found.</p>}
        {captureDatesDisagree(dates) && (
          <p className="capture-error">
            The embedded capture dates disagree. Choose the value you want to
            use.
          </p>
        )}
        {captures.length > 0 && list(captures)}
        {otherDates.length > 0 && (
          <details>
            <summary>Other embedded dates</summary>
            {list(otherDates)}
          </details>
        )}
      </section>
    );
  }

  return (
    <div className="capture-details">
      <button
        type="button"
        className="text-button"
        disabled={reading || disabled}
        onClick={() => void readDates()}
      >
        {reading ? 'Reading embedded dates…' : 'Compare embedded dates'}
      </button>
      {error && (
        <p role="alert" className="capture-error">
          {error}
        </p>
      )}
    </div>
  );
}
