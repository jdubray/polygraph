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
    // Four consecutive failures: the 3rd is the seeded divergence (code stays
    // active where the reading says lock); the 1st/2nd/4th agree.
    s1_fails:   [['LOGIN_FAIL', {}], ['LOGIN_FAIL', {}], ['LOGIN_FAIL', {}], ['LOGIN_FAIL', {}]],
    // Success resets; unlock path; a no-op (LOGIN_OK while locked).
    s2_reset:   [['LOGIN_FAIL', {}], ['LOGIN_OK', {}]],
    s3_unlock:  [['LOGIN_FAIL', {}], ['LOGIN_FAIL', {}], ['LOGIN_FAIL', {}], ['LOGIN_FAIL', {}], ['UNLOCK', {}]],
    s4_noop:    [['LOGIN_FAIL', {}], ['LOGIN_FAIL', {}], ['LOGIN_FAIL', {}], ['LOGIN_FAIL', {}], ['LOGIN_OK', {}]],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
