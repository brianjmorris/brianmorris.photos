import { env } from 'cloudflare:workers';
import { defineMiddleware } from 'astro:middleware';
import { createOwnerAuthorizer } from './auth/owner.ts';
import { guardOwnerRequest, isOwnerPath } from './auth/guard.ts';

const authorize = createOwnerAuthorizer();

export const onRequest = defineMiddleware(async (context, next) => {
  if (!isOwnerPath(context.url.pathname)) return next();
  return guardOwnerRequest(context.request, env, authorize, async (owner) => {
    context.locals.owner = owner;
    return next();
  });
});
