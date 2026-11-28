import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import { defineConfig } from 'astro/config';
import { jpegDateAssets } from './scripts/jpeg-date-assets.mjs';

export default defineConfig({
  site: 'https://brianmorris.photos',
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough' }),
  integrations: [react()],
  session: false,
  vite: { plugins: [jpegDateAssets()], worker: { format: 'es' } },
});
