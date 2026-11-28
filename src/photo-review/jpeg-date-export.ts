import type { CaptureTime } from '../catalogue/metadata.ts';
import type { EmbeddedDate } from './embedded-dates.ts';
import type { DateFieldResult } from './processing-log.ts';

type JpegDateResult =
  { image: Blob; dates: DateFieldResult[] } | { embedded: EmbeddedDate[] };

function processJpegDates(
  file: File,
  capture?: CaptureTime,
  onPhase?: (phase: string) => void,
  signal?: AbortSignal,
): Promise<JpegDateResult> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(
      new URL('./jpeg-date-export.worker.ts', import.meta.url),
      { type: 'module' },
    );
    const timeout = setTimeout(() => {
      stop();
      reject(new Error('JPEG metadata processing timed out. Try again.'));
    }, 90_000);
    function abort() {
      stop();
      reject(signal?.reason);
    }
    function stop() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => {
      stop();
      reject(new Error('The browser could not start the JPEG metadata tool.'));
    };
    worker.onmessage = ({
      data,
    }: MessageEvent<
      { phase: string } | JpegDateResult | { error: string }
    >) => {
      if ('phase' in data) {
        onPhase?.(data.phase);
        return;
      }
      stop();
      if ('error' in data) reject(new Error(data.error));
      else resolve(data);
    };
    worker.postMessage({ file, capture });
  });
}

export async function correctedJpeg(
  file: File,
  capture: CaptureTime,
  onPhase: (phase: string) => void,
) {
  const result = await processJpegDates(file, capture, onPhase);
  if (!('image' in result))
    throw new Error('The corrected JPEG could not be prepared.');
  return result;
}

export async function inspectEmbeddedDates(file: File, signal: AbortSignal) {
  const result = await processJpegDates(file, undefined, undefined, signal);
  if (!('embedded' in result))
    throw new Error('Embedded dates could not be read.');
  return result.embedded;
}
