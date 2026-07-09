// Drives source.js through named scenarios and writes one NDJSON file per
// scenario into traces/. Each line is a (pre, action, data, post) window --
// ground truth, captured from the real code, not hand-typed.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = require('./source.cjs');

const scenarios = {
  // Trial conversion then a clean charge -- reference agrees with code here.
  // Driven to the terminal state (CANCEL) so the scenario captures a full
  // lifecycle, not just the transition of interest.
  s1_trial_to_active_ok: [
    ['TRIAL_END', {}],
    ['CHARGE', { result: 'ok' }],
    ['CANCEL', {}],
  ],
  // Decline -> dunning recovery.
  s2_declined_then_recovered: [
    ['TRIAL_END', {}],
    ['CHARGE', { result: 'declined' }],
    ['RETRY', { result: 'ok' }],
    ['CANCEL', {}],
  ],
  // The seeded window: a transient gateway error during the initial charge.
  s3_charge_error: [
    ['TRIAL_END', {}],
    ['CHARGE', { result: 'error' }],
    ['CANCEL', {}],
  ],
  // The parallel dunning 'error' (correctly a no-op) -- a sibling that
  // agrees, to prove the corpus is specific to the CHARGE path.
  s4_retry_error_noop: [
    ['TRIAL_END', {}],
    ['CHARGE', { result: 'declined' }],
    ['RETRY', { result: 'error' }],
    ['CANCEL', {}],
  ],
  // Dunning all the way to cancellation.
  s5_dunning_to_cancel: [
    ['TRIAL_END', {}],
    ['CHARGE', { result: 'declined' }],
    ['RETRY', { result: 'declined' }],
    ['RETRY', { result: 'declined' }],
    ['RETRY', { result: 'declined' }],
  ],
  // No-op actions: CANCEL from trialing, then CHARGE/TRIAL_END on a
  // terminal (canceled) row.
  s6_noop_actions: [
    ['CANCEL', {}],
    ['CHARGE', { result: 'ok' }],
    ['TRIAL_END', {}],
  ],
};

const outDir = join(HERE, 'traces');
mkdirSync(outDir, { recursive: true });

for (const [name, steps] of Object.entries(scenarios)) {
  let state = src.init();
  const lines = [];
  for (const [action, data] of steps) {
    const pre = state;
    const post = src.next(pre, action, data);
    lines.push(JSON.stringify({ pre, action, data, post }));
    state = post;
  }
  writeFileSync(join(outDir, `${name}.ndjson`), lines.join('\n') + '\n', 'utf-8');
}

console.log(`wrote ${Object.keys(scenarios).length} trace files to ${outDir}`);
