// D3 counterexample: the bug face and the fix (clean-pass) face render from the
// same renderer; determinism and overflow hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCounterexample } from '../src/diagrams/counterexample.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { fixture } from './helpers.mjs';

const dark = () => loadTheme('dark');

test('bug face: violation present → red banner with the invariant id', () => {
  const svg = renderCounterexample(fixture(), { tokens: dark() }).svg;
  assert.match(svg, /S1 VIOLATED/);
  assert.doesNotMatch(svg, /CHECK PASSES/); // not the pass banner
});

test('fix face: no violation → green clean-pass banner', () => {
  const svg = renderCounterexample(fixture('daao-fixed.polyviz.json'), { tokens: dark() }).svg;
  assert.match(svg, /CHECK PASSES/);
  assert.doesNotMatch(svg, /VIOLATED/);
});

test('deterministic across repeated runs (both faces)', () => {
  for (const f of ['daao.polyviz.json', 'daao-fixed.polyviz.json']) {
    const a = renderCounterexample(fixture(f), { tokens: dark() }).svg;
    const b = renderCounterexample(fixture(f), { tokens: dark() }).svg;
    assert.equal(a, b);
  }
});

test('requires non-empty trace.steps', () => {
  assert.throws(() => renderCounterexample({ trace: { steps: [] } }, { tokens: dark() }), /steps is required/);
  assert.throws(() => renderCounterexample({}, { tokens: dark() }), /steps is required/);
});

test('long violation detail and callout body grow the canvas, do not clip', () => {
  const base = renderCounterexample(fixture(), { tokens: dark() });
  const m = fixture();
  m.trace.violation.detail = 'One human, counted twice, '.repeat(20);
  m.trace.callout.body = 'The gate explored the reachable states. '.repeat(20);
  const grown = renderCounterexample(m, { tokens: dark() });
  assert.ok(grown.height > base.height);
});

test('a long violation title wraps and grows the banner instead of overflowing', () => {
  const base = renderCounterexample(fixture(), { tokens: dark() });
  const m = fixture();
  m.trace.violation.title = 'S1 VIOLATED — two distinct human approvers are required and exactly one principal was counted twice across redelivery to reach execute';
  const grown = renderCounterexample(m, { tokens: dark() });
  assert.ok(grown.height > base.height, 'wrapped title should grow the canvas');
});

test('overflow: a very wide trace logs a single-row warning', () => {
  const m = fixture();
  m.trace.steps = Array.from({ length: 12 }, (_, i) => ({ label: `verylongstepname_${i}()`, kind: 'normal' }));
  const logs = [];
  renderCounterexample(m, { tokens: dark(), log: (s) => logs.push(s) });
  assert.ok(logs.some((l) => /single-row/.test(l)), 'expected an overflow log');
});
