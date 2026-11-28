import { inspectJpeg } from './jpeg-input.ts';

// Local review only, one file at a time, with no network or publication work.
globalThis.onmessage = async (
  event: MessageEvent<{ id: string; file: File }>,
) => {
  const { id, file } = event.data;
  let bitmap: ImageBitmap | null = null;
  try {
    const header = await inspectJpeg(file);
    const rotated = header.orientation >= 5;
    const sourceWidth = rotated ? header.height : header.width,
      sourceHeight = rotated ? header.width : header.height;
    const scale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale)),
      height = Math.max(1, Math.round(sourceHeight * scale));
    const digest = await crypto.subtle.digest(
      'SHA-256',
      await file.arrayBuffer(),
    );
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
    if (bitmap.width !== width || bitmap.height !== height)
      throw new Error('This browser could not create a bounded preview.');
    const canvas = new OffscreenCanvas(width, height),
      context = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!context)
      throw new Error('Photo previews are unavailable in this browser.');
    context.drawImage(bitmap, 0, 0, width, height);
    const preview = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: 0.85,
    });
    const thumbScale = Math.min(1, 320 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * thumbScale));
    canvas.height = Math.max(1, Math.round(height * thumbScale));
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumbnail = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: 0.8,
    });
    canvas.width = canvas.height = 1;
    if (preview.size > 4 * 1024 * 1024 || thumbnail.size > 256 * 1024)
      throw new Error('This photograph needs a smaller local preview.');
    bitmap.close();
    bitmap = null;
    globalThis.postMessage({
      id,
      hash,
      preview,
      thumbnail,
      width: sourceWidth,
      height: sourceHeight,
      capture: header.capture,
      gps: header.gps,
    });
  } catch (cause) {
    globalThis.postMessage({
      id,
      error:
        cause instanceof Error
          ? cause.message
          : 'This JPEG could not be previewed.',
    });
  } finally {
    bitmap?.close();
  }
};
