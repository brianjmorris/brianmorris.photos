import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import {
  collectionApi,
  collectionInput,
  readCollectionBody,
} from '../../../../authoring/collections.ts';

export const GET: APIRoute = ({ locals, url }) =>
  collectionApi(locals.owner, env.CATALOGUE, async (repository) =>
    Response.json(
      await repository.listTagDrafts(
        url.searchParams.get('after') ?? undefined,
      ),
    ),
  );

export const POST: APIRoute = ({ locals, request }) =>
  collectionApi(locals.owner, env.CATALOGUE, async (repository) => {
    const { input } = collectionInput(
      await readCollectionBody(request, 'json'),
    );
    return Response.json(await repository.createTag(input), { status: 201 });
  });
