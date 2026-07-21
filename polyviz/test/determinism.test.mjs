// Flagship property (spec §4.7): same inputs → byte-identical SVG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInvariants } from '../src/diagrams/invariants.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { sha256 } from '../src/hash.mjs';
import { fixture } from './helpers.mjs';

test('invariants render is byte-identical across repeated runs (dark)', () => {
  const model = fixture();
  const tokens = loadTheme('dark');
  const a = renderInvariants(model, { tokens }).svg;
  const b = renderInvariants(model, { tokens }).svg;
  assert.equal(a, b);
  assert.equal(sha256(a), sha256(b));
});

test('invariants render is byte-identical across repeated runs (light)', () => {
  const model = fixture();
  const tokens = loadTheme('light');
  const a = renderInvariants(model, { tokens }).svg;
  const b = renderInvariants(model, { tokens }).svg;
  assert.equal(a, b);
});

test('output contains no wall-clock or random artifacts', () => {
  const svg = renderInvariants(fixture(), { tokens: loadTheme('dark') }).svg;
  // A determinism smoke check: no obvious timestamp-like or NaN content.
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
  assert.doesNotMatch(svg, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO timestamp
});
