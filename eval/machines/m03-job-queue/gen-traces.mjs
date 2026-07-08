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
    // Normal run, with heartbeats that ARE no-ops (running) — reference agrees.
    s1_run:     [['START', {}], ['HEARTBEAT', {}], ['COMPLETE', {}]],
    // The seeded window: heartbeat on a failed job.
    s2_failbeat: [['START', {}], ['FAIL', {}], ['HEARTBEAT', {}]],
    // Reset path + idle/done heartbeat no-ops.
    s3_reset:   [['START', {}], ['FAIL', {}], ['RESET', {}], ['HEARTBEAT', {}]],
    s4_noop:    [['HEARTBEAT', {}], ['COMPLETE', {}], ['START', {}], ['COMPLETE', {}], ['HEARTBEAT', {}]],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
