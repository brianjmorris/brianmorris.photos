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
): Promise<{ results: Record<string, unknown>[] }[]> {
  try {
    return (await db.batch(statements)) as {
      results: Record<string, unknown>[];
    }[];
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/photo_tag_limit/.test(message))
      throw new CatalogueError(
        'invalid_input',
        'A photo can have at most 64 tags.',
        { cause },
      );
    if (/invalid_collection_cover/.test(message))
      throw new CatalogueError(
        'invalid_input',
        'Choose a published cover photograph with every defining tag.',
        { cause },
      );
    if (
      /invalid_collection_definition|FOREIGN KEY constraint failed/.test(
        message,
      )
    )
      throw new CatalogueError(
        'invalid_input',
        'A referenced record is missing or the tag combination is invalid.',
        { cause },
      );
    if (/collections.tag_set_key/.test(message))
      throw new CatalogueError(
        'conflict',
        'This tag combination already has a saved draft. Open that combination to edit it.',
        { cause },
      );
    if (/photo_draft_discarded/.test(message))
      throw new CatalogueError('conflict', 'This photo draft was discarded.', {
        cause,
      });
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
        'A revision, name, alias, or source record conflicts.',
        { cause },
      );
    }
    throw cause;
  }
}
