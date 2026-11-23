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
    const tag = await repository.getTagDraft(params.id!);
    if (!tag) throw new CatalogueError('not_found', 'Collection not found.');
    return Response.json(tag);
  });

export const PUT: APIRoute = ({ locals, params, request }) =>
  collectionApi(locals.owner, env.CATALOGUE, async (repository) => {
    const { input, expectedRevision } = collectionInput(
      await readCollectionBody(request, 'json'),
      true,
    );
    return Response.json(
      await repository.saveTagDraft(params.id!, expectedRevision!, input),
    );
  });
