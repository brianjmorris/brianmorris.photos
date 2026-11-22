import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ locals }) => {
  if (!locals.owner) return new Response('Sign-in required.', { status: 403 });
  return Response.json({ authenticated: true });
};
