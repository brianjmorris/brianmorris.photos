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
    const { tag, created } = await repository.createOrFindTag(input);
    return Response.json(tag, { status: created ? 201 : 200 });
  });
