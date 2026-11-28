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
      await repository.listDrafts(url.searchParams.get('after') ?? undefined),
    ),
  );
export const POST: APIRoute = ({ locals, request }) =>
  collectionApi(locals.owner, env.CATALOGUE, async (repository) =>
    Response.json(
      await repository.createDraft(
        collectionInput(await readCollectionBody(request, 'json')).input,
      ),
      { status: 201 },
    ),
  );
