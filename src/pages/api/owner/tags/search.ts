import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { tagApi } from '../../../../authoring/tags.ts';
import { searchDraftTags } from '../../../../catalogue/tag-search.ts';

export const GET: APIRoute = ({ locals, url }) =>
  tagApi(locals.owner, env.CATALOGUE, async () =>
    Response.json({
      items: await searchDraftTags(
        env.CATALOGUE!,
        url.searchParams.get('q') ?? '',
        url.searchParams.getAll('tag'),
      ),
    }),
  );
