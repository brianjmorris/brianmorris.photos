import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectJpeg, INPUT_LIMITS } from '../src/photo-review/jpeg-input.ts';

function header(width, height, marker = 192, channels = 3) {
  const length = 8 + 3 * channels;
  return new Uint8Array([
    255,
    216,
    255,
    marker,
    0,
    length,
    8,
    height >>> 8,
    height & 255,
    width >>> 8,
    width & 255,
    channels,
    ...new Array(channels * 3).fill(0),
  ]);
}
test('accepts bounded baseline and progressive frame headers', async () => {
  for (const marker of [192, 194])
    assert.deepEqual(
      await inspectJpeg(new Blob([header(8256, 5504, marker)])),
      { width: 8256, height: 5504, channels: 3, orientation: 1 },
    );
  assert.equal(
    (await inspectJpeg(new Blob([header(600, 400, 192, 1)]))).channels,
    1,
  );
});
test('rejects dimension bombs and unsupported layouts before decode', async () => {
  for (const bytes of [
    header(65535, 65535),
    header(10000, 10000),
    header(0, 10),
    header(100, 100, 195),
    header(100, 100, 192, 4),
  ])
    await assert.rejects(inspectJpeg(new Blob([bytes])));
});
test('rejects malformed, truncated and non-JPEG input', async () => {
  for (const bytes of [
    [],
    [255, 216, 255, 218, 0, 2],
    [255, 216, 255, 225, 0, 1],
    [255, 216, 255, 225, 255, 255],
    [...header(600, 400)].slice(0, -1),
    [1, 2, 3],
  ])
    await assert.rejects(inspectJpeg(new Blob([new Uint8Array(bytes)])));
});
test('rejects compressed size before reading bytes', async () => {
  const blob = new Blob([new Uint8Array(INPUT_LIMITS.bytes + 1)]);
  blob.slice = () => {
    throw new Error('must not read oversized file');
  };
  await assert.rejects(inspectJpeg(blob), /40 MiB/);
});
test('bounds header scanning and handles marker fill bytes', async () => {
  const frame = header(600, 400);
  assert.equal(
    (
      await inspectJpeg(
        new Blob([frame.slice(0, 2), new Uint8Array([255]), frame.slice(2)]),
      )
    ).width,
    600,
  );
  const app = new Uint8Array(65537);
  app.set([255, 225, 255, 255]);
  await assert.rejects(
    inspectJpeg(
      new Blob([
        new Uint8Array([255, 216]),
        ...new Array(9).fill(app),
        frame.slice(2),
      ]),
    ),
    /header/i,
  );
});

test('reads all eight EXIF orientations in both byte orders and rejects bad offsets', async () => {
  const exif = (orientation, little) => {
    const tiff = new Uint8Array(26),
      view = new DataView(tiff.buffer);
    tiff.set(little ? [73, 73] : [77, 77]);
    view.setUint16(2, 42, little);
    view.setUint32(4, 8, little);
    view.setUint16(8, 1, little);
    view.setUint16(10, 274, little);
    view.setUint16(12, 3, little);
    view.setUint32(14, 1, little);
    view.setUint16(18, orientation, little);
    return tiff;
  };
  const jpeg = (tiff) =>
    new Blob([
      new Uint8Array([255, 216, 255, 225, 0, 34, 69, 120, 105, 102, 0, 0]),
      tiff,
      header(600, 400).slice(2),
    ]);
  for (const little of [true, false])
    for (let orientation = 1; orientation <= 8; orientation++)
      assert.equal(
        (await inspectJpeg(jpeg(exif(orientation, little)))).orientation,
        orientation,
      );
  await assert.rejects(inspectJpeg(jpeg(exif(9, true))), /orientation/);
  const bad = exif(1, true);
  new DataView(bad.buffer).setUint32(4, 0xffffffff, true);
  await assert.rejects(inspectJpeg(jpeg(bad)), /directory/);
});
