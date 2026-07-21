// Schema validation (spec §4.11): valid models pass, malformed ones fail loud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/model/validate.mjs';
import { fixture } from './helpers.mjs';

test('the DAAO fixture is a valid viz-model', () => {
  assert.doesNotThrow(() => validate(fixture()));
});

test('missing required field fails', () => {
  const m = fixture();
  delete m.invariants[0].text;
  assert.throws(() => validate(m), /missing required "text"/);
});

test('bad enum value fails', () => {
  const m = fixture();
  m.invariants[0].status = 'maybe';
  assert.throws(() => validate(m), /not in \{pass, fail, unchecked\}/);
});

test('unexpected property fails (additionalProperties:false)', () => {
  const m = fixture();
  m.scorecard = [{ value: '1' }];
  assert.throws(() => validate(m), /unexpected property "scorecard"/);
});

test('wrong type fails', () => {
  const m = fixture();
  m.invariants = 'not-an-array';
  assert.throws(() => validate(m), /expected array/);
});
