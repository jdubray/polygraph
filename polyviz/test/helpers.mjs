// Shared test helpers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');

export function fixture(name = 'daao.polyviz.json') {
  return JSON.parse(readFileSync(join(ROOT, 'fixtures', name), 'utf8'));
}

export function snapshot(name) {
  return readFileSync(join(HERE, '__snapshots__', name), 'utf8');
}
