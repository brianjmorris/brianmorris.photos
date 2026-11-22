import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Miniflare } from 'miniflare';
import ts from 'typescript';

export async function createLocalCatalogue() {
  const tempRoot = await realpath(tmpdir());
  const persistence = await mkdtemp(join(tempRoot, 'photos-catalogue-test-'));
  const modules = {
    'test.mjs': {
      type: 'esm',
      contents: await readFile(
        new URL('../catalogue-worker.mjs', import.meta.url),
        'utf8',
      ),
    },
  };
  const sourceDirectory = new URL('../../src/catalogue/', import.meta.url);
  for (const file of (await readdir(sourceDirectory)).filter((file) =>
    file.endsWith('.ts'),
  )) {
    const name = file.slice(0, -3);
    const source = await readFile(
      new URL(`../../src/catalogue/${name}.ts`, import.meta.url),
      'utf8',
    );
    modules[`${name}.js`] = {
      type: 'esm',
      contents: ts.transpileModule(source, {
        fileName: `${name}.ts`,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          rewriteRelativeImportExtensions: true,
        },
      }).outputText,
    };
  }
  const mf = new Miniflare({
    host: '127.0.0.1',
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: persistence,
    workers: [
      {
        config: {
          name: 'catalogue-local-test',
          compatibilityDate: '2026-11-17',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'test.mjs',
            modules,
          },
          env: {
            DB: {
              type: 'd1',
              id: 'disposable-catalogue',
              dev: { remote: false },
            },
          },
        },
      },
    ],
  });
  async function close() {
    await mf.dispose();
    const resolved = await realpath(persistence);
    assert.equal(dirname(resolved), tempRoot);
    assert(basename(resolved).startsWith('photos-catalogue-test-'));
    await rm(resolved, { recursive: true });
  }
  try {
    return {
      db: await mf.getD1Database('DB'),
      fetch: (url) => mf.dispatchFetch(url),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// Test-only migration ledger. Deployment tooling and bindings are configured later.
export async function applyLocalMigrations(db, through) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS catalogue_test_migrations (
    name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL
  ) STRICT`,
    )
    .run();
  const directory = new URL('../../migrations/', import.meta.url);
  const names = (await readdir(directory))
    .filter(
      (name) =>
        /^\d{4}_[a-z_]+\.sql$/.test(name) && (!through || name <= through),
    )
    .sort();
  assert(names.length > 0);
  for (const name of names) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    const applied = await db
      .prepare('SELECT sha256 FROM catalogue_test_migrations WHERE name = ?')
      .bind(name)
      .first();
    if (applied) {
      assert.equal(
        applied.sha256,
        sha256,
        `Applied migration changed: ${name}`,
      );
      continue;
    }
    const statements = sql
      .split('-- statement')
      .map((part) => part.trim())
      .filter(Boolean);
    await db.batch([
      ...statements.map((statement) => db.prepare(statement)),
      db
        .prepare(
          'INSERT INTO catalogue_test_migrations (name, sha256) VALUES (?, ?)',
        )
        .bind(name, sha256),
    ]);
  }
}
