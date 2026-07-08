import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { driveAll } from '../../lib/drive.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = require('./source.cjs');
const project = (s) => ({ light: s.light });

export function run() {
  driveAll(src, project, join(HERE, 'traces'), {
    s1_cycle: [['NEXT', {}], ['NEXT', {}], ['NEXT', {}], ['NEXT', {}]],
    s2_noop:  [['STOP', {}], ['NEXT', {}]],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
