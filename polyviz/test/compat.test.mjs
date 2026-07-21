// D4 compat-gate: the blocked (bug) face and the clear (fix) face render from
// the same renderer; determinism holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCompat } from '../src/diagrams/compat.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { fixture } from './helpers.mjs';

const dark = () => loadTheme('dark');

test('blocked face: red banner + version delta + fleet', () => {
  const { svg, width } = renderCompat(fixture(), { tokens: dark() });
  assert.equal(width, 760);
  assert.match(svg, /DEPLOY BLOCKED/);
  assert.doesNotMatch(svg, /SAFE TO DEPLOY/);
  assert.ok(svg.includes('>RULE v1<'), 'from version card');
  assert.ok(svg.includes('>#o2<'), 'fleet entry');
  // the flagged offender uses the warn stroke.
  assert.ok(svg.includes(`stroke="${dark().warn}"`), 'flagged card is amber');
});

test('clear face: green banner, nothing flagged', () => {
  const { svg } = renderCompat(fixture('daao-compat-clear.polyviz.json'), { tokens: dark() });
  assert.match(svg, /SAFE TO DEPLOY/);
  assert.doesNotMatch(svg, /BLOCKED/);
  assert.doesNotMatch(svg, new RegExp(`stroke="${dark().warn}"`), 'no amber flag when clear');
});

test('deterministic across runs (both faces)', () => {
  for (const f of ['daao.polyviz.json', 'daao-compat-clear.polyviz.json']) {
    const a = renderCompat(fixture(f), { tokens: dark() }).svg;
    const b = renderCompat(fixture(f), { tokens: dark() }).svg;
    assert.equal(a, b);
  }
});

test('requires compat.verdict', () => {
  assert.throws(() => renderCompat({ compat: {} }, { tokens: dark() }), /verdict is required/);
  assert.throws(() => renderCompat({}, { tokens: dark() }), /verdict is required/);
});

test('long verdict detail wraps and grows the banner', () => {
  const base = renderCompat(fixture(), { tokens: dark() });
  const m = fixture();
  m.compat.verdict.detail = 'Order #o2 was approved under the 2-rule. '.repeat(12);
  const grown = renderCompat(m, { tokens: dark() });
  assert.ok(grown.height > base.height);
});
