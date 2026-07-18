// polyvers snapshot corpus — the states a compatibility gate runs against.
//
// Three sources, in descending order of honesty (the report records which
// one was used — provenance is part of the verdict):
//   live      — a polyrun database via its config (M1; not wired in M0)
//   archive   — `polyrun archive` output, or plain ndjson/json state dumps
//   synthesized — BFS-reachable states of the OLD machine (weakest tier:
//                 it can only contain states the old model says are
//                 reachable, which is exactly the assumption a landmine
//                 violates; still far better than an empty corpus)
//
// Corpus entries are { id, state, key, source } — `key` is the stable()
// canonical form, computed once here so gates never recompute it, and `id`s
// are RELATIVE to the corpus root so the report stays byte-identical across
// machines and working directories.
//
// Deterministic, no API key.
'use strict';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import samAdapter from '../../scripts/sam-adapter.cjs';
import { stable } from '../../scripts/load-spec.mjs';

const { isSamV2Module, makeSamAdapter, domainFromManifest } = samAdapter;

function pushUnique(out, seen, id, state, source) {
  const key = stable(state);
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ id, state, key, source });
}

function fromNdjsonFile(path, idBase, out, seen) {
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim());
  if (!lines.length) return;
  const first = JSON.parse(lines[0]);
  // A polyrun archive header is {archived: <instance row>} with a .state
  // object — require that shape, so a bare state dump whose first state
  // happens to carry a truthy 'archived' field is not misrouted (and its
  // remaining lines silently dropped).
  if (first && typeof first.archived === 'object' && first.archived !== null && typeof first.archived.state === 'object') {
    // `polyrun archive` layout: line 0 is the header whose .state is the
    // final persisted snapshot; the rest is the journal.
    pushUnique(out, seen, `${idBase}#archived:${first.archived.instance_id ?? '?'}`, first.archived.state, 'archive');
    // Journal post-states are additional real snapshots the machine held —
    // each was persisted at some seq, so each must survive the gate too.
    // (Journal rows come from the store, which emits snake_case step_kind.)
    for (const line of lines.slice(1)) {
      const row = JSON.parse(line);
      if (row && row.post && row.step_kind !== 'rejected') {
        pushUnique(out, seen, `${idBase}#seq:${row.seq ?? '?'}`, row.post, 'archive');
      }
    }
  } else {
    // Plain ndjson: each line is a bare state object.
    lines.forEach((line, i) => pushUnique(out, seen, `${idBase}#${i}`, JSON.parse(line), 'archive'));
  }
}

function fromJsonFile(path, idBase, out, seen) {
  const arr = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(arr)) throw new Error(`${path}: a .json corpus file must be an array of states`);
  arr.forEach((state, i) => pushUnique(out, seen, `${idBase}#${i}`, state, 'archive'));
}

/**
 * Load a snapshot corpus from a path: a directory of *.ndjson/*.json
 * (archive exports or state dumps), a single .ndjson, or a .json array of
 * states. Duplicate states (by stable()) are collapsed at parse time — the
 * gates are pointwise, so one representative per distinct state suffices
 * and the duplicates never occupy memory.
 */
export function loadCorpus(path) {
  const abs = resolve(path);
  const out = [];
  const seen = new Set();
  if (statSync(abs).isDirectory()) {
    for (const f of readdirSync(abs).sort()) {
      if (f.endsWith('.ndjson')) fromNdjsonFile(join(abs, f), f, out, seen);
      else if (f.endsWith('.json')) fromJsonFile(join(abs, f), f, out, seen);
    }
  } else if (abs.endsWith('.ndjson')) {
    fromNdjsonFile(abs, basename(abs), out, seen);
  } else if (abs.endsWith('.json')) {
    fromJsonFile(abs, basename(abs), out, seen);
  } else {
    throw new Error(`unsupported corpus path '${abs}' (expected a directory, .ndjson, or .json array)`);
  }
  return out;
}

/**
 * Synthesize a corpus: every BFS-reachable state of the OLD machine, driven
 * through the same sam-adapter + manifest-declared domain the model checker
 * uses. Labeled 'synthesized' so the report can say so.
 *
 * Returns { entries, truncated, notes }. `notes` discloses everything that
 * narrows the exploration — intents excluded by the domain builder and
 * (action, data) combos whose next() threw — because a silently truncated
 * corpus reads as "covered everything" when it did not.
 *
 * Runs the BFS twice and refuses a nondeterministic module (two identical
 * explorations must reach the same state set): a corpus that differs per
 * run would flip gate verdicts with no diagnosis.
 */
export function synthesizeCorpus(oldModule, { maxStates = 20000 } = {}) {
  if (!isSamV2Module(oldModule)) {
    throw new Error('synthesize: the old machine module does not export the v2 SAM surface { instance, init, actions, getState, setState }');
  }
  if (typeof oldModule.instance({}).manifest !== 'function') {
    throw new Error('synthesize: the old module\'s instance accessor exposes no manifest() — it predates the SAM structural registry, so the exploration domain cannot be read; use --snapshots with real fleet state instead');
  }
  const mod = makeSamAdapter(oldModule);
  const { steps, notes: domainNotes } = domainFromManifest(oldModule);
  if (!steps.length) throw new Error('synthesize: the old module\'s manifest() yields no explorable (action, data) steps — an empty corpus would pass every gate vacuously');

  const explore = () => {
    const notes = [...(domainNotes ?? [])];
    const threw = new Set(); // one note per (action) — not one per state
    const init = mod.init();
    const seen = new Map([[stable(init), init]]);
    const queue = [init];
    let head = 0;
    let truncated = false;
    outer: while (head < queue.length) {
      const s = queue[head++];
      const sJson = JSON.stringify(s); // hoisted: one stringify per state, one parse per step
      for (const { action, data } of steps) {
        let post;
        try { post = mod.next(JSON.parse(sJson), action, data); }
        catch (e) {
          // A throwing combo narrows the corpus, it must not abort it — the
          // machines this tool exists to protect are exactly the imperfect
          // ones. Disclose and continue.
          if (!threw.has(action)) { threw.add(action); notes.push(`next() threw on ${action}: ${e && e.message} — paths through it are NOT in the corpus`); }
          continue;
        }
        const key = stable(post);
        if (!seen.has(key)) {
          if (seen.size >= maxStates) { truncated = true; break outer; }
          seen.set(key, post);
          queue.push(post);
        }
      }
    }
    return { seen, truncated, notes };
  };

  const pass1 = explore();
  const pass2 = explore();
  const digest = (r) => [...r.seen.keys()].sort().join('\n');
  if (digest(pass1) !== digest(pass2)) {
    throw new Error('synthesize: two identical explorations reached different state sets — the old module is nondeterministic (Math.random / Date.now / retained mutable state); its synthesized corpus cannot be trusted, so refusing to gate on it; use --snapshots with real fleet state instead');
  }

  const entries = [...pass1.seen.entries()].map(([key, state], i) => ({ id: `synthesized#${i}`, state, key, source: 'synthesized' }));
  return { entries, truncated: pass1.truncated, notes: pass1.notes };
}
