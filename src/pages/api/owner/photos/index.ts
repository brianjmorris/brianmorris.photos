import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import {
  CatalogueRepository,
  type NewPhotoDraft,
} from '../../../../catalogue/repository.ts';
import { invalid } from '../../../../catalogue/model.ts';
import {
  collectionError,
  readCollectionBody,
} from '../../../../authoring/collections.ts';

export const GET: APIRoute = ({ locals, url }) =>
  photoApi(locals.owner, async (repository) =>
    Response.json(
      await repository.listPhotoDrafts(
        url.searchParams.get('after') ?? undefined,
        30,
        url.searchParams.has('ids')
          ? url.searchParams.get('ids')!.split(',')
          : undefined,
      ),
    ),
  );

export const POST: APIRoute = ({ locals, request }) =>
  photoApi(locals.owner, async (repository) => {
    const value = await readCollectionBody(request, 'json');
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'photos')
    )
      invalid('Supply photograph draft details.');
    const photos = (value as { photos: unknown }).photos;
    if (
      !Array.isArray(photos) ||
      photos.some(
        (photo) =>
          !photo ||
          typeof photo !== 'object' ||
          Array.isArray(photo) ||
          Object.keys(photo).some(
            (key) => !['photoId', 'title', 'tagIds'].includes(key),
          ) ||
          typeof photo.photoId !== 'string' ||
          !(photo.title === null || typeof photo.title === 'string') ||
          !Array.isArray(photo.tagIds) ||
          photo.tagIds.some((id: unknown) => typeof id !== 'string'),
      )
    )
      invalid('Supply only draft identifiers, titles and tags.');
    await repository.createPhotoDraftBatch(photos as NewPhotoDraft[]);
    return Response.json(
      await repository.listPhotoDrafts(
        undefined,
        30,
        photos.map((photo) => photo.photoId),
      ),
      { status: 201 },
    );
  });

async function photoApi(
  owner: unknown,
  operation: (repository: CatalogueRepository) => Promise<Response>,
) {
  if (!owner)
    return Response.json({ error: 'Sign-in required.' }, { status: 401 });
  if (!env.CATALOGUE)
    return Response.json(
      {
        error:
          'Draft storage is temporarily unavailable. Your local batch stays on this device.',
      },
      { status: 503 },
    );
  try {
    return await operation(new CatalogueRepository(env.CATALOGUE));
  } catch (cause) {
    const error = collectionError(cause);
    return Response.json({ error: error.message }, { status: error.status });
  }
}
