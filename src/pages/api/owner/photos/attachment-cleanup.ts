import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import {
  cleanDraftPhotos,
  draftPhotoApi,
} from '../../../../authoring/photo-attachments.ts';
import { invalid } from '../../../../catalogue/model.ts';

export const POST: APIRoute = ({ locals, url }) =>
  draftPhotoApi(
    locals.owner,
    env.CATALOGUE,
    env.DRAFT_PHOTOS,
    (repository, bucket) => {
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if (cursor !== undefined && (!cursor.length || cursor.length > 2048))
        invalid('Invalid attachment cleanup cursor.');
      return cleanDraftPhotos(repository, bucket, cursor);
    },
  );
