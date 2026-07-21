// Spec §4.6: renderers reference tokens only — no hard-coded colors. Guard by
// grepping renderer/diagram sources for hex-color literals. theme.mjs (the
// token loader) and assets/*.json are exempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const HEX = /#[0-9a-fA-F]{3,8}\b/;

function collect(dir, exempt = []) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.mjs') && !exempt.includes(name)) files.push(join(dir, name));
  }
  return files;
}

test('no hex color literals in renderers or diagrams', () => {
  const files = [
    ...collect(join(ROOT, 'src/render'), ['theme.mjs']),
    ...collect(join(ROOT, 'src/diagrams'))
  ];
  const offenders = files.filter((f) => HEX.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], `hex literals found in: ${offenders.join(', ')}`);
});
