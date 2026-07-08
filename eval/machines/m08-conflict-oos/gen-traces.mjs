import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { driveAll } from '../../lib/drive.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = require('./source.cjs');
const project = (s) => ({ status: s.status });

export function run() {
  driveAll(src, project, join(HERE, 'traces'), {
    s1_ok:       [['CHARGE', { result: 'ok' }]],
    s2_declined: [['CHARGE', { result: 'declined' }], ['CHARGE', { result: 'ok' }]],
    // The conflict window: self-consistent (code and any faithful reader agree
    // conflict -> active), so it is correctly NOT a finding.
    s3_conflict: [['CHARGE', { result: 'conflict' }]],
    s4_noop:     [['CHARGE', { result: 'ok' }], ['CHARGE', { result: 'declined' }]],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
