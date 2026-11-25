export interface LocalPreview {
  hash: string;
  preview: Blob;
  thumbnail: Blob;
  width: number;
  height: number;
}

export function previewFile(
  file: File,
  signal: AbortSignal,
): Promise<LocalPreview> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./preview.worker.ts', import.meta.url), {
      type: 'module',
    });
    const id = crypto.randomUUID();
    const stop = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      stop();
      reject(new Error('Preview cancelled.'));
    };
    const timeout = setTimeout(() => {
      stop();
      reject(new Error('Preview took too long. Try this photograph again.'));
    }, 30_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    worker.onerror = () => {
      stop();
      reject(new Error('This browser could not prepare the photo preview.'));
    };
    worker.onmessage = (
      event: MessageEvent<LocalPreview & { id: string; error?: string }>,
    ) => {
      if (event.data.id !== id) return;
      stop();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.postMessage({ id, file });
  });
}
