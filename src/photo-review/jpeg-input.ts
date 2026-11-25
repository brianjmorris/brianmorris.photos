export const INPUT_LIMITS = Object.freeze({
  bytes: 40 * 1024 * 1024,
  pixels: 60_000_000,
  side: 20_000,
  headerBytes: 512 * 1024,
});

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
      const view = new DataView(bytes.buffer, tiff, end - tiff);
      const little = bytes[tiff] === 73 && bytes[tiff + 1] === 73;
      const big = bytes[tiff] === 77 && bytes[tiff + 1] === 77;
      if ((!little && !big) || view.getUint16(2, little) !== 42)
        throw new Error('Malformed EXIF header');
      const ifd = view.getUint32(4, little);
      if (ifd < 8 || ifd + 2 > view.byteLength)
        throw new Error('Malformed EXIF directory');
      const count = view.getUint16(ifd, little);
      if (ifd + 2 + count * 12 + 4 > view.byteLength)
        throw new Error('Truncated EXIF directory');
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (view.getUint16(entry, little) === 274) {
          if (
            view.getUint16(entry + 2, little) !== 3 ||
            view.getUint32(entry + 4, little) !== 1
          )
            throw new Error('Malformed EXIF orientation');
          orientation = view.getUint16(entry + 8, little);
          if (orientation < 1 || orientation > 8)
            throw new Error('Invalid EXIF orientation');
        }
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
      return { width, height, channels, orientation };
    }
    at += length;
  }
  throw new Error('JPEG frame not found within header limit');
}
