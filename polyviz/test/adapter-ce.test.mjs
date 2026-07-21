// Counterexample adapter: trace records → viz-model.trace; findings resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { adaptCounterexample, parseTrace, rejectReason } from '../src/adapters/counterexample.mjs';
import { adaptDir } from '../src/adapters/index.mjs';
import { validate } from '../src/model/validate.mjs';
import { renderCounterexample } from '../src/diagrams/counterexample.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { HERE } from './helpers.mjs';

const DIR = join(HERE, 'fixtures', 'artifacts-ce');

const richTrace = [
  { pre: { s: 'A' }, action: 'submit', data: { actor: 'alice' }, post: { s: 'B' } },
  { pre: { s: 'B', ap: [] }, action: 'approve', data: { actor: 'bob' }, post: { s: 'B', ap: ['bob'] } },
  { pre: { s: 'B', ap: ['bob'] }, action: 'approve', data: { actor: 'bob' }, post: { s: 'B', ap: ['bob'] } }, // no-op
  { pre: { s: 'B' }, action: 'execute', data: {}, post: { s: 'X' } }
];

test('rich trace: labels, redelivered no-op detection, violation marking', () => {
  const ce = adaptCounterexample(richTrace, { violationIndex: 3, reason: 'duplicate-approver' });
  assert.deepEqual(ce.steps.map((s) => s.label), ['submit(Alice)', 'approve(Bob)', 'approve(Bob)', 'execute()']);
  assert.equal(ce.steps[2].kind, 'redelivered'); // post == pre
  assert.equal(ce.steps[3].kind, 'violation');
  assert.match(ce.violation.detail, /duplicate-approver/);
});

test('simple op trace: repeat op+actor is a redelivery', () => {
  const ce = adaptCounterexample([
    { op: 'submit', actor: 'alice' },
    { op: 'approve', actor: 'bob' },
    { op: 'approve', actor: 'bob' }
  ], {});
  assert.equal(ce.steps[2].kind, 'violation'); // last step defaults to violation
  assert.equal(ce.steps[1].kind, 'normal');
});

test('annotations override the narrative', () => {
  const ce = adaptCounterexample(richTrace, { annotations: { invariantId: 'S1', violationTitle: 'S1 VIOLATED' } });
  assert.equal(ce.violation.invariantId, 'S1');
  assert.equal(ce.violation.title, 'S1 VIOLATED');
});

test('parseTrace and rejectReason helpers', () => {
  assert.equal(parseTrace('{"op":"a"}\n{"op":"b"}').length, 2);
  assert.equal(rejectReason('rejected(duplicate-approver)'), 'duplicate-approver');
  assert.equal(rejectReason('mutated'), null);
});

test('empty trace fails loud', () => {
  assert.throws(() => adaptCounterexample([]), /no steps/);
});

test('adaptDir resolves findings.json → scenario trace → renderable counterexample', async () => {
  const model = await adaptDir(DIR);
  assert.doesNotThrow(() => validate(model));
  assert.ok(model.trace, 'has a trace section');
  assert.equal(model.trace.steps[2].kind, 'redelivered');
  assert.equal(model.trace.steps[2].label, 'approve(Bob)');
  const { svg } = renderCounterexample(model, { tokens: loadTheme('dark') });
  assert.match(svg, /Invariant violated|VIOLATED/);
});
