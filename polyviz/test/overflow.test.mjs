// Overflow (spec §4.11 / AC §7): long labels and many invariants must wrap and
// grow the panel — never clip or overlap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureText, wrapText, ellipsize } from '../src/layout/measure.mjs';
import { renderInvariants } from '../src/diagrams/invariants.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { fixture } from './helpers.mjs';

test('wrapText keeps every line within maxWidth', () => {
  const long =
    'Never permit an order to reach execute() when the accumulated set of ' +
    'distinct approving principals (excluding the original proposer under every ' +
    'redelivery and retry) has cardinality strictly less than the configured threshold';
  const maxWidth = 800;
  const lines = wrapText(long, { size: 17, maxWidth });
  assert.ok(lines.length > 1, 'long text should wrap');
  for (const line of lines) {
    assert.ok(measureText(line, { size: 17 }) <= maxWidth, `line exceeds maxWidth: "${line}"`);
  }
});

test('ellipsize truncates to fit and appends an ellipsis', () => {
  const long = '+amendCount, +state:amend-count-nonnegative, +more';
  const maxWidth = 200;
  const out = ellipsize(long, { size: 18, bold: true, maxWidth });
  assert.notEqual(out, long);
  assert.ok(out.endsWith('…'));
  assert.ok(measureText(out, { size: 18, bold: true }) <= maxWidth);
});

test('ellipsize leaves a fitting string untouched', () => {
  assert.equal(ellipsize('short', { size: 14, maxWidth: 500 }), 'short');
});

test('hard-breaks a single unbreakable word', () => {
  const word = 'x'.repeat(500);
  const lines = wrapText(word, { size: 17, maxWidth: 300 });
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(measureText(line, { size: 17 }) <= 300);
});

test('a long invariant grows the diagram height, does not clip', () => {
  const base = renderInvariants(fixture(), { tokens: loadTheme('dark') });
  const m = fixture();
  m.invariants[0].text = 'Never '.concat('do a very elaborate forbidden thing '.repeat(12)).trim();
  const grown = renderInvariants(m, { tokens: loadTheme('dark') });
  assert.ok(grown.height > base.height, 'panel/canvas should grow to fit wrapped text');
});

// x-coordinate of the first <text> whose content starts with `startsWith`.
function firstTextX(svg, startsWith) {
  const re = new RegExp(`<text x="([\\d.]+)"[^>]*>${startsWith}`);
  const m = svg.match(re);
  return m ? parseFloat(m[1]) : null;
}

test('a long invariant id widens the id column so text does not overlap it', () => {
  const short = fixture();
  short.invariants = [{ id: 'S1', kind: 'safety', text: 'Never do the forbidden thing', status: 'pass' }];
  const long = fixture();
  long.invariants = [{ id: 'SAFETY-COUNT-1', kind: 'safety', text: 'Never do the forbidden thing', status: 'pass' }];

  const sx = firstTextX(renderInvariants(short, { tokens: loadTheme('dark') }).svg, 'Never do');
  const lx = firstTextX(renderInvariants(long, { tokens: loadTheme('dark') }).svg, 'Never do');
  assert.ok(sx != null && lx != null, 'body text should be present');
  assert.ok(lx > sx, 'a longer id must push the body text column to the right');
  // And the long id itself must fit before the text column.
  const idW = measureText('SAFETY-COUNT-1', { size: 17, mono: true, bold: true });
  const idX = firstTextX(renderInvariants(long, { tokens: loadTheme('dark') }).svg, 'SAFETY-COUNT-1');
  assert.ok(idX + idW <= lx, 'id must end before the text column starts');
});

test('many invariants render without throwing', () => {
  const m = fixture();
  m.invariants = Array.from({ length: 40 }, (_, i) => ({
    id: `S${i + 1}`, kind: 'safety', text: `Invariant number ${i + 1} that must always hold`, status: 'pass'
  }));
  assert.doesNotThrow(() => renderInvariants(m, { tokens: loadTheme('dark') }));
});
