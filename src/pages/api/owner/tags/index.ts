import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { readCollectionBody } from '../../../../authoring/collections.ts';
import { tagApi, tagInput } from '../../../../authoring/tags.ts';

export const GET: APIRoute = ({ locals, url }) =>
  tagApi(locals.owner, env.CATALOGUE, async (repository) =>
    Response.json(
      await repository.listTagDrafts(
        url.searchParams.get('after') ?? undefined,
      ),
    ),
  );

export const POST: APIRoute = ({ locals, request }) =>
  tagApi(locals.owner, env.CATALOGUE, async (repository) => {
    const { input } = tagInput(await readCollectionBody(request, 'json'));
    return Response.json(await repository.createTag(input), { status: 201 });
  });
