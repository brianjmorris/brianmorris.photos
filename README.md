# brianmorris.photos

A photography library built with Astro, React, and TypeScript for Cloudflare
Workers. The current application is a minimal server-rendered foundation.
Catalogue, owner access, uploads, image processing, and public exploration are
not implemented yet.

## Local setup

Use Node.js 24 LTS and npm 11. The development version is recorded in
`.node-version`; dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:4321>. The Cloudflare adapter runs server routes in the
local Workers runtime. No Cloudflare login, remote resources, or environment
variables are required for this scaffold.

## Verification

```sh
npm run format:check
npm run check
npm run build
npm run preview
```

`check` checks Astro and TypeScript. `build` creates the Worker and static assets
under `dist/`. `preview` serves the built application locally on port 4321;
stop the development server first. Use `npm run format` to apply formatting.
`npm run verify` runs formatting checks, type checks, and the build in order,
stopping if a check fails.

## Project structure

- `src/pages/`: file-based routes, rendered on demand by default.
- `src/layouts/`: shared HTML layouts.
- `astro.config.mjs`: Astro, React integration, and Cloudflare adapter.
- `wrangler.jsonc`: Worker runtime and static-asset configuration.

React is configured for interactive components when needed. Pages currently
ship without hydrated React controls. The Cloudflare image service is set to
passthrough, and Astro sessions are disabled; neither managed image processing
nor session storage is required by the foundation.

## Configuration and deployment

The checked-in Wrangler configuration has no database, object-storage, domain
route, or account binding. Its name is an application identifier, not evidence
that a Worker exists. D1 and R2 bindings will be added with their integrations.
The configuration targets one Worker named `brianmorris-photos`. Its workers.dev
address is enabled, version preview URLs are disabled, and it has no custom-domain
routes. Branch previews are managed separately by Workers Builds. The application
currently serves only the placeholder page; its custom domain is not connected.

When a feature needs local variables, copy `.dev.vars.example` to `.dev.vars`
and supply only the values documented by that feature. Keep credentials on the
server; values prefixed with `PUBLIC_` can be exposed to the browser.

The placeholder page uses `noindex, nofollow`. Revisit that policy when real
public content is ready to launch.

## Workers Builds deployment

Cloudflare Workers Builds handles deployment from GitHub. GitHub Actions runs
the same checks on pull requests and pushes to `main`, without deployment
credentials. Cloudflare also runs these checks in its own build command, so a
failed check stops deployment even if the GitHub check has not finished.

To connect the site:

1. In Cloudflare, open **Workers & Pages > Create application > Import a
   repository** and connect GitHub. Grant repository access to
   `brianjmorris/brianmorris.photos` and select it.
2. Configure the project with the settings below. The Worker name must match
   `wrangler.jsonc` exactly. The tracked `main` branch updates this same Worker
   after each successful build.

   | Setting         | Value                           |
   | --------------- | ------------------------------- |
   | Worker name     | `brianmorris-photos`            |
   | Branch          | `main`                          |
   | Root directory  | Repository root                 |
   | Build command   | `npm run verify`                |
   | Deploy command  | `npm run deploy`                |
   | API token       | Let Cloudflare generate a token |
   | Preview builds  | Enabled                         |
   | Preview command | `npx wrangler preview`          |

3. Select **Save and Deploy**. Cloudflare installs dependencies using the
   lockfile, runs verification, then uploads the generated Worker and assets.
   Node is pinned in `.node-version` and npm in `package.json`.
4. Open the workers.dev address shown after deployment and verify the page.
   Subsequent pushes to `main` trigger checks and deployment automatically.
   Inspect failures under **Settings > Builds** or the Worker build history.

Do not set `CLOUDFLARE_ENV`; the default configuration is the deployment target.
No application environment variables are required yet. Deployment credentials
are managed in Cloudflare; this setup requires no Cloudflare secrets or
deployment environment in GitHub. A manually created account token is not
needed for Workers Builds, which currently uses user tokens.

In GitHub, configure a branch rule for `main` requiring a pull request and the
`Check and build` check before merging. Enable native preview builds so branches
get their own URLs for review before merging. No separate development Worker is
required. Connect the custom domain to this same Worker when the application is
ready. When data services are introduced, configure isolated preview bindings
before allowing previews to access them.

The workers.dev site and branch previews are public. `noindex` discourages indexing; it does not
provide access control. Keep real originals, private metadata, and credentials
out of the application artifacts.

To check the upload package locally without publishing:

```sh
npm run verify
npm run deploy:check
```

`deploy:check` uses the adapter-generated `dist/server/wrangler.json`, including
its static-asset paths. Build first so it checks the current source.

References: [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/),
[build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
and [build tool versions](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).

## Development startup messages

`Debugger listening` and `Debugger attached` indicate that Node debugging is
enabled. For an ordinary development session in VS Code, use **Debug: Toggle
Auto Attach > Disabled**, then open a new regular PowerShell terminal.

The local Cloudflare/Vite runtime has also logged a `node:process` module-fallback
error during startup while still returning successful page responses. Its cause
has not been established. Disabling auto-attach is a useful diagnostic step,
not a verified fix for that error. Check the page and built preview separately;
a running local page does not establish compatibility with the hosted runtime.

## Files and artifacts

Keep private planning and local fixtures in the ignored `local/` directory.
Source photographs, metadata sidecars, secrets, dependencies, and generated
runtime/build files are ignored by Git. The photograph rules apply at any
directory depth; review explicit exceptions if curated application images are
added later. Git ignore rules are not deployment or archive filters. Publish
only the adapter-generated application artifacts, never the project directory.

Reference: [Astro Cloudflare adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/).
