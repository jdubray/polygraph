import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { driveAll } from '../../lib/drive.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = require('./source.cjs');
const project = (s) => ({ status: s.status, amount: s.amount, approved: s.approved });

export function run() {
  driveAll(src, project, join(HERE, 'traces'), {
    // Full authorization captures (agrees with the reading).
    s1_full:    [['REQUEST', { amount: 100 }], ['AUTHORIZE', { approved: 100 }]],
    // The seeded window: a partial authorization.
    s2_partial: [['REQUEST', { amount: 100 }], ['AUTHORIZE', { approved: 60 }]],
    // Zero authorization declines (both agree: approved <= 0 and approved < amount).
    s3_zero:    [['REQUEST', { amount: 100 }], ['AUTHORIZE', { approved: 0 }]],
    // Overpayment (tip) captures; a no-op (AUTHORIZE after capture).
    s4_over:    [['REQUEST', { amount: 100 }], ['AUTHORIZE', { approved: 120 }], ['AUTHORIZE', { approved: 50 }]],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
