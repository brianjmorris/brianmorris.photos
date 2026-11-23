import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type FetchImplementation,
} from 'jose';

export interface OwnerAccessEnvironment {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUDIENCE?: string;
}

export interface OwnerIdentity {
  subject: string;
  email: string;
}

export type OwnerAccessResult =
  { ok: true; owner: OwnerIdentity } | { ok: false; status: 401 | 503 };

function configuration(env: OwnerAccessEnvironment) {
  try {
    const issuer = new URL(env.ACCESS_TEAM_DOMAIN ?? '');
    // Signing keys must come from the configured Access team, never a token URL.
    if (
      issuer.protocol !== 'https:' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(
        issuer.hostname,
      ) ||
      issuer.port ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      issuer.pathname !== '/'
    )
      return null;
    const audience = env.ACCESS_AUDIENCE?.trim();
    if (!audience || audience.length > 256 || /\s/.test(audience)) return null;
    return { issuer: issuer.origin, audience };
  } catch {
    return null;
  }
}

// Dependency injection is for a transport, not a way to skip verification.
// Application code always uses the default fetch and cannot enable a test mode
// through environment variables or request headers.
export function createOwnerAuthorizer(fetchKeys?: FetchImplementation) {
  let cachedIssuer: string | undefined;
  let keys: ReturnType<typeof createRemoteJWKSet> | undefined;
  return async (
    request: Request,
    env: OwnerAccessEnvironment,
  ): Promise<OwnerAccessResult> => {
    const config = configuration(env);
    if (!config) return { ok: false, status: 503 };
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 16_384) return { ok: false, status: 401 };
    try {
      if (cachedIssuer !== config.issuer || !keys) {
        keys = createRemoteJWKSet(
          new URL('/cdn-cgi/access/certs', config.issuer),
          {
            ...(fetchKeys ? { [customFetch]: fetchKeys } : {}),
          },
        );
        cachedIssuer = config.issuer;
      }
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'email', 'type'],
      });
      if (
        payload.type !== 'app' ||
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        payload.sub.length > 256 ||
        typeof payload.iat !== 'number' ||
        !Number.isSafeInteger(payload.iat) ||
        payload.iat < 0 ||
        payload.iat > Math.floor(Date.now() / 1000) ||
        typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp <= payload.iat ||
        typeof payload.email !== 'string' ||
        payload.email.length > 254 ||
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)
      )
        return { ok: false, status: 401 };
      // The dedicated dashboard application's Access policy owns the allowlist.
      // An authentic human token for this exact application is its approval;
      // the app must not maintain a second email list or trust another app's token.
      return {
        ok: true,
        owner: { subject: payload.sub, email: payload.email.toLowerCase() },
      };
    } catch (error) {
      // Invalid credentials are distinct from an unavailable signing-key service.
      // Never send raw library errors, token claims, or settings to the browser.
      const invalidToken =
        error instanceof errors.JOSEError &&
        ![
          'ERR_JOSE_GENERIC',
          'ERR_JWKS_TIMEOUT',
          'ERR_JWKS_INVALID',
          'ERR_JWK_INVALID',
          'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
        ].includes(error.code);
      return { ok: false, status: invalidToken ? 401 : 503 };
    }
  };
}
