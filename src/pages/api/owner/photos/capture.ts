import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { readCollectionBody } from '../../../../authoring/collections.ts';
import { photoApi, photoCaptureInput } from '../../../../authoring/photos.ts';

export const GET: APIRoute = ({ locals, url }) =>
  photoApi(locals.owner, env.CATALOGUE, async (repository) =>
    Response.json(
      await repository.getPhotoCaptureDraft(
        url.searchParams.get('photoId') ?? '',
      ),
    ),
  );

export const POST: APIRoute = ({ locals, request }) =>
  photoApi(locals.owner, env.CATALOGUE, async (repository) => {
    const data = photoCaptureInput(await readCollectionBody(request, 'json'));
    return Response.json(
      await repository.savePhotoCaptureDraft(
        data.photoId,
        data.expectedRevision,
        data.capture,
        data.original,
      ),
    );
  });
