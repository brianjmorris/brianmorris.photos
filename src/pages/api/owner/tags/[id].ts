import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { CatalogueError } from '../../../../catalogue/model.ts';
import { readCollectionBody } from '../../../../authoring/collections.ts';
import { tagApi, tagInput } from '../../../../authoring/tags.ts';

export const GET: APIRoute = ({ locals, params }) =>
  tagApi(locals.owner, env.CATALOGUE, async (repository) => {
    const tag = await repository.getTagDraft(params.id!);
    if (!tag) throw new CatalogueError('not_found', 'Tag not found.');
    return Response.json(tag);
  });

export const PUT: APIRoute = ({ locals, params, request }) =>
  tagApi(locals.owner, env.CATALOGUE, async (repository) => {
    const { input, expectedRevision } = tagInput(
      await readCollectionBody(request, 'json'),
      true,
    );
    return Response.json(
      await repository.saveTagDraft(params.id!, expectedRevision!, input),
    );
  });
