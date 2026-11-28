import { handle } from '@astrojs/cloudflare/handler';
import { runDraftPhotoCleanup } from './authoring/photo-attachments.ts';

export default {
  fetch: handle,
  async scheduled(_controller: unknown, env: Cloudflare.Env) {
    if (!env.CATALOGUE || !env.DRAFT_PHOTOS)
      throw new Error(
        'Draft photo cleanup requires catalogue and private photo storage bindings.',
      );
    try {
      const summary = await runDraftPhotoCleanup(
        env.CATALOGUE,
        env.DRAFT_PHOTOS,
        'scheduled',
      );
      console.info('Draft photo cleanup completed.', summary);
    } catch {
      // Provider errors can include private object keys or query parameters.
      throw new Error('Draft photo cleanup failed.');
    }
  },
};
