import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { invalid } from '../../../../catalogue/model.ts';
import {
  collectionApi,
  readCollectionBody,
} from '../../../../authoring/collections.ts';
import type { PhotoDraftSelection } from '../../../../catalogue/repository.ts';

export const POST: APIRoute = ({ locals, request }) =>
  collectionApi(locals.owner, env.CATALOGUE, async (repository) => {
    const value = await readCollectionBody(request, 'json');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      invalid('Select photographs and collections.');
    const data = value as Record<string, unknown>;
    if (
      Object.keys(data).some(
        (key) => !['photos', 'collectionIds'].includes(key),
      ) ||
      !Array.isArray(data.photos) ||
      !Array.isArray(data.collectionIds)
    )
      invalid('Select photographs and collections.');
    if (
      data.photos.some(
        (photo) =>
          !photo ||
          typeof photo !== 'object' ||
          Array.isArray(photo) ||
          Object.keys(photo).some(
            (key) => !['photoId', 'expectedRevision'].includes(key),
          ),
      )
    )
      invalid('Invalid photograph selection.');
    return Response.json({
      photos: await repository.assignPhotos(
        data.photos as PhotoDraftSelection[],
        data.collectionIds as string[],
      ),
    });
  });
