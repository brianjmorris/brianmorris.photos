import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { jpegDateWasmAsset } from '../src/photo-review/jpeg-date-asset.ts';

export function jpegDateAssets() {
  let compressed;
  function asset() {
    // The unpacked WASM exceeds the Workers static asset limit.
    const wasm = import.meta
      .resolve('@colorhythm/exiftool-wasm/dist/esm/zeroperl-3qzfmxbv.wasm');
    return (compressed ??= gzipSync(readFileSync(new URL(wasm))));
  }
  return {
    name: 'jpeg-date-assets',
    configureServer(server) {
      server.middlewares.use(`/${jpegDateWasmAsset}`, (_request, response) => {
        response.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Cache-Control': 'no-store',
        });
        response.end(asset());
      });
    },
    generateBundle() {
      if (this.environment.name === 'client') {
        this.emitFile({
          type: 'asset',
          fileName: jpegDateWasmAsset,
          source: asset(),
        });
      }
    },
  };
}
