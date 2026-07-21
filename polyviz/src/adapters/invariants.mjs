// Adapter: a Polygraph invariants module (invariants.mjs) → viz-model
// `invariants` array (spec §4.3). The module exports predicate objects
// ({ name, pred, ... }); display text/kind/status the figures show are not in
// the file, so we derive them (kind from the name prefix, text prettified from
// the name) and let annotations/explicit fields override. Async: the module is
// ESM and loaded via dynamic import.

import { pathToFileURL } from 'node:url';

// Find the exported array of invariant descriptors, whatever it is named.
function pickArray(mod) {
  const candidates = ['stateInvariants', 'invariants', 'default', 'safetyInvariants'];
  for (const k of candidates) if (Array.isArray(mod[k])) return mod[k];
  for (const v of Object.values(mod)) if (Array.isArray(v) && v.every((x) => x && typeof x.name === 'string')) return v;
  return null;
}

function kindOf(inv) {
  if (inv.kind === 'safety' || inv.kind === 'liveness') return inv.kind;
  return /^\s*L\d/i.test(inv.name) ? 'liveness' : 'safety';
}

// Prettify "S1-two-person-integrity" → "Two person integrity".
function prettify(name) {
  const body = name.replace(/^[A-Za-z]+\d+[-_ ]?/, '') || name;
  const words = body.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

// Leading id token, e.g. "S1-two-person-integrity" → "S1".
function idPrefix(name) {
  const m = /^([A-Za-z]+\d+)/.exec(name);
  return m ? m[1] : name;
}

/**
 * Adapt a dynamically-imported invariants module into a viz-model `invariants`
 * array. opts: { annotations? (by id or name), statusById? }.
 */
export function adaptInvariantsModule(mod, { annotations = {}, statusById = {} } = {}) {
  const arr = pickArray(mod);
  if (!arr) throw new Error('invariants adapter: no exported array of { name, ... } invariants found');

  // Use short id prefixes only when they are unique across the set.
  const prefixes = arr.map((i) => idPrefix(i.name));
  const uniquePrefix = new Set(prefixes).size === prefixes.length;

  return arr.map((inv, i) => {
    const id = inv.id ?? (uniquePrefix ? prefixes[i] : inv.name);
    const a = annotations[id] ?? annotations[inv.name] ?? {};
    return {
      id: a.id ?? id,
      kind: a.kind ?? kindOf(inv),
      text: a.text ?? inv.text ?? inv.description ?? prettify(inv.name),
      status: a.status ?? inv.status ?? statusById[id] ?? statusById[inv.name] ?? 'pass'
    };
  });
}

export async function adaptInvariants(modulePath, opts = {}) {
  const mod = await import(pathToFileURL(modulePath).href);
  return adaptInvariantsModule(mod, opts);
}
