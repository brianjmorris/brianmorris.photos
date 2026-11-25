import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { invalid } from '../../../../catalogue/model.ts';
import {
  collectionApi,
  readCollectionBody,
} from '../../../../authoring/collections.ts';
import {
  CatalogueRepository,
  type PhotoDraftSelection,
} from '../../../../catalogue/repository.ts';

export const POST: APIRoute = ({ locals, request }) =>
  collectionApi(locals.owner, env.CATALOGUE, async (repository) => {
    const value = await readCollectionBody(request, 'json');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      invalid('Select photographs and collections.');
    const data = value as Record<string, unknown>;
    if (
      Object.keys(data).some(
        (key) =>
          !['photos', 'collectionIds', 'tagIds', 'tagNames'].includes(key),
      ) ||
      !Array.isArray(data.photos) ||
      !Array.isArray(data.collectionIds)
    )
      invalid('Select photographs and collections.');
    const { tagIds = [], tagNames = [] } = data;
    if (
      !Array.isArray(tagIds) ||
      tagIds.length > 64 ||
      !Array.isArray(tagNames) ||
      tagNames.length > 64 ||
      tagNames.some((name: unknown) => typeof name !== 'string')
    )
      invalid('Select valid tags.');
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
    const photos = data.photos as PhotoDraftSelection[];
    const updated = await repository.assignPhotos(
      photos,
      data.collectionIds as string[],
      tagIds,
      tagNames,
    );
    return Response.json({
      photos: updated,
      items: (
        await new CatalogueRepository(env.CATALOGUE!).listPhotoDrafts(
          undefined,
          30,
          photos.map((photo) => photo.photoId),
        )
      ).items,
    });
  });
