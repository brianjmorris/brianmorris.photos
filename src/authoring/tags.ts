import type { CatalogueDatabase } from '../catalogue/d1.ts';
import { invalid } from '../catalogue/model.ts';
import { CatalogueRepository, type TagInput } from '../catalogue/repository.ts';
import { validRevision } from '../catalogue/validation.ts';
import { collectionError } from './collections.ts';

export function tagInput(
  value: unknown,
  editing = false,
): { input: TagInput; expectedRevision?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('A tag is required.');
  const data = value as Record<string, unknown>;
  const allowed = [
    'name',
    'aliases',
    'notes',
    ...(editing ? ['expectedRevision'] : []),
  ];
  if (
    Object.keys(data).some((key) => !allowed.includes(key)) ||
    typeof data.name !== 'string' ||
    (data.aliases !== undefined &&
      (!Array.isArray(data.aliases) ||
        data.aliases.some((alias) => typeof alias !== 'string'))) ||
    (data.notes !== undefined && typeof data.notes !== 'string')
  )
    invalid('Supply a tag name and optional aliases and notes.');
  if (editing) validRevision(data.expectedRevision as number);
  return {
    input: {
      name: data.name,
      aliases: data.aliases as string[] | undefined,
      notes: data.notes as string | undefined,
    },
    ...(editing ? { expectedRevision: data.expectedRevision as number } : {}),
  };
}
export async function tagApi(
  owner: unknown,
  db: CatalogueDatabase | undefined,
  operation: (repository: CatalogueRepository) => Promise<Response>,
) {
  if (!owner)
    return Response.json({ error: 'Sign-in required.' }, { status: 401 });
  if (!db)
    return Response.json(
      { error: 'Tags are temporarily unavailable.' },
      { status: 503 },
    );
  try {
    return await operation(new CatalogueRepository(db));
  } catch (error) {
    const result = collectionError(error);
    return Response.json({ error: result.message }, { status: result.status });
  }
}
