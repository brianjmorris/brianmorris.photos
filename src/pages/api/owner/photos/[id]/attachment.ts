import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import {
  draftPhotoApi,
  readDraftPhoto,
  removeDraftPhoto,
  writeDraftPhoto,
} from '../../../../../authoring/photo-attachments.ts';

export const GET: APIRoute = ({ locals, params }) =>
  draftPhotoApi(
    locals.owner,
    env.CATALOGUE,
    env.DRAFT_PHOTOS,
    (repository, bucket) => readDraftPhoto(repository, bucket, params.id!),
  );

export const PUT: APIRoute = ({ locals, params, request }) =>
  draftPhotoApi(
    locals.owner,
    env.CATALOGUE,
    env.DRAFT_PHOTOS,
    (repository, bucket) =>
      writeDraftPhoto(repository, bucket, params.id!, request),
  );

export const POST = PUT;

export const DELETE: APIRoute = ({ locals, params }) =>
  draftPhotoApi(
    locals.owner,
    env.CATALOGUE,
    env.DRAFT_PHOTOS,
    (repository, bucket) => removeDraftPhoto(repository, bucket, params.id!),
  );
