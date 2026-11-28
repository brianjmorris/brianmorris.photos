import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare } from 'miniflare';
import { createOwnerAuthorizer } from '../src/auth/owner.ts';
import { guardOwnerRequest, isOwnerPath } from '../src/auth/guard.ts';
import { applyLocalMigrations } from './helpers/catalogue.mjs';
import { verifyCollectionEditor } from './helpers/collections-integration.mjs';
import { verifyDraftAttachments } from './helpers/draft-attachments-integration.mjs';

const issuer = 'https://synthetic-team.cloudflareaccess.com';
const env = {
  ACCESS_TEAM_DOMAIN: issuer,
  ACCESS_AUDIENCE: 'synthetic-audience',
};
const fixtureEmail = 'owner@example.test';
const request = (
  token,
  {
    url = 'https://photos.example.test/dashboard',
    method = 'GET',
    headers = {},
  } = {},
) =>
  new Request(url, {
    method,
    headers: {
      ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}),
      ...headers,
    },
  });
const denied = (status) => ({ ok: false, status });
let signing, replacement, jwks;

async function token(claims = {}, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    aud: [env.ACCESS_AUDIENCE],
    sub: 'synthetic-subject',
    iat: now,
    exp: now + 3600,
    email: fixtureEmail,
    type: 'app',
    ...claims,
  };
  for (const name of options.omit ?? []) delete payload[name];
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: 'RS256',
      kid: 'synthetic-key',
      ...options.header,
    })
    .sign(options.key ?? signing.privateKey);
}

function transport(keys = () => jwks) {
  const calls = [];
  const fetchKeys = async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    return Response.json({ keys: keys() });
  };
  return { authorize: createOwnerAuthorizer(fetchKeys), calls };
}

before(async () => {
  signing = await generateKeyPair('RS256', { extractable: true });
  replacement = await generateKeyPair('RS256', { extractable: true });
  jwks = [
    {
      ...(await exportJWK(signing.publicKey)),
      kid: 'synthetic-key',
      alg: 'RS256',
      use: 'sig',
    },
  ];
});

describe('Cloudflare-approved dashboard identity verification', () => {
  it('accepts a signed dashboard identity and reuses the signing-key cache', async () => {
    const { authorize, calls } = transport();
    const signed = await token();
    const owner = {
      ok: true,
      owner: { subject: 'synthetic-subject', email: fixtureEmail },
    };
    assert.deepEqual(await authorize(request(signed), env), owner);
    assert.deepEqual(await authorize(request(signed), env), owner);
    assert.deepEqual(calls, [
      { url: issuer + '/cdn-cgi/access/certs', redirect: 'manual' },
    ]);
  });

  it('gets issuer and application from server configuration and identity from the signed token', async () => {
    const { authorize } = transport();
    const otherEnv = {
      ACCESS_TEAM_DOMAIN: 'https://another-team.cloudflareaccess.com/',
      ACCESS_AUDIENCE: 'another-application',
    };
    const signed = await token({
      iss: 'https://another-team.cloudflareaccess.com',
      aud: ['another-application'],
      email: 'another-owner@example.test',
    });
    assert.deepEqual(await authorize(request(signed), otherEnv), {
      ok: true,
      owner: {
        subject: 'synthetic-subject',
        email: 'another-owner@example.test',
      },
    });
    assert.deepEqual(await authorize(request(signed), env), denied(401));
  });

  it('denies missing or invalid setup without requesting signing keys', async () => {
    const { authorize, calls } = transport();
    for (const config of [
      {},
      { ...env, ACCESS_TEAM_DOMAIN: undefined },
      { ...env, ACCESS_AUDIENCE: undefined },
      { ...env, ACCESS_AUDIENCE: '' },
      {
        ...env,
        ACCESS_TEAM_DOMAIN: 'http://synthetic-team.cloudflareaccess.com',
      },
      { ...env, ACCESS_TEAM_DOMAIN: 'https://untrusted.example.test' },
      { ...env, ACCESS_TEAM_DOMAIN: issuer + '/custom-path' },
      { ...env, ACCESS_TEAM_DOMAIN: issuer + '?query=1' },
      {
        ...env,
        ACCESS_TEAM_DOMAIN:
          'https://user:password@synthetic-team.cloudflareaccess.com',
      },
    ]) {
      assert.deepEqual(
        await authorize(request(await token()), config),
        denied(503),
      );
    }
    assert.equal(calls.length, 0);
  });

  it('rejects absent assertions, spoofed identity headers, cookies alone and excessive tokens', async () => {
    const { authorize, calls } = transport();
    for (const req of [
      request(),
      request(undefined, {
        headers: { 'Cf-Access-Authenticated-User-Email': fixtureEmail },
      }),
      request(undefined, {
        headers: { Cookie: `CF_Authorization=${await token()}` },
      }),
      request('a'.repeat(16385)),
    ]) {
      assert.deepEqual(await authorize(req, env), denied(401));
    }
    assert.equal(calls.length, 0);
  });

  it('rejects invalid signatures, unsigned tokens, wrong algorithms and unknown signing keys', async () => {
    const { authorize } = transport();
    const signed = await token();
    const [header, payload] = signed.split('.');
    const hmac = await new SignJWT({ email: fixtureEmail })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(
        new TextEncoder().encode('synthetic-test-key-with-at-least-32-bytes'),
      );
    for (const value of [
      'malformed',
      `${header}.${payload}.`,
      await token({}, { key: replacement.privateKey }),
      await token({}, { header: { kid: 'unknown-key' } }),
      hmac,
    ]) {
      assert.deepEqual(await authorize(request(value), env), denied(401));
    }
  });

  it('validates issuer, audience, expiry, not-before, issued-at and required claim shapes', async () => {
    const { authorize } = transport();
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { iss: 'https://attacker.cloudflareaccess.com' },
      { aud: ['wrong-application'] },
      { exp: now - 1 },
      { nbf: now + 600 },
      { iat: now + 600 },
      { iat: -1 },
      { iat: now + 0.5 },
      { exp: now + 0.5 },
      { sub: '' },
      { sub: 123 },
      { email: [] },
      { email: '' },
      { email: 'not-an-email' },
      { email: 'x'.repeat(255) + '@example.test' },
      { type: 'service' },
    ]) {
      assert.deepEqual(
        await authorize(request(await token(claims)), env),
        denied(401),
      );
    }
    for (const claim of ['iss', 'aud', 'exp', 'iat', 'sub', 'email', 'type']) {
      assert.deepEqual(
        await authorize(request(await token({}, { omit: [claim] })), env),
        denied(401),
      );
    }
  });

  it('accepts an email change approved by Cloudflare without changing server configuration', async () => {
    const { authorize } = transport();
    assert.deepEqual(
      await authorize(
        request(await token({ email: 'new-address@example.test' })),
        env,
      ),
      {
        ok: true,
        owner: {
          subject: 'synthetic-subject',
          email: 'new-address@example.test',
        },
      },
    );
    assert.deepEqual(
      await authorize(
        request(await token({ email: 'OWNER@EXAMPLE.TEST' })),
        env,
      ),
      {
        ok: true,
        owner: { subject: 'synthetic-subject', email: fixtureEmail },
      },
    );
  });

  it('ignores token-supplied key URLs and can verify current and previous public signing keys', async () => {
    const secondKey = {
      ...(await exportJWK(replacement.publicKey)),
      kid: 'rotated-key',
      alg: 'RS256',
      use: 'sig',
    };
    const { authorize, calls } = transport(() => [...jwks, secondKey]);
    assert.equal((await authorize(request(await token()), env)).ok, true);
    assert.equal(
      (
        await authorize(
          request(
            await token(
              {},
              {
                key: replacement.privateKey,
                header: {
                  kid: 'rotated-key',
                  jku: 'https://untrusted.example.test/keys',
                },
              },
            ),
          ),
          env,
        )
      ).ok,
      true,
    );
    assert(
      calls.every((call) => call.url === issuer + '/cdn-cgi/access/certs'),
    );
    assert.equal(calls.length, 1);
  });

  it('denies access when the signing-key service fails or returns an invalid key set', async () => {
    const signed = await token();
    for (const fetchKeys of [
      async () => {
        throw new Error('private-network-detail');
      },
      async () => new Response('unavailable', { status: 500 }),
      async () => Response.json({ invalid: 'private-key-detail' }),
    ]) {
      assert.deepEqual(
        await createOwnerAuthorizer(fetchKeys)(request(signed), env),
        denied(503),
      );
    }
  });
});

describe('private request boundary', () => {
  const success = async (owner) =>
    Response.json(
      { authenticated: true, subject: owner.subject },
      {
        headers: {
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  function assertPrivate(response) {
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
    assert.equal(
      response.headers.get('Cloudflare-CDN-Cache-Control'),
      'no-store',
    );
    assert.equal(
      response.headers.get('X-Robots-Tag'),
      'noindex, nofollow, noarchive',
    );
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }

  it('recognizes the dashboard and owner API including encoded and normalized paths', () => {
    for (const path of [
      '/dashboard',
      '/dashboard/',
      '/dashboard/tools',
      '/api/owner',
      '/api/owner/session',
      '/%64ashboard',
      '/dashboard%2Ftools',
      '/api%2Fowner/session',
      '//dashboard',
      '/x/../dashboard',
      '/DASHBOARD',
      '/dashboard\\tools',
    ])
      assert.equal(isOwnerPath(path), true, path);
    for (const path of [
      '/',
      '/photos',
      '/dashboard-other',
      '/api/ownership',
      '/api/public',
      '/search',
    ])
      assert.equal(isOwnerPath(path), false, path);
  });

  it('allows the verified owner through on custom, worker and preview hostnames', async () => {
    const { authorize } = transport();
    for (const url of [
      'https://photos.example.test/dashboard',
      'https://synthetic-worker.example.workers.dev/api/owner/session',
      'https://branch-synthetic-worker.example.workers.dev/dashboard',
    ]) {
      const response = await guardOwnerRequest(
        request(await token(), { url }),
        env,
        authorize,
        success,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        authenticated: true,
        subject: 'synthetic-subject',
      });
      assertPrivate(response);
    }
  });

  it('never calls private handlers for missing, invalid or unauthorized identity on any host', async () => {
    const { authorize } = transport();
    for (const url of [
      'https://photos.example.test/dashboard',
      'https://worker.example.workers.dev/dashboard',
      'https://branch-worker.example.workers.dev/api/owner/session',
    ]) {
      for (const signed of [
        undefined,
        'fake',
        await token({
          email: 'visitor@example.test',
          aud: ['different-application'],
        }),
      ]) {
        const response = await guardOwnerRequest(
          request(signed, { url }),
          env,
          authorize,
          async () => assert.fail('Unauthorized handler reached'),
        );
        assert.equal(response.status, 401);
        assertPrivate(response);
        assert.equal(await response.text(), 'Sign-in required.');
      }
    }
  });

  it('rejects cross-origin and origin-free writes while allowing same-origin writes', async () => {
    const { authorize } = transport();
    const signed = await token();
    for (const origin of [null, 'null', 'https://untrusted.example.test']) {
      const response = await guardOwnerRequest(
        request(signed, {
          method: 'POST',
          headers: origin ? { Origin: origin } : {},
        }),
        env,
        authorize,
        async () => assert.fail('Cross-origin write reached handler'),
      );
      assert.equal(response.status, 403);
      assertPrivate(response);
    }
    const response = await guardOwnerRequest(
      request(signed, {
        method: 'POST',
        headers: { Origin: 'https://photos.example.test' },
      }),
      env,
      authorize,
      success,
    );
    assert.equal(response.status, 200);
    assertPrivate(response);
  });

  it('keeps setup errors and downstream failures private without exposing details', async () => {
    const { authorize } = transport();
    const missing = await guardOwnerRequest(request(), {}, authorize, success);
    assert.equal(missing.status, 503);
    assertPrivate(missing);
    assert.equal(await missing.text(), 'Dashboard unavailable.');
    const failed = await guardOwnerRequest(
      request(await token()),
      env,
      authorize,
      async () => {
        throw new Error('private-draft-or-token-detail');
      },
    );
    assert.equal(failed.status, 503);
    assertPrivate(failed);
    assert.equal(await failed.text(), 'Dashboard unavailable.');
  });

  it('runs the built Worker with public access, identity checks and protected collection editing', async () => {
    // Build current source instead of relying on potentially stale dist output.
    execFileSync(
      process.execPath,
      ['node_modules/astro/bin/astro.mjs', 'build'],
      { cwd: process.cwd(), env: process.env, stdio: 'pipe' },
    );
    const root = join(process.cwd(), 'dist', 'server');
    const modules = {};
    for (const file of await readdir(root, { recursive: true })) {
      if (file.endsWith('.mjs'))
        modules[file.replaceAll('\\', '/')] = {
          type: 'esm',
          contents: await readFile(join(root, file), 'utf8'),
        };
    }
    const config = JSON.parse(
      await readFile(join(root, 'wrangler.json'), 'utf8'),
    );
    const mf = new Miniflare({
      host: '127.0.0.1',
      enableDevRegistry: false,
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: 'owner-boundary-local-test',
            compatibilityDate: config.compatibility_date,
            compatibilityFlags: config.compatibility_flags,
            manifest: { mainModule: 'entry.mjs', modules },
          },
        },
      ],
    });
    try {
      const publicPage = await mf.dispatchFetch('https://photos.example.test/');
      assert.equal(publicPage.status, 200);
      assert(
        (await publicPage.text()).includes('A new collection is taking shape.'),
      );
      assert.notEqual(
        publicPage.headers.get('Cache-Control'),
        'private, no-store',
      );
      for (const path of [
        '/dashboard',
        '/dashboard/',
        '/api/owner/session',
        '/%64ashboard',
      ]) {
        const response = await mf.dispatchFetch(
          'https://photos.example.test' + path,
          {
            headers: { 'Cf-Access-Authenticated-User-Email': fixtureEmail },
          },
        );
        assert.equal(response.status, 503, path);
        assertPrivate(response);
        assert.equal(await response.text(), 'Dashboard unavailable.');
      }
    } finally {
      await mf.dispose();
    }
    const configured = new Miniflare({
      host: '127.0.0.1',
      enableDevRegistry: false,
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: 'configured-owner-local-test',
            compatibilityDate: config.compatibility_date,
            compatibilityFlags: config.compatibility_flags,
            manifest: { mainModule: 'entry.mjs', modules },
            env: Object.fromEntries([
              ...Object.entries(env).map(([name, value]) => [
                name,
                { type: 'text', value },
              ]),
              [
                'CATALOGUE',
                {
                  type: 'd1',
                  id: 'disposable-owner-collections',
                  dev: { remote: false },
                },
              ],
              [
                'DRAFT_PHOTOS',
                {
                  type: 'r2',
                  name: 'disposable-owner-draft-photos',
                  dev: { remote: false },
                },
              ],
            ]),
          },
          dev: {
            outboundService: {
              type: 'fetcher',
              handler: async (req) => {
                assert.equal(req.url, issuer + '/cdn-cgi/access/certs');
                return Response.json({ keys: jwks });
              },
            },
          },
        },
      ],
    });
    try {
      const headers = { 'Cf-Access-Jwt-Assertion': await token() };
      const dashboard = await configured.dispatchFetch(
        'https://photos.example.test/dashboard',
        { headers },
      );
      assert.equal(dashboard.status, 200);
      assert(
        (await dashboard.text()).includes('Your photo and collection tools'),
      );
      assertPrivate(dashboard);
      const session = await configured.dispatchFetch(
        'https://branch-worker.example.workers.dev/api/owner/session',
        { headers },
      );
      assert.equal(session.status, 200);
      assert.deepEqual(await session.json(), { authenticated: true });
      assertPrivate(session);
      const updatedEmail = await configured.dispatchFetch(
        'https://photos.example.test/api/owner/session',
        {
          headers: {
            'Cf-Access-Jwt-Assertion': await token({
              email: 'new-address@example.test',
            }),
          },
        },
      );
      assert.equal(updatedEmail.status, 200);
      assert.deepEqual(await updatedEmail.json(), { authenticated: true });
      assertPrivate(updatedEmail);
      for (const headers of [
        { 'Cf-Access-Authenticated-User-Email': fixtureEmail },
        {
          'Cf-Access-Jwt-Assertion': await token({
            email: 'visitor@example.test',
            aud: ['different-application'],
          }),
        },
      ]) {
        const denied = await configured.dispatchFetch(
          'https://photos.example.test/dashboard',
          { headers },
        );
        assert.equal(denied.status, 401);
        assertPrivate(denied);
      }
      const database = await configured.getD1Database('CATALOGUE');
      const unavailable = await configured.dispatchFetch(
        'https://photos.example.test/dashboard/collections',
        { headers },
      );
      assert.equal(unavailable.status, 503);
      assertPrivate(unavailable);
      assert(!(await unavailable.text()).includes('no such table'));
      await applyLocalMigrations(database);
      await verifyCollectionEditor(
        configured,
        database,
        headers,
        assertPrivate,
      );
      await verifyDraftAttachments(
        configured,
        database,
        await configured.getR2Bucket('DRAFT_PHOTOS'),
        headers,
        assertPrivate,
      );
    } finally {
      await configured.dispose();
    }
  });
});
