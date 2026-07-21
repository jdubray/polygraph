// Adapters: real polyvers compat-report.json → viz-model → validate → render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adaptCompat } from '../src/adapters/compat.mjs';
import { adaptDir } from '../src/adapters/index.mjs';
import { validate } from '../src/model/validate.mjs';
import { renderCompat } from '../src/diagrams/compat.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { HERE } from './helpers.mjs';

const ARTIFACTS = join(HERE, 'fixtures', 'artifacts');
const report = () => JSON.parse(readFileSync(join(ARTIFACTS, 'compat-report.json'), 'utf8'));

test('adaptDir on a real polyvers report dir yields a valid, renderable viz-model', async () => {
  const model = await adaptDir(ARTIFACTS);
  assert.doesNotThrow(() => validate(model));
  assert.ok(model.compat, 'has a compat section');
  const { svg } = renderCompat(model, { tokens: loadTheme('dark') });
  assert.match(svg, /SAFE TO DEPLOY/, 'PASS report → clear verdict');
});

test('adaptCompat maps a PASS report to a clear verdict with no offenders', () => {
  const c = adaptCompat(report());
  assert.equal(c.verdict.status, 'clear');
  assert.deepEqual(c.verdict.offenders, []);
  assert.ok(c.from.label.startsWith('v '), 'version card from hash');
});

test('adaptCompat caps the fleet and logs the truncation', () => {
  const logs = [];
  const c = adaptCompat(report(), { maxFleet: 3, log: (s) => logs.push(s) });
  assert.equal(c.fleet.length, 3);
  assert.ok(logs.some((l) => /showing the first 3/.test(l)), 'expected a truncation log');
});

test('adaptCompat maps a failing gate to a blocked verdict with named offenders', () => {
  const r = report();
  r.verdict = 'FAIL';
  const mg = r.gates.find((g) => g.gate === 'migrate');
  mg.ok = false;
  mg.failures = [{ id: 'synthesized#1', reason: 'projection mismatch' }]; // within the shown fleet
  const c = adaptCompat(r);
  assert.equal(c.verdict.status, 'blocked');
  assert.deepEqual(c.verdict.offenders, ['s1']);
  assert.ok(c.fleet.find((f) => f.id === 's1')?.flagged, 'the offender card is flagged');
});

test('adaptCompat rejects non-compat JSON', () => {
  assert.throws(() => adaptCompat({ hello: 'world' }), /not a polyvers compat-report/);
});

test('annotations override narrative fields', () => {
  const c = adaptCompat(report(), { annotations: { title: 'Custom title', verdictTitle: 'GREEN LIGHT' } });
  assert.equal(c.title, 'Custom title');
  assert.equal(c.verdict.title, 'GREEN LIGHT');
});
