// polyrun config loader — a polyrun.config.mjs default-exports the runtime
// configuration: { store, machines, handlers, worker }. Handlers are real
// functions, so the config is a module, not JSON.
'use strict';

import { pathToFileURL } from 'node:url';
import { resolve, dirname, isAbsolute, join } from 'node:path';

export async function loadConfig(configPath) {
  const abs = resolve(configPath);
  const mod = await import(pathToFileURL(abs).href);
  const config = mod.default;
  if (!config || typeof config !== 'object') {
    throw new Error(`config '${configPath}' must default-export an object`);
  }
  // Resolve machine artifact paths relative to the config file, so a config
  // works no matter the CWD it is launched from.
  const base = dirname(abs);
  const rel = (p) => (isAbsolute(p) ? p : join(base, p));
  for (const m of config.machines ?? []) {
    m.module = rel(m.module);
    if (m.contract) m.contract = rel(m.contract);
    if (m.effects) {
      m.effects = { mapper: rel(m.effects.mapper), manifest: rel(m.effects.manifest) };
    }
    if (m.invariants) m.invariants = rel(m.invariants);
  }
  if (config.store && config.store.sqlite && config.store.sqlite !== ':memory:') {
    config.store = { ...config.store, sqlite: rel(config.store.sqlite) };
  }
  return config;
}
