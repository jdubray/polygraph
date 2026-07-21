// D1 state-machine + model-card: elk-backed layout, determinism, scale-to-fit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStateMachine } from '../src/diagrams/state-machine.mjs';
import { renderModelCard } from '../src/diagrams/model-card.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { fixture } from './helpers.mjs';

const dark = () => loadTheme('dark');

test('state-machine renders every state and highlights the marked one', async () => {
  const { svg } = await renderStateMachine(fixture(), { tokens: dark() });
  // labels are XML-escaped in the SVG (e.g. ACK'D → ACK&#39;D), so check the
  // unambiguous ones plus the escaped apostrophe case.
  for (const label of ['DRAFT', 'PENDING', 'APPROVED', 'RELEASED', 'EXECUTED', 'CLOSED', 'ABORTED', 'EXPIRED']) {
    assert.ok(svg.includes(`>${label}<`), `missing state ${label}`);
  }
  assert.ok(svg.includes('>ACK&#39;D<'), "missing state ACK'D");
  // highlighted EXECUTED uses the ok token color.
  assert.match(svg, new RegExp(`fill="${dark().ok}"[^>]*>EXECUTED<`));
});

test('elk layout is deterministic → byte-identical SVG across runs', async () => {
  const a = (await renderStateMachine(fixture(), { tokens: dark() })).svg;
  const b = (await renderStateMachine(fixture(), { tokens: dark() })).svg;
  assert.equal(a, b);
});

test('a wide machine is scaled to fit the frame and logs the choice', async () => {
  const m = fixture();
  const logs = [];
  const { svg, width } = await renderStateMachine(m, { tokens: dark(), log: (s) => logs.push(s) });
  assert.equal(width, 1200);
  assert.match(svg, /<g transform="translate\([^)]*\) scale\(0\.\d+\)"/);
  assert.ok(logs.some((l) => /scaled to/.test(l)), 'expected a scale log');
});

test('model-card composes the graph and the must-nevers panel', async () => {
  const { svg } = await renderModelCard(fixture(), { tokens: dark() });
  assert.ok(svg.includes('>DRAFT<'), 'has the machine');
  assert.match(svg, /MUST-NEVERS/, 'has the invariants panel');
  assert.ok(svg.includes('>S1<'), 'has safety invariants');
});

test('model-card is deterministic across runs', async () => {
  const a = (await renderModelCard(fixture(), { tokens: dark() })).svg;
  const b = (await renderModelCard(fixture(), { tokens: dark() })).svg;
  assert.equal(a, b);
});

test('state-machine requires non-empty machine.states', async () => {
  await assert.rejects(renderStateMachine({ machine: { states: [], transitions: [] } }, { tokens: dark() }), /states is required/);
});
