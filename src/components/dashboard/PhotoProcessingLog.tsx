import type { ProcessingEvent } from '../../photo-review/processing-log.ts';

const eventTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'medium',
});

export default function PhotoProcessingLog({
  events,
}: {
  events: readonly ProcessingEvent[];
}) {
  return (
    <details className="capture-details photo-processing-log">
      <summary>Processing log</summary>
      <p>History for this browser tab.</p>
      {events.length ? (
        <ol>
          {events.map((event, index) => (
            <li key={`${event.time}-${index}`}>
              <time dateTime={new Date(event.time).toISOString()}>
                {eventTime.format(event.time)}
              </time>
              <span>{event.message}</span>
              {event.dates?.length ? (
                <details className="processing-fields">
                  <summary>{event.dates.length} verified date fields</summary>
                  <dl>
                    {event.dates.map(({ tag, before, after }) => (
                      <div key={tag}>
                        <dt>{tag}</dt>
                        <dd>
                          Source {before ?? 'absent'} · Corrected{' '}
                          {after ?? 'absent'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p>Processing events will appear here when you work on this photo.</p>
      )}
    </details>
  );
}
