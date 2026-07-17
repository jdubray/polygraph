// @polygraph/polyrun — public API (M0).
//
//   const rt = createRuntime({ dbPath, machines, handlers })
//   rt.create / rt.dispatch / rt.getState / rt.getJournal / rt.exportTraces
//   rt.startWorkers() / rt.stopWorkers()
//
// See docs/polyrun-spec.md for the full functional/technical specification.
'use strict';

import { Runtime, PoisonedError, ConflictError } from './kernel.mjs';
import { Workers } from './workers.mjs';
import { Store } from './store.mjs';

export { Runtime, Workers, Store, PoisonedError, ConflictError };

export function createRuntime(config) {
  const rt = new Runtime(config);
  const workers = new Workers(rt, config.worker || {});
  rt.workers = workers;
  rt.startWorkers = (opts) => workers.start(opts);
  rt.stopWorkers = () => workers.stop();
  return rt;
}
