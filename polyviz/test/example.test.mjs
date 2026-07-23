// The worked example (examples/polyviz-oms) is a golden set: the committed
// img/*.svg must stay byte-identical to a fresh render of the committed
// artifacts, or the example's determinism pitch is silently falsified by any
// renderer change. Regenerate intentionally with:
//   node polyviz/bin/polyviz.mjs render --in examples/polyviz-oms --diagram all \
//        --out examples/polyviz-oms/img --format svg
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adaptDir } from '../src/adapters/index.mjs';
import { validate } from '../src/model/validate.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { DIAGRAMS, availableFor } from '../src/diagrams/index.mjs';
import { ROOT } from './helpers.mjs';

const EXAMPLE = join(ROOT, '..', 'examples', 'polyviz-oms');

test('the example adapts to a valid viz-model exposing all five diagrams', async () => {
  const model = await adaptDir(EXAMPLE);
  assert.doesNotThrow(() => validate(model));
  assert.deepEqual(
    availableFor(model).sort(),
    ['compat-gate', 'counterexample', 'invariants', 'model-card', 'state-machine']
  );
});

test('committed example SVGs are byte-identical to a fresh render', async () => {
  const model = await adaptDir(EXAMPLE);
  const tokens = loadTheme(model.meta?.theme ?? 'dark');
  for (const id of availableFor(model)) {
    const { svg } = await DIAGRAMS[id](model, { tokens });
    const committed = readFileSync(join(EXAMPLE, 'img', `${id}.svg`), 'utf8');
    assert.equal(svg, committed,
      `${id}.svg drifted from the committed figure — re-render examples/polyviz-oms/img (see header) and commit`);
  }
});
