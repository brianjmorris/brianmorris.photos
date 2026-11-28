import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { readCollectionBody } from '../../../../../authoring/collections.ts';
import { photoApi } from '../../../../../authoring/photos.ts';
import { invalid } from '../../../../../catalogue/model.ts';

export const DELETE: APIRoute = ({ locals, params, request }) =>
  photoApi(locals.owner, env.CATALOGUE, async (repository) => {
    const value = await readCollectionBody(request, 'json');
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !('expectedRevision' in value) ||
      typeof value.expectedRevision !== 'number'
    )
      invalid('Supply the draft revision to discard.');
    await repository.discardPhotoDraft(params.id!, value.expectedRevision);
    return Response.json({ discarded: true });
  });
