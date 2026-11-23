import type {
  OwnerAccessEnvironment,
  OwnerAccessResult,
  OwnerIdentity,
} from './owner.ts';

export function isOwnerPath(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* Malformed URLs cannot resolve a private route. */
  }
  // Normalize separators and dot segments before checking the reserved prefixes.
  const segments: string[] = [];
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(segment);
  }
  path = '/' + segments.join('/').toLowerCase();
  return ['/dashboard', '/api/owner'].some(
    (prefix) => path === prefix || path.startsWith(prefix + '/'),
  );
}

export function privateResponse(response: Response): Response {
  // Reconstruct instead of mutating potentially immutable upstream headers.
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('CDN-Cache-Control', 'no-store');
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Access-Control-Allow-Credentials');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function guardOwnerRequest(
  request: Request,
  env: OwnerAccessEnvironment,
  authorize: (
    request: Request,
    env: OwnerAccessEnvironment,
  ) => Promise<OwnerAccessResult>,
  next: (owner: OwnerIdentity) => Promise<Response>,
): Promise<Response> {
  try {
    const result = await authorize(request, env);
    if (!result.ok) {
      const message =
        result.status === 503 ? 'Dashboard unavailable.' : 'Sign-in required.';
      return privateResponse(
        new Response(message, {
          status: result.status,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }),
      );
    }
    // Cookie-backed Access sign-in must not authorize cross-origin mutations.
    const url = new URL(request.url);
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      request.headers.get('Origin') !== url.origin
    ) {
      return privateResponse(
        new Response('Request not allowed.', { status: 403 }),
      );
    }
    return privateResponse(await next(result.owner));
  } catch {
    return privateResponse(
      new Response('Dashboard unavailable.', { status: 503 }),
    );
  }
}
