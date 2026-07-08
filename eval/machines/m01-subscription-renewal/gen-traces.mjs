import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { driveAll } from '../../lib/drive.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = require('./source.cjs');
const project = (s) => ({ status: s.status, attempts: s.attempts });

export function run() {
  driveAll(src, project, join(HERE, 'traces'), {
    // Normal renewal (ok) and the decline path — reference agrees with code here.
    s1_ok:       [['RENEW_CHARGE', { result: 'ok' }]],
    s2_declined: [['RENEW_CHARGE', { result: 'declined' }], ['DUNNING_RETRY', { result: 'ok' }]],
    // The seeded window: a transient 5xx during renewal.
    s3_renew5xx: [['RENEW_CHARGE', { result: 'err5xx' }]],
    // The parallel dunning 5xx (no-op) — a sibling that agrees, to prove specificity.
    s4_dun5xx:   [['RENEW_CHARGE', { result: 'declined' }], ['DUNNING_RETRY', { result: 'err5xx' }]],
    // Dunning to cancellation + a no-op (CANCEL from active-then-terminal).
    s5_dunning:  [['RENEW_CHARGE', { result: 'declined' }], ['DUNNING_RETRY', { result: 'declined' }], ['DUNNING_RETRY', { result: 'declined' }], ['DUNNING_RETRY', { result: 'declined' }]],
    s6_noop:     [['CANCEL', {}], ['RENEW_CHARGE', { result: 'ok' }]],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
