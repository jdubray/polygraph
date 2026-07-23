// Unit check for withSamTracingV2 (scripts/instrument/sam-emitter.mjs).
//
// Needs @cognitive-fab/sam-pattern 2.0.0-alpha (strict profile). Resolution:
//   1. scripts/vendor/sam-pattern.cjs (if the vendored bundle exists)
//   2. env POLYGRAPH_SAM (path to a v2 dist bundle, e.g. <sam-lib>/dist/SAM.js)
//   3. otherwise the test SKIPS (exit 0) — it must not fail on machines
//      without the alpha library.
//
// Run: node test/sam-emitter-v2.test.mjs
'use strict';

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSamTracingV2 } from '../scripts/instrument/sam-emitter.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

function resolveSamV2() {
  const vendored = path.join(here, '..', 'scripts', 'vendor', 'sam-pattern.cjs');
  if (existsSync(vendored)) return vendored;
  if (process.env.POLYGRAPH_SAM) return process.env.POLYGRAPH_SAM;
  return null;
}

const samPath = resolveSamV2();
if (!samPath) {
  console.log(
    'SKIP sam-emitter-v2: no sam-pattern v2 found (no scripts/vendor/' +
      'sam-pattern.cjs and POLYGRAPH_SAM is unset)'
  );
  process.exit(0);
}
const { createInstance } = require(samPath);

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}`);
  }
}

// --- a minimal v2 strict machine: counter with a guarded decrement ---------
const instance = createInstance({
  strict: true, hasAsyncActions: false, instanceName: 'emitterV2Test',
});
const control = instance({
  initialState: { counts: { c1: { value: 0 } } },
  component: {
    modelShape: { counts: { type: 'object' } },
    actions: {
      Inc: {
        action: (data) => ({ ...data }),
        schema: { id: { type: 'string', required: true } },
        domain: [{ id: 'c1' }],
      },
      Dec: {
        action: (data) => ({ ...data }),
        schema: { id: { type: 'string', required: true } },
        domain: [{ id: 'c1' }],
      },
    },
    acceptors: {
      Inc: (model) => (p, { next, unchanged }) => {
        const c = model.counts[p.id];
        if (!c) return unchanged('counts'); // accepted no-op needs an explicit frame (2.1)
        next.counts = { ...model.counts, [p.id]: { value: c.value + 1 } };
      },
      Dec: (model) => (p, { reject, next, unchanged }) => {
        const c = model.counts[p.id];
        if (!c) return unchanged('counts');
        if (c.value === 0) return reject('cannot decrement below zero');
        next.counts = { ...model.counts, [p.id]: { value: c.value - 1 } };
      },
    },
    reactors: [],
  },
});

// --- wire the v2 tracer with a function sink --------------------------------
const windows = [];
withSamTracingV2(instance, (w) => windows.push(w));

control.intents.Inc({ id: 'c1' });   // mutates: 0 -> 1
control.intents.Dec({ id: 'c1' });   // mutates: 1 -> 0
control.intents.Dec({ id: 'c1' });   // REJECTED at 0

check(windows.length === 3, 'three dispatches -> three windows');

const [w1, w2, w3] = windows;
check(w1.action === 'Inc', 'window 1 action is Inc');
check(w1.pre.counts.c1.value === 0 && w1.post.counts.c1.value === 1,
  'window 1 pre/post capture the mutation 0 -> 1');
check(w1.data.id === 'c1', 'window 1 data carries the payload');
check(!('rejected' in w1), 'window 1 (mutated) has no rejected key');

check(w2.action === 'Dec' && w2.pre.counts.c1.value === 1 && w2.post.counts.c1.value === 0,
  'window 2 chains pre from window 1 post (1 -> 0)');

check(w3.action === 'Dec', 'window 3 action is Dec');
check(w3.rejected === 'cannot decrement below zero',
  'rejected step emits a window with the rejection reason');
check(JSON.stringify(w3.pre) === JSON.stringify(w3.post),
  'rejected window is a no-op window (pre == post)');

// windows must be plain JSON (NDJSON-safe)
check(windows.every((w) => JSON.stringify(w).length > 0), 'windows serialize to JSON');

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('sam-emitter-v2: all checks passed');
