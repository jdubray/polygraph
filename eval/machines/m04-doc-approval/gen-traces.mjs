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
    // The seeded window: PUBLISH from draft (isolated, one step).
    s1_pubdraft: [['PUBLISH', {}]],
    // Normal approve->publish (approved->PUBLISH agrees with the reading).
    s2_normal:   [['SUBMIT', {}], ['APPROVE', {}], ['PUBLISH', {}]],
    // Reject and recall paths + a no-op (PUBLISH from review).
    s3_reject:   [['SUBMIT', {}], ['REJECT', {}]],
    s4_recall:   [['SUBMIT', {}], ['RECALL', {}]],
    s5_noop:     [['SUBMIT', {}], ['PUBLISH', {}]],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
