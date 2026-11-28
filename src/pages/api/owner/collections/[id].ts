import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { CatalogueError } from '../../../../catalogue/model.ts';
import {
  collectionApi,
  collectionInput,
  readCollectionBody,
} from '../../../../authoring/collections.ts';

export const GET: APIRoute = ({ locals, params }) =>
  collectionApi(locals.owner, env.CATALOGUE, async (repository) => {
    const collection = await repository.getDraft(params.id!);
    if (!collection)
      throw new CatalogueError('not_found', 'Collection not found.');
    return Response.json(collection);
  });
export const PUT: APIRoute = ({ locals, params, request }) =>
  collectionApi(locals.owner, env.CATALOGUE, async (repository) => {
    const { input, expectedRevision } = collectionInput(
      await readCollectionBody(request, 'json'),
      true,
    );
    return Response.json(
      await repository.saveDraft(params.id!, expectedRevision!, input),
    );
  });
