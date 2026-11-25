import { parseMetadata, writeMetadata } from '@colorhythm/exiftool-wasm';
import type { CaptureTime } from '../catalogue/metadata.ts';
import { jpegDateWasmAsset } from './jpeg-date-asset.ts';
import {
  gpsDateTags,
  jpegDateReadbackName,
  jpegDateTags,
} from './jpeg-date-tags.ts';
import { inspectJpeg } from './jpeg-input.ts';
import type { DateFieldResult } from './processing-log.ts';
import { embeddedDates, embeddedDateTags } from './embedded-dates.ts';

async function wasm() {
  const response = await fetch(`/${jpegDateWasmAsset}`, {
    mode: 'same-origin',
    redirect: 'error',
  });
  if (!response.ok || !response.body)
    throw new Error('The JPEG metadata tool could not be loaded.');
  return new Response(
    response.body.pipeThrough(new DecompressionStream('gzip')),
  );
}

async function readTags(file: File, names: readonly string[]) {
  const result = await parseMetadata<Record<string, unknown>[]>(file, {
    fetch: wasm,
    args: ['-j', '-G1', ...names.map((name) => `-${name}`)],
    transform: JSON.parse,
  });
  if (!result.success || !result.data[0])
    throw new Error('JPEG metadata could not be read.');
  return result.data[0];
}

globalThis.onmessage = async ({
  data,
}: MessageEvent<{ file: File; capture?: CaptureTime }>) => {
  try {
    // Use fixed virtual filenames, independent of the selected file's name.
    const source = new File([data.file], 'source.jpg', { type: 'image/jpeg' });
    await inspectJpeg(source);
    const dateTagNames = data.capture
      ? [...Object.keys(jpegDateTags(data.capture, {})), ...gpsDateTags]
      : embeddedDateTags;
    const existing = await readTags(source, ['FileType', ...dateTagNames]);
    if (existing['File:FileType'] !== 'JPEG')
      throw new Error('Choose a JPEG source.');
    if (!data.capture) {
      globalThis.postMessage({ embedded: embeddedDates(existing) });
      return;
    }
    const tags = jpegDateTags(data.capture, existing);
    globalThis.postMessage({
      phase: 'Read the source JPEG’s embedded date fields.',
    });
    const result = await writeMetadata(source, tags, { fetch: wasm });
    if (!result.success)
      throw new Error('The JPEG metadata could not be written.');
    const copy = new File([result.data], 'corrected.jpg', {
      type: 'image/jpeg',
    });
    globalThis.postMessage({
      phase: 'Wrote synchronized dates to a new JPEG copy.',
    });
    const written = await readTags(copy, Object.keys(tags));
    const dates: DateFieldResult[] = [];
    for (const [tag, expected] of Object.entries(tags)) {
      const actual = written[jpegDateReadbackName(tag)];
      const matches =
        tag === 'GPS:GPSTimeStamp' && expected && typeof actual === 'string'
          ? actual.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1') ===
            expected.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
          : expected
            ? String(actual) === expected
            : actual === undefined;
      if (!matches)
        throw new Error(`The corrected JPEG did not retain ${tag} accurately.`);
      const before = existing[jpegDateReadbackName(tag)];
      dates.push({
        tag,
        before: before === undefined ? null : String(before),
        after: actual === undefined ? null : String(actual),
      });
    }
    globalThis.postMessage({ image: copy, dates });
  } catch (cause) {
    globalThis.postMessage({
      error:
        cause instanceof Error
          ? cause.message
          : 'JPEG metadata could not be processed.',
    });
  }
};
