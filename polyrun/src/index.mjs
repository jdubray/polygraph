// @polygraph/polyrun — public API (M1).
//
//   const rt = await createRuntime({ store: {sqlite: 'path'} | {postgres: url},
//                                    machines, handlers, worker })
//   rt.create / rt.dispatch / rt.getState / rt.getStateAt / rt.getJournal /
//   rt.exportTraces / rt.list / rt.metrics
//   rt.startWorkers() / rt.stopWorkers() / rt.close()
//
// See docs/polyrun-spec.md for the full functional/technical specification.
'use strict';

import { Runtime, PoisonedError, ConflictError } from './kernel.mjs';
import { Workers } from './workers.mjs';
import { Store } from './store.mjs';
import { PgStore } from './store-pg.mjs';

export { Runtime, Workers, Store, PgStore, PoisonedError, ConflictError };

export async function createStore(config = {}) {
  if (config.postgres) return new PgStore(config.postgres, config.poolOptions, config.schema).init();
  return new Store(config.sqlite ?? ':memory:').init();
}

export async function createRuntime(config) {
  const store = config.store instanceof Object && typeof config.store.txn === 'function'
    ? config.store
    : await createStore(config.store ?? (config.dbPath ? { sqlite: config.dbPath } : {}));
  const rt = new Runtime({ ...config, store });
  const workers = new Workers(rt, config.worker || {});
  rt.workers = workers;
  rt.startWorkers = (opts) => workers.start(opts);
  rt.stopWorkers = () => workers.stop();
  return rt;
}
