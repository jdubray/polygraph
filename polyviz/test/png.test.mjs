// PNG export (spec §4.8): deterministic per-platform rasterization via resvg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPng } from '../src/raster/png.mjs';
import { renderInvariants } from '../src/diagrams/invariants.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { fixture } from './helpers.mjs';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('renderPng emits a PNG that is byte-identical across repeated runs', async () => {
  const tokens = loadTheme('dark');
  const svg = renderInvariants(fixture(), { tokens }).svg;
  const a = await renderPng(svg, { scale: 2, background: tokens.bg });
  const b = await renderPng(svg, { scale: 2, background: tokens.bg });
  assert.ok(a.subarray(0, 8).equals(PNG_MAGIC), 'has PNG magic bytes');
  assert.ok(a.equals(b), 'same input → byte-identical PNG on this platform');
  assert.ok(a.length > 1000, 'non-trivial image');
});
