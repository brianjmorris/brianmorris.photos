import { CatalogueError } from './model.ts';

// The subset of the D1 binding used by this module. No provider implementation
// or connection configuration is embedded in the catalogue.
export interface CatalogueStatement {
  bind(...values: (string | number | null)[]): CatalogueStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface CatalogueDatabase {
  prepare(sql: string): CatalogueStatement;
  batch(statements: CatalogueStatement[]): Promise<unknown>;
}

export async function writeCatalogueBatch(
  db: CatalogueDatabase,
  statements: CatalogueStatement[],
): Promise<void> {
  try {
    await db.batch(statements);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/invalid_place_(hierarchy|parent_kind)/.test(message))
      throw new CatalogueError(
        'invalid_input',
        'Place hierarchy is cyclic, exceeds 16 levels, or has an invalid parent type.',
        { cause },
      );
    if (
      /catalogue_.*conflict|UNIQUE constraint failed|immutable_photo_membership|immutable_tag_aliases/.test(
        message,
      )
    ) {
      throw new CatalogueError(
        'conflict',
        'A revision, name, alias, slug, or source record conflicts.',
        { cause },
      );
    }
    throw cause;
  }
}
