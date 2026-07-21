// color() must fail loud on an unknown token (spec §2.6) — regression for the
// silent-fallback fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTheme, color } from '../src/render/theme.mjs';

test('color resolves a known token', () => {
  const t = loadTheme('dark');
  assert.equal(color(t, 'fail'), t.fail);
});

test('color throws on an unknown token instead of emitting it', () => {
  const t = loadTheme('dark');
  assert.throws(() => color(t, 'accentAA'), /unknown theme token "accentAA"/);
});

test('a falsy ref falls back to the given token', () => {
  const t = loadTheme('dark');
  assert.equal(color(t, '', 'muted'), t.muted);
  assert.equal(color(t, null), t.ink);
});
