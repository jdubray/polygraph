// Golden/snapshot parity (spec §4.11). Re-render each fixture and compare to the
// committed SVG. Regenerate intentionally with: UPDATE_SNAPSHOTS=1 node --test.
// Renderers may be async (elk-backed), so every case is awaited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderInvariants } from '../src/diagrams/invariants.mjs';
import { renderCounterexample } from '../src/diagrams/counterexample.mjs';
import { renderStateMachine } from '../src/diagrams/state-machine.mjs';
import { renderModelCard } from '../src/diagrams/model-card.mjs';
import { renderCompat } from '../src/diagrams/compat.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { fixture, snapshot, HERE } from './helpers.mjs';

// [snapshot name, render fn, fixture file, theme]
const CASES = [
  ['invariants.dark.svg', renderInvariants, 'daao.polyviz.json', 'dark'],
  ['invariants.light.svg', renderInvariants, 'daao.polyviz.json', 'light'],
  ['counterexample.dark.svg', renderCounterexample, 'daao.polyviz.json', 'dark'],
  ['counterexample.light.svg', renderCounterexample, 'daao.polyviz.json', 'light'],
  ['counterexample-fixed.dark.svg', renderCounterexample, 'daao-fixed.polyviz.json', 'dark'],
  ['state-machine.dark.svg', renderStateMachine, 'daao.polyviz.json', 'dark'],
  ['model-card.dark.svg', renderModelCard, 'daao.polyviz.json', 'dark'],
  ['model-card.light.svg', renderModelCard, 'daao.polyviz.json', 'light'],
  ['compat-gate.dark.svg', renderCompat, 'daao.polyviz.json', 'dark'],
  ['compat-gate.light.svg', renderCompat, 'daao.polyviz.json', 'light'],
  ['compat-clear.dark.svg', renderCompat, 'daao-compat-clear.polyviz.json', 'dark']
];

for (const [name, render, file, theme] of CASES) {
  test(`golden: ${name}`, async () => {
    const { svg } = await render(fixture(file), { tokens: loadTheme(theme) });
    if (process.env.UPDATE_SNAPSHOTS) {
      writeFileSync(join(HERE, '__snapshots__', name), svg);
      return;
    }
    assert.equal(svg, snapshot(name), `${name} drifted — run UPDATE_SNAPSHOTS=1 to accept`);
  });
}
