import { invalid } from './model.ts';

export function validId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id))
    invalid('Invalid record ID.');
}

export function validRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1)
    invalid('An existing positive revision is required.');
}

export function validTime(time: number): void {
  if (!Number.isSafeInteger(time) || time < 0) invalid('Invalid timestamp.');
}
