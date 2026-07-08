import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { driveAll } from '../../lib/drive.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const src = require('./source.cjs');
const project = (s) => ({ status: s.status, count: s.count });

export function run() {
  driveAll(src, project, join(HERE, 'traces'), {
    s1_shop:    [['ADD', { qty: 2 }], ['ADD', { qty: 1 }], ['REMOVE', { qty: 1 }], ['CHECKOUT', {}]],
    s2_empty:   [['ADD', { qty: 1 }], ['REMOVE', { qty: 1 }]],
    s3_noop:    [['REMOVE', { qty: 1 }], ['CHECKOUT', {}], ['ADD', { qty: 1 }], ['CHECKOUT', {}], ['ADD', { qty: 1 }]],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
