// Machine + invariants adapters: BFS-derived transition graph and invariant
// extraction from a tiny dependency-free contract + module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveMachine } from '../src/adapters/machine.mjs';
import { adaptInvariants, adaptInvariantsModule } from '../src/adapters/invariants.mjs';
import { adaptDir } from '../src/adapters/index.mjs';
import { validate } from '../src/model/validate.mjs';
import { renderModelCard } from '../src/diagrams/model-card.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { HERE, ROOT } from './helpers.mjs';

const DIR = join(HERE, 'fixtures', 'artifacts-machine');
const contract = () => JSON.parse(readFileSync(join(DIR, 'contract.json'), 'utf8'));

// A real in-repo machine whose state field is NOT named "state" (orderState).
const OMS = join(ROOT, '..', 'examples', 'polyvers-oms', 'order-v1');

test('deriveMachine BFSes the module into an abstract transition graph', () => {
  const m = deriveMachine(contract(), join(DIR, 'next.cjs'));
  assert.deepEqual(m.states.map((s) => s.id), ['A', 'B', 'DONE']);
  assert.equal(m.states.find((s) => s.id === 'DONE').kind, 'terminal');
  const edge = (from, ev, to) => m.transitions.find((t) => t.from === from && t.event === ev && t.to === to);
  assert.ok(edge('A', 'go', 'B'), 'A --go--> B');
  const fin = edge('B', 'finish', 'DONE');
  assert.ok(fin, 'B --finish--> DONE');
  assert.equal(fin.effect, 'executed', 'executed flag flip → effect labelled by the contract field name');
  assert.equal(fin.emphasis, 'accent');
});

test('bare next() returning undefined for a no-op does not crash the BFS', () => {
  // The fixture module returns undefined for inapplicable actions; deriveMachine
  // must treat that as a no-op (guard before sanitize), not throw.
  assert.doesNotThrow(() => deriveMachine(contract(), join(DIR, 'next.cjs')));
});

test('a machine whose state field is not "state" (orderState) still yields edges', () => {
  const c = JSON.parse(readFileSync(join(OMS, 'contract.json'), 'utf8'));
  const m = deriveMachine(c, join(OMS, 'next.cjs'));
  assert.ok(m.transitions.length > 0, 'derives transitions from the orderState field');
  const ids = new Set(m.states.map((s) => s.id));
  const orphans = m.transitions.filter((t) => !ids.has(t.from) || !ids.has(t.to));
  assert.deepEqual(orphans, [], 'every edge endpoint is a declared state (quotes stripped)');
});

test('deriveMachine is deterministic', () => {
  const a = JSON.stringify(deriveMachine(contract(), join(DIR, 'next.cjs')));
  const b = JSON.stringify(deriveMachine(contract(), join(DIR, 'next.cjs')));
  assert.equal(a, b);
});

test('adaptInvariants derives id/kind/text/status', async () => {
  const inv = await adaptInvariants(join(DIR, 'invariants.mjs'));
  assert.equal(inv.length, 2);
  const s1 = inv[0];
  assert.equal(s1.id, 'S1'); // unique prefixes → short id
  assert.equal(s1.kind, 'safety');
  assert.equal(s1.text, 'Done implies executed'); // prettified from the name
  assert.equal(s1.status, 'pass'); // default
  assert.equal(inv[1].kind, 'liveness');
});

test('adaptInvariantsModule falls back to full names when prefixes collide', () => {
  const inv = adaptInvariantsModule({
    stateInvariants: [{ name: 'S1-a' }, { name: 'S1-b' }]
  });
  assert.equal(inv[0].id, 'S1-a');
  assert.equal(inv[1].id, 'S1-b');
});

test('adaptDir on a contract dir yields a valid, renderable model-card', async () => {
  const model = await adaptDir(DIR);
  assert.doesNotThrow(() => validate(model));
  assert.ok(model.machine && model.invariants, 'machine + invariants');
  const { svg } = await renderModelCard(model, { tokens: loadTheme('dark') });
  assert.ok(svg.includes('>DONE<'), 'renders the derived states');
});
